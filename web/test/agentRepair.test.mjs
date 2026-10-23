import test from 'node:test';
import assert from 'node:assert/strict';
import {repairViaJob,AgentJobError,AGENT_JOB_POLL_MS} from '../src/agentJobs.ts';

const config={baseUrl:'https://synthetic-model.test/v1',apiKey:'synthetic-private-repair-key',model:'synthetic-repair-model'};
const input=()=>({goal:'解释待核对项，提出少量业务输入问题',nodes:[
  {id:'node-1',label:'提交资料',kind:'request',readiness:'missing-input',description:'资料提交步骤',uncertainty:'尚未验证运行',issues:['REVIEW_REQUIRED'],fields:[{id:'field-1',target:'body',path:'email',valueType:'string',existingBinding:false}],sources:[]},
  {id:'node-2',label:'网页处理步骤',kind:'request',readiness:'unsupported',description:'依赖网页能力',uncertainty:'当前HTTP执行器不支持',issues:['UNSUPPORTED_STEP'],fields:[],sources:[]},
]});
const plan=()=>({summary:'这是待用户核对的绑定草稿，未改变就绪状态或运行流程。',questions:[{id:'question-email',title:'联系邮箱',help:'答案留在本页，不回传模型。',placeholder:'输入联系邮箱',required:true}],bindings:[{nodeId:'node-1',fieldId:'field-1',mode:'user',questionId:'question-email',reason:'使用用户提供的业务资料。'}],notes:[{nodeId:'node-1',title:'核对资料来源',message:'应用后仍需核对有效性，保持待核对状态。',kind:'review'},{nodeId:'node-2',title:'需要网页能力',message:'填写输入不能自动修复浏览器状态或动态签名。',kind:'unsupported'}],warnings:[]});
const json=(body,status=200,requestId)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...(requestId?{'x-request-id':requestId}:{})}});
const start=()=>json({id:'repair-job',status:'running',mode:'repair'},202,'repair-start');
const done=()=>json({id:'repair-job',status:'completed',mode:'repair',repair:plan()},200,'repair-complete');
const immediate=async()=>{};

test('repair submits one immutable value-free catalog and validates against the submitted snapshot',async()=>{
  const mutableInput=input(),mutableConfig={...config},before=structuredClone(mutableInput),methods=[],delays=[],events=[];
  let sent;
  const result=await repairViaJob(mutableConfig,mutableInput,new AbortController().signal,{
    fetch:async(url,init)=>{
      methods.push(init.method);
      if(init.method==='POST'){
        sent=JSON.parse(init.body);
        mutableInput.goal='changed goal';mutableInput.nodes[0].fields[0].id='changed-field';mutableInput.nodes[0].readiness='unsupported';
        mutableConfig.apiKey='changed-key';mutableConfig.model='changed-model';
        return start();
      }
      assert.equal(url,'/api/agent/jobs/repair-job');
      return done();
    },sleep:async milliseconds=>delays.push(milliseconds),onEvent:event=>events.push(event),
  });
  assert.deepEqual(sent,{mode:'repair',config,repair:before});
  assert.deepEqual(result,plan());
  assert.deepEqual(methods,['POST','GET']);
  assert.deepEqual(delays,[AGENT_JOB_POLL_MS]);
  assert.deepEqual(events.map(event=>event.stage),['submitted','completed']);
  assert.ok(!JSON.stringify(events).includes(config.apiKey));
  assert.ok(!JSON.stringify(events).includes(before.goal));
});

test('repair result cannot use capabilities injected after the job was submitted',async()=>{
  const mutable=input(),methods=[];
  await assert.rejects(repairViaJob(config,mutable,new AbortController().signal,{
    fetch:async(_,init)=>{
      methods.push(init.method);
      if(init.method==='POST'){
        mutable.nodes[0].fields.push({id:'injected-field',target:'header',path:'X-Injected',valueType:'string',existingBinding:false});
        return start();
      }
      const modified=plan();modified.bindings[0].fieldId='injected-field';
      return json({id:'repair-job',status:'completed',mode:'repair',repair:modified});
    },sleep:immediate,
  }),error=>error instanceof AgentJobError);
  assert.deepEqual(methods,['POST','GET']);
});

test('repair strictly requires its mode on create and every poll',async()=>{
  for(const mode of [undefined,'','detail','overview','repair ']){
    const createMethods=[];
    await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
      fetch:async(_,init)=>{createMethods.push(init.method);return json({id:'repair-job',status:'running',mode},init.method==='POST'?202:200);},sleep:immediate,
    }),error=>error instanceof AgentJobError&&error.jobId==='repair-job');
    assert.deepEqual(createMethods,['POST','DELETE']);
    const pollMethods=[];
    await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
      fetch:async(_,init)=>{pollMethods.push(init.method);return init.method==='POST'?start():json({id:'repair-job',status:'completed',mode,repair:plan()});},sleep:immediate,
    }),error=>error instanceof AgentJobError&&error.jobId==='repair-job');
    assert.deepEqual(pollMethods,['POST','GET','DELETE']);
  }
});

test('repair rejects arbitrary patches and wrong result types without returning detail or overview data',async()=>{
  for(const body of [
    {analysis:{summary:'detail',suggestions:[],warnings:[]}},
    {overview:{summary:'overview',selectedRequestIds:[],reasons:[],warnings:[]}},
    {repair:{...plan(),readiness:'ready'}},
    {repair:{...plan(),bindings:[{...plan().bindings[0],path:'arbitrary.field'}]}},
    {repair:{...plan(),bindings:[{...plan().bindings[0],nodeId:'unknown-node'}]}},
  ]){
    const methods=[];
    await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
      fetch:async(_,init)=>{methods.push(init.method);return init.method==='POST'?start():json({id:'repair-job',status:'completed',mode:'repair',...body});},sleep:immediate,
    }),error=>error instanceof AgentJobError);
    assert.deepEqual(methods,['POST','GET']);
  }
});

test('repair cancellation during polling deletes once with an independent live signal',async()=>{
  const controller=new AbortController(),methods=[],events=[];
  await assert.rejects(repairViaJob(config,input(),controller.signal,{
    fetch:async(_,init)=>{
      methods.push(init.method);
      if(init.method==='POST')return start();
      if(init.method==='DELETE'){
        assert.notEqual(init.signal,controller.signal);assert.equal(init.signal.aborted,false);
        return json({id:'repair-job',status:'cancelled',mode:'repair'},200,'repair-delete');
      }
      return new Promise((_,reject)=>{
        init.signal.addEventListener('abort',()=>reject(new Error('synthetic network abort')),{once:true});
        queueMicrotask(()=>controller.abort());
      });
    },sleep:immediate,onEvent:event=>events.push(event),
  }),{name:'AbortError'});
  assert.deepEqual(methods,['POST','GET','DELETE']);
  assert.deepEqual(events.map(event=>event.stage),['submitted','cancelled']);
  assert.equal(events.at(-1).requestId,'repair-delete');
  controller.abort();await Promise.resolve();
  assert.equal(methods.filter(method=>method==='DELETE').length,1);
});

test('repair cancellation after a late create response still cleans the known job without resubmitting',async()=>{
  const controller=new AbortController(),methods=[];
  await assert.rejects(repairViaJob(config,input(),controller.signal,{
    fetch:async(_,init)=>{
      methods.push(init.method);
      if(init.method==='POST'){controller.abort();return start();}
      assert.equal(init.method,'DELETE');assert.equal(init.signal.aborted,false);
      return json({id:'repair-job',status:'cancelled',mode:'repair'});
    },sleep:immediate,
  }),{name:'AbortError'});
  assert.deepEqual(methods,['POST','DELETE']);
});

test('already cancelled repair never submits and server cancellation sends no redundant delete',async()=>{
  const controller=new AbortController();controller.abort();let submissions=0;
  await assert.rejects(repairViaJob(config,input(),controller.signal,{fetch:async()=>{submissions++;throw new Error('unexpected fetch');}}),{name:'AbortError'});
  assert.equal(submissions,0);
  const methods=[];
  await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
    fetch:async(_,init)=>{methods.push(init.method);return init.method==='POST'?start():json({id:'repair-job',status:'cancelled',mode:'repair'});},sleep:immediate,
  }),{name:'AbortError'});
  assert.deepEqual(methods,['POST','GET']);
});

test('repair never retries a lost POST, a failed poll, or a terminal model failure',async()=>{
  const lost=[];
  await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
    fetch:async(_,init)=>{lost.push(init.method);throw new Error('synthetic lost POST response');},sleep:immediate,
  }),error=>error instanceof AgentJobError&&error.jobId===undefined);
  assert.deepEqual(lost,['POST']);
  const polled=[];
  await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
    fetch:async(_,init)=>{polled.push(init.method);if(init.method==='POST')return start();if(init.method==='GET')throw new Error('synthetic failed poll');return json({id:'repair-job',status:'cancelled',mode:'repair'});},sleep:immediate,
  }),error=>error instanceof AgentJobError&&error.jobId==='repair-job');
  assert.deepEqual(polled,['POST','GET','DELETE']);
  const failed=[],events=[];
  await assert.rejects(repairViaJob(config,input(),new AbortController().signal,{
    fetch:async(_,init)=>{failed.push(init.method);return init.method==='POST'?start():json({id:'repair-job',status:'failed',mode:'repair',error:'模型服务暂不可用',errorCode:'provider_unavailable'});},sleep:immediate,onEvent:event=>events.push(event),
  }),error=>error instanceof AgentJobError&&error.code==='provider_unavailable');
  assert.deepEqual(failed,['POST','GET']);
  assert.deepEqual(events.map(event=>event.stage),['submitted','failed']);
});

test('repair reports actual numeric progress without exposing input or provider extras',async()=>{
  const reports=[],events=[];let polls=0;
  const result=await repairViaJob(config,input(),new AbortController().signal,{
    fetch:async(_,init)=>{
      if(init.method==='POST')return json({id:'repair-job',status:'running',mode:'repair',progress:{stage:'preparing',elapsedMs:0}},202);
      if(polls++===0)return json({id:'repair-job',status:'running',mode:'repair',progress:{stage:'reading_response',elapsedMs:1000,payloadBytes:4096,contextBytes:2048,privateKey:config.apiKey}});
      return json({id:'repair-job',status:'completed',mode:'repair',repair:plan(),progress:{stage:'completed',elapsedMs:1500,responseBytes:1024}});
    },sleep:immediate,onProgress:progress=>reports.push(progress),onEvent:event=>events.push(event),
  });
  assert.deepEqual(result,plan());
  assert.deepEqual(reports.map(progress=>progress.stage),['preparing','reading_response','completed']);
  assert.ok(reports.every(progress=>!Object.hasOwn(progress,'privateKey')));
  assert.ok(!JSON.stringify([...reports,...events]).includes(config.apiKey));
});
