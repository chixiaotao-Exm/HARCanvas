import test from 'node:test';
import assert from 'node:assert/strict';
import {configurationEdges,scopeResourceDefaults,applyScopeResources,scopeUsesFreshSession,freshScopeSessions} from '../src/resourceRelations.ts';
const node=(id,kind,data={})=>({id,type:'block',position:{x:0,y:0},data:{kind,label:id,...data}});
test('configuration lines remain derived resource relations and never mutate execution edges',()=>{
 const nodes=[node('proxy','proxy'),node('profile','profile'),node('session','browserSession',{session:{name:'账号',proxyId:'proxy',profileId:'profile'}}),node('request','request',{sessionId:'session'})];
 const result=configurationEdges(nodes,[],{});
 assert.deepEqual(result.map(edge=>[edge.source,edge.target]),[['proxy','session'],['profile','session'],['session','request']]);
 assert.ok(result.every(edge=>edge.id.startsWith('config:')&&edge.deletable===false&&edge.sourceHandle==='resource-out'&&edge.targetHandle==='resource-in'));
 assert.equal(configurationEdges([nodes[3]],[],{}).length,0);
 assert.equal(nodes[3].data.sessionId,'session');
});
test('explicit resource bindings take priority over ancestor scope defaults',()=>{
 const request=node('request','request'),loop=node('loop','loop',{loop:{nodes:[],edges:[]}});
 const resources=[node('proxy','proxy'),node('profile','profile'),node('session','browserSession')];
 const bindings=[{id:'p',resourceId:'proxy',targetId:'request'},{id:'s',resourceId:'session',targetId:'request'},{id:'f',resourceId:'profile',targetId:'loop'}];
 const compiled=applyScopeResources([request,loop],{proxyId:'ancestor-proxy',profileId:'ancestor-profile',sessionId:'ancestor-session'},bindings,resources);
 assert.equal(compiled[0].data.proxyId,undefined);assert.equal(compiled[0].data.sessionId,undefined);
 assert.equal(compiled[0].data.profileId,'ancestor-profile');assert.equal(compiled[1].data.profileId,undefined);
 assert.equal(compiled[1].data.proxyId,'ancestor-proxy');assert.equal(request.data.profileId,undefined);
});
test('running inside a fresh-session loop never reuses saved browser or HTTP state',()=>{
 const session=node('saved','browserSession',{session:{name:'保存会话',persist:true}});
 const inner=node('inner','subflow',{loop:{nodes:[session],edges:[]}}),outer=node('outer','loop',{loop:{freshSession:true,nodes:[inner],edges:[]}});
 assert.equal(scopeUsesFreshSession({nodes:[outer]},['outer','inner']),true);
 assert.equal(scopeUsesFreshSession({nodes:[outer]},[]),false);
 const snapshot=freshScopeSessions([outer],true);
 assert.equal(snapshot[0].data.loop.nodes[0].data.loop.nodes[0].data.session.persist,false);
 assert.equal(session.data.session.persist,true);
 assert.equal(freshScopeSessions([session],false)[0],session);
});
test('standalone subflow execution retains scope overrides above session settings and project defaults',()=>{
 const child=node('request','request',{proxyId:'explicit'}),inner=node('inner','subflow',{profileId:'nearest',loop:{nodes:[child],edges:[]}}),outer=node('outer','loop',{sessionId:'saved',profileId:'outer-profile',loop:{nodes:[inner],edges:[]}});
 const root={nodes:[outer,node('bound-proxy','proxy')]},defaults={profileId:'project-profile'};
 const overrides=scopeResourceDefaults(root,['outer','inner'],{},[{id:'binding',resourceId:'bound-proxy',targetId:'inner'}]);
 assert.deepEqual(overrides,{sessionId:'saved',profileId:'nearest',proxyId:'bound-proxy'});
 const compiled=applyScopeResources([child],overrides);
 assert.equal(compiled[0].data.profileId,'nearest');assert.equal(compiled[0].data.sessionId,'saved');assert.equal(compiled[0].data.proxyId,'explicit');
 assert.deepEqual(defaults,{profileId:'project-profile'});assert.equal(child.data.profileId,undefined);
});
