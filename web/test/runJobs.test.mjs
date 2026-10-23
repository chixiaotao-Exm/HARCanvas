import test from 'node:test';
import assert from 'node:assert/strict';
import {followRunJob,cancelRunJob,postJSON,ApiError} from '../src/runJobs.ts';

const id='test-job';
const event=(seq,status='success')=>({runId:id,seq,nodeId:'request',status,time:'2026-10-23T00:00:00.000Z'});
const view=(fields={})=>({id,status:'completed',events:[],seq:0,...fields});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','X-Request-ID':'test-request'}});
async function withFetch(implementation,body){const original=globalThis.fetch;globalThis.fetch=implementation;try{return await body();}finally{globalThis.fetch=original;}}

test('runtime polling advances the same cursor without submitting another execution',async()=>{
 const calls=[],updates=[];await withFetch(async(route,init)=>{calls.push({route,method:init.method??'GET'});return response(calls.length===1?view({status:'running',seq:1,events:[event(1,'running')]}):view({seq:2,events:[event(2)]}));},async()=>{const result=await followRunJob(id,new AbortController().signal,job=>updates.push(job));assert.equal(result.status,'completed');});assert.deepEqual(calls,[{route:'/api/flow/jobs/test-job?after=0',method:'GET'},{route:'/api/flow/jobs/test-job?after=1',method:'GET'}]);assert.deepEqual(updates.map(j=>j.seq),[1,2]);
});

test('runtime protocol rejects invalid statuses, cursors, event order and manual state before updating the UI',async()=>{
 const invalid=[view({id:'wrong'}),view({status:'unknown'}),view({seq:'1'}),view({seq:-1}),view({events:null}),view({seq:2,events:[event(2),event(1)]}),view({seq:1,events:[{...event(1),runId:'wrong'}]}),view({seq:1,events:[{...event(1),time:'invalid'}]}),view({seq:1,events:[{...event(1),status:'unknown'}]}),view({status:'waiting_input'}),view({pendingInput:{nodeId:'x',variable:'x',label:'x'}}),view({result:{status:'success',steps:null}})];
 for(const value of invalid){let updates=0;await withFetch(async()=>response(value),async()=>{await assert.rejects(followRunJob(id,new AbortController().signal,()=>updates++));});assert.equal(updates,0);}
 await withFetch(async()=>response(view({seq:1})),async()=>{await assert.rejects(followRunJob(id,new AbortController().signal,()=>assert.fail('stale update'),2));});
});

test('poll failure and abort stop querying without replay or implicit cancellation',async()=>{
 let calls=0;await withFetch(async()=>{calls++;throw new Error('offline');},async()=>{await assert.rejects(followRunJob(id,new AbortController().signal,()=>{}),/offline/);});assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await withFetch(async()=>assert.fail('aborted query sent request'),async()=>{await assert.rejects(followRunJob(id,controller.signal,()=>{}));});
 const later=new AbortController();await withFetch(async()=>response(view({status:'running'})),async()=>{await assert.rejects(followRunJob(id,later.signal,()=>later.abort()));});
});

test('explicit cancellation sends one DELETE and validates its returned task identity',async()=>{
 const calls=[];await withFetch(async(route,init)=>{calls.push({route,method:init.method});assert.ok(init.signal instanceof AbortSignal);return response(view({status:'cancelled',seq:1,events:[event(1,'cancelled')]}));},async()=>{const result=await cancelRunJob(id);assert.equal(result.status,'cancelled');});assert.deepEqual(calls,[{route:'/api/flow/jobs/test-job',method:'DELETE'}]);await withFetch(async()=>response(view({id:'wrong'})),async()=>assert.rejects(cancelRunJob(id)));
});

test('execution POST errors retain structured validation and are never retried',async()=>{
 let calls=0;const validation={valid:false,issues:[{code:'source_deleted',nodeId:'request',field:'source',message:'来源已删除',suggestedAction:'重新选择'}],entryNodeIds:['request'],reachableNodeIds:['request']};await withFetch(async(_route,init)=>{calls++;assert.equal(init.method,'POST');return response(validation,400);},async()=>{await assert.rejects(postJSON('/api/flow/jobs',{nodes:[]}),error=>error instanceof ApiError&&error.status===400&&error.data.issues[0].code==='source_deleted'&&error.message.includes('test-request'));});assert.equal(calls,1);
});
