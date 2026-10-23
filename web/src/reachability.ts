import type {FlowNode,FlowEdge} from './types';
const resourceKinds=new Set(['proxy','profile','browserSession']);
/** Index each scope once; nested members keep their original IDs for preparation and input lookup. */
export function reachable(nodes:FlowNode[],edges:FlowEdge[],entryId:string){
 const byId=new Map(nodes.map(node=>[node.id,node])),incoming=new Set<string>(),outgoing=new Map<string,string[]>();
 for(const edge of edges){incoming.add(edge.target);const targets=outgoing.get(edge.source)??[];targets.push(edge.target);outgoing.set(edge.source,targets);}
 const roots=nodes.filter(node=>!resourceKinds.has(node.data.kind)&&!incoming.has(node.id)).map(node=>node.id);
 const chosen=byId.get(entryId),start=(chosen&&!resourceKinds.has(chosen.data.kind)?entryId:'')||(roots.length===1?roots[0]:'');
 const ids=new Set<string>(),todo=start?[start]:[];
 while(todo.length){const id=todo.pop()!;if(ids.has(id))continue;const node=byId.get(id);if(!node||resourceKinds.has(node.data.kind))continue;ids.add(id);
  if(node.data.loop)for(const child of reachable(node.data.loop.nodes,node.data.loop.edges,node.data.loop.entryId??'').ids)ids.add(child);
  todo.push(...outgoing.get(id)??[]);
 }
 return {ids,roots,start};
}
