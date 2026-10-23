import type { FlowNode, FlowEdge, HarRequest, Suggestion, BlockData, ParameterBinding } from './types';
import { getHarBlocks } from './harBlocks.ts';
import { findFieldRelations, planRequestGroups } from './analysisContext.ts';
import type { FieldRelation } from './analysisContext.ts';

export type GenerationMetadata = {
  generatedKey?:string; groupId?:string; groupLabel?:string;
  readiness?:string; evidence?:string[]; uncertainty?:string; inputs?:string[]; outputs?:string[];
};
type Enriched = Suggestion & {group?:string;readiness?:string;evidence?:string[];uncertainty?:string;inputs?:string[];outputs?:string[]};
const stableId=(value:string)=>{let hash=2166136261;for(const char of value)hash=Math.imul(hash^char.charCodeAt(0),16777619);return (hash>>>0).toString(36);};
const reserveId=(base:string,occupied:Set<string>)=>{let id=base,index=1;while(occupied.has(id))id=`${base}-${index++}`;occupied.add(id);return id;};
const fieldNames:Record<string,string>={orderId:'订单编号',ticket:'查询凭据',token:'访问凭据',csrf:'会话校验值',session:'会话标识',cursor:'分页位置'};
function jsonField(body:string,path:string,safeNumbers=false):unknown {
  let value:unknown=JSON.parse(body,(_key,item:unknown)=>{
    if(safeNumbers&&typeof item==='number'&&(!Number.isFinite(item)||(Number.isInteger(item)&&!Number.isSafeInteger(item))))throw new Error('unsupported JSON number');
    return item;
  });
  for(const key of path.split('.').slice(1)){
    if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw new Error('missing recorded field');
    value=(value as Record<string,unknown>)[key];
  }
  return value;
}
/** Only exact recorded scalar values can initialize a supported binding. */
function relationBinding(relation:FieldRelation,source:HarRequest|undefined,target:HarRequest,sourceNodeId:string|undefined):Omit<ParameterBinding,'id'>|undefined {
  if(!source||!sourceNodeId||!(relation.sourcePath==='body'||relation.sourcePath.startsWith('body.')))return;
  try{
    const value=jsonField(source.responseBody,relation.sourcePath);
    if(typeof value!=='string')return;
    const [kind,...keys]=relation.targetPath.split('.'),path=keys.join('.');
    let bindingTarget:ParameterBinding['target'],recorded:unknown;
    if(kind==='body'&&path){bindingTarget='body';recorded=jsonField(target.body,relation.targetPath,true);}
    else if(kind==='headers'&&path){bindingTarget='header';recorded=target.headers[path];}
    else if(kind==='query'&&path){
      const values=new URL(target.url).searchParams.getAll(path);
      if(values.length!==1)return;
      bindingTarget='query';recorded=values[0];
    }else return;
    // For example, an Authorization value with a Bearer prefix cannot be
    // replaced with the bare token without changing its protocol semantics.
    if(recorded!==value)return;
    const field=keys.at(-1)!;
    return {name:fieldNames[field]??field,target:bindingTarget,path,mode:'upstream',source:sourceNodeId,sourcePath:relation.sourcePath,required:true,evidence:relation.evidence};
  }catch{return;}
}

/** Append only: never change a user's text, position, bindings, or connections. */
export function mergeGeneratedFlow(nodes:FlowNode[],edges:FlowEdge[],requests:HarRequest[],suggestions:Suggestion[],datasetKey:string,options:{suppressedRequestIds?:Set<string>}={}) {
  const nextNodes=[...nodes], nextEdges=[...edges];
  const nodeIds=new Set(nodes.map(node=>node.id)),edgeIds=new Set(edges.map(edge=>edge.id));
  const newIds=new Set<string>();
  const known=new Map<string,string>();
  for(const node of nodes) {
    const metadata=node.data as BlockData&GenerationMetadata;
    if(node.data.requestId && metadata.generatedKey===`${datasetKey}:${node.data.requestId}`) known.set(node.data.requestId,node.id);
  }
  const groupByRequest=new Map(planRequestGroups(requests).flatMap(g=>g.requestIds.map(id=>[id,g] as const)));
  const relationList=findFieldRelations(requests);
  const requestById=new Map(requests.map(request=>[request.id,request]));
  const pending:string[]=[];
  let nextGroupX=nodes.reduce((max,n)=>Math.max(max,n.position.x),-360)+360;
  const groupLayout=new Map<string,{x:number;y:number}>();
  for(const node of nodes)if(node.data.groupId){
    const current=groupLayout.get(node.data.groupId);
    if(current)current.y=Math.max(current.y,node.position.y+260);
    else groupLayout.set(node.data.groupId,{x:node.position.x,y:node.position.y+260});
  }
  let addedCount=0;
  for(const block of getHarBlocks(requests,suggestions)) {
    if(known.has(block.request.id)||options.suppressedRequestIds?.has(block.request.id)) continue;
    const suggestion=block.suggestion as Enriched;
    const group=groupByRequest.get(block.request.id);
    const generatedKey=`${datasetKey}:${block.request.id}`;
    const id=reserveId(`har-${stableId(generatedKey)}`,nodeIds);
    const groupId=suggestion.group?.trim()?`model:${suggestion.group.trim().slice(0,100)}`:group?.id;
    const layoutKey=groupId??`request:${block.request.id}`;
    let layout=groupLayout.get(layoutKey);
    if(!layout){layout={x:nextGroupX,y:60};groupLayout.set(layoutKey,layout);nextGroupX+=360;}
    const sensitive=Object.keys(block.request.headers??{}).some(k=>/cookie|authorization|api[-_]?key|csrf|token|session/i.test(k)) || Object.keys(block.request.query??{}).some(k=>/password|captcha|verification|otp|csrf|token|session|nonce|signature|ticket/i.test(k)) || /password|captcha|verification|otp|csrf|token/i.test(block.request.body);
    const proposedReadiness=['ready','missing-input','manual','unsupported'].includes(suggestion.readiness??'')?suggestion.readiness:(sensitive?'missing-input':'ready');
    let readiness=sensitive&&proposedReadiness==='ready'?'missing-input':proposedReadiness;
    const relations=relationList.filter(r=>r.targetRequestId===block.request.id),bindings:ParameterBinding[]=[],bindingIds=new Set<string>(),bindingWarnings:string[]=[];
    for(const relation of relations){
      const binding=relationBinding(relation,requestById.get(relation.sourceRequestId),block.request,known.get(relation.sourceRequestId));
      if(binding)bindings.push({...binding,id:reserveId(`auto-${stableId(`${generatedKey}:${relation.sourceRequestId}:${relation.sourcePath}:${relation.targetPath}`)}`,bindingIds)});
      else bindingWarnings.push(`${relation.sourceRequestId}.${relation.sourcePath} → ${relation.targetPath} 的来源或编码暂不能自动绑定，请在参数向导中核对。`);
    }
    if(bindingWarnings.length&&readiness!=='manual'&&readiness!=='unsupported')readiness='missing-input';
    pending.push(...bindingWarnings.map(warning=>`${suggestion.label}：${warning}`));
    const evidence=[...(suggestion.evidence??[]),...relations.map(r=>r.evidence)];
    const uncertainty=[suggestion.uncertainty||(sensitive?'包含抓包时的会话或动态字段，请通过参数向导检查后再运行。':''),...bindingWarnings].filter(Boolean).join('\n');
    const data:BlockData&GenerationMetadata={...block.data,generatedKey,groupId,groupLabel:suggestion.group?.trim().slice(0,100)||group?.label,readiness,evidence:evidence.length?evidence:[`原始记录 ${block.request.id} · ${block.request.method} · HTTP ${block.request.status}`],uncertainty,inputs:suggestion.inputs??suggestion.variables.map(v=>`${v.name}：${v.description}`),outputs:suggestion.outputs??[],...(bindings.length?{bindings}:{})};
    nextNodes.push({id,type:'block',position:{x:layout.x,y:layout.y},data});
    layout.y+=260;
    known.set(block.request.id,id);newIds.add(id);addedCount++;
  }
  const pairSet=new Set(nextEdges.map(e=>`${e.source}:${e.target}`));
  // Recorded field matches establish temporal direction. Model-only guesses
  // remain pending and cannot silently turn into executable connections.
  for(const relation of relationList) {
    const source=known.get(relation.sourceRequestId),target=known.get(relation.targetRequestId);
    if(!source||!target||source===target||pairSet.has(`${source}:${target}`)||(!newIds.has(source)&&!newIds.has(target)))continue;
    // An edited graph may already contain the reverse path. Never add cycles.
    const queue=[target],visited=new Set<string>();let cycle=false;
    while(queue.length){const id=queue.pop()!;if(id===source){cycle=true;break;}if(visited.has(id))continue;visited.add(id);for(const edge of nextEdges)if(edge.source===id)queue.push(edge.target);}
    if(cycle){pending.push(`${relation.targetRequestId}：检测到已有反向连接，请手动核对依赖。`);continue;}
    nextEdges.push({id:reserveId(`auto-${stableId(`${datasetKey}:${source}:${target}`)}`,edgeIds),source,target,type:'smoothstep',label:'字段关联',data:{evidence:relation.evidence,generated:true}});
    pairSet.add(`${source}:${target}`);
  }
  for(const suggestion of suggestions) for(const dependency of suggestion.dependencies??[]) {
    if(!relationList.some(r=>r.sourceRequestId===dependency&&r.targetRequestId===suggestion.requestId))pending.push(`${suggestion.label}：与 ${dependency} 的关系待确认，尚未自动连线。`);
  }
  return {nodes:nextNodes,edges:nextEdges,addedCount,pending:[...new Set(pending)]};
}
