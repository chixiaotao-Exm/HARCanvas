import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewViaJob,analyzeViaJob,AgentJobError,AGENT_JOB_POLL_MS} from '../src/agentJobs.ts';
import {buildOverviewRequests} from '../src/overview.ts';

const config={baseUrl:'https://model.test/v1',apiKey:'never-log-overview-key',model:'model'};
const request=(id='req-1')=>({id,method:'GET',url:'https://target.test/private?value=secret',domain:'target.test',path:'/private',category:'api',status:200,mimeType:'application/json',duration:1,headers:{Authorization:'private-header'},query:{secret:'private-query'},body:'private-body',responseBody:'private-response',responseHeaders:{}});
const result={summary:'按目录找到一个主流程候选。',selectedRequestIds:['req-1'],reasons:[{requestId:'req-1',reason:'目标相关候选，需深入分析。'}],warnings:[]};
const json=(body,status=200,requestId)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...(requestId?{'x-request-id':requestId}:{})}});
const start=()=>json({id:'overview-1',mode:'overview',status:'running'},202,'overview-start');
const completed=(overview=result)=>json({id:'overview-1',mode:'overview',status:'completed',overview},200,'overview-complete');
const sleep=async()=>{};

test('overview starts once with metadata, polls the same typed job, and publishes only real safe stages',async()=>{
 const input=[request()],goal='还原操作目标',methods=[],events=[],reports=[],waits=[];let polls=0,active=0;
 const actual=await overviewViaJob(config,input,new AbortController().signal,{fetch:async(path,init)=>{assert.equal(++active,1);methods.push(init.method);assert.equal(path,init.method==='POST'?'/api/agent/jobs':'/api/agent/jobs/overview-1');await Promise.resolve();active--;if(init.method==='POST'){assert.deepEqual(JSON.parse(init.body),{mode:'overview',config,overview:{goal,requests:buildOverviewRequests(input,goal)}});assert.ok(!init.body.includes('private-body'));assert.ok(!init.body.includes('private-header'));return start();}return ++polls===1?json({id:'overview-1',mode:'overview',status:'running',progress:{stage:'reading_response',elapsedMs:1000,payloadBytes:4321,contextBytes:0,responseBytes:500,rawOutput:'private-response'}}):completed({...result,suggestions:[{label:'must not become an Analysis'}]});},sleep:async(ms)=>waits.push(ms),onEvent:e=>events.push(e),onProgress:p=>reports.push(p)},goal);
 assert.deepEqual(actual,result);assert.deepEqual(methods,['POST','GET','GET']);assert.deepEqual(waits,[AGENT_JOB_POLL_MS,AGENT_JOB_POLL_MS]);assert.deepEqual(events.map(e=>e.stage),['submitted','completed']);assert.equal(reports[0].stage,'reading_response');assert.ok(!Object.hasOwn(actual,'suggestions'));
 assert.ok(!JSON.stringify({events,reports}).includes(config.apiKey));assert.ok(!JSON.stringify({events,reports}).includes('private-response'));
});

test('an empty overview is valid and never falls back to a full detail analysis',async()=>{
 const methods=[],empty={summary:'目录不足以确定主流程，请补充操作目标。',selectedRequestIds:[],reasons:[],warnings:['没有选择任何请求。']};
 const actual=await overviewViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{methods.push(init.method);return init.method==='POST'?start():completed(empty);},sleep});
 assert.deepEqual(actual,empty);assert.deepEqual(methods,['POST','GET']);
});

test('selection identities are checked against the submitted immutable directory snapshot',async()=>{
 const input=[request()],mutableConfig={...config};let sent;
 const actual=await overviewViaJob(mutableConfig,input,new AbortController().signal,{fetch:async(_path,init)=>{if(init.method==='POST'){sent=JSON.parse(init.body);input[0].id='changed-after-post';input[0].path='/changed';mutableConfig.apiKey='changed';return start();}return completed();},sleep});
 assert.deepEqual(actual,result);assert.equal(sent.overview.requests[0].id,'req-1');assert.equal(sent.overview.requests[0].path,'/private');assert.equal(sent.config.apiKey,config.apiKey);
});

test('missing or mismatched overview modes fail explicitly and cancel a known active job without resubmitting',async()=>{
 for(const wrongAt of ['start','poll'])for(const mode of [undefined,'analysis','wrong']){
  const methods=[];await assert.rejects(overviewViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{methods.push(init.method);if(init.method==='DELETE')return json({});if(init.method==='POST')return wrongAt==='start'?json({id:'overview-1',status:'running',mode},202,'bad-mode'):start();return json({id:'overview-1',status:'completed',mode,overview:result},200,'bad-mode');},sleep}),error=>error instanceof AgentJobError&&error.requestId==='bad-mode');
  assert.deepEqual(methods,wrongAt==='start'?['POST','DELETE']:['POST','GET','DELETE']);
 }
 const methods=[];await assert.rejects(analyzeViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{methods.push(init.method);return init.method==='POST'?start():json({});},sleep}),AgentJobError);assert.deepEqual(methods,['POST','DELETE'],'detail jobs must not accept a selector identity');
});

test('detail jobs accept the backend explicit detail mode while retaining the legacy request shape',async()=>{
 const analysis={summary:'真实深入分析',suggestions:[],warnings:[]},methods=[];
 const actual=await analyzeViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{methods.push(init.method);if(init.method==='POST'){assert.equal(Object.hasOwn(JSON.parse(init.body),'mode'),false);return json({id:'detail-1',mode:'detail',status:'running'},202);}return json({id:'detail-1',mode:'detail',status:'completed',analysis});},sleep});
 assert.deepEqual(actual,analysis);assert.deepEqual(methods,['POST','GET']);
});

test('unknown, duplicate, unreasoned selections and fake Analysis completions never start detail calls',async()=>{
 for(const invalid of [undefined,{...result,selectedRequestIds:['unknown']},{...result,selectedRequestIds:['req-1','req-1']},{...result,reasons:[]},{...result,reasons:[{requestId:'req-1',reason:''}]}]){
  const methods=[];await assert.rejects(overviewViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{methods.push(init.method);return init.method==='POST'?start():completed(invalid===undefined?null:invalid);},sleep}),error=>error.code==='invalid_overview_result'&&error.requestId==='overview-complete');assert.deepEqual(methods,['POST','GET']);
 }
});

test('overview validation fails locally before any POST and reports bounded actionable errors',async()=>{
 for(const input of [[],Array.from({length:1001},(_,i)=>request(`req-${i}`)),[request('invalid/id')]]){
  const events=[];await assert.rejects(overviewViaJob(config,input,new AbortController().signal,{fetch:async()=>assert.fail('invalid metadata must not reach the network'),onEvent:e=>events.push(e)}),error=>error instanceof AgentJobError&&typeof error.code==='string'&&!error.message.includes('private-body'));assert.deepEqual(events.map(e=>e.stage),['failed']);
 }
 const controller=new AbortController();controller.abort();const events=[];await assert.rejects(overviewViaJob(config,[],controller.signal,{fetch:async()=>assert.fail('aborted overview POST'),onEvent:e=>events.push(e)}),{name:'AbortError'});assert.deepEqual(events.map(e=>e.stage),['cancelled']);
});

test('aborting overview waiting cancels only the known job using an independent signal',async()=>{
 const controller=new AbortController(),methods=[],events=[];
 await assert.rejects(overviewViaJob(config,[request()],controller.signal,{fetch:async(_path,init)=>{methods.push(init.method);if(init.method==='POST')return start();assert.equal(init.method,'DELETE');assert.notEqual(init.signal,controller.signal);assert.equal(init.signal.aborted,false);return json({id:'overview-1',mode:'overview',status:'cancelled'},200,'delete-overview');},sleep:async()=>controller.abort(),onEvent:e=>events.push(e)}),{name:'AbortError'});
 assert.deepEqual(methods,['POST','DELETE']);assert.deepEqual(events.map(e=>e.stage),['submitted','cancelled']);assert.equal(events.at(-1).requestId,'delete-overview');
});

test('cancelling from an actual stage update cannot publish a completed selector result',async()=>{
 const controller=new AbortController(),methods=[],events=[];
 await assert.rejects(overviewViaJob(config,[request()],controller.signal,{fetch:async(_path,init)=>{methods.push(init.method);if(init.method==='POST')return start();if(init.method==='DELETE')return json({});return json({id:'overview-1',mode:'overview',status:'completed',overview:result,progress:{stage:'completed',elapsedMs:1000}});},sleep,onEvent:e=>events.push(e),onProgress:()=>controller.abort()}),{name:'AbortError'});
 assert.deepEqual(methods,['POST','GET','DELETE']);assert.equal(events.some(e=>e.stage==='completed'),false);
});

test('overview provider failures and lost starts retain diagnostics without retries or fallback analysis',async()=>{
 const methods=[],events=[],reports=[];
 await assert.rejects(overviewViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{methods.push(init.method);return init.method==='POST'?start():json({id:'overview-1',mode:'overview',status:'failed',error:'等待模型服务超时',errorCode:'timeout',progress:{stage:'reading_response',elapsedMs:180000,responseBytes:300}},200,'overview-timeout');},sleep,onEvent:e=>events.push(e),onProgress:p=>reports.push(p)}),error=>error.code==='timeout'&&error.requestId==='overview-timeout'&&error.jobId==='overview-1');
 assert.deepEqual(methods,['POST','GET']);assert.equal(events.at(-1).code,'timeout');assert.equal(reports.at(-1).stage,'reading_response');
 const lost=[];await assert.rejects(overviewViaJob(config,[request()],new AbortController().signal,{fetch:async(_path,init)=>{lost.push(init.method);throw new Error('lost start');},sleep}),error=>error.jobId===undefined&&/未自动重试/.test(error.message));assert.deepEqual(lost,['POST']);
});
