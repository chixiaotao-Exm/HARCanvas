import type {FlowNode,RunEvent} from './types';

export function flattenRunNodes(nodes:FlowNode[]):FlowNode[]{
 const result:FlowNode[]=[];
 for(const node of nodes){result.push(node);if(node.data.loop)result.push(...flattenRunNodes(node.data.loop.nodes));}
 return result;
}
export function executionEventKey(event:Pick<RunEvent,'executionId'|'nodeId'>):string{return event.executionId||event.nodeId;}
export function latestExecutionEvents(events:RunEvent[]):RunEvent[]{
 const latest=new Map<string,RunEvent>();
 for(const event of events){const key=executionEventKey(event),previous=latest.get(key);if(!previous||event.seq>previous.seq)latest.set(key,event);}
 return [...latest.values()].sort((a,b)=>a.seq-b.seq);
}
export function executionScopeLabel(scopePath:string[]|undefined,nodes:FlowNode[]):string{
 return(scopePath??[]).map(segment=>{const split=segment.lastIndexOf(':'),id=split<0?segment:segment.slice(0,split),iteration=split<0?'':segment.slice(split+1);return`${nodes.find(node=>node.id===id)?.data.label||id}${/^\d+$/.test(iteration)?` · 第 ${iteration} 轮`:''}`;}).join(' › ');
}
