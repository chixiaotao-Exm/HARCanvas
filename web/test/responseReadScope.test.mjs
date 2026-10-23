import test from 'node:test';
import assert from 'node:assert/strict';
import {createResponseReadScope} from '../src/responseReadScope.ts';
const identity=(id,url)=>JSON.stringify([id,url]);
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};

test('late full response cannot overwrite a different record or a changed full-response URL',async()=>{
 const scope=createResponseReadScope(),old=identity('request-1','/api/har/uploads/old/requests/request-1'),newURL=identity('request-1','/api/har/uploads/new/requests/request-1');
 const first=scope.begin(old),late=deferred(),commits=[];
 const finish=late.promise.then(body=>{if(first.isCurrent())commits.push(body);});
 scope.select(newURL);
 assert.equal(first.signal.aborted,true);
 const second=scope.begin(newURL);if(second.isCurrent())commits.push('new body');
 late.resolve('old body');await finish;
 assert.deepEqual(commits,['new body']);
 scope.select(identity('request-2','/api/har/uploads/new/requests/request-2'));
 assert.equal(second.signal.aborted,true);assert.equal(second.isCurrent(),false);
});

test('a second read of the same identity and component cleanup invalidate earlier callbacks',()=>{
 const scope=createResponseReadScope(),key=identity('request-1','/api/har/uploads/id/requests/request-1');
 const first=scope.begin(key),second=scope.begin(key);
 assert.equal(first.signal.aborted,true);assert.equal(first.isCurrent(),false);assert.equal(second.isCurrent(),true);
 scope.cancel();assert.equal(second.signal.aborted,true);assert.equal(second.isCurrent(),false);
 const remounted=scope.begin(key);assert.equal(remounted.isCurrent(),true);
});
