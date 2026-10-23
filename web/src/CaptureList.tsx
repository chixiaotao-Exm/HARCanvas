import {Check,ChevronDown,LoaderCircle,X} from 'lucide-react';
import type {Analysis} from './types';
import {captureProgress,type CaptureSource} from './captures';
import './captures.css';

export default function CaptureList(p:{sources:CaptureSource[];selectedId:string;analysis:Analysis|null;onSelect:(id:string)=>void;onRename:(id:string,name:string)=>void;onRemove:(id:string)=>void;onRetry?:(id:string)=>void;disabled?:boolean}){
 if(!p.sources.length)return null;
 return <section className="capture-list" aria-label="录制资料"><div className="section-heading"><strong>录制资料 · {p.sources.length}</strong><button className="text-button" onClick={()=>p.onSelect('')}>查看全部</button></div>
  {p.sources.map(source=><article key={source.id} className={`capture-source ${p.selectedId===source.id?'selected':''}`}>
   <button className="capture-source-select" onClick={()=>p.onSelect(source.id)}><span>{source.status==='ready'?<Check size={13}/>:source.status==='queued'||source.status==='reading'?<LoaderCircle size={13} className="spin"/>:<X size={13}/>}</span><span><strong>{source.name}</strong><small>{source.status==='ready'?`${source.requests.length} 条 · 已解释 ${captureProgress(source,p.analysis)} 条 · ${source.summary.domains.slice(0,2).join('、')}`:source.status==='queued'?'等待导入':source.status==='reading'?'正在读取与解析':source.status==='cancelled'?'已取消导入':source.error||'导入失败'}</small></span><ChevronDown size={12}/></button>
   {p.selectedId===source.id&&<div className="capture-source-actions"><input aria-label="录制名称" value={source.name} maxLength={120} onChange={e=>p.onRename(source.id,e.target.value)}/>{p.onRetry&&['failed','cancelled'].includes(source.status)&&<button className="text-button" disabled={p.disabled} onClick={()=>p.onRetry?.(source.id)}>重新导入这份资料</button>}<button className="text-button danger" disabled={p.disabled||source.status==='reading'} onClick={()=>p.onRemove(source.id)}>移除资料</button></div>}
  </article>)}
 </section>;
}
