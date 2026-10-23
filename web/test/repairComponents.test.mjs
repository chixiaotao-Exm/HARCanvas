import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';

// Exercise the actual React components without a browser or a test-only UI model.
const folder=mkdtempSync(join(tmpdir(),'har-canvas-component-')),bundlePath=join(folder,'components.cjs');
let components;
try{
 const output=buildSync({stdin:{contents:"export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';export {default as RunPanel} from './RunPanel.tsx';export {default as Inspector} from './Inspector.tsx';export {default as RepairPanel} from './RepairPanel.tsx';",resolveDir:fileURLToPath(new URL('../src',import.meta.url)),sourcefile:'component-test-entry.tsx'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},logLevel:'silent'});
 writeFileSync(bundlePath,output.outputFiles[0].contents);components=createRequire(import.meta.url)(bundlePath);
}finally{try{unlinkSync(bundlePath);}catch{}rmdirSync(folder);}
const {createElement,renderToStaticMarkup,RunPanel,Inspector,RepairPanel}=components;
const render=(Component,props)=>renderToStaticMarkup(createElement(Component,props));
const noop=()=>{};
const node=(id,readiness='missing-input')=>({id,type:'block',position:{x:0,y:0},data:{kind:'request',label:`步骤 ${id}`,readiness,description:'准备业务资料',method:'POST',url:'https://example.invalid/example',body:'{"email":"recorded"}',headers:{}}});
const nodes=[node('step-1'),node('step-2','unsupported')];
const buttons=html=>[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match=>({attributes:match[1],text:match[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim()}));
const disabled=button=>/\bdisabled(?:=|\s|$)/.test(button.attributes);
const runProps=()=>({nodes,entryNodeIds:['step-1'],parameterNodeIds:['step-1','step-2'],entryId:'',onEntry:noop,values:{},onValues:noop,issues:[],checking:false,resuming:false,onRun:noop,job:null,events:[],result:null,resultLoaded:false,loadingResult:false,onLoadResult:noop,onStop:noop,onResume:noop,onLocate:noop,onReconnect:noop,disconnected:false,error:'',onRepair:noop});
const inspectorProps=selected=>({node:selected,nodes,requests:[],onChange:noop,onDelete:noop,onLoadResult:noop,loadingResult:false,focusField:'',onDraftIssue:noop,onRepair:noop});
const plan=()=>({summary:'整理本次要填写的资料与需要网页处理的步骤。',questions:[{id:'question-1',title:'本次邮箱',help:'填写这次流程使用的邮箱。',placeholder:'输入邮箱',required:true}],bindings:[{nodeId:'step-1',fieldId:'field-1',mode:'user',questionId:'question-1',reason:'本次业务输入。'}],notes:[{nodeId:'step-1',title:'核对当前会话',message:'确认资料和会话仍有效。',kind:'review'},{nodeId:'step-2',title:'仍需网页能力',message:'请先在网页中处理这个步骤。',kind:'unsupported'}],warnings:[]});
const repairProps=()=>({nodes,issues:[],goal:'',onGoal:noop,loading:false,progress:null,error:'',plan:plan(),input:{goal:'',nodes:[{id:'step-1',label:'步骤 step-1',kind:'request',readiness:'missing-input',description:'',uncertainty:'',issues:[],fields:[{id:'field-1',target:'body',path:'email',valueType:'string',existingBinding:false}],sources:[]}]},answers:{'question-1':'current@example.invalid'},onAnswers:noop,applied:false,stale:false,disabled:false,onAnalyze:noop,onStop:noop,onApply:noop,onConfirmNode:noop,onCheck:noop,onLocate:noop});

test('run preparation groups several conditions by step and keeps technical details collapsed',()=>{
 const props=runProps();props.issues=[{nodeId:'step-1',code:'MISSING_INPUT',field:'bindings.one',message:'资料待填写。'},{nodeId:'step-1',code:'REVIEW_REQUIRED',field:'readiness',message:'请核对会话。'},{nodeId:'step-2',code:'UNSUPPORTED_STEP',field:'readiness',message:'需要网页能力。'}];
 props.repair=createElement('section',{'aria-label':'inline-repair-fixture'},'修补表单在运行页内');
 const html=render(RunPanel,props);
 assert.match(html,/3 项准备条件，涉及 2 个步骤或流程位置/);
 assert.equal([...html.matchAll(/class="run-preparation-item"/g)].length,2);
 const details=[...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];assert.equal(details.length,2);assert.ok(details.every(match=>!/(?:^|\s)open(?:=|\s|$)/.test(match[1])));
 assert.ok(details.some(match=>match[2].includes('MISSING_INPUT')&&match[2].includes('REVIEW_REQUIRED')));
 assert.match(html,/修补表单在运行页内/);assert.ok(buttons(html).some(button=>button.text==='让 Agent 帮我修补'&&!disabled(button)));
});

test('active runs keep stop available and disable repair and new execution entries',()=>{
 const props=runProps();props.job={id:'run-1',status:'running',seq:0};
 const controls=buttons(render(RunPanel,props));
 assert.ok(controls.filter(button=>button.text==='让 Agent 帮我修补').every(disabled));
 assert.ok(disabled(controls.find(button=>button.text==='检查并运行')));
 assert.equal(disabled(controls.find(button=>button.text==='停止本次运行')),false);
});

test('preflight freezes the selected entry and business inputs used by the prepared execution',()=>{
 const props=runProps();props.checking=true;props.nodes=[{...nodes[0],data:{...nodes[0].data,bindings:[{id:'email',name:'本次邮箱',target:'body',path:'email',mode:'user',required:true}]}}];
 const html=render(RunPanel,props),entry=html.match(/<select\b[^>]*>/)?.[0],input=html.match(/<input\b[^>]*>/)?.[0];
 assert.ok(entry&&entry.includes('disabled=""'));assert.ok(input&&input.includes('disabled=""'));
});

test('Inspector preserves the parameter wizard but cannot directly mark unsupported steps ready',()=>{
 const html=render(Inspector,inspectorProps(nodes[1]));
 const readiness=html.match(/<input\b[^>]*data-field="readiness"[^>]*>/)?.[0];assert.ok(readiness);assert.match(readiness,/\bdisabled=""/);
 assert.match(html,/当前执行器暂不支持，不能直接标记为就绪/);assert.match(html,/高级 HTTP 设置/);assert.match(html,/业务参数/);
 assert.ok(buttons(html).some(button=>button.text==='让 Agent 帮我修补'));
 const supported=render(Inspector,inspectorProps(nodes[0])).match(/<input\b[^>]*data-field="readiness"[^>]*>/)?.[0];assert.ok(supported&&!supported.includes('disabled'));
});

test('applied answers stay consistent with runtime values and unsupported notes never offer confirmation',()=>{
 const props=repairProps();props.applied=true;
 const html=render(RepairPanel,props),answerInputs=[...html.matchAll(/<input\b[^>]*aria-describedby="[^"]+"[^>]*>/g)].map(match=>match[0]);
 assert.equal(answerInputs.length,1);assert.match(answerInputs[0],/\bdisabled=""/);assert.match(answerInputs[0],/current@example.invalid/);
 assert.match(html,/后续可在「运行准备」的业务参数中修改/);
 assert.equal(buttons(html).filter(button=>button.text==='我已核对这一步').length,1);
 const unsupportedCard=html.match(/<article class="repair-review-card unsupported">([\s\S]*?)<\/article>/)?.[1];assert.ok(unsupportedCard);assert.ok(!unsupportedCard.includes('我已核对这一步'));
 assert.ok(buttons(html).some(button=>button.text==='仅重新检查'));
});

test('stale suggestions and active runs disable applying drafts and confirming a step',()=>{
 for(const state of [{stale:true},{disabled:true}]){
  const props={...repairProps(),...state};const controls=buttons(render(RepairPanel,props));assert.ok(disabled(controls.find(button=>button.text==='填写并应用参数草稿')));
  const appliedControls=buttons(render(RepairPanel,{...props,applied:true}));assert.ok(disabled(appliedControls.find(button=>button.text==='我已核对这一步')));
 }
});

test('inherited answer keys and unknown readiness labels cannot crash an empty repair form',()=>{
 const props=repairProps();props.answers={};props.nodes=[node('step-1','constructor'),nodes[1]];props.plan.questions=[{id:'constructor',title:'资料一',help:'',placeholder:'',required:true},{id:'__proto__',title:'资料二',help:'',placeholder:'',required:true}];
 const html=render(RepairPanel,props);assert.match(html,/还需填写 2 项必填资料/);assert.match(html,/待核对/);assert.ok(!html.includes('[object Object]'));
});
