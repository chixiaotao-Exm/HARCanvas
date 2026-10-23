import test from 'node:test';
import assert from 'node:assert/strict';
import {readProjectDocument,exportProjectDocument} from '../src/projectDocument.ts';
import {bindingVariable} from '../src/bindings.ts';
const node=(id,kind='request',data={})=>({id,type:'block',position:{x:0,y:0},data:{kind,label:id,...data}});
const request={id:'source-req-1',captureId:'source',originalRequestId:'req-1',method:'POST',url:'https://example.invalid/submit',domain:'example.invalid',path:'/submit',category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body:'{"email":"recorded@example.invalid"}',responseBody:'{}',responseHeaders:{},query:{}};
const source=()=>({id:'source',name:'录制A',createdAt:'2026-10-23T12:00:00Z',status:'ready',requests:[structuredClone(request)],summary:{total:1,api:1,static:0,domains:['example.invalid']},warnings:[],pages:[]});
const base=()=>({version:4,projectId:'project-test',nodes:[],edges:[],captures:[source()],resourceBindings:[],defaults:{},values:{},goal:'组合网站操作',manualSteps:'',datasetKey:'test-dataset'});
test('v4 preserves stable project identity, source provenance, resources and nested local answers',()=>{
 const p=base(),binding={id:'input-body-profile.email',name:'邮箱',target:'body',path:'profile.email',mode:'user'},key=bindingVariable('inside',binding.id);
 p.nodes=[node('proxy','proxy',{proxy:{url:'socks5://proxy.invalid:1080',rotation:'fixed'}}),node('loop','loop',{loop:{mode:'count',count:3,items:'',itemVariable:'item',indexVariable:'index',entryId:'inside',nodes:[node('inside','request',{requestId:request.id,proxyId:'proxy',bindings:[binding]})],edges:[]}})];p.values={[key]:'new@example.invalid',unrelated:'must-drop'};p.defaults={proxyId:'proxy'};p.resourceBindings=[{id:'binding-proxy',resourceId:'proxy',targetId:'inside'}];p.suppressedRequestIds=['removed-req-2'];
 const imported=readProjectDocument(p),again=readProjectDocument(exportProjectDocument(imported));
 assert.equal(again.projectId,'project-test');assert.equal(again.nodes[1].data.loop.nodes[0].data.captureId,'source');assert.equal(again.values[key],'new@example.invalid');assert.equal(again.values.unrelated,undefined);assert.deepEqual(again.defaults,{proxyId:'proxy'});assert.deepEqual(again.suppressedRequestIds,['removed-req-2']);assert.deepEqual(again.resourceBindings,p.resourceBindings);
});
test('legacy project generates an identity once and keeps original node and request IDs',()=>{
 const original={version:3,nodes:[node('old','request',{requestId:'req-1'})],edges:[],requests:[{...request,id:'req-1',captureId:undefined}],values:{},datasetKey:'legacy-test'};
 const first=readProjectDocument(original),roundtrip=readProjectDocument(exportProjectDocument(first));assert.match(first.projectId,/^[\w-]+$/);assert.equal(roundtrip.projectId,first.projectId);assert.equal(first.nodes[0].id,'old');assert.equal(first.captures[0].requests[0].id,'req-1');assert.equal(original.nodes[0].data.captureId,undefined);
});
test('ordinary export removes encoded proxy credentials from config and chat without changing source state',()=>{
 const p=base(),url='socks5://team-user:pass%40word@proxy.invalid:1080';p.nodes=[node('p','proxy',{proxy:{url,rotation:'minutes',rotationMinutes:5,sessionToken:'session-identifier'}})];p.chatMessages=[{id:'chat',role:'user',content:`接入 ${url}，密码是 pass@word`},{id:'answer',role:'assistant',content:'代理已保存',error:'pass@word',questions:[{id:'q',title:'pass@word',help:'team-user',placeholder:'session-identifier',required:true,variable:'business_input'}]}];
 const exported=exportProjectDocument(p),encoded=JSON.stringify(exported);for(const secret of ['pass%40word','pass@word','team-user','session-identifier'])assert.equal(encoded.includes(secret),false);
 assert.equal(exported.nodes[0].data.proxy.url,'socks5://proxy.invalid:1080');assert.equal(exported.nodes[0].data.proxy.credentialsMissing,true);assert.equal(p.nodes[0].data.proxy.url,url);assert.equal(p.chatMessages[0].content.includes(url),true);
 const explicit=exportProjectDocument(p,true);assert.equal(explicit.nodes[0].data.proxy.url,url);assert.equal(explicit.chatMessages[0].content,p.chatMessages[0].content);
});
test('malformed proxy links cannot leak credentials through ordinary exports',()=>{
 for(const url of ['user:bad-password@proxy.invalid:1080','socks5://user:bad password@proxy.invalid:no-port','socks5://user:secret@[broken']){
  const p=base();p.nodes=[node('p','proxy',{proxy:{url,rotation:'fixed'}})];p.chatMessages=[{id:'m',role:'user',content:`链接为 ${url}`}];const exported=exportProjectDocument(p);assert.equal(exported.nodes[0].data.proxy.url,'');assert.equal(exported.nodes[0].data.proxy.credentialsMissing,true);assert.equal(JSON.stringify(exported).includes(url),false);assert.equal(JSON.stringify(exported).includes('bad-password'),false);
 }
});
test('nested resource shapes, existing reference types and loop fields are validated before importing anything',()=>{
 const edits=[p=>{p.nodes=[node('a')];p.defaults={proxyId:'a'};},p=>{p.nodes=[node('a')];p.resourceBindings=[{id:'bad',resourceId:'a',targetId:'missing'}];},p=>p.nodes=[node('a','request',{proxyId:'bad.reference'})],p=>p.nodes=[node('p','profile',{profile:{browser:'chromium',locale:'zh-CN',timezone:'not-a-zone',viewport:{width:800,height:600}}})],p=>p.nodes=[node('p','proxy',{proxy:{url:'',rotation:'minutes',rotationMinutes:-1}})],p=>p.nodes=[node('loop','loop',{loop:{mode:'count',count:2,items:'',itemVariable:'item',indexVariable:'index',entryId:'missing',nodes:[],edges:[]}})],p=>p.nodes=[node('a'),node('a')],p=>p.captures[0].requests[0].captureId='other'];
 for(const edit of edits){const p=base();edit(p);assert.throws(()=>readProjectDocument(p));}
});
test('draft round-trip retains missing resources in defaults, nested settings and configuration relations',()=>{
 const p=base();
 p.nodes=[node('step','request',{sessionId:'deleted-session',proxyId:'deleted-proxy',profileId:'deleted-profile'}),node('session','browserSession',{session:{name:'工作会话',proxyId:'deleted-session-proxy',profileId:'deleted-session-profile',persist:true}}),node('flow','subflow',{proxyId:'deleted-flow-proxy',loop:{mode:'count',count:1,items:'',itemVariable:'item',indexVariable:'index',entryId:'inside',nodes:[node('inside','request',{sessionId:'deleted-inner-session',proxyId:'deleted-inner-proxy',profileId:'deleted-inner-profile'}),node('nested-session','browserSession',{session:{name:'内部会话',proxyId:'deleted-nested-proxy',profileId:'deleted-nested-profile',persist:false}})],edges:[]}})];
 p.defaults={sessionId:'deleted-default-session',proxyId:'deleted-default-proxy',profileId:'deleted-default-profile'};
 p.resourceBindings=[{id:'missing-source',resourceId:'deleted-resource',targetId:'step'},{id:'missing-target',resourceId:'session',targetId:'deleted-step'},{id:'missing-both',resourceId:'deleted-inner-resource',targetId:'deleted-inner-step'}];
 const original=JSON.stringify(p),reopened=readProjectDocument(exportProjectDocument(readProjectDocument(p)));
 assert.equal(JSON.stringify(p),original);assert.deepEqual(reopened.nodes,p.nodes);assert.deepEqual(reopened.defaults,p.defaults);assert.deepEqual(reopened.resourceBindings,p.resourceBindings);
});
test('deleting resource blocks after a valid import does not prevent reopening the saved draft',()=>{
 const p=base();p.nodes=[node('proxy','proxy',{proxy:{url:'socks5://proxy.invalid:1080',rotation:'fixed'}}),node('step','request',{proxyId:'proxy'})];p.defaults={proxyId:'proxy'};p.resourceBindings=[{id:'uses-proxy',resourceId:'proxy',targetId:'step'}];
 const imported=readProjectDocument(p);imported.nodes=imported.nodes.filter(node=>node.id!=='proxy');
 const reopened=readProjectDocument(exportProjectDocument(imported));assert.equal(reopened.nodes[0].data.proxyId,'proxy');assert.deepEqual(reopened.defaults,{proxyId:'proxy'});assert.deepEqual(reopened.resourceBindings,[{id:'uses-proxy',resourceId:'proxy',targetId:'step'}]);
});
test('malformed conversation objects and injected input keys never reach ChatPanel',()=>{
 const p=base();p.chatMessages=[{id:'m',role:'assistant',content:'填写',questions:[{id:'q',title:'邮箱',help:'',placeholder:'',required:'yes',variable:'mail'}]}];assert.throws(()=>readProjectDocument(p),/对话/);
 const invalid=base();invalid.values=JSON.parse('{"__proto__":"bad"}');assert.throws(()=>readProjectDocument(invalid),/填写/);
});
test('pending messages restore as cancelled and obsolete questions do not edit unrelated values',()=>{
 const p=base();p.chatMessages=[{id:'m',role:'assistant',content:'请补充',status:'pending',questions:[{id:'q',title:'旧邮箱',help:'',placeholder:'',required:true,variable:'obsolete'}]}];const result=readProjectDocument(p);assert.equal(result.chatMessages[0].status,'cancelled');assert.deepEqual(result.chatMessages[0].questions,[]);
});
test('duplicate source IDs, cross-source request aliases and malformed versions reject safely',()=>{
 const duplicate=base();duplicate.captures.push(source());assert.throws(()=>readProjectDocument(duplicate),/重复/);
 const mismatched=base();mismatched.nodes=[node('a','request',{requestId:request.id,captureId:'other'})];assert.throws(()=>readProjectDocument(mismatched),/来源/);
 const wrong=base();wrong.version='4';assert.throws(()=>readProjectDocument(wrong));
});
