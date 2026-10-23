import test from 'node:test';
import assert from 'node:assert/strict';
import {createExpansionPracticeFlow,expansionPracticeGuide} from '../src/expansionPractice.ts';
import {allProjectNodes} from '../src/captures.ts';
import {compileProjectBindings} from '../src/subflows.ts';
import {readProjectDocument,exportProjectDocument} from '../src/projectDocument.ts';

test('expanded practice is explicitly local and includes per-round human input, branching and early exit',()=>{
 const flow=createExpansionPracticeFlow(),nodes=allProjectNodes(flow.nodes),kinds=new Set(nodes.map(node=>node.data.kind));
 assert.deepEqual([...kinds].sort(),['break','condition','input','loop','manual','output'].sort());
 assert.equal(nodes.length,new Set(nodes.map(node=>node.id)).size);
 assert.ok(!JSON.stringify(flow).includes('http'));assert.ok(!nodes.some(node=>node.data.requestId||node.data.proxy||node.data.session));
 const loop=flow.nodes.find(node=>node.data.kind==='loop');assert.equal(loop.data.loop.count,2);assert.equal(loop.data.loop.nodes.filter(node=>node.data.kind==='manual').length,1);
 const condition=loop.data.loop.nodes.find(node=>node.data.kind==='condition');assert.equal(condition.data.expected,'结束');assert.ok(loop.data.loop.edges.some(edge=>edge.source===condition.id&&edge.sourceHandle==='true'&&edge.target==='expansion-break'));
 assert.equal(expansionPracticeGuide.length,4);
});

test('practice inputs compile without missing parameters and v4 export retains nested graph and initial defaults',()=>{
 const flow=createExpansionPracticeFlow(),compiled=compileProjectBindings(flow.nodes,flow.edges,{});assert.deepEqual(compiled.issues,[]);
 const document=readProjectDocument({version:4,...flow,captures:[],values:{},resourceBindings:[],goal:'体验循环',manualSteps:'',datasetKey:'practice'}),roundtrip=readProjectDocument(exportProjectDocument(document));
 assert.equal(roundtrip.nodes.find(node=>node.id==='expansion-loop').data.loop.nodes.length,4);
 assert.equal(roundtrip.nodes.find(node=>node.id==='expansion-switch').data.value,'是');assert.equal(roundtrip.captures.length,0);
});

test('opening practice repeatedly creates independent nested graphs',()=>{
 const first=createExpansionPracticeFlow(),second=createExpansionPracticeFlow();first.nodes.find(node=>node.data.kind==='loop').data.loop.nodes[0].data.label='edited';first.edges.pop();
 assert.equal(second.nodes.find(node=>node.data.kind==='loop').data.loop.nodes[0].data.label,'填写这一轮的练习备注');assert.equal(second.edges.length,5);
});
