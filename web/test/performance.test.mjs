import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {planGraphDeletion,restoreGraphDeletion} from '../src/graph.ts';
import {applyGraphTransaction} from '../src/graphCommands.ts';
import {latestExecutionEvents,flattenRunNodes} from '../src/runHistory.ts';

function fixture(size,edgeCount){
 const nodes=Array.from({length:size},(_,index)=>({id:`node-${index}`,type:'block',position:{x:index*10,y:0},data:{kind:'output',label:`步骤 ${index}`,template:''}}));
 const edges=Array.from({length:size-1},(_,index)=>({id:`edge-${index}`,source:`node-${index}`,target:`node-${index+1}`}));
 for(let index=0;edges.length<edgeCount&&index<size-2;index++)edges.push({id:`extra-${index}`,source:`node-${index}`,target:`node-${index+2}`});
 return{nodes,edges,values:{},revision:1};
}
function sample(fn,count=30){const values=[];for(let index=0;index<count;index++){const start=performance.now();fn();values.push(performance.now()-start);}values.sort((a,b)=>a-b);return{samples:count,p50Ms:+values[Math.floor(count*.5)].toFixed(3),p95Ms:+values[Math.ceil(count*.95)-1].toFixed(3)};}

for(const [size,edgeCount]of [[200,300],[1000,1498]])test(`synthetic ${size} nodes / ${edgeCount} edges helper baseline`,t=>{
 const graph=fixture(size,edgeCount),original=JSON.stringify(graph);
 const deletion=planGraphDeletion(graph.nodes,graph.edges,'edge-3','after');
 const restored=restoreGraphDeletion(deletion.nodes,deletion.edges,{nodes:deletion.removedNodes,edges:deletion.removedEdges,nodeOrder:graph.nodes.map(node=>node.id),edgeOrder:graph.edges.map(edge=>edge.id)});
 assert.deepEqual(restored.nodes,graph.nodes);assert.deepEqual(restored.edges,graph.edges);
 const events=graph.nodes.flatMap((node,index)=>[{nodeId:node.id,executionId:`repeat:1/${node.id}`,seq:index*2+1,status:'running'},{nodeId:node.id,executionId:`repeat:1/${node.id}`,seq:index*2+2,status:'success'}]);
 const summary={nodes:size,edges:edgeCount,node:process.version,platform:process.platform,arch:process.arch,deletion:sample(()=>planGraphDeletion(graph.nodes,graph.edges,'edge-3','after')),history:sample(()=>latestExecutionEvents(events)),flatten:sample(()=>flattenRunNodes(graph.nodes))};
 const start=performance.now(),changed=applyGraphTransaction(graph,{baseRevision:1,commands:[{op:'layout'}]});summary.layoutTransactionMs=+(performance.now()-start).toFixed(3);
 assert.equal(changed.nodes.length,size);assert.equal(changed.edges.length,edgeCount);assert.equal(changed.revision,2);assert.equal(JSON.stringify(graph),original);
 t.diagnostic(JSON.stringify(summary));
});
