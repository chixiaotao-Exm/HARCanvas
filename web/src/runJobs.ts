import type {RunJob} from './types';
import {sleepForAgentJob} from './agentJobs.ts';
export class ApiError extends Error{status:number;data:unknown;constructor(message:string,status:number,data:unknown){super(message);this.name='ApiError';this.status=status;this.data=data;}}
export async function apiJSON<T>(path:string,init:RequestInit={}):Promise<T>{
 const response=await fetch(path,{...init,cache:'no-store'});const requestId=response.headers.get('x-request-id');let data:unknown;
 try{data=JSON.parse(await response.text());}catch{throw new ApiError(`服务器返回非 JSON 内容（HTTP ${response.status}${requestId?`；请求编号 ${requestId}`:''}）。${response.status===502?'网关连接失败；请检查服务器日志。':''}`,response.status,null);}
 if(!response.ok){const message=data&&typeof data==='object'&&'error'in data&&typeof data.error==='string'?data.error:'请求失败';throw new ApiError(`${message}（HTTP ${response.status}${requestId?`；请求编号 ${requestId}`:''}）`,response.status,data);}
 return data as T;
}
export function postJSON<T>(path:string,payload:unknown,signal?:AbortSignal){return apiJSON<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const jobStatuses=new Set(['running','waiting_input','completed','failed','cancelled']);
const eventStatuses=new Set(['pending','running','waiting_input','success','error','skipped','cancelled']);
function parseRunJob(value:unknown,id:string,after=0):RunJob{
 if(!record(value)||value.id!==id)throw new Error('服务器返回了不同或无效的运行任务，请恢复查询并检查服务状态。');
 if(typeof value.status!=='string'||!jobStatuses.has(value.status)||!Number.isSafeInteger(value.seq)||(value.seq as number)<after||!Array.isArray(value.events))throw new Error('服务器返回的运行状态或事件序号无效，请恢复同一任务的查询。');
 let sequence=after;
 for(const event of value.events){
  if(!record(event)||event.runId!==id||!Number.isSafeInteger(event.seq)||(event.seq as number)<=sequence||(event.seq as number)>(value.seq as number)||typeof event.nodeId!=='string'||!event.nodeId||typeof event.status!=='string'||!eventStatuses.has(event.status)||typeof event.time!=='string'||!Number.isFinite(Date.parse(event.time))||(event.durationMs!==undefined&&(typeof event.durationMs!=='number'||!Number.isFinite(event.durationMs)||event.durationMs<0))||(event.message!==undefined&&typeof event.message!=='string')||(event.errorCode!==undefined&&typeof event.errorCode!=='string'))throw new Error('服务器返回的执行事件无效，请恢复同一任务的查询。');
  sequence=event.seq as number;
 }
 if(value.status==='waiting_input'){
  const pending=value.pendingInput;
  if(!record(pending)||typeof pending.nodeId!=='string'||!pending.nodeId||typeof pending.variable!=='string'||!pending.variable||typeof pending.label!=='string'||(pending.prompt!==undefined&&typeof pending.prompt!=='string'))throw new Error('服务器返回的人工输入信息无效，请恢复同一任务的查询。');
 }else if(value.pendingInput!==undefined)throw new Error('服务器返回了与当前状态不一致的人工输入信息。');
 if(value.result!==undefined&&(!record(value.result)||!['success','error','cancelled'].includes(String(value.result.status))||!Array.isArray(value.result.steps)))throw new Error('服务器返回的运行结果摘要无效，请按任务编号恢复查询。');
 return value as RunJob;
}
export async function cancelRunJob(id:string){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),2500);try{return parseRunJob(await apiJSON<unknown>(`/api/flow/jobs/${encodeURIComponent(id)}`,{method:'DELETE',signal:controller.signal}),id);}finally{clearTimeout(timer);}}
export async function followRunJob(id:string,signal:AbortSignal,onUpdate:(job:RunJob)=>void,after=0){
 if(!Number.isSafeInteger(after)||after<0)throw new Error('恢复查询需要有效的事件序号。');
 let sequence=after;while(true){signal.throwIfAborted();const raw=await apiJSON<unknown>(`/api/flow/jobs/${encodeURIComponent(id)}?after=${sequence}`,{signal});signal.throwIfAborted();const job=parseRunJob(raw,id,sequence);sequence=job.seq;onUpdate(job);if(!['running','waiting_input'].includes(job.status))return job;await sleepForAgentJob(500,signal);}
}
