import test from 'node:test';
import assert from 'node:assert/strict';
import {findFieldRelations,buildAnalysisContext,planRequestGroups} from '../src/analysisContext.ts';
import {mergeGeneratedFlow} from '../src/generation.ts';
import {compileBindings} from '../src/bindings.ts';
const req=(id,extra={})=>({id,method:'POST',url:`https://example.test/${id}`,domain:'example.test',path:`/${id}`,category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body:'',responseBody:'{}',responseHeaders:{},query:{},...extra});
const suggestion=(requestId,extra={})=>({requestId,label:'处理表单',description:'提交用户提供的资料，读取响应结果。',category:'api',confidence:'high',dependencies:[],variables:[],...extra});

test('auto generation is grounded, incremental, and connects recorded field matches',()=>{
 const requests=[req('a',{responseBody:'{"ticket":"unique-ticket"}'}),req('b',{body:'{"ticket":"unique-ticket"}'})];
 const first=mergeGeneratedFlow([],[],requests,[suggestion('a')],'capture-1');
 assert.equal(first.nodes.length,1);assert.equal(first.edges.length,0);
 first.nodes[0].data.label='手动改名';first.nodes[0].position={x:999,y:888};
 const next=mergeGeneratedFlow(first.nodes,first.edges,requests,[suggestion('a'),suggestion('b',{dependencies:['a']})],'capture-1');
 assert.equal(next.addedCount,1);assert.equal(next.nodes[0].data.label,'手动改名');assert.deepEqual(next.nodes[0].position,{x:999,y:888});
 assert.equal(next.edges.length,1);assert.equal(next.edges[0].source,next.nodes[0].id);assert.equal(next.edges[0].target,next.nodes[1].id);
 assert.equal(next.nodes[1].data.body,requests[1].body);
 const repeated=mergeGeneratedFlow(next.nodes,[],requests,[suggestion('a'),suggestion('b')],'capture-1');
 assert.equal(repeated.addedCount,0);assert.equal(repeated.edges.length,0,'manually deleted connections stay deleted');
});

test('unknown purposes and speculative relationships never become executable edges',()=>{
 const result=mergeGeneratedFlow([],[],[req('a'),req('b')],[suggestion('a'),suggestion('b',{dependencies:['a']}),suggestion('invented')],'capture');
 assert.equal(result.nodes.length,2);assert.equal(result.edges.length,0);assert.ok(result.pending.length);
 assert.equal(mergeGeneratedFlow([],[],[req('a')],[suggestion('a',{description:' '})],'capture').nodes.length,0);
});

test('different captures cannot deduplicate or connect through identical request IDs',()=>{
 const old=mergeGeneratedFlow([],[],[req('a')],[suggestion('a')],'old');
 const next=mergeGeneratedFlow(old.nodes,[],[req('a'),req('b')],[suggestion('a'),suggestion('b')],'new');
 assert.equal(next.addedCount,2);assert.equal(next.nodes.length,3);assert.notEqual(next.nodes[0].id,next.nodes[1].id);
});

test('deleted generated blocks are suppressed during subsequent batches',()=>{
 const result=mergeGeneratedFlow([],[],[req('a'),req('b')],[suggestion('a'),suggestion('b')],'capture',{suppressedRequestIds:new Set(['a'])});
 assert.deepEqual(result.nodes.map(n=>n.data.requestId),['b']);
});

test('field matches do not expose values and ambiguous repeated outputs are not guessed',()=>{
 const secret='opaque-value-do-not-show';
 const requests=[req('a',{responseBody:JSON.stringify({session:secret})}),req('b',{body:JSON.stringify({session:secret})}),req('c',{responseBody:JSON.stringify({session:secret})}),req('d',{body:JSON.stringify({session:secret})})];
 const relations=findFieldRelations(requests);
 assert.equal(relations.length,1);assert.equal(relations[0].targetRequestId,'b');assert.ok(!JSON.stringify(relations).includes(secret));
});

test('common successful status strings cannot turn into dependency edges',()=>{
 const relations=findFieldRelations([req('a',{responseBody:'{"message":"successfully","status":"completed"}'}),req('b',{body:'{"label":"successfully","status":"completed"}'})]);
 assert.deepEqual(relations,[]);
});

test('same URL requests remain individually traceable within noise groups and context',()=>{
 const requests=[req('a',{path:'/events',body:'{"event":"first"}'}),req('b',{path:'/events',body:'{"event":"second"}'}),req('c',{category:'static',path:'/app.js'})];
 const groups=planRequestGroups(requests);assert.equal(groups.length,2);assert.deepEqual(groups[0].requestIds,['a','b']);
 const context=buildAnalysisContext(requests,'查询订单',[suggestion('a')]);
 assert.equal(context.goal,'查询订单');assert.equal(context.catalog.length,3);assert.equal(context.previous[0].requestId,'a');
});

test('a model ready claim cannot clear captured session inputs that need review',()=>{
 for(const fields of [{headers:{Authorization:'Bearer synthetic'}},{headers:{'X-API-Key':'synthetic'}},{query:{session:'synthetic'}},{body:'{"password":"synthetic"}'}]){
  const generate=readiness=>mergeGeneratedFlow([],[],[req('a',fields)],[suggestion('a',{readiness})],'capture').nodes[0].data;
  assert.equal(generate('ready').readiness,'missing-input');
  assert.ok(generate('ready').uncertainty.includes('动态字段'));
  assert.equal(generate('manual').readiness,'manual');
  assert.equal(generate('unsupported').readiness,'unsupported');
 }
 assert.equal(mergeGeneratedFlow([],[],[req('a')],[suggestion('a',{readiness:'ready'})],'capture').nodes[0].data.readiness,'ready');
});

test('interleaved business groups use separate columns and incremental children preserve manual layout',()=>{
 const requests=[req('a1'),req('b1'),req('a2'),req('b2')];
 const suggestions=requests.map(item=>suggestion(item.id,{group:item.id.startsWith('a')?'读取订单':'下载详情'}));
 const together=mergeGeneratedFlow([],[],requests,suggestions,'capture');
 const byId=new Map(together.nodes.map(node=>[node.data.requestId,node]));
 assert.equal(byId.get('a1').position.x,byId.get('a2').position.x);
 assert.equal(byId.get('b1').position.x,byId.get('b2').position.x);
 assert.notEqual(byId.get('a1').position.x,byId.get('b1').position.x);
 assert.equal(new Set(together.nodes.map(node=>JSON.stringify(node.position))).size,4);
 const first=mergeGeneratedFlow([],[],requests,suggestions.slice(0,2),'capture');
 first.nodes[0].position={x:999,y:888};
 const appended=mergeGeneratedFlow(first.nodes,first.edges,requests,suggestions,'capture');
 assert.deepEqual(appended.nodes[0].position,{x:999,y:888});
 assert.deepEqual(appended.nodes[1].position,first.nodes[1].position);
 const newA=appended.nodes.find(node=>node.data.requestId==='a2');
 assert.equal(newA.position.x,999);
 assert.ok(newA.position.y>=888+260);
});

test('node and edge ID collisions never silently omit recognized requests or overwrite existing graph IDs',()=>{
 const requests=[req('a',{responseBody:'{"ticket":"unique-ticket"}'}),req('b',{body:'{"ticket":"unique-ticket"}'})];
 const suggestions=[suggestion('a'),suggestion('b')];
 const original=mergeGeneratedFlow([],[],requests,suggestions,'capture');
 const occupied=original.nodes.map((node,index)=>({...node,data:{kind:'input',label:`Existing ${index}`,variable:`value_${index}`}}));
 const occupiedEdge={id:original.edges[0].id,source:occupied[1].id,target:occupied[0].id};
 const regenerated=mergeGeneratedFlow(occupied,[occupiedEdge],requests,suggestions,'capture');
 assert.equal(regenerated.addedCount,2);
 assert.equal(regenerated.nodes.length,4);
 assert.equal(new Set(regenerated.nodes.map(node=>node.id)).size,4);
 assert.equal(regenerated.edges.length,2);
 assert.equal(new Set(regenerated.edges.map(edge=>edge.id)).size,2);
 assert.deepEqual(regenerated.edges[0],occupiedEdge);
});

test('exact field evidence initializes supported upstream bindings once and preserves later user edits',()=>{
 const secret='synthetic-ticket-001';
 const requests=[req('a',{responseBody:JSON.stringify({ticket:secret})}),req('b',{body:JSON.stringify({ticket:secret})})];
 const suggestions=[suggestion('a'),suggestion('b',{readiness:'ready'})];
 const generated=mergeGeneratedFlow([],[],requests,suggestions,'capture');
 const binding=generated.nodes[1].data.bindings[0];
 assert.equal(binding.mode,'upstream');assert.equal(binding.target,'body');assert.equal(binding.path,'ticket');
 assert.equal(binding.source,generated.nodes[0].id);assert.equal(binding.sourcePath,'body.ticket');
 assert.ok(!binding.evidence.includes(secret));assert.equal(generated.nodes[1].data.body,requests[1].body);
 const compiled=compileBindings(generated.nodes,generated.edges,{});
 assert.deepEqual(compiled.issues,[]);
 assert.equal(JSON.parse(compiled.nodes[1].data.body).ticket,`{{${generated.nodes[0].id}.body.ticket}}`);
 generated.nodes[1].data.bindings=[];
 const reanalyzed=mergeGeneratedFlow(generated.nodes,generated.edges,requests,suggestions,'capture');
 assert.deepEqual(reanalyzed.nodes[1].data.bindings,[],'deleted bindings stay deleted on reanalysis');
});

test('supported single query values and exact raw header values get upstream drafts',()=>{
 const secret='synthetic-csrf-001';
 const requests=[req('a',{responseBody:JSON.stringify({csrf:secret})}),req('b',{url:`https://example.test/query?csrf=${secret}`,query:{csrf:secret},headers:{'X-CSRF':secret}})];
 const generated=mergeGeneratedFlow([],[],requests,[suggestion('a'),suggestion('b')],'capture');
 const bindings=generated.nodes[1].data.bindings;
 assert.equal(bindings.length,2);
 assert.ok(bindings.some(binding=>binding.target==='query'&&binding.path==='csrf'));
 assert.ok(bindings.some(binding=>binding.target==='header'&&binding.path==='X-CSRF'));
 assert.deepEqual(compileBindings(generated.nodes,generated.edges,{}).issues,[]);
});

test('unsupported encodings, missing source nodes and unsafe numeric bodies remain pending instead of ready',()=>{
 const secret='synthetic-ticket-001';
 for(const target of [
  {headers:{Authorization:`Bearer ${secret}`}},
  {body:`ticket=${secret}`},
  {body:`{"ticket":"${secret}","large":12345678901234567890}`},
  {url:`https://example.test/query?ticket=${secret}&ticket=other`,query:{ticket:secret}},
 ]){
  const generated=mergeGeneratedFlow([],[],[req('a',{responseBody:JSON.stringify({ticket:secret})}),req('b',target)],[suggestion('a'),suggestion('b',{readiness:'ready'})],'capture');
  assert.deepEqual(generated.nodes[1].data.bindings??[],[]);
  assert.equal(generated.nodes[1].data.readiness,'missing-input');
  assert.ok(generated.pending.some(message=>message.includes('暂不能自动绑定')));
 }
 const suppressed=mergeGeneratedFlow([],[],[req('a',{responseBody:JSON.stringify({ticket:secret})}),req('b',{body:JSON.stringify({ticket:secret})})],[suggestion('a'),suggestion('b',{readiness:'ready'})],'capture',{suppressedRequestIds:new Set(['a'])});
 assert.equal(suppressed.nodes.length,1);assert.equal(suppressed.nodes[0].data.readiness,'missing-input');
 assert.deepEqual(suppressed.nodes[0].data.bindings??[],[]);
});
