import test from 'node:test';
import assert from 'node:assert/strict';
import {reachable} from '../src/reachability.ts';
const node=(id,kind='request',data={})=>({id,type:'block',position:{x:0,y:0},data:{kind,label:id,...data}});
test('execution scope excludes resource cards and includes reachable nested members',()=>{
 const nodes=[node('proxy','proxy'),node('a'),node('loop','loop',{loop:{nodes:[node('x'),node('y')],edges:[{source:'x',target:'y'}]}}),node('z')];
 const scope=reachable(nodes,[{source:'a',target:'loop'},{source:'loop',target:'z'}],'');
 assert.deepEqual(scope.roots,['a']);assert.equal(scope.start,'a');assert.deepEqual([...scope.ids],['a','loop','x','y','z']);
 assert.deepEqual([...reachable(nodes,[],'proxy').ids],[]);
});
test('selected branch and cycles are traversed once without selecting disconnected steps',()=>{
 const nodes=[node('a'),node('b'),node('c'),node('other')],edges=[{source:'a',target:'b'},{source:'b',target:'c'},{source:'c',target:'b'}];
 assert.equal(reachable(nodes,edges,'').start,'');assert.deepEqual([...reachable(nodes,edges,'b').ids],['b','c']);
});
