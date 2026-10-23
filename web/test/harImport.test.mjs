import test from 'node:test';
import assert from 'node:assert/strict';
import {importHar,discardHarImport,HAR_CHUNK_SIZE,HarImportError} from '../src/harImport.ts';
import {ApiError} from '../src/runJobs.ts';

const result={requests:[],summary:{total:0,api:0,static:0,domains:[]},warnings:[]};
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const options=(request,extra={})=>({signal:new AbortController().signal,request,sleep:async()=>{},pollMs:0,...extra});
function server(file,{put,complete,poll,readResult}={}){
 const calls=[],chunks=[];let status='uploading',received=0,created=0,parsed=0,putCount=0,pollCount=0,resultCount=0;
 const view=()=>({id:`import_${created}`,status,size:file.size,receivedBytes:received,chunkSize:HAR_CHUNK_SIZE,requestId:'safe-request-id'});
 const request=async(path,init={})=>{
  const method=init.method??'GET';calls.push({path,method,signal:init.signal});
  if(method==='POST'&&path==='/api/har/imports'){assert.deepEqual(JSON.parse(init.body),{size:file.size});created++;received=0;status='uploading';return view();}
  assert.ok(path.startsWith(`/api/har/imports/import_${created}`));
  if(method==='DELETE'){status='cancelled';return view();}
  if(method==='PUT'){
   putCount++;const offset=Number(new URL(path,'https://local.test').searchParams.get('offset'));
   assert.ok(init.body instanceof Blob);assert.equal(init.headers['Content-Type'],'application/octet-stream');
   const bytes=new Uint8Array(await init.body.arrayBuffer());
   assert.equal(bytes.length,Math.min(HAR_CHUNK_SIZE,file.size-offset));
   assert.deepEqual(bytes,new Uint8Array(await file.slice(offset,offset+bytes.length).arrayBuffer()));
   const commit=()=>{assert.equal(offset,received);received+=bytes.length;chunks.push({offset,size:bytes.length});return view();};
   return put?put({count:putCount,offset,commit,view}):commit();
  }
  if(method==='POST'&&path.endsWith('/complete')){assert.equal(received,file.size);parsed++;status='parsing';return complete?complete({count:parsed,view}):view();}
  if(path.endsWith('/result')){resultCount++;assert.equal(status,'completed');return readResult?readResult({count:resultCount,view}):result;}
  pollCount++;if(poll)return poll({count:pollCount,view,setStatus:next=>{status=next;}});if(status==='parsing')status='completed';return view();
 };
 return {request,calls,chunks,view,counts:()=>({created,parsed,putCount,pollCount,resultCount})};
}

test('uploads exact one-MiB slices, reports only confirmed bytes, then parses and reads results separately',async()=>{
 const bytes=Uint8Array.from({length:HAR_CHUNK_SIZE*2+17},(_,i)=>i%251),file=new Blob([bytes]),fixture=server(file),progress=[];
 const actual=await importHar(file,options(fixture.request,{onProgress:p=>progress.push(p)}));
 assert.deepEqual(actual,result);assert.deepEqual(fixture.chunks,[{offset:0,size:HAR_CHUNK_SIZE},{offset:HAR_CHUNK_SIZE,size:HAR_CHUNK_SIZE},{offset:HAR_CHUNK_SIZE*2,size:17}]);
 assert.deepEqual([...new Set(progress.map(p=>p.phase))],['creating','uploading','parsing','result','completed']);
 assert.deepEqual([...new Set(progress.filter(p=>p.phase==='uploading').map(p=>p.receivedBytes))],[0,HAR_CHUNK_SIZE,HAR_CHUNK_SIZE*2,file.size]);
 assert.equal(progress.at(-1).receivedBytes,file.size);assert.equal(fixture.counts().created,1);assert.equal(fixture.counts().parsed,1);
 assert.equal(fixture.calls.some(c=>c.path==='/api/har/upload'),false);
});

test('a committed chunk with a lost acknowledgement resumes from GET without uploading it again',async()=>{
 const file=new Blob([new Uint8Array(HAR_CHUNK_SIZE+5)]),fixture=server(file,{put:({count,commit})=>{const value=commit();if(count===1)throw new TypeError('network disconnected after commit');return value;}}),progress=[];
 await importHar(file,options(fixture.request,{onProgress:p=>progress.push(p)}));
 assert.equal(fixture.counts().putCount,2);assert.equal(fixture.calls.filter(c=>c.method==='GET'&&!c.path.endsWith('/result')).length,2);
 assert.deepEqual(fixture.chunks.map(c=>c.offset),[0,HAR_CHUNK_SIZE]);assert.ok(progress.some(p=>p.retryCount===1));
});

test('a server error before commit retries the same chunk only after synchronizing its offset',async()=>{
 const file=new Blob(['safe payload']),fixture=server(file,{put:({count,commit})=>{if(count===1)throw new ApiError('HTTP 502；请求编号 retry-request',502,{error:'temporary'});return commit();}});
 await importHar(file,options(fixture.request));
 assert.deepEqual(fixture.calls.slice(0,4).map(c=>[c.method,c.path]),[['POST','/api/har/imports'],['PUT','/api/har/imports/import_1/chunks?offset=0'],['GET','/api/har/imports/import_1'],['PUT','/api/har/imports/import_1/chunks?offset=0']]);
 assert.equal(fixture.counts().putCount,2);assert.equal(fixture.chunks.length,1);
});

test('400 errors preserve the server error code and request ID without automatic retry or fallback',async()=>{
 const file=new Blob(['payload']);let reject=true;const fixture=server(file,{put:({commit})=>{if(reject)throw new ApiError('分片无效（HTTP 400；请求编号 bad-chunk-request）',400,{error:'invalid',errorCode:'bad_chunk',requestId:'bad-chunk-request'});return commit();}});let failure;
 await assert.rejects(importHar(file,options(fixture.request)),error=>{failure=error;return error instanceof HarImportError&&error.status===400&&error.code==='bad_chunk'&&error.requestId==='bad-chunk-request';});
 assert.equal(fixture.calls.length,2);assert.equal(failure.view.receivedBytes,0);
 reject=false;await importHar(file,options(fixture.request,{resume:failure.view}));assert.equal(fixture.counts().created,1);assert.equal(fixture.calls[2].method,'GET');
});

test('retry budget ends after two recoveries and never blindly retries a 429 response',async()=>{
 const file=new Blob(['payload']),fixture=server(file,{put:()=>{throw new ApiError('gateway',503,{});}});
 await assert.rejects(importHar(file,options(fixture.request)),error=>error.status===503);
 assert.equal(fixture.counts().putCount,3);assert.equal(fixture.counts().pollCount,2);
 const limited=server(file,{put:()=>{throw new ApiError('limit',429,{errorCode:'import_limit'});}});
 await assert.rejects(importHar(file,options(limited.request)),error=>error.status===429&&error.code==='import_limit');assert.equal(limited.counts().putCount,1);assert.equal(limited.counts().pollCount,0);
});

test('losing complete acknowledgement queries the same import and starts parsing exactly once',async()=>{
 const file=new Blob(['payload']),fixture=server(file,{complete:()=>{throw new TypeError('lost complete response');}});
 await importHar(file,options(fixture.request));assert.equal(fixture.counts().created,1);assert.equal(fixture.counts().parsed,1);assert.equal(fixture.counts().resultCount,1);
});

test('parser failure remains a persistent structured error and never claims result completion',async()=>{
 const file=new Blob(['bad HAR']),fixture=server(file,{poll:({view,setStatus})=>{setStatus('failed');return {...view(),error:'HAR JSON 格式无效',errorCode:'invalid_har',requestId:'parse-request'};}}),phases=[];
 await assert.rejects(importHar(file,options(fixture.request,{onProgress:p=>phases.push(p.phase)})),error=>error.code==='invalid_har'&&error.requestId==='parse-request'&&error.view.status==='failed');
 assert.equal(phases.includes('completed'),false);assert.equal(fixture.counts().resultCount,0);
});

test('result failures resume the completed task without uploading or parsing again',async()=>{
 const file=new Blob(['payload']),fixture=server(file,{readResult:({count})=>{if(count===1)throw new ApiError('result offline',502,{});return result;}});let failure;
 await assert.rejects(importHar(file,options(fixture.request,{maxRetries:0})),error=>{failure=error;return error.view.status==='completed';});
 await importHar(file,options(fixture.request,{resume:failure.view}));assert.equal(fixture.counts().created,1);assert.equal(fixture.counts().parsed,1);assert.equal(fixture.counts().resultCount,2);
});

test('404 expiry clears resumable state so explicit retry creates a new task',async()=>{
 const file=new Blob(['payload']),fixture=server(file);let expired=true;
 const request=async(path,init={})=>{if(expired&&(init.method??'GET')==='GET')throw new ApiError('任务过期（HTTP 404；请求编号 expired-request）',404,{errorCode:'import_expired'});return fixture.request(path,init);};let failure;
 await assert.rejects(importHar(file,options(request)),error=>{failure=error;return error.code==='import_expired'&&error.requestId==='expired-request'&&error.view===null;});
 expired=false;await importHar(file,options(request,{resume:failure.view}));assert.equal(fixture.counts().created,2);
});

test('cancellation aborts the in-flight chunk and late success cannot publish progress',async()=>{
 const file=new Blob(['payload']),controller=new AbortController(),gate=deferred(),entered=deferred(),progress=[];let chunkSignal,deleteSignal,view={id:'cancel-test',status:'uploading',size:file.size,receivedBytes:0,chunkSize:HAR_CHUNK_SIZE};
 const request=async(path,init)=>{if(init.method==='POST')return {...view};if(init.method==='PUT'){chunkSignal=init.signal;entered.resolve();return gate.promise;}if(init.method==='DELETE'){deleteSignal=init.signal;return {...view,status:'cancelled'};}assert.fail(`unexpected ${path}`);};
 const running=importHar(file,options(request,{signal:controller.signal,onProgress:p=>progress.push(p)}));await entered.promise;controller.abort();
 await assert.rejects(running,error=>error.code==='CANCELLED');await tick();const count=progress.length;
 assert.equal(chunkSignal.aborted,true);assert.ok(deleteSignal);assert.equal(deleteSignal.aborted,false);
 gate.resolve({...view,receivedBytes:file.size});await tick();assert.equal(progress.length,count);assert.equal(progress.some(p=>p.phase==='completed'),false);
});

test('a request deadline also interrupts an incomplete JSON response body',async()=>{
 const file=new Blob(['payload']),original=globalThis.fetch;let bodySignal,errored=false;
 globalThis.fetch=async(path,init)=>{if(init.method==='POST')return new Response(JSON.stringify({id:'body-timeout',status:'uploading',size:file.size,receivedBytes:0,chunkSize:HAR_CHUNK_SIZE}));bodySignal=init.signal;return new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('{"id":'));init.signal.addEventListener('abort',()=>{errored=true;stream.error(new DOMException('aborted','AbortError'));},{once:true});}}),{headers:{'Content-Type':'application/json'}});};
 try{await assert.rejects(importHar(file,{signal:new AbortController().signal,requestTimeoutMs:15,maxRetries:0}),error=>error.code==='REQUEST_TIMEOUT'&&error.view.id==='body-timeout');assert.equal(bodySignal.aborted,true);assert.equal(errored,true);}finally{globalThis.fetch=original;}
});

test('overall parsing budget stops endless polling while keeping the same task available for retry',async()=>{
 const file=new Blob(['payload']),fixture=server(file,{poll:({view})=>view()});let time=0;
 await assert.rejects(importHar(file,options(fixture.request,{now:()=>time,sleep:async ms=>{time+=ms;},parseTimeoutMs:10,pollMs:4})),error=>error.code==='PARSE_TIMEOUT'&&error.view.status==='parsing');
 assert.equal(fixture.counts().pollCount,2);assert.equal(time,10);assert.equal(fixture.counts().parsed,1);
});

test('late create responses after cancellation are cleaned up without publishing their task',async()=>{
 const file=new Blob(['payload']),controller=new AbortController(),gate=deferred(),entered=deferred(),deletions=[],progress=[];
 const request=async(path,init)=>{if(init.method==='POST'){entered.resolve();return gate.promise;}deletions.push({path,signal:init.signal});return {};};
 const running=importHar(file,options(request,{signal:controller.signal,onProgress:p=>progress.push(p)}));await entered.promise;controller.abort();await assert.rejects(running,error=>error.code==='CANCELLED');
 gate.resolve({id:'late-create',status:'uploading',size:file.size,receivedBytes:0,chunkSize:HAR_CHUNK_SIZE});await tick();
 assert.equal(deletions.length,1);assert.equal(deletions[0].path,'/api/har/imports/late-create');assert.equal(deletions[0].signal.aborted,false);assert.deepEqual(progress.map(p=>p.phase),['creating']);
});

test('abandoning failed client state releases active tasks while retrying the same ID retains it',async()=>{
 const file=new Blob(['payload']),view={id:'retained-task',status:'parsing',size:file.size,receivedBytes:file.size,chunkSize:HAR_CHUNK_SIZE},calls=[];
 const request=async(path,init)=>{calls.push({path,method:init.method,signal:init.signal});return {...view,status:'cancelled'};};
 await discardHarImport(view,view.id,request);await discardHarImport({...view,status:'completed'},undefined,request);assert.equal(calls.length,0);
 await discardHarImport(view,undefined,request);assert.equal(calls.length,1);assert.equal(calls[0].method,'DELETE');assert.equal(calls[0].signal.aborted,false);
 await discardHarImport({...view,status:'uploading',receivedBytes:0},undefined,request);assert.equal(calls.length,2);
});

test('invalid protocol identity and already-aborted imports cannot send chunks or create fallback uploads',async()=>{
 const file=new Blob(['payload']),calls=[];
 await assert.rejects(importHar(file,options(async(path)=>{calls.push(path);return {id:'wrong/id',status:'uploading',size:file.size,receivedBytes:0,chunkSize:HAR_CHUNK_SIZE};})),error=>error.code==='INVALID_IMPORT_STATE');assert.deepEqual(calls,['/api/har/imports']);
 const controller=new AbortController();controller.abort();await assert.rejects(importHar(file,options(async()=>assert.fail('sent an aborted request'),{signal:controller.signal})),error=>error.code==='CANCELLED');
});
