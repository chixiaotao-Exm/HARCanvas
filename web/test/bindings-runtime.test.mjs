import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileBindings,bindingVariable} from '../src/bindings.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const resultsRoot=path.join(root,'test-results');
const node=(id,kind,fields={})=>({id,type:'block',position:{x:100,y:50},data:{kind,label:id,...fields}});
const edge=(source,target,sourceHandle)=>({id:`${source}-${target}`,source,target,...(sourceHandle?{sourceHandle}:{})});
const binding=(id,fields={})=>({id,name:id,target:'body',path:id,mode:'fixed',value:'text',...fields});
const special='a"b\nline & extra=1 + plus {{literal}}';
const sourceValue='upstream "quoted"\nvalue & other=1 + plus';
const generators={uuid:()=> 'test-uuid',timestamp:()=> '2026-10-23T00:00:00.000Z',random:()=> '42'};
let temporary,child,childExit,base;

function command(executable,args){return new Promise((resolve,reject)=>{const process=spawn(executable,args,{cwd:root,windowsHide:true});let output='';for(const stream of [process.stdout,process.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-8000));process.once('error',reject);process.once('exit',code=>code===0?resolve():reject(new Error(output)));});}

const harness=String.raw`package main
import (
 "encoding/json"
 "io"
 "fmt"
 "net"
 "net/http"
 "os"
 "strings"
 "harcanvas/internal/app"
)
type transport func(*http.Request)(*http.Response,error)
func(f transport) RoundTrip(r *http.Request)(*http.Response,error){return f(r)}
func main(){
 server:=app.NewServer(os.Args[1])
 server.Runner.Client.Transport=transport(func(r *http.Request)(*http.Response,error){
  var raw []byte
  if r.Body!=nil {raw,_=io.ReadAll(r.Body)}
  var body any
  if json.Unmarshal(raw,&body)!=nil {body=string(raw)}
  value:=map[string]any{"value":"upstream \"quoted\"\nvalue & other=1 + plus","body":body,"query":r.URL.Query(),"header":r.Header.Get("X-Test"),"cookie":r.Header.Get("Cookie")}
  encoded,_:=json.Marshal(value)
  return &http.Response{StatusCode:200,Header:http.Header{"Content-Type":[]string{"application/json"},"Set-Cookie":[]string{"sid=fresh; Path=/"}},Body:io.NopCloser(strings.NewReader(string(encoded)))},nil
 })
 listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil{panic(err)}
 fmt.Printf("BINDINGS_SERVER=http://%s\n",listener.Addr())
 if err:=http.Serve(listener,server);err!=nil{panic(err)}
}`;

before(async()=>{
 await mkdir(resultsRoot,{recursive:true});temporary=await mkdtemp(path.join(resultsRoot,'bindings-runtime-'));const source=path.join(temporary,'main.go'),binary=path.join(temporary,process.platform==='win32'?'server.exe':'server');await writeFile(source,harness);await command('go',['build','-o',binary,source]);
 child=spawn(binary,[temporary],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});childExit=new Promise(resolve=>child.once('exit',resolve));base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('bindings API did not start')),10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`bindings API exited ${code}: ${output}`));});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-8000);const match=output.match(/BINDINGS_SERVER=(http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
});
after(async()=>{if(child&&child.exitCode===null){child.kill();await childExit;}if(temporary){const relative=path.relative(resultsRoot,temporary);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await rm(temporary,{recursive:true,force:true});}});

async function api(route,body,method=body===undefined?'GET':'POST'){
 const response=await fetch(base+route,{method,signal:AbortSignal.timeout(5000),...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};
}
function payload(compiled,entry){return {nodes:compiled.nodes,edges:compiled.edges,inputs:compiled.inputs,entryId:compiled.entryMap[entry]||entry};}
async function waitFor(id,status){const deadline=Date.now()+3000;while(Date.now()<deadline){const result=await api(`/api/flow/jobs/${id}`);if(result.data.status===status)return result.data;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`job did not reach ${status}`);}

test('binding identifiers remain stable, bounded and distinguish punctuation and pairs',()=>{
 assert.notEqual(bindingVariable('a-b','x'),bindingVariable('a_b','x'));
 assert.notEqual(bindingVariable('a','b_c'),bindingVariable('a_b','c'));
 assert.equal(bindingVariable('a','b'),bindingVariable('a','b'));
 const name=bindingVariable('n'.repeat(128),'b'.repeat(1000));assert.match(name,/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/);
 const ns=[node('a-b','request',{url:'https://8.8.8.8',body:'{"x":""}',bindings:[binding('x',{mode:'user',value:'first'})]}),node('a_b','request',{url:'https://8.8.8.8',body:'{"x":""}',bindings:[binding('x',{mode:'user',value:'second'})]})];
 const compiled=compileBindings(ns,[],{},generators);assert.equal(compiled.issues.length,0);assert.equal(Object.keys(compiled.inputs).length,2);assert.equal(compiled.inputs[bindingVariable('a-b','x')],'first');assert.equal(compiled.inputs[bindingVariable('a_b','x')],'second');
});

test('manual compiler inserts an ordered chain and retains condition handles without mutating the design',async()=>{
 const ns=[node('condition','condition',{variable:'choice',operator:'eq',expected:'yes'}),node('request','request',{url:'https://8.8.8.8',body:'{"one":"","two":""}',bindings:[binding('one',{mode:'manual'}),binding('two',{mode:'manual'})]})];const es=[edge('condition','request','true')],before=structuredClone({ns,es});const compiled=compileBindings(ns,es,{},generators);assert.deepEqual({ns,es},before);assert.equal(compiled.issues.length,0);
 const manuals=compiled.nodes.filter(n=>n.data.kind==='manual');assert.equal(manuals.length,2);const first=compiled.entryMap.request;assert.equal(first,manuals[0].id);assert.equal(compiled.nodeMap[manuals[0].id],'request');assert.equal(compiled.nodeMap[manuals[1].id],'request');assert.ok(compiled.edges.some(e=>e.source==='condition'&&e.target===first&&e.sourceHandle==='true'));assert.ok(compiled.edges.some(e=>e.source===manuals[0].id&&e.target===manuals[1].id));assert.ok(compiled.edges.some(e=>e.source===manuals[1].id&&e.target==='request'));assert.ok(!compiled.edges.some(e=>e.source==='condition'&&e.target==='request'));
 const checked=await api('/api/flow/validate',{...payload(compiled,'condition'),inputs:{choice:'yes'}});assert.equal(checked.data.valid,true,JSON.stringify(checked.data));
});

test('manual request entry runs both pauses in one task before submitting once',async()=>{
 const request=node('r'.repeat(128),'request',{url:'https://8.8.8.8',body:'{"one":"","two":""}',bindings:[binding('one',{mode:'manual'}),binding('two',{mode:'manual'})]});const compiled=compileBindings([request],[],{},generators),definition=payload(compiled,request.id);assert.equal(compiled.issues.length,0);
 const validation=await api('/api/flow/validate',definition);assert.equal(validation.data.valid,true,JSON.stringify(validation.data));assert.equal(validation.data.entryId,compiled.entryMap[request.id]);
 const started=await api('/api/flow/jobs',definition);assert.equal(started.status,202);const id=started.data.id;
 const first=await waitFor(id,'waiting_input');assert.equal(compiled.nodeMap[first.pendingInput.nodeId],request.id);await api(`/api/flow/jobs/${id}/resume`,{inputs:{[first.pendingInput.variable]:special}});let second;const deadline=Date.now()+3000;while(Date.now()<deadline){second=await api(`/api/flow/jobs/${id}`);if(second.data.status==='waiting_input'&&second.data.pendingInput.nodeId!==first.pendingInput.nodeId)break;await new Promise(resolve=>setTimeout(resolve,5));}assert.notEqual(second.data.pendingInput.nodeId,first.pendingInput.nodeId);await api(`/api/flow/jobs/${id}/resume`,{inputs:{[second.data.pendingInput.variable]:'second'}});await waitFor(id,'completed');const full=await api(`/api/flow/jobs/${id}/result`);assert.equal(full.data.steps.filter(s=>s.kind==='request').length,1);const observed=full.data.steps.find(s=>s.kind==='request').result.body;assert.deepEqual(observed.body,{one:special,two:'second'});
});

test('fixed literal braces and mixed JSON/query/header bindings survive actual runtime rendering',async()=>{
 const ns=[node('source','request',{url:'https://8.8.8.8/prepare'}),node('target','request',{url:'https://8.8.8.8/submit?keep=raw%2Bplus',method:'POST',body:'{"user":"","fixed":"","upstream":"","count":1,"active":false}',bindings:[binding('user',{mode:'user',value:special}),binding('fixed',{value:special}),binding('upstream',{mode:'upstream',source:'source',sourcePath:'body.value'}),binding('count',{value:'42'}),binding('active',{value:'true'}),binding('query',{target:'query',path:'query',mode:'user',value:special}),binding('query-source',{target:'query',path:'source',mode:'upstream',source:'source',sourcePath:'body.value'}),binding('header',{target:'header',path:'X-Test',value:'literal {{text}}'})]})];
 const compiled=compileBindings(ns,[edge('source','target')],{},generators);assert.equal(compiled.issues.length,0,JSON.stringify(compiled.issues));const definition=payload(compiled,'source'),validation=await api('/api/flow/validate',definition);assert.equal(validation.data.valid,true,JSON.stringify(validation.data));const result=await api('/api/flow/run',definition);assert.equal(result.data.status,'success');const observed=result.data.steps.find(s=>s.nodeId==='target').result.body;assert.deepEqual(observed.body,{user:special,fixed:special,upstream:sourceValue,count:42,active:true});assert.deepEqual(observed.query,{keep:['raw+plus'],query:[special],source:[sourceValue]});assert.equal(observed.header,'literal {{text}}');assert.match(observed.cookie,/sid=fresh/);
});

test('whole-body fixed content stays literal and dynamic numeric fields fail explicitly',async()=>{
 const raw='{"message":"literal {{unknown}}"}';const compiled=compileBindings([node('request','request',{url:'https://8.8.8.8',body:'{}',bindings:[binding('body',{path:'',value:raw})]})],[],{},generators);const result=await api('/api/flow/run',payload(compiled,'request'));assert.equal(result.data.status,'success');assert.deepEqual(result.data.steps[0].result.body.body,{message:'literal {{unknown}}'});
 for(const original of [1,true]){const nodes=[node('typed','request',{url:'https://8.8.8.8',body:JSON.stringify({field:original}),bindings:[binding('field',{mode:'user',value:'42'})]})];assert.ok(compileBindings(nodes,[],{},generators).issues.some(i=>i.code==='UNSUPPORTED_DYNAMIC_TYPE'));nodes[0].data.bindings[0].mode='fixed';nodes[0].data.bindings[0].value='"wrong type"';assert.ok(compileBindings(nodes,[],{},generators).issues.some(i=>i.code==='INVALID_BINDING_TYPE'));}
});

test('deleted sources, required values, duplicate targets and URL/query conflicts are blocking issues',()=>{
 const baseNode=node('request','request',{url:'https://8.8.8.8',body:'{"field":""}'});
 const scenarios=[
  {bindings:[binding('field',{mode:'user',value:' '})],code:'MISSING_INPUT'},
  {bindings:[binding('field',{mode:'upstream',source:'deleted',sourcePath:'body.id'})],code:'MISSING_BINDING_SOURCE'},
  {bindings:[binding('field',{mode:'runtime',generator:'unknown'})],code:'INVALID_GENERATOR'},
  {bindings:[binding('one',{path:'field'}),binding('two',{path:'field'})],code:'CONFLICTING_BINDING'},
  {bindings:[binding('all',{path:''}),binding('field')],code:'CONFLICTING_BINDING'},
  {bindings:[binding('url',{target:'url',path:'',mode:'user',value:'https://8.8.8.8'}),binding('query',{target:'query',path:'x'})],code:'CONFLICTING_BINDING'},
 ];
 for(const {bindings,code}of scenarios){const compiled=compileBindings([{...baseNode,data:{...baseNode.data,bindings}}],[],{},generators);assert.ok(compiled.issues.some(i=>i.code===code&&i.nodeId==='request'&&i.field.startsWith('bindings.')),`${code}: ${JSON.stringify(compiled.issues)}`);}
 const name=bindingVariable('request','field');assert.ok(compileBindings([{...baseNode,data:{...baseNode.data,bindings:[binding('field')]}},node('input','input',{variable:name})],[],{},generators).issues.some(i=>i.code==='BINDING_VARIABLE_COLLISION'));
 const initial=compileBindings([{...baseNode,data:{...baseNode.data,bindings:[binding('field',{mode:'manual'})]}}],[],{},generators);const manualId=Object.keys(initial.nodeMap)[0];assert.ok(compileBindings([{...baseNode,data:{...baseNode.data,bindings:[binding('field',{mode:'manual'})]}},node(manualId,'output')],[],{},generators).issues.some(i=>i.code==='MANUAL_NODE_COLLISION'));
 const unsafe=compileBindings([node('number','request',{url:'https://8.8.8.8',body:'{"field":"text","large":12345678901234567890}',bindings:[binding('field')]})],[],{},generators);assert.ok(unsafe.issues.length,'unsafe integer must not be silently rounded while writing another field');
 const prototype=compileBindings([node('__proto__','request',{url:'https://8.8.8.8',body:'{"field":""}',bindings:[binding('field',{mode:'manual'})]})],[],{},generators);assert.equal(prototype.issues.length,0);assert.equal(prototype.nodeMap[prototype.entryMap.__proto__],'__proto__');
});

test('temporary nodes are included in runtime limits and preflight issues map back to a visible step',async()=>{
 const nodes=Array.from({length:100},(_,index)=>node(`n${index}`,'output'));nodes[0]=node('n0','request',{url:'https://8.8.8.8',body:'{"field":""}',bindings:[binding('field',{mode:'manual'})]});const edges=nodes.slice(1).map((n,index)=>edge(nodes[index].id,n.id)),compiled=compileBindings(nodes,edges,{},generators);const result=await api('/api/flow/validate',payload(compiled,'n0'));assert.equal(result.data.valid,false);const issue=result.data.issues.find(i=>i.code==='run_node_count');assert.ok(issue);assert.equal(compiled.nodeMap[issue.nodeId]||issue.nodeId,'n0');
});

test('cancelling a compiled manual run is terminal and cursor polling does not replay acknowledged events',async()=>{
 const compiled=compileBindings([node('request','request',{url:'https://8.8.8.8',body:'{"field":""}',bindings:[binding('field',{mode:'manual'})]})],[],{},generators);const created=await api('/api/flow/jobs',payload(compiled,'request'));const waiting=await waitFor(created.data.id,'waiting_input');const cancelled=await api(`/api/flow/jobs/${created.data.id}`,undefined,'DELETE');assert.equal(cancelled.data.status,'cancelled');const polled=await api(`/api/flow/jobs/${created.data.id}?after=${cancelled.data.seq}`);assert.equal(polled.data.status,'cancelled');assert.deepEqual(polled.data.events,[]);assert.ok(cancelled.data.events.every((event,index,list)=>index===0||event.seq>list[index-1].seq));assert.ok(cancelled.data.events.some(e=>e.nodeId===waiting.pendingInput.nodeId&&e.status==='cancelled'));assert.equal((await api(`/api/flow/jobs/${created.data.id}/resume`,{inputs:{[waiting.pendingInput.variable]:'late'}})).status,409);
});
