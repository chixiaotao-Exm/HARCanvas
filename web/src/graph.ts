/** Graph edits are pure: the same plan drives the menu preview and the deletion. */
export type GraphNode = { id: string };
export type GraphEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
export type DeletionKind = 'edge' | 'before' | 'after';
export type GraphDeletion<N extends GraphNode, E extends GraphEdge> = {
  nodes: N[]; edges: E[]; removedNodes: N[]; removedEdges: E[]; protectedNodeId?: string;
};

export function planGraphDeletion<N extends GraphNode, E extends GraphEdge>(
  nodes: readonly N[], edges: readonly E[], edgeId: string, kind: DeletionKind,
): GraphDeletion<N,E> {
  const edge = edges.find(item => item.id === edgeId);
  if (!edge) return {nodes: [...nodes], edges: [...edges], removedNodes: [], removedEdges: []};
  const deleted = new Set<string>();
  const nodeIds = new Set(nodes.map(node => node.id));
  const protectedNodeId = kind === 'before' ? edge.target : kind === 'after' ? edge.source : undefined;
  if (kind !== 'edge') {
    const adjacent = new Map<string,string[]>();
    for (const item of edges) {
      if (item.id === edgeId || !nodeIds.has(item.source) || !nodeIds.has(item.target)) continue;
      const from = kind === 'before' ? item.target : item.source;
      const to = kind === 'before' ? item.source : item.target;
      const list = adjacent.get(from) ?? [];
      list.push(to);
      adjacent.set(from,list);
    }
    const pending = [kind === 'before' ? edge.source : edge.target];
    while (pending.length) {
      const id = pending.pop()!;
      // The retained endpoint is a hard boundary, even inside cycles.
      if (id === protectedNodeId || deleted.has(id) || !nodeIds.has(id)) continue;
      deleted.add(id);
      for (const next of adjacent.get(id) ?? []) pending.push(next);
    }
  }
  const removeEdge = (item:E) => item.id === edgeId || deleted.has(item.source) || deleted.has(item.target);
  return {
    nodes: nodes.filter(node => !deleted.has(node.id)),
    edges: edges.filter(item => !removeEdge(item)),
    removedNodes: nodes.filter(node => deleted.has(node.id)),
    removedEdges: edges.filter(removeEdge),
    protectedNodeId,
  };
}

/** Restore deleted items without replacing nodes/edges added or edited since. */
export function restoreGraphDeletion<N extends GraphNode, E extends GraphEdge>(
  nodes: readonly N[], edges: readonly E[], deletion: {nodes: readonly N[]; edges: readonly E[]; nodeOrder?: readonly string[]; edgeOrder?: readonly string[]},
): {nodes:N[];edges:E[]} {
  const nodeIds = new Set(nodes.map(node => node.id));
  const restoredNodes = [...nodes, ...deletion.nodes.filter(node => !nodeIds.has(node.id))];
  const restoredIds = new Set(restoredNodes.map(node => node.id));
  const edgeIds = new Set(edges.map(edge => edge.id));
  const connectionKey=(edge:E)=>JSON.stringify([edge.source,edge.target,edge.sourceHandle??'']);
  const connections=new Set(edges.map(connectionKey));
  const restoredEdges = deletion.edges.filter(edge => {
    const key=connectionKey(edge);
    if(edgeIds.has(edge.id)||connections.has(key)||!restoredIds.has(edge.source)||!restoredIds.has(edge.target))return false;
    edgeIds.add(edge.id);connections.add(key);return true;
  });
  return {nodes:restoreOriginalOrder(restoredNodes,deletion.nodeOrder),edges:restoreOriginalOrder([...edges,...restoredEdges],deletion.edgeOrder)};
}

function restoreOriginalOrder<T extends {id:string}>(items:T[],originalOrder?:readonly string[]):T[] {
  if(!originalOrder)return items;
  const remaining=new Map(items.map(item=>[item.id,item]));
  const ordered:T[]=[];
  for(const id of originalOrder){const item=remaining.get(id);if(item){ordered.push(item);remaining.delete(id);}}
  // New items retain their current relative order after the restored original items.
  for(const item of items){if(remaining.has(item.id)){ordered.push(item);remaining.delete(item.id);}}
  return ordered;
}

export function clampMenuPosition(point:{x:number;y:number},size:{width:number;height:number},viewport:{width:number;height:number}) {
  const margin=8;
  return {x:Math.max(margin,Math.min(point.x,viewport.width-size.width-margin)),y:Math.max(margin,Math.min(point.y,viewport.height-size.height-margin))};
}
