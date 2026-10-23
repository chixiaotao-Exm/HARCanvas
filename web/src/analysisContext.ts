import type { HarRequest, Suggestion } from './types';

export type FieldRelation = { sourceRequestId: string; targetRequestId: string; sourcePath: string; targetPath: string; evidence: string };
export type RequestGroup = { id: string; label: string; kind: 'business'|'session'|'background'|'resources'; requestIds: string[] };
export type AnalysisContext = {
  goal: string;
  catalog: {id:string; method:string; domain:string; path:string; category:string; pageId?:string}[];
  groups: RequestGroup[];
  relations: FieldRelation[];
  previous: {requestId:string; label:string; dependencies:string[]}[];
  truncated?: boolean;
};
export const ANALYSIS_CONTEXT_BYTES = 480 * 1024;
const encoder = new TextEncoder();

/** Bound the complete serialized context, including refreshed batch history. */
export function boundAnalysisContext(context:AnalysisContext):AnalysisContext {
  let truncated=Boolean(context.truncated);
  const text=(value:string,limit:number)=>{if(value.length>limit)truncated=true;return value.slice(0,limit);};
  const take=<T,>(values:T[],limit:number)=>{if(values.length>limit)truncated=true;return values.slice(0,limit);};
  // Reserve the flag in the byte count even when the final result omits it.
  const result:AnalysisContext={goal:text(context.goal,4000),catalog:[],groups:[],relations:[],previous:[],truncated:true};
  let bytes=encoder.encode(JSON.stringify(result)).byteLength;
  const append=<T,>(target:T[],items:T[],budget:number)=>{
    let used=0;
    for(const item of items){
      const added=encoder.encode(JSON.stringify(item)).byteLength+(target.length?1:0);
      if(used+added>budget||bytes+added>ANALYSIS_CONTEXT_BYTES){truncated=true;continue;}
      target.push(item);used+=added;bytes+=added;
    }
  };
  append(result.catalog,take(context.catalog,1000).flatMap(item=>{
    if(item.id.length>128){truncated=true;return [];}
    return [{...item,method:text(item.method,16),domain:text(item.domain,200),path:text(item.path,200),category:text(item.category,32),
      pageId:item.pageId===undefined?undefined:text(item.pageId,160),
    }];
  }),216*1024);
  append(result.groups,take(context.groups,100).map(group=>({...group,
    id:text(group.id,360),label:text(group.label,240),requestIds:take(group.requestIds,1000).filter(id=>{if(id.length>128){truncated=true;return false;}return true;}),
  })),56*1024);
  append(result.relations,take(context.relations,300).flatMap(relation=>{
    // Never truncate a field location into a different, misleading location.
    if(relation.sourceRequestId.length>128||relation.targetRequestId.length>128||relation.sourcePath.length>1024||relation.targetPath.length>1024){truncated=true;return [];}
    return [{...relation,evidence:text(relation.evidence,2400)}];
  }),96*1024);
  // Keep the most recent history when a provider returns many dependencies.
  const previous=context.previous.slice(-300);
  if(previous.length!==context.previous.length)truncated=true;
  append(result.previous,previous.reverse().flatMap(item=>{
    if(item.requestId.length>128){truncated=true;return [];}
    return [{...item,label:text(item.label,100),dependencies:take(item.dependencies,64).filter(id=>{if(id.length>128){truncated=true;return false;}return true;})}];
  }),96*1024);
  result.previous.reverse();
  if(!truncated)delete result.truncated;
  return result;
}
type Leaf = {path:string; value:string};
const safeKey = (key:string) => !/[.{}]/.test(key) && !['__proto__','prototype','constructor'].includes(key);
function leaves(value:unknown, prefix:string, result:Leaf[]=[], depth=0):Leaf[] {
  if(result.length>=64 || depth>6) return result;
  if(typeof value==='string' && value.length>=6 && value.length<=2048) result.push({path:prefix,value});
  else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) {
    if(safeKey(key)) leaves(item,`${prefix}.${key}`,result,depth+1);
    if(result.length>=64) break;
  }
  return result;
}
function jsonLeaves(text:string,prefix:string) { if(text.length>2*1024*1024) return [];try{return leaves(JSON.parse(text),prefix);}catch{return [];} }
function inputLeaves(request:HarRequest) {
  const result=jsonLeaves(request.body,'body');
  if(!result.length && request.body.length<12000 && request.body.includes('=')) for(const [key,value] of new URLSearchParams(request.body)) if(safeKey(key)&&value.length>=6) result.push({path:`form.${key}`,value});
  for(const [key,value] of Object.entries(request.query??{})) if(safeKey(key)&&value.length>=6) result.push({path:`query.${key}`,value});
  for(const [key,value] of Object.entries(request.headers??{})) if(safeKey(key)&&value.length>=6 && !/^(accept|host|origin|referer|user-agent|content-type|content-length)$/i.test(key)) {
    result.push({path:`headers.${key}`,value:value.replace(/^Bearer\s+/i,'')});
  }
  return result;
}
function hasDataFlowEvidence(sourcePath:string,targetPath:string,value:string) {
  const normalize=(path:string)=>path.split('.').at(-1)!.toLowerCase().replace(/[^a-z0-9]/g,'');
  const source=normalize(sourcePath),target=normalize(targetPath);
  if(value.length<8 || new Set(value).size<5 || /\s/.test(value))return false;
  if(/^(message|status|label|name|type|url|locale|language|format|description|error|result|contenttype)$/.test(source))return false;
  if(source===target)return true;
  if(source==='id'&&target.endsWith('id'))return true;
  return /token|nonce|csrf|session|ticket|challenge|cursor|reference/i.test(source)&&(/authorization|cookie/i.test(target)||target.endsWith(source));
}

/** Match recorded values without putting those values in explanations or logs. */
export function findFieldRelations(requests:HarRequest[]):FieldRelation[] {
  const outputs=new Map<string,{id:string;path:string;ambiguous:boolean}>();
  const result:FieldRelation[]=[];
  const seen=new Set<string>();
  for(const request of requests) {
    for(const input of inputLeaves(request)) {
      const source=outputs.get(input.value);
      if(!source || source.ambiguous || source.id===request.id || !hasDataFlowEvidence(source.path,input.path,input.value)) continue;
      const key=`${source.id}:${request.id}:${source.path}:${input.path}`;
      if(seen.has(key)) continue;
      seen.add(key);
      result.push({sourceRequestId:source.id,targetRequestId:request.id,sourcePath:source.path,targetPath:input.path,evidence:`抓包中响应字段 ${source.path} 与后续输入 ${input.path} 的值一致；重放前仍需确认有效期。`});
      if(result.length>=300) return result;
    }
    for(const output of jsonLeaves(request.responseBody,'body')) {
      const existing=outputs.get(output.value);
      if(existing && existing.id!==request.id) existing.ambiguous=true;
      else if(!existing && outputs.size<12000) outputs.set(output.value,{id:request.id,path:output.path,ambiguous:false});
    }
  }
  return result;
}

export function planRequestGroups(requests:HarRequest[]):RequestGroup[] {
  const groups=new Map<string,RequestGroup>();
  for(const request of requests) {
    const kind:RequestGroup['kind']=request.category==='static'?'resources':/telemetry|analytics|\/events?(?:\/|$)|\/collect|beacon|metrics|sentry/i.test(request.path)?'background':/csrf|session|config|\/auth(?:\/|$)|oauth|token/i.test(request.path)?'session':'business';
    const pageId=(request as HarRequest&{pageId?:string}).pageId??'';
    const id=`${kind}:${pageId}:${request.domain}`;
    const label=({resources:'页面资源',background:'后台活动',session:'会话准备',business:'业务步骤'}[kind])+` · ${request.domain}`;
    let group=groups.get(id);if(!group){group={id,label,kind,requestIds:[]};groups.set(id,group);}
    group.requestIds.push(request.id);
  }
  return [...groups.values()];
}

export function buildAnalysisContext(requests:HarRequest[],goal='',previous:Suggestion[]=[]):AnalysisContext {
  // Context contains bounded metadata and field locations; raw values are sent
  // only as part of the current batch's previews.
  return boundAnalysisContext({
    goal,
    catalog:requests.map(r=>({id:r.id,method:r.method,domain:r.domain,path:r.path,category:r.category,pageId:(r as HarRequest&{pageId?:string}).pageId})),
    groups:planRequestGroups(requests),
    relations:findFieldRelations(requests),
    previous:previous.map(s=>({requestId:s.requestId,label:s.label,dependencies:s.dependencies??[]})),
  });
}
