import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';

const folder=mkdtempSync(join(tmpdir(),'har-canvas-inline-')),bundlePath=join(folder,'components.cjs');
let components;
try{
 const output=buildSync({stdin:{contents:"export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';export {ReactFlowProvider} from '@xyflow/react';export {WorkspaceNode} from './WorkspaceNode.tsx';export {InlineInputContext,InlineInputs,inlineInputModel} from './InlineInputs.tsx';export {bindingVariable} from './bindings.ts';",resolveDir:fileURLToPath(new URL('../src',import.meta.url)),sourcefile:'inline-input-test-entry.tsx'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},logLevel:'silent'});
 writeFileSync(bundlePath,output.outputFiles[0].contents);components=createRequire(import.meta.url)(bundlePath);
}finally{try{unlinkSync(bundlePath);}catch{}rmdirSync(folder);}
const {createElement,renderToStaticMarkup,ReactFlowProvider,WorkspaceNode,InlineInputContext,InlineInputs,inlineInputModel,bindingVariable}=components;
const binding=(id,name,mode='user',extra={})=>({id,name,target:'body',path:id,mode,...extra});
const data=(extra={})=>({kind:'request',label:'提交申请',method:'POST',url:'https://example.invalid/apply',body:'{"email":"recorded@example.invalid"}',bindings:[binding('email','本次邮箱')],readiness:'missing-input',...extra});
const state=(extra={})=>({values:{},disabled:false,onChange:()=>{},...extra});
const renderInputs=(block,context=state())=>{
 const model=inlineInputModel('step-1',block,context.values);
 return renderToStaticMarkup(createElement(InlineInputContext.Provider,{value:context},createElement(InlineInputs,{nodeId:'step-1',fields:model.fields,total:model.total})));
};
const renderNode=(block,context=state())=>renderToStaticMarkup(createElement(ReactFlowProvider,null,createElement(InlineInputContext.Provider,{value:context},createElement(WorkspaceNode,{id:'step-1',data:block,selected:false}))));

test('request blocks show named business inputs while captured values and machine bindings remain outside the form',()=>{
 const block=data({bindings:[binding('email','本次邮箱','user',{placeholder:'填写这次使用的邮箱'}),binding('token','令牌','upstream',{source:'previous',sourcePath:'token'}),binding('device','设备编号','runtime',{generator:'uuid'}),binding('code','人工验证码','manual'),binding('constant','固定参数','fixed',{value:'fixed'})]});
 const html=renderInputs(block);
 assert.match(html,/>本次邮箱<small>必填<\/small>/);assert.match(html,/placeholder="填写这次使用的邮箱"/);assert.match(html,/type="text"/);assert.match(html,/value=""/);assert.match(html,/class="node-inputs nodrag nopan nowheel"/);
 assert.equal([...html.matchAll(/<input\b/g)].length,1);assert.ok(!html.includes('recorded@example.invalid'));assert.ok(!html.includes('人工验证码'));assert.ok(!html.includes('令牌'));
});

test('inline inputs use the same binding keys and explicit values as execution without sharing similarly named node inputs',()=>{
 const variable=bindingVariable('step-1','email'),block=data(),context=state({values:{[variable]:'current@example.invalid'}});
 assert.equal(inlineInputModel('step-1',block,context.values).fields[0].key,variable);
 assert.match(renderInputs(block,context),/value="current@example.invalid"/);
 assert.ok(!renderInputs(block,context).includes('recorded@example.invalid'));
 assert.equal(inlineInputModel('step-2',block,context.values).missingRequired,1);
 assert.equal(inlineInputModel('step-1',block,context.values).missingRequired,0);
});

test('explicit user defaults remain supported and clearing a saved value overrides its default',()=>{
 const block=data({bindings:[binding('email','本次邮箱','user',{value:'explicit@example.invalid'})]}),key=bindingVariable('step-1','email');
 assert.match(renderInputs(block),/value="explicit@example.invalid"/);
 assert.match(renderInputs(block,state({values:{[key]:''}})),/value=""/);
 assert.equal(inlineInputModel('step-1',block,{[key]:''}).missingRequired,1);
});

test('active operations disable editable inline fields and optional fields are labelled honestly',()=>{
 const block=data({bindings:[binding('nickname','昵称','user',{required:false})]}),html=renderInputs(block,state({disabled:true}));
 assert.match(html,/>选填<\/small>/);assert.match(html,/<input[^>]+disabled=""/);assert.ok(!/<input[^>]+required=""/.test(html));
 assert.equal(inlineInputModel('step-1',block,{}).missingRequired,0);
});

test('filled inputs retain step review and unsupported warnings instead of marking a request ready',()=>{
 const block=data(),context=state({values:{[bindingVariable('step-1','email')]:'current@example.invalid'}});
 assert.match(renderNode(block),/还需填写 1 项/);
 const filled=renderNode(block,context);assert.match(filled,/输入已准备，仍需核对步骤/);assert.ok(!filled.includes('需要补充输入'));
 assert.match(renderNode({...block,readiness:'unsupported'},context),/暂不支持/);
 assert.match(renderNode({...block,readiness:'manual'},context),/需要人工处理/);
});

test('only filled request steps needing review offer explicit readiness confirmation and freeze it during operations',()=>{
 const block=data(),context=state({values:{[bindingVariable('step-1','email')]:'current@example.invalid'},onConfirm:()=>{}}),label='已核对其余参数，标记就绪';
 const button=renderNode(block,context).match(new RegExp(`<button\\b([^>]*)>${label}<\\/button>`));
 assert.ok(button);assert.match(button[1],/node-confirm-inputs nodrag nopan/);assert.ok(!button[1].includes('disabled'));
 const frozen=renderNode(block,{...context,disabled:true}).match(new RegExp(`<button\\b([^>]*)>${label}<\\/button>`));assert.ok(frozen);assert.match(frozen[1],/disabled=""/);
 assert.ok(!renderNode(block,{...context,values:{}}).includes(label));
 assert.ok(!renderNode({...block,bindings:[]},context).includes(label));
 assert.ok(!renderNode({...block,kind:'input',variable:'email'},context).includes(label));
 for(const readiness of ['manual','unsupported','ready'])assert.ok(!renderNode({...block,readiness},context).includes(label));
});

test('a large imported binding list renders at most sixteen inputs without hiding missing required counts',()=>{
 const bindings=Array.from({length:18},(_,index)=>binding(`field-${index}`,`资料 ${index+1}`));
 const block=data({bindings}),context=state({onConfigure:()=>{}}),model=inlineInputModel('step-1',block,{}),html=renderInputs(block,context);
 assert.equal(model.total,18);assert.equal(model.fields.length,16);assert.equal(model.missingRequired,18);
 assert.equal([...html.matchAll(/<input\b/g)].length,16);assert.match(html,/还有 2 项参数/);assert.match(html,/打开步骤设置/);
});

test('input blocks use their declared runtime variable and inherited values cannot fill a field',()=>{
 const block={kind:'input',label:'收件邮箱',variable:'email'},context=state({values:Object.create({email:'inherited@example.invalid'})});
 assert.match(renderInputs(block,context),/value=""/);assert.equal(inlineInputModel('step-1',block,context.values).fields[0].key,'email');
 assert.match(renderInputs(block,state({values:{email:'direct@example.invalid'}})),/value="direct@example.invalid"/);
});
