import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRepairSnapshot,parseRepairPlan,applyRepairPlan,repairFingerprint,confirmRepairedNode,readinessIssues} from '../src/repair.ts';
import {bindingVariable,compileBindings} from '../src/bindings.ts';

const recorded='synthetic-recorded-ticket-9021';
const answer='new local answer "quoted" & {{literal}}';
const node=(id='step',data={})=>({id,type:'block',position:{x:100,y:80},data:{kind:'request',requestId:id,label:'填写业务资料',description:'提交用户提供的资料，执行前仍需核对。',uncertainty:'需要确认本次使用的资料。',readiness:'missing-input',method:'POST',url:'https://example.invalid/capture',headers:{},body:'{"email":"synthetic-private-recorded-email"}',...data}});
const request=(id,extra={})=>({id,method:'POST',url:'https://example.invalid/capture',domain:'example.invalid',path:'/capture',category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body:'',responseBody:'{}',responseHeaders:{},query:{},...extra});
const edge=(source,target)=>({id:`${source}-${target}`,source,target});
const question=(id='question-email')=>({id,title:'本次使用的邮箱',help:'填写这次需要提交的资料。',placeholder:'在这里填写',required:true});
const notes=input=>input.nodes.filter(item=>item.readiness!=='ready').map(item=>({nodeId:item.id,title:'核对执行条件',message:'参数草稿不会自动完成网页交互。',kind:item.readiness==='unsupported'?'unsupported':item.readiness==='manual'?'manual':'review'}));
const field=(input,nodeId,path='email',target='body')=>input.nodes.find(item=>item.id===nodeId).fields.find(item=>item.path===path&&item.target===target);
function userPlan(input,nodeIds=input.nodes.filter(item=>item.readiness!=='unsupported').map(item=>item.id)){
 return {summary:'请填写本次资料，再核对执行条件。',questions:nodeIds.length?[question()]:[],bindings:nodeIds.map(nodeId=>({nodeId,fieldId:field(input,nodeId).id,mode:'user',questionId:'question-email',reason:'由用户提供已有正文中的字符串字段。'})),notes:notes(input),warnings:[]};
}
function fixture(data={}){
 const nodes=[node('step',data)],edges=[],requests=[request('step',{body:nodes[0].data.body})];
 const snapshot=buildRepairSnapshot(nodes,edges,requests,readinessIssues(nodes));
 return {nodes,edges,requests,snapshot,plan:userPlan(snapshot.input)};
}
function sourceFixture(){
 const nodes=[node('source',{readiness:'ready',body:''}),node('target',{body:JSON.stringify({ticket:recorded})})];
 const edges=[edge('source','target')],requests=[request('source',{responseBody:JSON.stringify({ticket:recorded})}),request('target',{body:JSON.stringify({ticket:recorded})})];
 const snapshot=buildRepairSnapshot(nodes,edges,requests,readinessIssues(nodes)),capability=snapshot.input.nodes.find(item=>item.id==='target').sources[0];
 const plan={summary:'核对已录制的字段来源。',questions:[],bindings:[{nodeId:'target',fieldId:field(snapshot.input,'target','ticket').id,mode:'upstream',sourceId:capability?.id??'missing-source',reason:'录制值精确一致，仍需确认本次响应。'}],notes:notes(snapshot.input),warnings:[]};
 return {nodes,edges,requests,snapshot,plan};
}

test('capability catalog exposes only supported field locations and never captured values or executable requests',()=>{
 const privateValue='synthetic-private-value-never-send';
 const nodes=[node('step',{body:JSON.stringify({email:privateValue,count:2,active:true,nested:{text:privateValue},items:[privateValue]}),url:`https://example.invalid/private-url-marker?single=${privateValue}&repeat=one&repeat=two`,headers:{'X-Input':privateValue,Authorization:privateValue,Cookie:privateValue,Host:privateValue,'Content-Length':privateValue,'Proxy-Connection':privateValue,'Proxy-Authorization':privateValue,'Keep-Alive':privateValue,'Accept-Encoding':privateValue,Connection:'X-Drop','X-Drop':privateValue,'X-Dupe':privateValue,'x-dupe':privateValue}})];
 const before=structuredClone(nodes),snapshot=buildRepairSnapshot(nodes,[],[request('step',{body:privateValue,responseBody:privateValue})],readinessIssues(nodes)),catalog=snapshot.input.nodes[0];
 assert.deepEqual(catalog.fields.map(item=>`${item.target}:${item.path}`).sort(),['body:email','body:items.0','body:nested.text','header:Authorization','header:X-Input','query:single'].sort());
 assert.ok(catalog.fields.every(item=>item.valueType==='string'&&!item.existingBinding));
 const payload=JSON.stringify(snapshot.input);assert.ok(!payload.includes(privateValue));assert.ok(!payload.includes('private-url-marker'));assert.ok(!payload.includes('https://'));assert.ok(!payload.includes('responseBody'));assert.ok(!payload.includes('fingerprint'));
 assert.deepEqual(nodes,before);
});

test('JSON capability enumeration rejects ambiguous keys, unsupported containers and unsafe numeric documents',()=>{
 const body=JSON.stringify(JSON.parse('{"normal":"text","nested":{"safe":"text"},"items":["text",5,true,null],"literal.dot":"text","literal[key]":"text","bad\\nkey":"text","__proto__":{"value":"text"},"constructor":"text","prototype":"text","object":{},"none":null}'));
 const snapshot=buildRepairSnapshot([node('step',{body})],[],[],[]);
 assert.deepEqual(snapshot.input.nodes[0].fields.map(item=>item.path).sort(),['items.0','nested.safe','normal']);
 for(const unsupported of ['email=recorded','not json','{"email":"text","large":9007199254740993}','{"email":"text","large":1e400}',JSON.stringify({email:'x'.repeat(2*1024*1024)})]){
  assert.equal(buildRepairSnapshot([node('step',{body:unsupported})],[],[],[]).input.nodes[0].fields.length,0);
 }
});

test('existing exact, complete-body and complete-URL bindings protect overlapping repair fields',()=>{
 const existing={id:'kept',name:'已配置参数',target:'body',path:'email',mode:'user',value:'original-default'};
 const configured=fixture({bindings:[existing]});
 assert.equal(field(configured.snapshot.input,'step').existingBinding,true);assert.throws(()=>parseRepairPlan(configured.plan,configured.snapshot.input));
 for(const binding of [{...existing,path:'',mode:'fixed',value:'{}'},{...existing,target:'url',path:'',mode:'fixed',value:'https://example.invalid'}]){
  const nodes=[node('step',{url:'https://example.invalid?email=recorded',bindings:[binding]})],snapshot=buildRepairSnapshot(nodes,[],[],[]);
  const target=field(snapshot.input,'step','email',binding.target==='url'?'query':'body');
  assert.ok(!target||target.existingBinding,'an overlapping existing binding must not become a writable capability');
 }
});

test('upstream capabilities require a real ancestor, recorded output, exact scalar equality and supported encoding',()=>{
 const {nodes,edges,requests,snapshot}=sourceFixture();
 assert.equal(snapshot.input.nodes[1].sources.length,1);assert.equal(snapshot.input.nodes[1].sources[0].sourceNodeId,'source');assert.ok(!JSON.stringify(snapshot.input).includes(recorded));
 assert.equal(buildRepairSnapshot(nodes,[],requests,[]).input.nodes[1].sources.length,0);
 assert.equal(buildRepairSnapshot(nodes,[edge('target','source')],requests,[]).input.nodes[1].sources.length,0);
 const changed=structuredClone(nodes);changed[1].data.body=JSON.stringify({ticket:'different-current-value'});assert.equal(buildRepairSnapshot(changed,edges,requests,[]).input.nodes[1].sources.length,0);
 const bearerNodes=[nodes[0],node('target',{body:'',headers:{Authorization:`Bearer ${recorded}`}})],bearerRequests=[requests[0],request('target',{headers:{Authorization:`Bearer ${recorded}`}})];
 assert.equal(buildRepairSnapshot(bearerNodes,edges,bearerRequests,[]).input.nodes[1].sources.length,0,'prefix removal cannot be guessed by a binding');
 const ambiguous=[requests[0],request('other',{responseBody:JSON.stringify({ticket:recorded})}),requests[1]];
 assert.equal(buildRepairSnapshot(nodes,edges,ambiguous,[]).input.nodes[1].sources.length,0);
});

test('catalog limits fail explicitly without truncating nodes or excessive field scopes',()=>{
 for(const nodes of [[],Array.from({length:101},(_,i)=>node(`step-${i}`)),[node('same'),node('same')],[node('invalid.id')],[node('step',{readiness:'invented'})]])assert.throws(()=>buildRepairSnapshot(nodes,[],[],[]));
 const many=Object.fromEntries(Array.from({length:81},(_,i)=>[`field${i}`,'text']));assert.throws(()=>buildRepairSnapshot([node('step',{body:JSON.stringify(many)})],[],[],[]),/80/);
 assert.throws(()=>buildRepairSnapshot([node()],[],[],[],'字'.repeat(5334)),/目标/);
 assert.throws(()=>buildRepairSnapshot([node('step',{description:'字'.repeat(1334)})],[],[],[]),/说明/);
});

test('one question can feed multiple known fields while the returned plan remains a detached copy',()=>{
 const nodes=[node('one'),node('two')],input=buildRepairSnapshot(nodes,[edge('one','two')],[],[]).input,raw=userPlan(input),before=structuredClone(raw),parsed=parseRepairPlan(raw,input);
 assert.equal(parsed.questions.length,1);assert.equal(parsed.bindings.length,2);assert.deepEqual(raw,before);
 parsed.questions[0].title='changed-copy';parsed.notes[0].message='changed-copy';assert.deepEqual(raw,before);
});

test('repair parsing rejects unknown patches, forged IDs, prototype IDs and non-boolean questions',()=>{
 const {snapshot,plan}=fixture();
 const edits=[
  value=>{value.readiness='ready';},value=>{value.nodes=[];},value=>{value.questions[0].value='secret';},
  value=>{delete value.questions[0].required;},value=>{value.questions[0].required=null;},value=>{value.questions[0].required='true';},
  value=>{value.bindings[0].nodeId='unknown';},value=>{value.bindings[0].fieldId='unknown';},value=>{value.bindings[0].path='new-field';},
  value=>{value.bindings[0].mode='fixed';},value=>{value.bindings[0].sourceId='unrequested';},value=>{value.notes[0].nodeId='unknown';},
 ];
 for(const edit of edits){const invalid=structuredClone(plan);edit(invalid);assert.throws(()=>parseRepairPlan(invalid,snapshot.input));}
 for(const badId of ['bad.id','__proto__','prototype','constructor']){const invalid=structuredClone(plan);invalid.questions[0].id=badId;invalid.bindings[0].questionId=badId;assert.throws(()=>parseRepairPlan(invalid,snapshot.input));}
});

test('questions, targets and source capabilities must correspond exactly without overriding prior configuration',()=>{
 const {snapshot,plan}=fixture();
 const invalid=[{...plan,questions:[...plan.questions,question('unused')]},{...plan,questions:[...plan.questions,question()]},{...plan,bindings:[...plan.bindings,plan.bindings[0]]},{...plan,bindings:[]},{...plan,notes:[]}];
 for(const raw of invalid)assert.throws(()=>parseRepairPlan(raw,snapshot.input));
 const source=sourceFixture();assert.deepEqual(parseRepairPlan(source.plan,source.snapshot.input),source.plan);
 for(const edit of [value=>{value.bindings[0].sourceId='unknown';},value=>{value.bindings[0].questionId='forbidden';},value=>{value.bindings[0].fieldId='unknown';}]){const invalid=structuredClone(source.plan);edit(invalid);assert.throws(()=>parseRepairPlan(invalid,source.snapshot.input));}
});

test('unsupported steps retain typed guidance and never receive a binding or an implicit readiness change',()=>{
 const nodes=[node('unsupported',{readiness:'unsupported'})],input=buildRepairSnapshot(nodes,[],[],readinessIssues(nodes)).input,empty={summary:'这一段需要当前执行器不具备的网页能力。',questions:[],bindings:[],notes:notes(input),warnings:[]};
 assert.deepEqual(parseRepairPlan(empty,input),empty);
 const wrongNote=structuredClone(empty);wrongNote.notes[0].kind='review';assert.throws(()=>parseRepairPlan(wrongNote,input));
 const binding=userPlan({...input,nodes:input.nodes.map(item=>({...item,readiness:'missing-input'}))});binding.notes=empty.notes;assert.throws(()=>parseRepairPlan(binding,input));
 assert.equal(nodes[0].data.readiness,'unsupported');
});

test('provider output limits use UTF-8 bytes and reject oversized or missing arrays',()=>{
 const {snapshot,plan}=fixture();
 const invalid=[null,{}, {...plan,summary:'字'.repeat(667)},{...plan,questions:Array(33).fill(question())},{...plan,bindings:Array(101).fill(plan.bindings[0])},{...plan,notes:null},{...plan,warnings:Array(13).fill('warning')},{...plan,warnings:['字'.repeat(334)]}];
 for(const raw of invalid)assert.throws(()=>parseRepairPlan(raw,snapshot.input));
 for(const [key,value]of [['title','字'.repeat(67)],['help','字'.repeat(334)],['placeholder','字'.repeat(101)]]){const raw=structuredClone(plan);raw.questions[0][key]=value;assert.throws(()=>parseRepairPlan(raw,snapshot.input));}
});

test('applying answers adds local parameter drafts atomically without rewriting captured values or readiness',()=>{
 const {nodes,edges,requests,snapshot,plan}=fixture(),answers={'question-email':answer},values={kept:'existing-local-value'},before=structuredClone({nodes,edges,requests,snapshot,plan,answers,values});
 const applied=applyRepairPlan(nodes,edges,requests,snapshot,plan,answers,values),binding=applied.nodes[0].data.bindings[0];
 assert.equal(binding.mode,'user');assert.equal(binding.target,'body');assert.equal(binding.path,'email');assert.equal(binding.value,undefined);assert.equal(applied.values[bindingVariable('step',binding.id)],answer);assert.equal(applied.values.kept,values.kept);
 assert.equal(applied.nodes[0].data.body,nodes[0].data.body);assert.equal(applied.nodes[0].data.readiness,'missing-input');assert.ok(!JSON.stringify(applied.plan).includes(answer));assert.ok(!JSON.stringify(snapshot.input).includes(answer));assert.ok(!JSON.stringify(applied.nodes).includes(answer));
 const compiled=compileBindings(applied.nodes,edges,applied.values);assert.equal(compiled.issues.length,0);assert.equal(compiled.inputs[bindingVariable('step',binding.id)],answer);
 assert.deepEqual({nodes,edges,requests,snapshot,plan,answers,values},before);
});

test('manual and verified upstream drafts retain their distinct runtime mechanisms without clearing preparation state',()=>{
 const manual=fixture({readiness:'manual'});manual.plan.questions=[];manual.plan.bindings[0]={nodeId:'step',fieldId:field(manual.snapshot.input,'step').id,mode:'manual',reason:'运行到此步骤时由用户填写已知字段。'};
 const applied=applyRepairPlan(manual.nodes,manual.edges,manual.requests,manual.snapshot,manual.plan,{},{});assert.equal(applied.nodes[0].data.readiness,'manual');assert.equal(applied.nodes[0].data.bindings[0].mode,'manual');assert.equal(compileBindings(applied.nodes,manual.edges,{}).nodes.filter(item=>item.data.kind==='manual').length,1);
 const source=sourceFixture(),fromSource=applyRepairPlan(source.nodes,source.edges,source.requests,source.snapshot,source.plan,{},{}),binding=fromSource.nodes[1].data.bindings[0];assert.equal(binding.mode,'upstream');assert.equal(binding.source,'source');assert.equal(binding.sourcePath,'body.ticket');assert.equal(fromSource.nodes[1].data.readiness,'missing-input');assert.deepEqual(fromSource.values,{});
});

test('failed answers, invalid plans and stale graphs leave nodes and local values unchanged',()=>{
 const {nodes,edges,requests,snapshot,plan}=fixture(),values={kept:'keep'},before=structuredClone({nodes,edges,requests,snapshot,plan,values});
 for(const answers of [{},{'question-email':'   '},{'question-email':'x'.repeat(16385)},{'question-email':42}])assert.throws(()=>applyRepairPlan(nodes,edges,requests,snapshot,plan,answers,values));
 const invalid=structuredClone(plan);invalid.bindings[0].fieldId='unknown';assert.throws(()=>applyRepairPlan(nodes,edges,requests,snapshot,invalid,{'question-email':answer},values));
 const changed=structuredClone(nodes);changed[0].data.body='{"email":"different"}';assert.throws(()=>applyRepairPlan(changed,edges,requests,snapshot,plan,{'question-email':answer},values),/画布/);
 assert.deepEqual({nodes,edges,requests,snapshot,plan,values},before);
});

test('application revalidates captured source evidence and refuses tampered capability locations',()=>{
 const source=sourceFixture(),changedRequests=structuredClone(source.requests);changedRequests[0].responseBody=JSON.stringify({ticket:'different-recorded-source'});
 assert.throws(()=>applyRepairPlan(source.nodes,source.edges,changedRequests,source.snapshot,source.plan,{},{}));
 const changedSnapshot=structuredClone(source.snapshot);changedSnapshot.input.nodes[1].sources[0].sourcePath='body.invented';assert.throws(()=>applyRepairPlan(source.nodes,source.edges,source.requests,changedSnapshot,source.plan,{},{}));
 const changedField=structuredClone(source.snapshot);changedField.input.nodes[1].fields[0].path='invented';assert.throws(()=>applyRepairPlan(source.nodes,source.edges,source.requests,changedField,source.plan,{},{}));
 assert.equal(source.nodes[1].data.bindings,undefined);
});

test('dragging and selecting preserve a valid plan while data and connection edits invalidate it',()=>{
 const {nodes,edges,requests,snapshot,plan}=fixture(),moved=structuredClone(nodes);moved[0].position={x:999,y:777};moved[0].selected=true;moved[0].measured={width:100,height:90};
 assert.equal(repairFingerprint(moved,edges),snapshot.fingerprint);const applied=applyRepairPlan(moved,edges,requests,snapshot,plan,{'question-email':answer},{});assert.deepEqual(applied.nodes[0].position,moved[0].position);
 const renamed=structuredClone(nodes);renamed[0].data.label='用户重新命名';assert.notEqual(repairFingerprint(renamed,edges),snapshot.fingerprint);
 assert.notEqual(repairFingerprint(nodes,[edge('step','other')]),snapshot.fingerprint);
});

test('new binding identifiers avoid existing IDs and preserve unrelated user configuration',()=>{
 const existing={id:'repair-field-1',name:'原有参数',target:'body',path:'kept',mode:'fixed',value:'keep-default',evidence:'用户已配置'};
 const setup=fixture({body:'{"email":"recorded","kept":"original"}',bindings:[existing]}),applied=applyRepairPlan(setup.nodes,setup.edges,setup.requests,setup.snapshot,setup.plan,{'question-email':answer},{});
 assert.deepEqual(applied.nodes[0].data.bindings.find(item=>item.path==='kept'),existing);assert.notEqual(applied.nodes[0].data.bindings.find(item=>item.path==='email').id,existing.id);
});

test('explicit per-step confirmation cannot clear unsupported, unconfigured or unsatisfied manual requirements',()=>{
 for(const readiness of ['missing-input','manual','unsupported'])assert.throws(()=>confirmRepairedNode([node('step',{readiness})],[],{},'step'));
 const setup=fixture(),applied=applyRepairPlan(setup.nodes,setup.edges,setup.requests,setup.snapshot,setup.plan,{'question-email':answer},{});
 assert.throws(()=>confirmRepairedNode(applied.nodes,[],{},'step'),'required local answers still need to be present');
 const confirmed=confirmRepairedNode(applied.nodes,[],applied.values,'step');assert.equal(confirmed[0].data.readiness,'ready');assert.equal(applied.nodes[0].data.readiness,'missing-input');
 const manual=structuredClone(applied.nodes);manual[0].data.readiness='manual';assert.throws(()=>confirmRepairedNode(manual,[],applied.values,'step'));
 const unsupported=structuredClone(applied.nodes);unsupported[0].data.readiness='unsupported';assert.throws(()=>confirmRepairedNode(unsupported,[],applied.values,'step'));
});
