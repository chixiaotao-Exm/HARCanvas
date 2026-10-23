import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_CONTEXT_BYTES, ANALYSIS_BATCH_CONTEXT_BYTES, boundAnalysisContext, buildAnalysisContext, planAnalysisContextForBatch } from '../src/analysisContext.ts';
import { analyzeInBatches } from '../src/agentBatches.ts';

const request=(id,extra={})=>({id,method:'GET',url:`https://example.test/${id}`,domain:'example.test',path:`/${id}`,category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body:'',responseBody:'{}',responseHeaders:{},query:{},...extra});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const empty=()=>({goal:'',catalog:[],groups:[],relations:[],previous:[]});

test('large Unicode provenance is bounded as a complete JSON context without changing HAR data',()=>{
 const requests=Array.from({length:1200},(_,index)=>request(`req-${index}`,{domain:'域'.repeat(250),path:'界'.repeat(300),pageId:`page-${index}-`+'页'.repeat(1800)}));
 const context=buildAnalysisContext(requests,'目'.repeat(6000));
 assert.ok(bytes(context)<=ANALYSIS_CONTEXT_BYTES);
 assert.equal(context.truncated,true);
 assert.ok(context.catalog.length>0&&context.catalog.length<=1000);
 assert.ok(context.catalog.every(item=>item.pageId.length<=160));
 assert.equal(requests[0].path,'界'.repeat(300));
 assert.ok(requests[0].pageId.length>1800);
});

test('fresh model history shares the byte budget and preserves the newest entries',()=>{
 const dependencies=Array.from({length:1000},(_,index)=>`req-${index}-`+'x'.repeat(110));
 const previous=Array.from({length:300},(_,index)=>({requestId:`step-${index}`,label:'读'.repeat(300),dependencies}));
 const original=JSON.stringify(previous);
 const context=boundAnalysisContext({...empty(),previous});
 assert.ok(bytes(context)<=ANALYSIS_CONTEXT_BYTES);
 assert.equal(context.truncated,true);
 assert.equal(context.previous.at(-1).requestId,'step-299');
 assert.ok(context.previous.length<previous.length);
 assert.ok(context.previous.every(item=>item.dependencies.length<=64));
 assert.equal(JSON.stringify(previous),original);
});

test('context identifiers and field locations are omitted rather than rewritten',()=>{
 const long='x'.repeat(129);
 const context=boundAnalysisContext({...empty(),catalog:[{id:long,method:'GET',domain:'example.test',path:'/',category:'api'}],previous:[{requestId:'valid',label:'读取',dependencies:[long,'source']}],relations:[{sourceRequestId:'source',targetRequestId:'valid',sourcePath:'body.'+'k'.repeat(1025),targetPath:'body.id',evidence:'recorded'}]});
 assert.deepEqual(context.catalog,[]);
 assert.deepEqual(context.previous[0].dependencies,['source']);
 assert.deepEqual(context.relations,[]);
 assert.equal(context.truncated,true);
});

test('each sequential batch rebudgets accumulated history and keeps all completed suggestions',async()=>{
 const requests=Array.from({length:120},(_,index)=>request(`req-${index}-`+'x'.repeat(110)));
 const dependencies=requests.map(item=>item.id);
 const contexts=[];
 const result=await analyzeInBatches({requests,config:{baseUrl:'https://example.test/v1',apiKey:'synthetic',model:'synthetic'},signal:new AbortController().signal,
  analyzeBatch:async(_config,batch,_signal,context)=>{
   contexts.push(context);
   assert.ok(bytes(context)<=ANALYSIS_BATCH_CONTEXT_BYTES);
   return {summary:'模拟分析',suggestions:batch.map(item=>({requestId:item.id,label:'读取模拟业务状态',description:'模拟用途',category:'api',confidence:'high',variables:[],dependencies})),warnings:[]};
  },
 });
 assert.equal(result.status,'completed');
 assert.equal(result.completedRequests,requests.length);
 assert.equal(result.analysis.suggestions.length,requests.length);
 assert.equal(contexts.length,11);
 assert.ok(contexts.slice(1).every(context=>context.truncated));
 assert.ok(result.analysis.warnings.some(warning=>warning.includes('大小预算裁剪')));
 assert.equal(result.analysis.suggestions[0].dependencies.length,120,'budgeting must not rewrite model results or the canvas');
});

test('batch context keeps recorded cross-batch field evidence, both endpoints, and direct dependency identities',()=>{
 const source=request('source',{responseBody:'{"token":"recorded-unique-token-6789"}'}),prepare=request('prepare'),unrelated=Array.from({length:300},(_,i)=>request(`unrelated-${i}`)),target=request('target',{headers:{Authorization:'Bearer recorded-unique-token-6789'}}),all=[prepare,source,...unrelated,target],context=buildAnalysisContext(all,'保留用户目标'),previous=[{requestId:'source',label:'已分析的会话准备',dependencies:['prepare']}],snapshot=JSON.stringify({context,previous,target});
 const compact=planAnalysisContextForBatch(context,[target],previous),known=new Set([...compact.catalog.map(item=>item.id),...compact.previous.map(item=>item.requestId)]);
 assert.equal(compact.goal,'保留用户目标');assert.ok(bytes(compact)<=ANALYSIS_BATCH_CONTEXT_BYTES);assert.ok(bytes(compact)<bytes(context)/3);
 assert.deepEqual(compact.relations,context.relations);assert.ok(known.has('source')&&known.has('target')&&known.has('prepare'));
 assert.deepEqual(compact.previous.find(item=>item.requestId==='source').dependencies,['prepare']);
 assert.ok(compact.previous.every(item=>item.dependencies.every(id=>known.has(id))));assert.ok(compact.groups.every(group=>group.requestIds.every(id=>known.has(id))));
 assert.equal(JSON.stringify({context,previous,target}),snapshot);
});

test('current requests beyond the global catalog limit still carry their exact identities and related source',()=>{
 const source=request('source',{responseBody:'{"token":"source-output-unique-6789"}'}),rest=Array.from({length:1099},(_,i)=>request(`req-${i}`)),target=request('last',{headers:{Authorization:'Bearer source-output-unique-6789'}}),all=[source,...rest,target],context=buildAnalysisContext(all);
 assert.equal(context.catalog.some(item=>item.id==='last'),false);
 const compact=planAnalysisContextForBatch(context,[target]);
 assert.equal(compact.catalog[0].id,'last');assert.ok(compact.catalog.some(item=>item.id==='source'));
 assert.deepEqual(compact.relations,context.relations);assert.ok(bytes(compact)<=ANALYSIS_BATCH_CONTEXT_BYTES);
});

test('complete JSON budget covers Unicode goal, catalogs, relation evidence, and accumulated history without dangling references',()=>{
 const all=Array.from({length:350},(_,i)=>request(`req-${i}-`+'x'.repeat(100),{domain:'域'.repeat(200),path:'界'.repeat(200),pageId:'页'.repeat(160)})),catalog=all.map(({id,method,domain,path,category,pageId})=>({id,method,domain,path,category,pageId})),batch=all.slice(100,112),relations=Array.from({length:80},(_,i)=>({sourceRequestId:all[i].id,targetRequestId:batch[i%batch.length].id,sourcePath:'body.'+'源'.repeat(300),targetPath:'body.'+'目标'.repeat(150),evidence:'录制证据'.repeat(500)})),previous=all.slice(0,100).map(item=>({requestId:item.id,label:'分析说明'.repeat(90),dependencies:all.slice(200,290).map(r=>r.id)})),context={goal:'目'.repeat(4000),catalog,groups:[{id:'business',label:'业务分组',kind:'business',requestIds:all.map(r=>r.id)}],relations,previous:[]},snapshot=JSON.stringify({context,previous,batch});
 const compact=planAnalysisContextForBatch(context,batch,previous),known=new Set([...compact.catalog.map(item=>item.id),...compact.previous.map(item=>item.requestId)]);
 assert.ok(bytes(compact)<=ANALYSIS_BATCH_CONTEXT_BYTES);assert.equal(compact.goal,context.goal);assert.equal(compact.truncated,true);
 assert.ok(batch.every(item=>known.has(item.id)));
 assert.ok(compact.relations.every(relation=>relations.some(original=>JSON.stringify(original)===JSON.stringify(relation))&&known.has(relation.sourceRequestId)&&known.has(relation.targetRequestId)));
 assert.ok(compact.previous.every(item=>item.dependencies.every(id=>known.has(id))));assert.equal(JSON.stringify({context,previous,batch}),snapshot);
});

test('oversized field locations and unknown provenance are omitted whole, never shortened into invented relationships',()=>{
 const source=request('source'),target=request('target'),base=buildAnalysisContext([source,target]),valid={sourceRequestId:'source',targetRequestId:'target',sourcePath:'body.'+'x'.repeat(1019),targetPath:'body.token',evidence:'captured exact field match'},context={...base,relations:[valid,{...valid,sourcePath:valid.sourcePath+'overflow'},{...valid,sourceRequestId:'not-captured'}]};
 const compact=planAnalysisContextForBatch(context,[target]);assert.deepEqual(compact.relations,[valid]);assert.equal(compact.relations[0].sourcePath.length,1024);assert.equal(compact.truncated,true);
});

test('a direct link to this batch survives even when it appears after the history dependency count limit',()=>{
 const all=Array.from({length:90},(_,i)=>request(`req-${i}`)),history={requestId:'req-0',label:'已有分析',dependencies:all.slice(1).map(r=>r.id)},context=buildAnalysisContext(all),compact=planAnalysisContextForBatch(context,[all.at(-1)],[history]),source=compact.previous.find(item=>item.requestId===history.requestId);
 assert.ok(source);assert.ok(source.dependencies.includes(all.at(-1).id));assert.equal(history.dependencies.length,89);assert.equal(compact.truncated,true);assert.ok(bytes(compact)<=ANALYSIS_BATCH_CONTEXT_BYTES);
});

test('sequential calls retain an earlier recorded source when the consumer falls in a later small batch',async()=>{
 const token='captured-source-token-6789',all=Array.from({length:17},(_,i)=>request(`req-${i}`));all[0].responseBody=JSON.stringify({token});all[4].headers={Authorization:`Bearer ${token}`};const contexts=[];
 const outcome=await analyzeInBatches({requests:all,config:{baseUrl:'https://example.test/v1',apiKey:'synthetic',model:'synthetic'},signal:new AbortController().signal,analyzeBatch:async(_config,batch,_signal,context)=>{contexts.push(context);return {summary:'真实模拟返回',suggestions:batch.map(item=>({requestId:item.id,label:'按录制记录解释',description:'模拟返回的业务用途',category:'api',confidence:'high',variables:[],dependencies:[]})),warnings:[]};}});
 assert.equal(outcome.completedRequests,17);assert.equal(contexts.length,3);assert.ok(contexts[1].relations.some(relation=>relation.sourceRequestId==='req-0'&&relation.targetRequestId==='req-4'));assert.ok(contexts[1].previous.some(item=>item.requestId==='req-0'));assert.ok(contexts.every(context=>bytes(context)<=ANALYSIS_BATCH_CONTEXT_BYTES));
});
