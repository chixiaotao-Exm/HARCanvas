import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeHasDimensions,getNodeDimensions,adoptUserNodes} from '@xyflow/system';
import {groupDimensions,rememberGroupDimensions} from '../src/groupMeasurements.ts';

const node=(sizes,expanded)=>({id:'view-group:orders',type:'businessGroup',position:{x:0,y:0},data:{expanded},...groupDimensions(sizes,'orders',expanded)});

test('view-only group remains visible to React Flow across repeated runtime rebuilds',()=>{
 let sizes=new Map(),lookup=new Map(),parents=new Map();
 assert.equal(nodeHasDimensions(node(sizes,false)),true);
 sizes=rememberGroupDimensions(sizes,'orders',false,{width:288,height:227});
 sizes=rememberGroupDimensions(sizes,'orders',true,{width:288,height:79});
 for(let frame=0;frame<12;frame++){
  const next=node(sizes,true);adoptUserNodes([next],lookup,parents);
  assert.equal(nodeHasDimensions(lookup.get(next.id)),true);
  assert.deepEqual(getNodeDimensions(lookup.get(next.id)),{width:288,height:79});
 }
 assert.deepEqual(getNodeDimensions(node(sizes,false)),{width:288,height:227});
});

test('unchanged and invalid measurements do not trigger view state churn',()=>{
 const original=rememberGroupDimensions(new Map(),'orders',true,{width:288,height:79});
 assert.equal(rememberGroupDimensions(original,'orders',true,{width:288,height:79}),original);
 assert.equal(rememberGroupDimensions(original,'orders',true,{width:288,height:0}),original);
 assert.equal(rememberGroupDimensions(original,'orders',true,{width:NaN,height:79}),original);
 const next=rememberGroupDimensions(original,'orders',true,{width:288,height:93});
 assert.equal(next.size,original.size);assert.deepEqual(getNodeDimensions(node(original,true)),{width:288,height:79});
 assert.deepEqual(getNodeDimensions(node(next,true)),{width:288,height:93});
});
