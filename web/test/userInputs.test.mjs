import test from 'node:test';
import assert from 'node:assert/strict';
import {userInputFields,addUserInputBindings,withUserInputBindings,projectInputValues} from '../src/userInputs.ts';
import {mergeGeneratedFlow} from '../src/generation.ts';
import {bindingVariable,compileBindings} from '../src/bindings.ts';
const data=(extra={})=>({kind:'request',label:'提交资料',readiness:'missing-input',url:'https://example.invalid/submit',headers:{'Content-Type':'application/json'},body:'{"profile":{"email":"captured@example.invalid","name":"recorded-name"}}',...extra});
const node=(extra={})=>({id:'submit',type:'block',position:{x:0,y:0},data:data(extra)});

test('business fields use canonical prompts with empty local values and preserve captured payload',()=>{
 const original=data(),result=addUserInputBindings(original,[{target:'body',path:'profile.email',name:'captured@example.invalid',placeholder:'recorded-name'},{target:'body',path:'profile.name',name:'姓名'}]);
 assert.equal(result.body,original.body);assert.equal(original.bindings,undefined);
 assert.deepEqual(result.bindings.map(b=>[b.name,b.path,b.value,b.placeholder]),[['邮箱','profile.email',undefined,'请输入邮箱'],['姓名','profile.name',undefined,'请输入姓名']]);
 assert.equal(JSON.stringify(result.bindings).includes('captured@example.invalid'),false);
 assert.deepEqual(addUserInputBindings(result),result);
});

test('field discovery excludes dynamic parents, ambiguous queries, typed values and unsupported bodies',()=>{
 const fields=userInputFields(data({url:'https://example.invalid/?email=a&email=b&login_hint=c&state=csrf',body:'{"session":{"email":"x"},"token_email":"x","email":123,"name":false,"code":"123456","address":{"city":"c"}}'}));
 assert.deepEqual(fields.map(f=>[f.target,f.path]),[['body','address.city'],['query','login_hint']]);
 assert.equal(userInputFields(data({headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'email=x'})).length,0);
 assert.equal(userInputFields(data({body:'{"email":"x","number":9007199254740993}'})).length,0);
 assert.equal(userInputFields(data({body:'{"user.email":"x","__proto__":{"email":"x"}}'})).length,0);
});

test('existing manual, upstream, fixed and whole-target bindings always take precedence',()=>{
 for(const mode of ['manual','upstream','fixed']){
  const binding={id:'custom',name:'自定义邮箱',target:'body',path:'profile.email',mode,value:'explicit'};
  const result=addUserInputBindings(data({bindings:[binding]}));
  assert.deepEqual(result.bindings[0],binding);assert.equal(result.bindings.filter(b=>b.path==='profile.email').length,1);
 }
 assert.equal(addUserInputBindings(data({bindings:[{id:'whole',name:'完整正文',target:'body',path:'',mode:'fixed'}]})).bindings.length,1);
 assert.equal(addUserInputBindings(data({body:'',url:'https://example.invalid/?email=x',bindings:[{id:'url',name:'完整地址',target:'url',path:'',mode:'fixed'}]})).bindings.length,1);
});

test('inline values compile to the actual JSON and URL fields without rewriting original node data',()=>{
 const n=node({url:'https://example.invalid/?email=old',body:'{"email":"recorded"}'});n.data=addUserInputBindings(n.data);
 const blank=compileBindings([n],[],{});assert.equal(blank.issues.filter(i=>i.code==='MISSING_INPUT').length,2);
 const values=Object.fromEntries(n.data.bindings.map(b=>[bindingVariable(n.id,b.id),'new+user@example.invalid']));
 const compiled=compileBindings([n],[],values);assert.equal(compiled.issues.length,0);
 assert.deepEqual(Object.values(compiled.inputs),['new+user@example.invalid','new+user@example.invalid']);
 assert.equal(n.data.body,'{"email":"recorded"}');assert.equal(n.data.url,'https://example.invalid/?email=old');
 assert.equal(JSON.parse(compiled.nodes[0].data.body).email,`{{${bindingVariable(n.id,n.data.bindings[0].id)}}}`);
});

test('legacy projects gain supported fields while model titles alone never invent an email location',()=>{
 const input=node(),legacy=withUserInputBindings([input]);
 assert.equal(legacy[0].data.bindings.length,2);assert.equal(legacy[0].data.readiness,'missing-input');
 const unsupported=node({readiness:'unsupported'});assert.equal(withUserInputBindings([unsupported])[0],unsupported);
 const unknown=node({body:'{"csrf":"recorded"}',label:'输入邮箱并发起身份验证'});
 assert.equal(withUserInputBindings([unknown])[0],unknown);
});

test('omitted model input decisions, protocol names and ready nodes never become required user fields',()=>{
 const protocol=data({body:'{"event":{"name":"signup"},"state":"opaque-oauth-state"}'});
 assert.equal(addUserInputBindings(protocol),protocol);
 const explicitNone=data({inputFieldsReviewed:true});assert.equal(addUserInputBindings(explicitNone),explicitNone);
 const ready=data({readiness:'ready'});assert.equal(addUserInputBindings(ready),ready);
 assert.equal(addUserInputBindings(data(),[]).bindings,undefined);
});

test('generation shows inputs while upstream field evidence retains its source binding',()=>{
 const req=(id,body,responseBody)=>({id,method:'POST',url:`https://example.invalid/${id}`,domain:'example.invalid',path:`/${id}`,category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body,responseBody,responseHeaders:{},query:{}});
 const suggestions=['a','b'].map(requestId=>({requestId,label:'填写邮箱',description:'合成提交资料步骤',category:'api',confidence:'high',dependencies:requestId==='b'?['a']:[],variables:[],inputFields:[{target:'body',path:'email',name:'邮箱'}]}));
 const result=mergeGeneratedFlow([],[],[req('a','','{"email":"distinct-recorded@example.invalid"}'),req('b','{"email":"distinct-recorded@example.invalid"}','{}')],suggestions,'demo');
 assert.equal(result.nodes[0].data.bindings,undefined);
 assert.equal(result.nodes[1].data.bindings[0].mode,'upstream');assert.equal(result.nodes[1].data.bindings.length,1);
 assert.equal(result.edges.length,1);
});

test('project answers round-trip only current input keys, including explicit empty values',()=>{
 const nodes=withUserInputBindings([node()]),key=bindingVariable('submit',nodes[0].data.bindings[0].id);
 const values=JSON.parse(`{"${key}":"","deleted-key":"old","__proto__":"ignore"}`);
 const exported=projectInputValues(nodes,values),roundTrip=JSON.parse(JSON.stringify({version:3,nodes,values:exported}));
 assert.deepEqual(Object.keys(exported),[key]);assert.equal(exported[key],'');
 assert.deepEqual({...projectInputValues(roundTrip.nodes,roundTrip.values)},{[key]:''});
 assert.equal(Object.getPrototypeOf(exported),null);
});
