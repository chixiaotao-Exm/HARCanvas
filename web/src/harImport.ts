import type {ParseResult} from './types';
import {apiJSON,ApiError} from './runJobs.ts';

export const HAR_IMPORT_LIMIT=256*1024*1024;
export const HAR_CHUNK_SIZE=1024*1024;
export type ImportView={id:string;status:'uploading'|'parsing'|'completed'|'failed'|'cancelled';size:number;receivedBytes:number;chunkSize:number;error?:string;errorCode?:string;requestId?:string};
export type ImportPhase='creating'|'uploading'|'parsing'|'result'|'completed';
export type ImportProgress={phase:ImportPhase;view:ImportView|null;size:number;receivedBytes:number;startedAt:number;phaseStartedAt:number;retryCount:number};
type Request=(path:string,init?:RequestInit)=>Promise<unknown>;
type Options={signal:AbortSignal;resume?:ImportView|null;onProgress?:(progress:ImportProgress)=>void;request?:Request;requestTimeoutMs?:number;resultTimeoutMs?:number;parseTimeoutMs?:number;pollMs?:number;maxRetries?:number;now?:()=>number;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>};
type ErrorDetails={code?:string;status?:number;requestId?:string;view?:ImportView|null};
export class HarImportError extends Error{
 code:string;status?:number;requestId?:string;view:ImportView|null;
 constructor(message:string,details:ErrorDetails={}){super(message);this.name='HarImportError';this.code=details.code??'IMPORT_FAILED';this.status=details.status;this.requestId=details.requestId;this.view=details.view??null;}
}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function cancelled(){return new HarImportError('导入已取消。',{code:'CANCELLED'});}
function check(signal:AbortSignal){if(signal.aborted)throw cancelled();}
function normalize(error:unknown,view:ImportView|null):HarImportError{
 if(error instanceof HarImportError){if(!error.view&&error.status!==404&&error.status!==410&&error.code!=='import_expired')error.view=view;return error;}
 const message=error instanceof Error?error.message:'HAR 导入失败，请重试或重新选择文件。';
 const data=error instanceof ApiError&&record(error.data)?error.data:null;
 const requestId=typeof data?.requestId==='string'?data.requestId:message.match(/请求编号\s+([^）)；\s]+)/)?.[1];
 const status=error instanceof ApiError?error.status:undefined,code=typeof data?.errorCode==='string'?data.errorCode:typeof data?.code==='string'?data.code:error instanceof ApiError?'HTTP_ERROR':'NETWORK_ERROR';
 return new HarImportError(message,{view:status===404||status===410||code==='import_expired'?null:view,status,requestId,code});
}
function viewOf(value:unknown,size:number,id?:string):ImportView{
 if(!record(value)||typeof value.id!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(value.id)||(id!==undefined&&value.id!==id)||!['uploading','parsing','completed','failed','cancelled'].includes(String(value.status))||value.size!==size||value.chunkSize!==HAR_CHUNK_SIZE||!Number.isSafeInteger(value.receivedBytes)||(value.receivedBytes as number)<0||(value.receivedBytes as number)>size||['error','errorCode','requestId'].some(k=>value[k]!==undefined&&typeof value[k]!=='string'))throw new HarImportError('服务器返回的导入状态无效，请重新选择文件。',{code:'INVALID_IMPORT_STATE'});
 if(value.status!=='uploading'&&value.status!=='cancelled'&&value.receivedBytes!==size)throw new HarImportError('服务器返回的导入字节数与文件不一致。',{code:'INVALID_IMPORT_STATE'});
 if(value.receivedBytes!==size&&(value.receivedBytes as number)%HAR_CHUNK_SIZE!==0)throw new HarImportError('服务器返回的分片边界无效，请重新导入。',{code:'INVALID_IMPORT_OFFSET'});
 return value as ImportView;
}
function parseResultOf(value:unknown):ParseResult{
 if(!record(value)||!Array.isArray(value.requests)||!record(value.summary)||!Number.isFinite(value.summary.total)||!Array.isArray(value.warnings)||!value.warnings.every(w=>typeof w==='string')||!value.requests.every(r=>record(r)&&['id','method','url','domain','path','category','mimeType','body','responseBody'].every(k=>typeof r[k]==='string')&&record(r.headers)&&record(r.responseHeaders)&&record(r.query)))throw new HarImportError('服务器返回的 HAR 解析结果无效，请重试读取。',{code:'INVALID_IMPORT_RESULT'});
 return value as ParseResult;
}
function terminal(view:ImportView){
 if(view.status==='failed')throw new HarImportError(view.error||'HAR 解析失败，请检查文件。',{code:view.errorCode||'PARSE_FAILED',view,requestId:view.requestId});
 if(view.status==='cancelled')throw new HarImportError('导入任务已取消，请重试。',{code:'CANCELLED',view,requestId:view.requestId});
}
const retryable=(error:HarImportError)=>error.code==='REQUEST_TIMEOUT'||error.code==='NETWORK_ERROR'||error.status!==undefined&&error.status>=500;
function sleep(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{check(signal);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(cancelled());};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}

/** Deadline covers response headers and the complete JSON body, not only fetch(). */
async function requestWithDeadline(request:Request,path:string,init:RequestInit,signal:AbortSignal,timeoutMs:number,onAbandoned?:(value:unknown)=>void){
 check(signal);const controller=new AbortController();let timedOut=false;
 const parentAbort=()=>controller.abort();signal.addEventListener('abort',parentAbort,{once:true});
 let rejectAbort:(error:unknown)=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
 const abort=()=>rejectAbort(timedOut?new HarImportError('请求超时，请重试当前导入。',{code:'REQUEST_TIMEOUT'}):cancelled());
 controller.signal.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
 const operation=Promise.resolve().then(()=>{check(controller.signal);return request(path,{...init,signal:controller.signal});}).then(value=>{if(controller.signal.aborted)onAbandoned?.(value);return value;});
 try{return await Promise.race([operation,aborted]);}
 catch(error){if(signal.aborted)throw cancelled();if(timedOut)throw new HarImportError('请求超时，请重试当前导入。',{code:'REQUEST_TIMEOUT'});throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',parentAbort);controller.signal.removeEventListener('abort',abort);}
}

/** Cleanup uses its own bounded signal, so cancelling an upload cannot cancel DELETE. */
export async function cancelHarImport(id:string,request:Request=apiJSON,timeoutMs=5000){
 const controller=new AbortController();
 await requestWithDeadline(request,`/api/har/imports/${encodeURIComponent(id)}`,{method:'DELETE'},controller.signal,timeoutMs);
}

/** A failed client can still own an active task; release it when abandoning it. */
export async function discardHarImport(view:ImportView|null|undefined,keepId?:string,request:Request=apiJSON){
 if(!view||view.id===keepId||!['uploading','parsing'].includes(view.status))return;
 try{await cancelHarImport(view.id,request);}catch{/* A fresh selection must remain usable if cleanup is offline. */}
}

/** One resumable import. This never falls back to uploading the entire file. */
export async function importHar(file:Blob,options:Options):Promise<ParseResult>{
 const {signal}=options,request=options.request??apiJSON,now=options.now??Date.now,wait=options.sleep??sleep;
 const requestMs=options.requestTimeoutMs??45000,resultMs=options.resultTimeoutMs??120000,parseMs=options.parseTimeoutMs??300000,pollMs=options.pollMs??1000,maxRetries=options.maxRetries??2;
 let view:ImportView|null=null,phase:ImportPhase='creating',phaseStartedAt=now(),retryCount=0;const startedAt=phaseStartedAt;
 const emit=(next:ImportPhase)=>{if(signal.aborted)return;if(next!==phase){phase=next;phaseStartedAt=now();}options.onProgress?.({phase,view:view?{...view}:null,size:file.size,receivedBytes:view?.receivedBytes??0,startedAt,phaseStartedAt,retryCount});};
 const send=(path:string,init:RequestInit={},timeoutMs=requestMs,onAbandoned?:(value:unknown)=>void)=>requestWithDeadline(request,path,init,signal,timeoutMs,onAbandoned);
 const sync=async()=>{if(!view)throw new HarImportError('导入任务尚未建立。');view=viewOf(await send(`/api/har/imports/${encodeURIComponent(view.id)}`),file.size,view.id);terminal(view);return view;};
 const cleanup=(id:string)=>{void cancelHarImport(id,request,Math.min(requestMs,5000)).catch(()=>{});};
 try{
  check(signal);
  if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>HAR_IMPORT_LIMIT)throw new HarImportError(file.size>HAR_IMPORT_LIMIT?'HAR 文件超过 256 MiB，请缩小抓包范围。':'请选择非空 HAR 文件。',{code:'INVALID_FILE_SIZE'});
  emit('creating');
  if(options.resume&&['uploading','parsing','completed'].includes(options.resume.status)){view=viewOf(options.resume,file.size);await sync();}
  else{
   const created=await send('/api/har/imports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({size:file.size})},requestMs,value=>{if(record(value)&&typeof value.id==='string'&&/^[-A-Za-z0-9_]{1,128}$/.test(value.id))cleanup(value.id);});
   view=viewOf(created,file.size);terminal(view);
  }
  check(signal);
  while(view.status==='uploading'&&view.receivedBytes<file.size){
   emit('uploading');const offset=view.receivedBytes,end=Math.min(offset+view.chunkSize,file.size);let errors=0,needsSync=false;
   while(true){
    check(signal);
    try{
     if(needsSync){await sync();emit(view.status==='uploading'?'uploading':'parsing');if(view.status!=='uploading'||view.receivedBytes===end)break;if(view.receivedBytes!==offset)throw new HarImportError('服务器确认的分片位置与当前文件不一致。',{code:'INVALID_IMPORT_OFFSET',view});}
     const result=await send(`/api/har/imports/${encodeURIComponent(view.id)}/chunks?offset=${offset}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,end)});
     view=viewOf(result,file.size,view.id);terminal(view);
     if(view.status!=='uploading'||view.receivedBytes!==end)throw new HarImportError('服务器未完整确认当前分片，请重新导入。',{code:'INVALID_IMPORT_OFFSET',view});
     retryCount=0;emit('uploading');break;
    }catch(error){const failure=normalize(error,view);if(signal.aborted||!retryable(failure)||errors>=maxRetries)throw failure;errors++;retryCount=errors;needsSync=true;emit('uploading');await wait(Math.min(250*errors,1000),signal);}
   }
  }
  check(signal);
  if(view.status==='uploading')emit('uploading');
  if(view.status==='uploading'){
   let errors=0,needsSync=false;
   while(true){
    try{
     if(needsSync){await sync();if(view.status!=='uploading')break;}
     view=viewOf(await send(`/api/har/imports/${encodeURIComponent(view.id)}/complete`,{method:'POST'}),file.size,view.id);terminal(view);
     if(view.status==='uploading')throw new HarImportError('服务器尚未开始解析，请重试当前任务。',{code:'INVALID_IMPORT_STATE',view});
     break;
    }catch(error){const failure=normalize(error,view);if(signal.aborted||!retryable(failure)||errors>=maxRetries)throw failure;errors++;retryCount=errors;needsSync=true;emit('uploading');await wait(250*errors,signal);}
   }
  }
  retryCount=0;emit('parsing');const parseStartedAt=now();let pollErrors=0;
  while(view.status==='parsing'){
   check(signal);const remaining=parseMs-(now()-parseStartedAt);
   if(remaining<=0)throw new HarImportError('解析等待超过上限。可以重试查询同一任务，或取消后重新导入。',{code:'PARSE_TIMEOUT',view,requestId:view.requestId});
   await wait(Math.min(pollMs,remaining),signal);
   if(now()-parseStartedAt>=parseMs)throw new HarImportError('解析等待超过上限。可以重试查询同一任务，或取消后重新导入。',{code:'PARSE_TIMEOUT',view,requestId:view.requestId});
   try{
    view=viewOf(await send(`/api/har/imports/${encodeURIComponent(view.id)}`,{},Math.min(requestMs,Math.max(1,parseMs-(now()-parseStartedAt)))),file.size,view.id);terminal(view);pollErrors=0;retryCount=0;emit('parsing');
    if(view.status==='uploading')throw new HarImportError('服务器的解析状态发生回退，请重新导入。',{code:'INVALID_IMPORT_STATE',view});
   }catch(error){const failure=normalize(error,view);if(signal.aborted||!retryable(failure)||pollErrors>=maxRetries)throw failure;pollErrors++;retryCount=pollErrors;emit('parsing');}
  }
  check(signal);terminal(view);
  if(view.status!=='completed')throw new HarImportError('服务器尚未完成 HAR 解析。',{code:'INVALID_IMPORT_STATE',view});
  emit('result');let resultErrors=0;
  while(true){
   try{const result=parseResultOf(await send(`/api/har/imports/${encodeURIComponent(view.id)}/result`,{},resultMs));check(signal);retryCount=0;emit('completed');return result;}
   catch(error){const failure=normalize(error,view);if(signal.aborted||!retryable(failure)||resultErrors>=maxRetries)throw failure;resultErrors++;retryCount=resultErrors;emit('result');await wait(250*resultErrors,signal);}
  }
 }catch(error){
  const failure=normalize(error,view);
  if(signal.aborted&&view){cleanup(view.id);failure.code='CANCELLED';}
  throw failure;
 }
}
