import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';

const folder=mkdtempSync(join(tmpdir(),'har-canvas-resources-')),bundlePath=join(folder,'components.cjs');
let components;
try{
 const output=buildSync({stdin:{contents:"export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';export {ReactFlowProvider} from '@xyflow/react';export {WorkspaceNode} from './WorkspaceNode.tsx';export {ResourceFieldContext,ResourceFields} from './ResourceFields.tsx';",resolveDir:fileURLToPath(new URL('../src',import.meta.url)),sourcefile:'resource-field-test-entry.tsx'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},logLevel:'silent'});
 writeFileSync(bundlePath,output.outputFiles[0].contents);components=createRequire(import.meta.url)(bundlePath);
}finally{try{unlinkSync(bundlePath);}catch{}rmdirSync(folder);}
const {createElement,renderToStaticMarkup,ReactFlowProvider,WorkspaceNode,ResourceFieldContext,ResourceFields}=components;
const node=(id,kind,label,extra={})=>({id,type:'block',position:{x:0,y:0},data:{kind,label,...extra}});
const resources=[node('proxy','proxy','美国代理'),node('profile','profile','中文测试环境'),node('session','browserSession','购物会话')];
const state=(extra={})=>({nodes:resources,disabled:false,onPatch:()=>{},onOpenSubflow:()=>{},onTestProxy:async()=>({ok:true}),...extra});
const render=(data,extra={})=>renderToStaticMarkup(createElement(ResourceFieldContext.Provider,{value:state(extra)},createElement(ResourceFields,{nodeId:'step',data,compact:true})));
const renderNode=(data)=>renderToStaticMarkup(createElement(ReactFlowProvider,null,createElement(ResourceFieldContext.Provider,{value:state()},createElement(WorkspaceNode,{id:'step',data,selected:false}))));

test('proxy block splits editable credentials and exposes click-to-select session tokens with all rotation choices',()=>{
 const html=render({kind:'proxy',label:'代理',proxy:{url:'socks5://user-region-US-sid-Example1-t-5:pass@proxy.example.invalid:3010',sessionToken:'Example1',rotation:'minutes',rotationMinutes:5}});
 assert.match(html,/aria-label="代理用户名"/);assert.match(html,/value="user-region-US-sid-Example1-t-5"/);assert.match(html,/aria-pressed="true"[^>]*>Example1/);
 for(const text of ['固定会话片段','每次运行随机','每次请求随机','每 X 分钟轮换','测试连接'])assert.ok(html.includes(text),text);
 assert.match(html,/aria-label="代理轮换分钟"/);assert.match(html,/nodrag nopan nowheel/);
});

test('request resource selectors name available blocks and distinguish a recording-isolated default',()=>{
 const html=render({kind:'request',label:'获取订单',captureId:'capture-a',sessionId:'session'});
 for(const text of ['购物会话','美国代理','中文测试环境','本录制独立会话','配置关系，不改变步骤执行顺序'])assert.ok(html.includes(text),text);
 assert.match(html,/<option value="session" selected="">购物会话/);
 const broken=render({kind:'request',label:'请求',proxyId:'deleted'});assert.ok(broken.includes('引用已失效，请重新选择'));
});

test('busy operations disable resource changes and browser actions expose only their applicable fields',()=>{
 const proxy=render({kind:'proxy',label:'代理',proxy:{url:'http://proxy.example.invalid:8080',rotation:'fixed'}},{disabled:true});
 assert.match(proxy,/<textarea[^>]+disabled=""/);assert.match(proxy,/<button[^>]+disabled=""[^>]*>[^<]*<svg/);
 const fill=render({kind:'browser',label:'填写邮箱',browserAction:'fill',selector:'#email',text:'{{email}}'});
 assert.ok(fill.includes('要填写的内容'));assert.ok(fill.includes('value="#email"'));assert.ok(!fill.includes('type="url"'));
 const read=render({kind:'browser',label:'读取结果',browserAction:'read',selector:'.status',variable:'status'});assert.ok(read.includes('保存到哪个变量'));assert.ok(!read.includes('要填写的内容'));
});

test('configuration blocks have no execution handles and loops show editable contents without fake success states',()=>{
 for(const kind of ['proxy','profile','browserSession']){const html=renderNode({kind,label:'配置'});assert.ok(!html.includes('react-flow__handle-left'),kind);assert.ok(!html.includes('react-flow__handle-right'),kind);assert.ok(html.includes('data-handleid="resource-out"'),kind);assert.ok(html.includes('data-handleid="resource-in"'),kind);}
 const html=render({kind:'loop',label:'逐条处理',loop:{mode:'count',count:3,items:'',itemVariable:'item',indexVariable:'index',nodes:[],edges:[]}});
 assert.ok(html.includes('循环次数'));assert.ok(html.includes('编辑内部 0 个步骤'));assert.ok(html.includes('框选后选择'));assert.ok(!html.includes('执行完成'));
});
