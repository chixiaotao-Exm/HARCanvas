import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOverviewRequests,parseOverviewResult,OverviewInputError,OverviewResultError,OVERVIEW_REQUEST_LIMIT,OVERVIEW_REQUEST_BYTES} from '../src/overview.ts';

const request=(id='req-1',extra={})=>({id,method:'GET',url:'https://example.test/private?raw=value',domain:'example.test',path:'/private',category:'api',status:200,mimeType:'application/json',duration:1,headers:{Authorization:'keep-original-secret'},query:{raw:'original-query'},body:'original-body',responseBody:'original-response',responseHeaders:{'Set-Cookie':'original-response-cookie'},...extra});
const known=new Set(['req-1','req-2']);
const selection=()=>({summary:'主流程候选，需要进一步逐条解释。',selectedRequestIds:['req-2','req-1'],reasons:[{requestId:'req-1',reason:'目标相关的请求记录。'},{requestId:'req-2',reason:'后续结果候选。'}],warnings:[]});

test('overview directory contains only explicit metadata and preserves every original request and order',()=>{
 const input=[request('req-1',{pageId:'page-1',startedDateTime:'2026-10-23T00:00:00Z'}),request('req-2',{pageId:'page-2',startedAt:'2026-10-23T00:00:01Z',startedDateTime:'different-original-field'})],snapshot=JSON.stringify(input),directory=buildOverviewRequests(input,'还原一次业务流程');
 assert.deepEqual(directory.map(item=>item.id),input.map(item=>item.id));assert.deepEqual(Object.keys(directory[0]).sort(),['id','method','domain','path','category','status','mimeType','pageId','startedAt'].sort());
 assert.equal(directory[0].startedAt,input[0].startedDateTime);assert.equal(directory[1].startedAt,input[1].startedAt);
 assert.equal(JSON.stringify(input),snapshot);assert.ok(!JSON.stringify(directory).includes('original-'));assert.ok(!JSON.stringify(directory).includes('?raw='));
 directory[0].path='/changed-copy';assert.equal(input[0].path,'/private');
 const guarded=request();for(const key of ['url','headers','query','body','responseBody','responseHeaders'])Object.defineProperty(guarded,key,{get:()=>assert.fail(`overview read ${key}`)});assert.equal(buildOverviewRequests([guarded]).length,1);
});

test('identical URLs and paths are not deduplicated, and the count limit never silently drops entries',()=>{
 const input=Array.from({length:OVERVIEW_REQUEST_LIMIT},(_,i)=>request(`req-${i}`)),directory=buildOverviewRequests(input);
 assert.equal(directory.length,1000);assert.equal(directory.at(-1).id,'req-999');assert.ok(Buffer.byteLength(JSON.stringify({goal:'',requests:directory}))<=OVERVIEW_REQUEST_BYTES);
 assert.throws(()=>buildOverviewRequests([...input,request('last')]),error=>error instanceof OverviewInputError&&error.code==='overview_scope_limit');assert.throws(()=>buildOverviewRequests([]),error=>error.code==='overview_scope_limit');
});

test('field and goal budgets use UTF-8 bytes and fail explicitly instead of truncating identifiers or paths',()=>{
 const id='x'.repeat(128);assert.equal(buildOverviewRequests([request(id,{path:'界'.repeat(1365)})])[0].id,id);
 for(const input of [[request('x'.repeat(129))],[request('请求')],[request('req-1'),request('req-1')],[request('req-1',{path:'界'.repeat(1366)})],[request('req-1',{status:200.5})],[request('req-1',{status:-1})],[request('req-1',{domain:''})]])assert.throws(()=>buildOverviewRequests(input),OverviewInputError);
 const source=request('req-1',{path:'x'.repeat(4097)}),snapshot=JSON.stringify(source);assert.throws(()=>buildOverviewRequests([source]),/4096/);assert.equal(JSON.stringify(source),snapshot);
 assert.equal(buildOverviewRequests([request()], '目'.repeat(5333)).length,1);assert.throws(()=>buildOverviewRequests([request()], '目'.repeat(5334)),error=>error.code==='overview_goal_limit');
 for(const [key,limit]of Object.entries({method:32,domain:512,category:100,mimeType:256,pageId:200,startedAt:100}))assert.throws(()=>buildOverviewRequests([request('req-1',{[key]:'x'.repeat(limit+1)})]),OverviewInputError);
});

test('the complete metadata and goal envelope shares the Go-compatible JSON byte budget',()=>{
 const input=Array.from({length:150},(_,i)=>request(`req-${i}`,{path:'p'.repeat(4096)})),snapshot=input.map(item=>item.path.length);assert.throws(()=>buildOverviewRequests(input),error=>error.code==='overview_payload_limit');assert.deepEqual(input.map(item=>item.path.length),snapshot);
 const html=Array.from({length:24},(_,i)=>request(`req-${i}`,{path:'<'.repeat(4096)}));assert.ok(Buffer.byteLength(JSON.stringify({goal:'',requests:html.map(({id,method,domain,path,category,status,mimeType})=>({id,method,domain,path,category,status,mimeType}))}))<OVERVIEW_REQUEST_BYTES);
 assert.throws(()=>buildOverviewRequests(html),error=>error.code==='overview_payload_limit','Go escapes HTML bytes; client must catch that size before submitting');
});

test('valid known selections retain exact reasons but never return Analysis or provider extras',()=>{
 const raw={...selection(),suggestions:[{requestId:'req-1',label:'must-not-create-a-block'}],rawPayload:'private-output'},snapshot=JSON.stringify(raw),result=parseOverviewResult(raw,known);
 assert.deepEqual(result,selection());assert.deepEqual(Object.keys(result).sort(),['summary','selectedRequestIds','reasons','warnings'].sort());assert.equal(JSON.stringify(raw),snapshot);
 result.reasons[0].reason='changed-copy';assert.notEqual(result.reasons[0].reason,raw.reasons[0].reason);assert.deepEqual([...known],['req-1','req-2']);
 const empty={summary:'目录中没有足够证据识别目标主流程。',selectedRequestIds:[],reasons:[],warnings:['可指定页面和操作目标后重试。']};assert.deepEqual(parseOverviewResult(empty,known),empty);
});

test('selected IDs and reason IDs must form the exact same known unique set',()=>{
 const invalid=[{...selection(),selectedRequestIds:['unknown']},{...selection(),selectedRequestIds:['req-1','req-1']},{...selection(),selectedRequestIds:['req-1']},{...selection(),reasons:[]},{...selection(),reasons:[{requestId:'req-1',reason:'same'},{requestId:'req-1',reason:'duplicate'}]},{...selection(),reasons:[{requestId:'req-1',reason:'valid'},{requestId:'unknown',reason:'unknown'}]},{...selection(),reasons:[{requestId:'req-1',reason:'   '},{requestId:'req-2',reason:'valid'}]},{...selection(),selectedRequestIds:[],reasons:[{requestId:'req-1',reason:'not selected'}]}];
 for(const raw of invalid)assert.throws(()=>parseOverviewResult(raw,known),OverviewResultError);
 const many=Array.from({length:25},(_,i)=>`req-${i}`);assert.throws(()=>parseOverviewResult({summary:'too many',selectedRequestIds:many,reasons:many.map(requestId=>({requestId,reason:'reason'})),warnings:[]},new Set(many)),OverviewResultError);
});

test('overview output enforces finite UTF-8 text and array budgets without echoing invalid provider values',()=>{
 const source=selection(),invalid=[null,{}, {...source,summary:''},{...source,summary:'字'.repeat(667)},{...source,reasons:[{requestId:'req-1',reason:'字'.repeat(201)},{requestId:'req-2',reason:'valid'}]},{...source,warnings:Array(13).fill('warning')},{...source,warnings:['字'.repeat(334)]},{...source,warnings:'not an array'},{...source,selectedRequestIds:null},{...source,reasons:null}];
 for(const raw of invalid)assert.throws(()=>parseOverviewResult(raw,known),error=>error instanceof OverviewResultError&&error.code==='invalid_overview_result'&&!error.message.includes('not an array'));
});
