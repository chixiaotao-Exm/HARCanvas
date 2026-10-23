import type {HarRequest} from './types';

export const OVERVIEW_REQUEST_LIMIT=1000;
export const OVERVIEW_REQUEST_BYTES=512*1024;
export const OVERVIEW_SELECTION_LIMIT=24;
export const OVERVIEW_GOAL_BYTES=16000;
export type OverviewRequest={id:string;method:string;domain:string;path:string;category:string;status:number;mimeType:string;pageId?:string;startedAt?:string};
export type OverviewReason={requestId:string;reason:string};
export type OverviewResult={summary:string;selectedRequestIds:string[];reasons:OverviewReason[];warnings:string[]};

const encoder=new TextEncoder();
const byteLength=(value:string)=>encoder.encode(value).byteLength;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const limits={method:32,domain:512,path:4096,category:100,mimeType:256,pageId:200,startedAt:100} as const;
export class OverviewInputError extends Error{
  code:string;
  constructor(message:string,code='invalid_overview_input'){super(message);this.name='OverviewInputError';this.code=code;}
}
export class OverviewResultError extends Error{
  code='invalid_overview_result';
  constructor(){super('主流程总览结果无效，未启动逐条分析。请重试或缩小筛选范围。');this.name='OverviewResultError';}
}

/** Match Go's JSON byte budget, including its default HTML and line escaping. */
function jsonBytes(value:unknown){return byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`));}

/** Metadata only: never copy URLs, header values, query values, or bodies. */
export function buildOverviewRequests(requests:readonly HarRequest[],goal=''):OverviewRequest[]{
  if(typeof goal!=='string'||byteLength(goal)>OVERVIEW_GOAL_BYTES)throw new OverviewInputError('操作目标超过 16000 UTF-8 字节，请缩短目标描述。','overview_goal_limit');
  if(!requests.length||requests.length>OVERVIEW_REQUEST_LIMIT)throw new OverviewInputError(`快速识别需要 1–${OVERVIEW_REQUEST_LIMIT} 条请求，请按页面或时间缩小范围，或选择完整逐条分析。`,'overview_scope_limit');
  const known=new Set<string>();
  const result=requests.map(request=>{
    if(!validId(request.id)||known.has(request.id))throw new OverviewInputError('请求目录包含无效或重复的记录编号，请重新导入 HAR。');
    known.add(request.id);
    const item:OverviewRequest={id:request.id,method:request.method,domain:request.domain,path:request.path,category:request.category,status:request.status,mimeType:request.mimeType};
    if(request.pageId!==undefined)item.pageId=request.pageId;
    const startedAt=request.startedAt??request.startedDateTime;if(startedAt!==undefined)item.startedAt=startedAt;
    for(const [key,limit]of Object.entries(limits)){
      const value=item[key as keyof typeof limits];
      if(value===undefined&&(key==='pageId'||key==='startedAt'))continue;
      if(typeof value!=='string'||byteLength(value)>limit)throw new OverviewInputError(`请求目录的 ${key} 字段无效或超过 ${limit} UTF-8 字节，请检查 HAR 或缩小范围。`);
    }
    if(!item.method.trim()||!item.domain.trim()||!Number.isSafeInteger(item.status)||item.status<0||item.status>999)throw new OverviewInputError('请求目录包含无效的方法、域名或响应状态，请检查 HAR。');
    return item;
  });
  if(jsonBytes({goal,requests:result})>OVERVIEW_REQUEST_BYTES)throw new OverviewInputError('快速识别目录超过 512 KiB，请按页面或时间缩小范围，或选择完整逐条分析。','overview_payload_limit');
  return result;
}

/** Selection is distinct from Analysis; it can never create executable blocks. */
export function parseOverviewResult(value:unknown,knownIds:ReadonlySet<string>):OverviewResult{
  if(!record(value)||typeof value.summary!=='string'||!value.summary.trim()||byteLength(value.summary)>2000||!Array.isArray(value.selectedRequestIds)||value.selectedRequestIds.length>OVERVIEW_SELECTION_LIMIT||!Array.isArray(value.reasons)||value.reasons.length!==value.selectedRequestIds.length||!Array.isArray(value.warnings)||value.warnings.length>12||!value.warnings.every(warning=>typeof warning==='string'&&byteLength(warning)<=1000))throw new OverviewResultError();
  const selected=new Set<string>();
  for(const id of value.selectedRequestIds){if(!validId(id)||!knownIds.has(id)||selected.has(id))throw new OverviewResultError();selected.add(id);}
  const explained=new Set<string>(),reasons:OverviewReason[]=[];
  for(const item of value.reasons){
    if(!record(item)||!validId(item.requestId)||!selected.has(item.requestId)||explained.has(item.requestId)||typeof item.reason!=='string'||!item.reason.trim()||byteLength(item.reason)>600)throw new OverviewResultError();
    explained.add(item.requestId);reasons.push({requestId:item.requestId,reason:item.reason});
  }
  return {summary:value.summary,selectedRequestIds:[...selected],reasons,warnings:[...value.warnings] as string[]};
}
