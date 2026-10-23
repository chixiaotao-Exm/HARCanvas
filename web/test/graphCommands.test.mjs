import test from 'node:test';
import assert from 'node:assert/strict';
import {applyGraphTransaction,createGraphHistory,commitGraphHistory,undoGraphHistory,redoGraphHistory} from '../src/graphCommands.ts';
import {bindingVariable} from '../src/bindings.ts';
const node=(id,kind='request',data={})=>({id,type:'block',position:{x:0,y:0},data:{kind,label:id,...data}});
const state=()=>({nodes:[node('a'),node('b')],edges:[{id:'ab',source:'a',target:'b'}],values:{filled:'retained'},revision:4});
test('all commands apply as one atomic transaction and preserve captured request values',()=>{
 const original=state(),before=JSON.stringify(original);
 assert.throws(()=>applyGraphTransaction(original,{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{label:'修改'}},{op:'connect',id:'bad',source:'b',target:'missing'}]}),/找不到/);
 assert.equal(JSON.stringify(original),before);
 const next=applyGraphTransaction(original,{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{label:'中文步骤'}},{op:'move',positions:[{nodeId:'b',x:400,y:200}]}]});
 assert.equal(next.revision,5);assert.equal(next.nodes[0].data.label,'中文步骤');assert.deepEqual(next.values,original.values);assert.equal(original.nodes[0].data.label,'a');
});
test('late replies cannot overwrite new edits, even after undo',()=>{
 const initial=state(),tx={baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{label:'改名'}}]},next=applyGraphTransaction(initial,tx);
 assert.throws(()=>applyGraphTransaction(next,tx),/画布已修改/);
 const history=undoGraphHistory(commitGraphHistory(createGraphHistory(initial),next));assert.equal(history.present.revision,6);assert.equal(history.present.nodes[0].data.label,'a');assert.throws(()=>applyGraphTransaction(history.present,tx),/画布已修改/);
 const redo=redoGraphHistory(history);assert.equal(redo.present.revision,7);assert.equal(redo.present.nodes[0].data.label,'改名');assert.deepEqual(redo.present.values,{filled:'retained'});
});
test('resource relationships never become execution edges and invalid references reject',()=>{
 const initial=state();const next=applyGraphTransaction(initial,{baseRevision:4,commands:[{op:'create',id:'p',kind:'proxy',label:'团队代理'},{op:'resource',id:'pa',resourceId:'p',targetId:'a'}]});
 assert.equal(next.nodes[2].data.proxy.rotation,'fixed');assert.equal(next.edges.length,1);assert.deepEqual(next.resourceBindings,[{id:'pa',resourceId:'p',targetId:'a'}]);
 assert.throws(()=>applyGraphTransaction(next,{baseRevision:5,commands:[{op:'connect',id:'bad',source:'p',target:'a'}]}),/资源方块/);
 assert.throws(()=>applyGraphTransaction(initial,{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{sessionId:'missing'}}]}),/不存在/);
});
test('new request references hydrate locally instead of asking a model for captured payload',()=>{
 const request={id:'capture_req-1',captureId:'capture',originalRequestId:'req-1',url:'https://example.invalid/?secret=local',method:'POST',headers:{Authorization:'local-secret'},body:'{"value":"local"}'};
 const next=applyGraphTransaction(state(),{baseRevision:4,commands:[{op:'create',id:'c',kind:'request',requestId:request.id,label:'新请求'}]},{requests:[request]});
 assert.equal(next.nodes[2].data.captureId,'capture');assert.equal(next.nodes[2].data.body,request.body);assert.equal(next.nodes[2].data.headers.Authorization,'local-secret');assert.equal(request.headers.Authorization,'local-secret');
});
test('cycles, unknown fields and forged readiness cannot be committed',()=>{
 assert.throws(()=>applyGraphTransaction(state(),{baseRevision:4,commands:[{op:'connect',id:'ba',source:'b',target:'a'}]}),/不能直接回连/);
 assert.throws(()=>applyGraphTransaction(state(),{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{readiness:'ready'}}]}),/已支持的方块字段/);
 assert.throws(()=>applyGraphTransaction(state(),{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:JSON.parse('{"__proto__":{}}')}]}));
});
test('wrap retains original steps once, reroutes boundaries, and stores a real count including zero',()=>{
 const s=state();s.nodes.push(node('out','output'));s.edges.push({id:'bo',source:'b',target:'out'});
 const result=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'wrap',nodeIds:['a','b'],id:'loop',label:'重复业务流程',kind:'loop',count:0}]});
 assert.deepEqual(result.nodes.map(n=>n.id),['out','loop']);assert.equal(result.nodes[1].data.loop.count,0);assert.equal(result.nodes[1].data.loop.nodes.length,2);assert.equal(result.nodes[1].data.loop.edges.length,1);assert.deepEqual(result.edges,[{id:'bo',source:'loop',target:'out',sourceHandle:undefined}]);
});
test('resource strategy edits retain local proxy credentials and merge profile dimensions',()=>{
 const s=state();s.nodes.push(node('p','proxy',{proxy:{url:'socks5://local:secret@proxy.invalid:1080',rotation:'fixed'}}));
 const result=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'patch',nodeId:'p',data:{proxy:{rotation:'minutes',rotationMinutes:5}}}]});
 assert.equal(result.nodes[2].data.proxy.url,s.nodes[2].data.proxy.url);assert.equal(result.nodes[2].data.proxy.rotationMinutes,5);
});
test('nested nodes can be edited, moved and connected without crossing scope boundaries',()=>{
 const s=state(),wrapped=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'wrap',nodeIds:['a','b'],id:'loop',label:'重复',kind:'loop',count:3}]});
 const edited=applyGraphTransaction(wrapped,{baseRevision:5,commands:[{op:'patch',nodeId:'a',data:{label:'内部步骤'}},{op:'move',positions:[{nodeId:'b',x:400,y:20}]}]});
 assert.equal(edited.nodes[0].data.loop.nodes[0].data.label,'内部步骤');assert.equal(edited.nodes[0].data.loop.nodes[1].position.x,400);
 assert.throws(()=>applyGraphTransaction(edited,{baseRevision:6,commands:[{op:'connect',id:'cross',source:'loop',target:'a'}]}),/同一层/);
});
test('wrapping never silently strands outer bindings to inner node responses',()=>{
 const s=state();s.nodes.push(node('out','request',{bindings:[{id:'b',name:'结果',target:'query',path:'id',mode:'upstream',source:'b',sourcePath:'body.id'}]}));s.edges.push({id:'bo',source:'b',target:'out'});
 assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'wrap',nodeIds:['a','b'],id:'loop',label:'重复',kind:'loop',count:3}]}),/重新绑定/);
});
test('bindings require connected ancestors and cannot read a future sibling response',()=>{
 const s=state(),binding={id:'future',name:'订单',target:'body',path:'id',mode:'upstream',source:'b',sourcePath:'body.id'};
 assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'bind',nodeId:'a',binding}]}),/当前步骤之前/);
 const valid=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'bind',nodeId:'b',binding:{...binding,source:'a'}}]});assert.equal(valid.nodes[1].data.bindings[0].source,'a');
});
test('recursive subflow duplication remaps internal nodes, edges, bindings and saved answers',()=>{
 const s=state(),binding={id:'email-field',name:'邮箱',target:'body',path:'email',mode:'user'},key=bindingVariable('a',binding.id);
 s.nodes[0].data={...s.nodes[0].data,url:'https://example.invalid/',body:'{"email":"captured"}',bindings:[binding]};
 s.nodes[1].data.bindings=[{id:'from-a',name:'结果',target:'body',path:'id',mode:'upstream',source:'a',sourcePath:'body.id'}];
 s.values[key]='saved@example.invalid';
 const wrapped=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'wrap',nodeIds:['a','b'],id:'flow',label:'业务子流程',kind:'subflow',count:1}]});
 const result=applyGraphTransaction(wrapped,{baseRevision:5,commands:[{op:'duplicate',nodeIds:['flow'],idMap:{flow:'flow-copy'}}]});
 const original=result.nodes.find(n=>n.id==='flow'),copy=result.nodes.find(n=>n.id==='flow-copy'),[a,b]=copy.data.loop.nodes;
 assert.equal(copy.data.loop.nodes.length,2);assert.notEqual(a.id,'a');assert.notEqual(b.id,'b');assert.equal(copy.data.loop.entryId,a.id);assert.equal(copy.data.loop.edges[0].source,a.id);assert.equal(copy.data.loop.edges[0].target,b.id);assert.equal(b.data.bindings[0].source,a.id);
 assert.equal(result.values[bindingVariable(a.id,binding.id)],'saved@example.invalid');assert.equal(original.data.loop.nodes[0].id,'a');assert.equal(s.nodes[0].id,'a');
});
test('nested loop copies keep loop locals and isolate declared inputs and templates',()=>{
 const input=node('name','input',{variable:'customer',value:''}),out=node('result','output',{template:'{{customer}} / {{name.value}} / {{item}}'}),loop=node('flow','loop',{loop:{mode:'each',count:1,items:'[1,2]',itemVariable:'item',indexVariable:'index',nodes:[input,out],edges:[{id:'ir',source:'name',target:'result'}],entryId:'name'}});
 const s={nodes:[loop],edges:[],values:{customer:'local-answer'},revision:1};
 const result=applyGraphTransaction(s,{baseRevision:1,commands:[{op:'duplicate',nodeIds:['flow'],idMap:{flow:'other'}}]}),copy=result.nodes[1],child=copy.data.loop.nodes;
 assert.notEqual(child[0].data.variable,'customer');assert.equal(result.values[child[0].data.variable],'local-answer');assert.equal(child[1].data.template,`{{${child[0].data.variable}}} / {{${child[0].id}.value}} / {{item}}`);assert.equal(copy.data.loop.itemVariable,'item');assert.equal(copy.data.loop.items,'[1,2]');
});
test('resource copies retain external resources and duplicate internal resource bindings to new targets',()=>{
 const s=state();s.nodes.push(node('p','proxy',{proxy:{url:'socks5://user:local@proxy.invalid:1080',rotation:'fixed'}}));s.resourceBindings=[{id:'pa',resourceId:'p',targetId:'a'}];
 const result=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'duplicate',nodeIds:['a','b','p'],idMap:{a:'a2',b:'b2',p:'p2'}}]});
 assert.equal(result.resourceBindings.length,2);assert.equal(result.resourceBindings[1].resourceId,'p2');assert.equal(result.resourceBindings[1].targetId,'a2');assert.equal(result.nodes.find(n=>n.id==='p2').data.proxy.url,s.nodes[2].data.proxy.url);
});
test('duplication rejects unsupported expressions or disconnected external data dependencies atomically',()=>{
 const s=state();s.nodes[1].data.bindings=[{id:'external',name:'结果',target:'body',path:'id',mode:'upstream',source:'a',sourcePath:'body.id'}];const before=JSON.stringify(s);
 assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'duplicate',nodeIds:['b'],idMap:{b:'b2'}}]}),/当前步骤之前/);assert.equal(JSON.stringify(s),before);
 s.nodes[1].data.bindings=[];s.nodes[1].data.body='{{a.body.id + 1}}';assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'duplicate',nodeIds:['a','b'],idMap:{a:'a2',b:'b2'}}]}),/无法自动改写/);
});
test('new blocks can be created and connected inside an existing subflow scope',()=>{
 const wrapped=applyGraphTransaction(state(),{baseRevision:4,commands:[{op:'wrap',nodeIds:['a','b'],id:'loop',label:'子流程',kind:'subflow',count:1}]});
 const result=applyGraphTransaction(wrapped,{baseRevision:5,commands:[{op:'create',id:'c',kind:'output',scopeId:'loop',label:'输出结果'},{op:'connect',id:'bc',source:'b',target:'c'}]});
 assert.equal(result.nodes.length,1);assert.equal(result.nodes[0].data.loop.nodes.at(-1).id,'c');assert.equal(result.nodes[0].data.loop.edges.at(-1).target,'c');
});
test('legacy dotted input binding IDs remain editable and removable after project import',()=>{
 const s=state(),binding={id:'input-body-profile.email',name:'邮箱',target:'body',path:'profile.email',mode:'user'};s.nodes[0].data.bindings=[binding];s.values[bindingVariable('a',binding.id)]='saved@example.invalid';
 const edited=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'bind',nodeId:'a',binding:{...binding,name:'联系邮箱'}}]});assert.equal(edited.nodes[0].data.bindings[0].name,'联系邮箱');assert.equal(edited.values[bindingVariable('a',binding.id)],'saved@example.invalid');
 const removed=applyGraphTransaction(edited,{baseRevision:5,commands:[{op:'unbind',nodeId:'a',bindingId:binding.id}]});assert.deepEqual(removed.nodes[0].data.bindings,[]);assert.equal(Object.hasOwn(removed.values,bindingVariable('a',binding.id)),false);
});
test('resource deletion preserves direct, nested and session references for preflight and only drops removed targets',()=>{
 const s=state();s.nodes[0].data.proxyId='p';s.nodes.push(node('p','proxy',{proxy:{url:'socks5://proxy.invalid:1080',rotation:'fixed'}}),node('session','browserSession',{session:{name:'会话',proxyId:'p',persist:false}}),node('flow','subflow',{proxyId:'p',loop:{mode:'count',count:1,items:'',itemVariable:'item',indexVariable:'index',nodes:[node('inside','request',{proxyId:'p'})],edges:[]}}));
 s.resourceBindings=[{id:'pa',resourceId:'p',targetId:'a'},{id:'pi',resourceId:'p',targetId:'inside'}];const before=JSON.stringify(s);
 const deleted=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'delete',nodeIds:['p']}]});assert.equal(JSON.stringify(s),before);assert.deepEqual(deleted.resourceBindings,s.resourceBindings);assert.equal(deleted.nodes.find(n=>n.id==='a').data.proxyId,'p');assert.equal(deleted.nodes.find(n=>n.id==='session').data.session.proxyId,'p');assert.equal(deleted.nodes.find(n=>n.id==='flow').data.loop.nodes[0].data.proxyId,'p');
 const edited=applyGraphTransaction(deleted,{baseRevision:5,commands:[{op:'patch',nodeId:'inside',data:{label:'稍后补全代理'}},{op:'move',positions:[{nodeId:'a',x:10,y:20}]}]});assert.deepEqual(edited.resourceBindings,s.resourceBindings);
 const removedTarget=applyGraphTransaction(edited,{baseRevision:6,commands:[{op:'delete',nodeIds:['flow']}]});assert.deepEqual(removedTarget.resourceBindings,[s.resourceBindings[0]]);
});
test('existing missing draft references survive unrelated edits and can be repaired without fallback',()=>{
 const s=state();s.nodes[0].data.proxyId='missing-proxy';s.nodes[1].data.sessionId='missing-session';s.nodes.push(node('session','browserSession',{session:{name:'已保存会话',proxyId:'missing-proxy',profileId:'missing-profile',persist:false}}));s.resourceBindings=[{id:'old-source',resourceId:'missing-proxy',targetId:'a'},{id:'old-target',resourceId:'session',targetId:'missing-target'}];
 const edited=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'patch',nodeId:'session',data:{session:{name:'改名后会话'}}},{op:'layout'}]});assert.equal(edited.nodes[0].data.proxyId,'missing-proxy');assert.equal(edited.nodes[1].data.sessionId,'missing-session');assert.equal(edited.nodes[2].data.session.profileId,'missing-profile');assert.deepEqual(edited.resourceBindings,s.resourceBindings);
 const repaired=applyGraphTransaction(edited,{baseRevision:5,commands:[{op:'create',id:'missing-proxy',kind:'proxy',label:'补回代理'},{op:'patch',nodeId:'session',data:{session:{profileId:''}}}]});assert.equal(repaired.nodes.find(n=>n.id==='session').data.session.profileId,'');assert.equal(repaired.nodes[0].data.proxyId,'missing-proxy');assert.equal(repaired.nodes.at(-1).data.kind,'proxy');
});
test('new or changed missing references cannot borrow another draft setting or a deletion allowance',()=>{
 const draft=state();draft.nodes[0].data.proxyId='missing';const before=JSON.stringify(draft);
 for(const commands of [[{op:'patch',nodeId:'b',data:{proxyId:'missing'}}],[{op:'patch',nodeId:'a',data:{proxyId:'other-missing'}}],[{op:'create',id:'new',kind:'request',label:'新增',data:{proxyId:'missing'}}],[{op:'create',id:'new-session',kind:'browserSession',label:'新会话',data:{session:{name:'新会话',proxyId:'missing'}}}],[{op:'delete',nodeIds:['a']},{op:'create',id:'a',kind:'request',label:'重建',data:{proxyId:'missing'}}]])assert.throws(()=>applyGraphTransaction(draft,{baseRevision:4,commands}),/不存在/);
 assert.equal(JSON.stringify(draft),before);
 const s=state();s.nodes[0].data.proxyId='p';s.nodes.push(node('p','proxy',{proxy:{url:'',rotation:'fixed'}}));
 assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'delete',nodeIds:['p']},{op:'patch',nodeId:'b',data:{proxyId:'p'}}]}),/不存在/);
 assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{proxyId:'b'}},{op:'delete',nodeIds:['b']}]}),/不存在/);
 assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[{op:'patch',nodeId:'a',data:{proxyId:'b'}}]}),/不存在/);
});
test('missing resource relations can be removed only by their complete existing identity',()=>{
 const s=state();s.resourceBindings=[{id:'missing-source',resourceId:'missing',targetId:'a'},{id:'missing-target',resourceId:'also-missing',targetId:'gone'}];
 const removed=applyGraphTransaction(s,{baseRevision:4,commands:[{op:'resource',id:'missing-source',resourceId:'missing',targetId:'a',remove:true}]});assert.deepEqual(removed.resourceBindings,[s.resourceBindings[1]]);
 for(const command of [{op:'resource',id:'missing-source',resourceId:'different',targetId:'a',remove:true},{op:'resource',id:'unknown',resourceId:'missing',targetId:'a',remove:true},{op:'resource',id:'new-relation',resourceId:'missing',targetId:'a'}])assert.throws(()=>applyGraphTransaction(s,{baseRevision:4,commands:[command]}),/找不到/);
});
