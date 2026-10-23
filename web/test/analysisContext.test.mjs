import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_CONTEXT_BYTES, boundAnalysisContext, buildAnalysisContext } from '../src/analysisContext.ts';
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
   assert.ok(bytes(context)<=ANALYSIS_CONTEXT_BYTES);
   return {summary:'模拟分析',suggestions:batch.map(item=>({requestId:item.id,label:'读取模拟业务状态',description:'模拟用途',category:'api',confidence:'high',variables:[],dependencies})),warnings:[]};
  },
 });
 assert.equal(result.status,'completed');
 assert.equal(result.completedRequests,requests.length);
 assert.equal(result.analysis.suggestions.length,requests.length);
 assert.equal(contexts.length,3);
 assert.ok(contexts.slice(1).every(context=>context.truncated));
 assert.ok(result.analysis.warnings.some(warning=>warning.includes('大小预算裁剪')));
 assert.equal(result.analysis.suggestions[0].dependencies.length,120,'budgeting must not rewrite model results or the canvas');
});
