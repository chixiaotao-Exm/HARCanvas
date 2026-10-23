import {useEffect,useRef,useState} from 'react';
import type {HarRequest} from './types';
import FieldTree from './FieldTree';
import {apiJSON} from './runJobs';
import {createResponseReadScope} from './responseReadScope';
function parse(text:string):unknown{if(text.length>2*1024*1024)return undefined;try{return JSON.parse(text);}catch{return text||undefined;}}
export default function ResponseFields({request,onPick}:{request:HarRequest;onPick:(path:string)=>void}){
 const [full,setFull]=useState<{identity:string;body:string}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const identity=JSON.stringify([request.id,request.responseDetailUrl??'']),latestIdentity=useRef(identity),reads=useRef(createResponseReadScope());
 // A changed prop invalidates late callbacks even before passive effect cleanup.
 latestIdentity.current=identity;
 useEffect(()=>{const scope=reads.current;scope.select(identity);setFull(null);setError('');setLoading(false);return()=>scope.cancel();},[identity]);
 const load=async()=>{
  if(!request.responseDetailUrl)return;
  const token=reads.current.begin(identity),isCurrent=()=>token.isCurrent()&&latestIdentity.current===identity;
  setLoading(true);setError('');
  try{
   const url=new URL(request.responseDetailUrl,location.origin);
   if(url.origin!==location.origin||!url.pathname.startsWith('/api/har/uploads/'))throw new Error('完整响应地址无效，请重新导入 HAR。');
   const result=await apiJSON<{request:HarRequest}>(url.pathname,{signal:token.signal});
   if(!isCurrent())return;
   if(!result?.request||result.request.id!==request.id||typeof result.request.responseBody!=='string')throw new Error('完整响应与当前记录不匹配，请重新导入。');
   setFull({identity,body:result.request.responseBody});
  }catch(error){if(isCurrent())setError(error instanceof Error?error.message:'完整响应读取失败，请重新导入 HAR。');}
  finally{if(isCurrent())setLoading(false);}
 };
 const fullBody=full?.identity===identity?full.body:null,body=fullBody??request.responseBody,value=parse(body);
 return <div className="response-fields">{request.responseBodyTruncated&&fullBody===null&&<div className="response-preview-note"><p>当前为录制响应预览，约 {Math.ceil((request.responseBodyBytes??0)/1024)} KiB。完整响应导入后保留 30 分钟。</p>{request.responseDetailUrl?<button className="text-button" disabled={loading} onClick={()=>void load()}>{loading?'读取中…':'读取完整响应并选择字段'}</button>:<p>请重新导入原 HAR 读取完整字段。</p>}</div>}{error&&<p className="error-text">{error}</p>}{value===undefined?<p className="hint">{body.length>2*1024*1024?'响应较大，树形选择限 2 MiB，可在高级模式填写字段路径。':'录制记录未包含响应正文。'}</p>:<FieldTree key={`${request.id}-${fullBody===null?'preview':'full'}`} value={value} onPick={onPick}/>}</div>;
}
