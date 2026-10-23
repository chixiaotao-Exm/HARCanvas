import test from 'node:test';
import assert from 'node:assert/strict';
import {planGraphDeletion,restoreGraphDeletion,clampMenuPosition} from '../src/graph.ts';
const nodes=(...ids)=>ids.map(id=>({id}));
const edges=(...pairs)=>pairs.map(([source,target],index)=>({id:`e${index}`,source,target}));
const ids=items=>items.map(item=>item.id).sort();
test('deleting only the clicked edge preserves nodes and parallel connections',()=>{
 const ns=nodes('a','b');const es=edges(['a','b'],['a','b']);const plan=planGraphDeletion(ns,es,'e0','edge');
 assert.deepEqual(plan.nodes,ns);assert.deepEqual(ids(plan.edges),['e1']);assert.equal(plan.removedNodes.length,0);assert.equal(es.length,2);
});
test('before removes source and ancestors, retaining target, downstream and unrelated nodes',()=>{
 const ns=nodes('a','b','c','d','x');const es=edges(['a','b'],['b','c'],['c','d']);const p=planGraphDeletion(ns,es,'e1','before');
 assert.deepEqual(ids(p.removedNodes),['a','b']);assert.deepEqual(ids(p.nodes),['c','d','x']);assert.deepEqual(ids(p.edges),['e2']);assert.equal(p.protectedNodeId,'c');
});
test('after removes target and descendants while retaining source and ancestors',()=>{
 const p=planGraphDeletion(nodes('a','b','c','d','x'),edges(['a','b'],['b','c'],['c','d']),'e1','after');
 assert.deepEqual(ids(p.removedNodes),['c','d']);assert.deepEqual(ids(p.nodes),['a','b','x']);assert.deepEqual(ids(p.edges),['e0']);
});
test('all upstream parents are removed; shared sibling branch stays but loses its link',()=>{
 const p=planGraphDeletion(nodes('root','left','right','merge','target','sibling'),edges(['root','left'],['root','right'],['left','merge'],['right','merge'],['merge','target'],['root','sibling']),'e4','before');
 assert.deepEqual(ids(p.removedNodes),['left','merge','right','root']);assert.deepEqual(ids(p.nodes),['sibling','target']);assert.equal(p.edges.length,0);assert.equal(p.removedEdges.length,6);
});
test('downstream shared merge is removed but its other upstream node is retained',()=>{
 const p=planGraphDeletion(nodes('source','target','merge','other','disconnected'),edges(['source','target'],['target','merge'],['other','merge']),'e0','after');
 assert.deepEqual(ids(p.nodes),['disconnected','other','source']);assert.deepEqual(ids(p.removedNodes),['merge','target']);assert.equal(p.edges.length,0);
});
test('upstream cycle cannot cross the retained target to delete ancestors beyond it',()=>{
 const p=planGraphDeletion(nodes('a','b','c','d','e'),edges(['a','b'],['b','c'],['c','a'],['d','b'],['e','d']),'e0','before');
 assert.deepEqual(ids(p.removedNodes),['a','c']);assert.deepEqual(ids(p.nodes),['b','d','e']);assert.deepEqual(ids(p.edges),['e3','e4']);
});
test('downstream cycle cannot cross retained source or follow its other branches',()=>{
 const p=planGraphDeletion(nodes('a','b','c','x'),edges(['a','b'],['b','c'],['c','a'],['a','x']),'e0','after');
 assert.deepEqual(ids(p.removedNodes),['b','c']);assert.deepEqual(ids(p.nodes),['a','x']);assert.deepEqual(ids(p.edges),['e3']);
});
test('self-loop keeps its protected endpoint and removes only the loop',()=>{
 for(const kind of ['before','after']){const p=planGraphDeletion(nodes('a','x'),edges(['a','a'],['a','x']),'e0',kind);assert.equal(p.removedNodes.length,0);assert.deepEqual(ids(p.edges),['e1']);}
});
test('missing edge is a no-op and traversal ignores nonexistent endpoints',()=>{
 const ns=nodes('a','b');const es=edges(['a','b'],['ghost','a']);assert.deepEqual(planGraphDeletion(ns,es,'missing','before').edges,es);
 assert.deepEqual(ids(planGraphDeletion(ns,es,'e0','before').removedNodes),['a']);
});
test('iterative traversal handles a long graph without recursion overflow',()=>{
 const ns=Array.from({length:15000},(_,i)=>({id:String(i)}));const es=ns.slice(1).map((n,i)=>({id:`e${i}`,source:String(i),target:n.id}));
 const p=planGraphDeletion(ns,es,'e14998','before');assert.equal(p.removedNodes.length,14999);assert.deepEqual(ids(p.nodes),['14999']);
});
test('undo restores deletion while preserving subsequent additions, edits and existing IDs',()=>{
 const ns=[{id:'a',label:'old'},{id:'b',label:'B'}];const es=edges(['a','b']);const p=planGraphDeletion(ns,es,'e0','before');
 const result=restoreGraphDeletion([{id:'b',label:'edited'},{id:'new',label:'new'}],[],{nodes:p.removedNodes,edges:p.removedEdges});
 assert.deepEqual(ids(result.nodes),['a','b','new']);assert.equal(result.nodes.find(n=>n.id==='b').label,'edited');assert.equal(result.edges.length,1);
 const reused=restoreGraphDeletion([{id:'a',label:'replacement'},{id:'b'}],[{id:'e0',source:'b',target:'a'}],{nodes:p.removedNodes,edges:p.removedEdges});
 assert.equal(reused.nodes.find(n=>n.id==='a').label,'replacement');assert.equal(reused.edges[0].source,'b');assert.equal(reused.edges.length,1);
});
test('undo never adds dangling connections when an endpoint remains absent',()=>{
 const result=restoreGraphDeletion([],[],{nodes:[{id:'a'}],edges:[{id:'ab',source:'a',target:'b'}]});assert.equal(result.edges.length,0);
});
test('undo preserves original execution order for nodes and edges without overwriting later edits',()=>{
 const ns=[{id:'a',template:'first'},{id:'b',template:'last'}];
 const es=[{id:'first',source:'a',target:'b',sourceHandle:'true'},{id:'second',source:'a',target:'b',sourceHandle:'false'}];
 const restored=restoreGraphDeletion([{id:'b',template:'edited-last'},{id:'new',template:'new'}],[es[1],{id:'new-edge',source:'b',target:'new'}],{nodes:[ns[0]],edges:[es[0]],nodeOrder:ns.map(n=>n.id),edgeOrder:es.map(e=>e.id)});
 assert.deepEqual(restored.nodes.map(n=>n.id),['a','b','new']);
 assert.deepEqual(restored.edges.map(e=>e.id),['first','second','new-edge']);
 assert.equal(restored.nodes.find(n=>n.id==='b').template,'edited-last');
 assert.equal(restored.nodes.filter(n=>n.id!=='new').at(-1).template,'edited-last');
});
test('undo preserves reconnected edges without creating duplicate connections, respecting branch handles',()=>{
 const ns=nodes('a','b');
 const existing=[{id:'new-id',source:'a',target:'b',sourceHandle:null},{id:'new-true',source:'a',target:'b',sourceHandle:'true'}];
 const restored=restoreGraphDeletion(ns,existing,{nodes:[],edges:[{id:'old-id',source:'a',target:'b'},{id:'old-true',source:'a',target:'b',sourceHandle:'true'},{id:'old-false',source:'a',target:'b',sourceHandle:'false'}]});
 assert.deepEqual(restored.edges.map(e=>e.id),['new-id','new-true','old-false']);
});
test('menu position stays inside viewport on bottom/right and top/left',()=>{
 assert.deepEqual(clampMenuPosition({x:990,y:690},{width:280,height:360},{width:1000,height:700}),{x:712,y:332});
 assert.deepEqual(clampMenuPosition({x:-20,y:-50},{width:280,height:360},{width:1000,height:700}),{x:8,y:8});
 assert.deepEqual(clampMenuPosition({x:20,y:20},{width:280,height:360},{width:200,height:300}),{x:8,y:8});
});
