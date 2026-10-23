import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCapture,migrateLegacyCapture,withCaptureProvenance,captureProgress,allProjectNodes} from '../src/captures.ts';
const request={id:'req-1',method:'GET',url:'https://example.invalid/',domain:'example.invalid',path:'/',category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body:'',responseBody:'{}',responseHeaders:{},query:{},pageId:'page-1'};
const parsed={requests:[request],summary:{total:1,api:1,static:0,domains:['example.invalid']},warnings:[],pages:[{id:'page-1',title:'操作',startedDateTime:''}]};
test('two captures with the same recorded IDs retain separate globally unique identities',()=>{
 const a=normalizeCapture(parsed,'A','source-a'),b=normalizeCapture(parsed,'B','source-b');
 assert.notEqual(a.requests[0].id,b.requests[0].id);assert.notEqual(a.pages[0].id,b.pages[0].id);
 assert.equal(a.requests[0].originalRequestId,'req-1');assert.equal(a.requests[0].captureId,'source-a');assert.equal(a.requests[0].pageId,a.pages[0].id);assert.equal(parsed.requests[0].id,'req-1');
 assert.equal(captureProgress(a,{suggestions:[{requestId:a.requests[0].id},{requestId:b.requests[0].id}]}),1);
});
test('legacy migration preserves original IDs and supplements nested node provenance',()=>{
 const sources=migrateLegacyCapture([request],'旧项目','old-dataset');
 assert.equal(sources[0].requests[0].id,'req-1');
 const leaf={id:'leaf',type:'block',position:{x:0,y:0},data:{kind:'request',label:'请求',requestId:'req-1'}};
 const nodes=withCaptureProvenance([{id:'loop',type:'block',position:{x:0,y:0},data:{kind:'loop',label:'循环',loop:{nodes:[leaf],edges:[]}}}],sources[0].requests);
 assert.equal(nodes[0].data.loop.nodes[0].data.captureId,sources[0].id);assert.equal(allProjectNodes(nodes).length,2);assert.equal(leaf.data.captureId,undefined);
});
test('capture IDs are constrained before becoming request namespace prefixes',()=>{
 assert.throws(()=>normalizeCapture(parsed,'A','../../file'));assert.throws(()=>normalizeCapture(parsed,'A','a'.repeat(65)));
});
