import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProxyUrl,buildProxyUrl,usernameSegments,selectProxySessionToken,detectedSessionToken,defaultResourceData,isResourceKind,resourceSummary,currentEnvironmentProfile} from '../src/resources.ts';

test('proxy URLs split credentials and round-trip special characters without losing password content',()=>{
 const parts={protocol:'socks5',host:'proxy.example.invalid',port:'3010',username:'user-region-US-sid-Example1-t-5',password:'p@ss:/? #+百分比%'};
 const text=buildProxyUrl(parts),parsed=parseProxyUrl(text);
 assert.deepEqual(parsed.value,parts);assert.ok(!text.includes(parts.password));assert.equal(parsed.error,undefined);
 const ipv6={...parts,host:'[2001:db8::1]',username:'u:ser',password:'a:b'};
 assert.deepEqual(parseProxyUrl(buildProxyUrl(ipv6)).value,ipv6);
});

test('current browser preset copies supported environment values without inventing a browser or user agent',()=>{
 const profile=defaultResourceData('profile').profile;
 const next=currentEnvironmentProfile(profile,{locale:'en-US',timezone:'UTC',width:900,height:600});
 assert.equal(next.browser,profile.browser);assert.equal(next.userAgent,undefined);assert.equal(next.locale,'en-US');assert.equal(next.timezone,'UTC');assert.deepEqual(next.viewport,{width:900,height:600});assert.equal(profile.locale,'zh-CN');
 const limited=currentEnvironmentProfile(profile,{locale:'',timezone:'',width:10,height:99999});assert.equal(limited.locale,profile.locale);assert.deepEqual(limited.viewport,{width:320,height:4320});
});

test('proxy parser rejects website paths, unsupported schemes, malformed encodings and invalid ports',()=>{
 for(const value of ['','ftp://example.invalid:21','socks5://example.invalid:70000','http://example.invalid/path','http://example.invalid/?token=x','http://example.invalid/#fragment','socks5://%XX:pass@example.invalid:3000','socks5://u:%00@example.invalid:3000']){
  const result=parseProxyUrl(value);assert.equal(result.value,undefined,value);assert.equal(typeof result.error,'string');
 }
 assert.equal(parseProxyUrl('socks5://example.invalid').value.port,'1080');
 assert.equal(parseProxyUrl('http://example.invalid').value.port,'80');
 assert.equal(parseProxyUrl('https://example.invalid').value.port,'443');
 assert.equal(parseProxyUrl('http://example.invalid:80').value.port,'80');
});

test('session selection marks explicit sid values and rejects ambiguous replacement without interpreting vendor t fields',()=>{
 const user='sample-region-US-sid-Example1-t-5',segments=usernameSegments(user);
 assert.equal(segments.map(segment=>segment.text).join(''),user);
 assert.deepEqual(segments.filter(segment=>segment.session).map(segment=>segment.text),['Example1']);
 assert.equal(detectedSessionToken(user),'Example1');
 assert.equal(detectedSessionToken('user-t-5'),undefined);
 assert.equal(detectedSessionToken('sid-a-sid-b'),undefined);
 assert.equal(selectProxySessionToken(user,'Example1').valid,true);
 assert.equal(selectProxySessionToken('same-same','same').valid,false);
 assert.equal(selectProxySessionToken(user,'missing').valid,false);
 assert.equal(selectProxySessionToken(user,'').valid,false);
});

test('resource defaults create independent snapshots and summaries never contain credentials',()=>{
 const first=defaultResourceData('loop'),second=defaultResourceData('loop');first.loop.nodes.push({id:'inner'});
 assert.equal(second.loop.nodes.length,0);assert.equal(second.loop.count,3);
 assert.equal(defaultResourceData('profile').profile.viewport.width,1280);
 assert.equal(defaultResourceData('browserSession').session.persist,false);
 assert.equal(defaultResourceData('browser').browserAction,'navigate');
 assert.equal(isResourceKind('proxy'),true);assert.equal(isResourceKind('request'),false);
 const summary=resourceSummary({kind:'proxy',label:'代理',proxy:{url:'socks5://secret-user:secret-pass@proxy.example.invalid:3010',rotation:'fixed'}});
 assert.equal(summary,'SOCKS5 · proxy.example.invalid:3010');assert.equal(summary.includes('secret'),false);
});
