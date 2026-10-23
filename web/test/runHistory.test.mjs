import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenRunNodes,latestExecutionEvents,executionScopeLabel} from '../src/runHistory.ts';
const node=(id,label,children)=>({id,type:'block',position:{x:0,y:0},data:{kind:children?'loop':'output',label,...(children?{loop:{nodes:children}}:{})}});

test('execution history keeps each iteration while merging only transitions of that instance',()=>{
 const events=[{seq:1,nodeId:'request',executionId:'repeat:1/request',status:'running'},{seq:2,nodeId:'request',executionId:'repeat:1/request',status:'success'},{seq:3,nodeId:'request',executionId:'repeat:2/request',status:'running'},{seq:4,nodeId:'request',executionId:'repeat:2/request',status:'error'}];
 assert.deepEqual(latestExecutionEvents(events).map(event=>[event.executionId,event.status]),[['repeat:1/request','success'],['repeat:2/request','error']]);
 assert.equal(latestExecutionEvents([...events,events[0]])[0].seq,2);
});
test('legacy events still merge by node without fabricating iterations',()=>{
 assert.deepEqual(latestExecutionEvents([{seq:1,nodeId:'a',status:'running'},{seq:2,nodeId:'a',status:'success'}]).map(event=>event.status),['success']);
});
test('nested names and iteration scopes stay understandable to beginners',()=>{
 const nodes=flattenRunNodes([node('outer','处理订单',[node('inner','重试查询',[node('req','查询结果')])])]);
 assert.deepEqual(nodes.map(node=>node.id),['outer','inner','req']);
 assert.equal(executionScopeLabel(['outer:2','inner:3'],nodes),'处理订单 · 第 2 轮 › 重试查询 · 第 3 轮');
 assert.equal(executionScopeLabel(undefined,nodes),'');
});
