import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChatSnapshot,parseChatPlan,applyChatPlan,runAgentChat} from '../src/agentChat.ts';
import {bindingVariable} from '../src/bindings.ts';
const n={id:'a',type:'block',position:{x:0,y:0},data:{kind:'request',label:'查询订单',url:'https://example.invalid/path?token=local-secret',headers:{Cookie:'local-cookie'},body:'{"email":"local@example.invalid"}',bindings:[{id:'mail',name:'邮箱',target:'body',path:'email',mode:'user'}]}};
const state=()=>({nodes:[structuredClone(n)],edges:[],values:{local:'local-answer'},revision:1});
const user={id:'m',role:'user',content:'帮我整理画布'};
test('model catalog includes useful capabilities without captured secrets or filled answers',()=>{
 const snapshot=buildChatSnapshot(state(),[{id:'req-1',method:'POST',domain:'example.invalid',path:'/123/opaqueveryveryveryverylongvaluehere?token=local-query'}],['a'],[user]);const sent=JSON.stringify(snapshot.input);
 for(const secret of ['local-secret','local-cookie','local@example.invalid','local-answer','local-query'])assert.equal(sent.includes(secret),false);
 assert.deepEqual(snapshot.input.nodes[0].fields,[{target:'body',path:'email'},{target:'query',path:'token'}]);assert.equal(snapshot.input.selectedNodeIds[0],'a');assert.equal(snapshot.input.requests[0].path,'/:参数/:参数');
});
test('questions reference only existing local input keys and cannot invent unrelated answers',()=>{
 const snapshot=buildChatSnapshot(state(),[],[],[user]),variable=snapshot.input.nodes[0].inputs[0].variable;
 const plan={baseRevision:1,message:'请在这里填写邮箱',commands:[],questions:[{id:'q',title:'邮箱',help:'用于此步骤',placeholder:'请输入邮箱',required:true,variable,nodeId:'a'}]};
 assert.equal(parseChatPlan(plan,snapshot.input).questions[0].variable,variable);
 assert.throws(()=>parseChatPlan({...plan,questions:[{...plan.questions[0],variable:'api_key'}]},snapshot.input));
 assert.throws(()=>parseChatPlan({...plan,baseRevision:0},snapshot.input));
});
test('full transactions are rechecked against the live graph and original fields',()=>{
 const s=state(),snapshot=buildChatSnapshot(s,[],[],[user]),plan={baseRevision:1,message:'已重命名',commands:[{op:'patch',nodeId:'a',data:{label:'读取订单'}}],questions:[]};
 assert.equal(applyChatPlan(s,snapshot,plan).nodes[0].data.label,'读取订单');
 s.nodes[0].position.x=42;assert.throws(()=>applyChatPlan(s,snapshot,plan),/新修改/);
});
test('selection and ReactFlow measurement updates do not discard a pending edit',()=>{
 const s=state(),snapshot=buildChatSnapshot(s,[],[],[user]),plan={baseRevision:1,message:'已改名',commands:[{op:'patch',nodeId:'a',data:{label:'新名称'}}],questions:[]};
 s.nodes[0].selected=true;s.nodes[0].measured={width:300,height:200};s.nodes[0].dragging=false;
 assert.equal(applyChatPlan(s,snapshot,plan).nodes[0].data.label,'新名称');
});
test('resource and loop metadata is visible without exposing configured credentials or items',()=>{
 const s=state();s.nodes.push({id:'proxy',type:'block',position:{x:0,y:0},data:{kind:'proxy',label:'代理',proxy:{url:'socks5://user:local-password@proxy.invalid:1080',rotation:'minutes',rotationMinutes:5}}});
 const snapshot=buildChatSnapshot(s,[],[],[user]);assert.deepEqual(snapshot.input.nodes[1].settings.proxy,{rotation:'minutes',rotationMinutes:5,configured:true});assert.equal(JSON.stringify(snapshot.input).includes('local-password'),false);
});
test('chat uses shared asynchronous jobs without business HTTP execution',async()=>{
 const snapshot=buildChatSnapshot(state(),[],[],[user]);let posts=0,polls=0;
 const result=await runAgentChat({baseUrl:'https://model.invalid/v1',apiKey:'model-key',model:'test'},snapshot.input,new AbortController().signal,{sleep:async()=>{},fetch:async(path,options)=>{
  if(options.method==='POST'){posts++;const body=JSON.parse(options.body);assert.equal(body.mode,'chat');assert.equal(JSON.stringify(body.chat).includes('model-key'),false);return new Response(JSON.stringify({id:'testjob',status:'running',mode:'chat'}),{status:202});}
  polls++;assert.equal(path,'/api/agent/jobs/testjob');return new Response(JSON.stringify({id:'testjob',status:'completed',mode:'chat',chat:{baseRevision:1,message:'已整理',commands:[],questions:[]}}));
 }});assert.equal(result.message,'已整理');assert.equal(posts,1);assert.equal(polls,1);
});
test('nested catalog retains child execution edges and selects nested blocks',()=>{
 const s=state();s.nodes=[{id:'flow',type:'block',position:{x:0,y:0},data:{kind:'subflow',label:'订单子流程',loop:{mode:'count',count:1,items:'',itemVariable:'item',indexVariable:'index',nodes:[s.nodes[0],{id:'out',type:'block',position:{x:0,y:0},data:{kind:'output',label:'输出'}}],edges:[{id:'ao',source:'a',target:'out'}]}}}];
 const snapshot=buildChatSnapshot(s,[],['a'],[user]);assert.deepEqual(snapshot.input.nodes[0].childEdges,[{id:'ao',source:'a',target:'out',sourceHandle:undefined}]);assert.deepEqual(snapshot.input.selectedNodeIds,['a']);
});
test('legacy dotted binding IDs can be edited and questioned in one response',()=>{
 const s=state(),binding={id:'input-body-profile.email',name:'邮箱',target:'body',path:'email',mode:'user'},variable=bindingVariable('a',binding.id),snapshot=buildChatSnapshot(s,[],[],[user]);
 const plan={baseRevision:1,message:'请填写邮箱',commands:[{op:'bind',nodeId:'a',binding}],questions:[{id:'q',title:'邮箱',help:'用于这一步',placeholder:'请输入邮箱',required:true,variable,nodeId:'a'}]};
 const result=applyChatPlan(s,snapshot,plan);assert.equal(result.nodes[0].data.bindings.at(-1).id,binding.id);assert.equal(parseChatPlan(plan,snapshot.input).questions[0].variable,variable);
});
test('raw or encoded at signs in proxy passwords never leave credential suffixes in chat history or diagnostics',()=>{
 for(const protocol of ['socks5','socks5h','http','https'])for(const password of ['before@after@tail','before%40after%40tail']){
  const link=`${protocol}://team-credential:${password}@proxy.invalid:1080`,snapshot=buildChatSnapshot(state(),[],[],[{...user,content:`使用 ${link}`}],{issues:[{nodeId:'a',code:'proxy',message:`连接 ${link} 失败`,suggestedAction:`检查 ${link}`}],events:[{nodeId:'a',status:'error',message:`连接 ${link} 失败`}]});
  const sent=JSON.stringify(snapshot.input);for(const fragment of ['team-credential','before','after','tail'])assert.equal(sent.includes(fragment),false);assert.equal(snapshot.input.messages[0].content,`使用 ${protocol}://[连接凭据已保存在本地]@proxy.invalid:1080`);
 }
 const publicURL='https://example.invalid/path@name?email=user@example.invalid#contact@team',snapshot=buildChatSnapshot(state(),[],[],[{...user,content:`打开 ${publicURL}`}]);assert.equal(snapshot.input.messages[0].content,`打开 ${publicURL}`);
});
