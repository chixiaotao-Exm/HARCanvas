import {useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import {Maximize2,Minimize2,X} from 'lucide-react';
import './CanvasFullscreen.css';

type CanvasTargetRef=RefObject<HTMLElement|null>;
type FullscreenOptions={onError?:(message:string)=>void};

/** Track this canvas only; an unrelated fullscreen element is never exited. */
export function useCanvasFullscreen(targetRef:CanvasTargetRef,options:FullscreenOptions={}){
 const [isFullscreen,setIsFullscreen]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const mounted=useRef(false),pending=useRef(false),onError=useRef(options.onError);
 onError.current=options.onError;

 useEffect(()=>{
  mounted.current=true;
  const target=targetRef.current,owner=target?.ownerDocument;
  const sync=()=>{if(mounted.current)setIsFullscreen(!!target&&owner?.fullscreenElement===target);};
  sync();
  owner?.addEventListener('fullscreenchange',sync);
  return()=>{
   mounted.current=false;
   owner?.removeEventListener('fullscreenchange',sync);
   // Removing the canvas must not leave its native fullscreen view open.
   if(target&&owner?.fullscreenElement===target&&typeof owner.exitFullscreen==='function')void owner.exitFullscreen().catch(()=>{});
  };
 },[targetRef]);

 const clearError=useCallback(()=>setError(''),[]);
 const toggle=useCallback(async()=>{
  if(pending.current)return;
  const target=targetRef.current,owner=target?.ownerDocument;
  const report=(message:string)=>{if(!mounted.current)return;setError(message);try{onError.current?.(message);}catch{/* Host notifications cannot interrupt the fullscreen control. */}};
  if(!target||!owner){report('画布尚未就绪，请稍后重试。');return;}
  if(typeof target.requestFullscreen!=='function'||typeof owner.exitFullscreen!=='function'){
   report('当前浏览器不支持画布全屏，请在支持全屏的浏览器中打开。');return;
  }
  const exiting=owner.fullscreenElement===target;
  if(!exiting&&owner.fullscreenEnabled===false){
   report('当前页面未获全屏权限，请允许页面使用全屏，或在外部浏览器中打开。');return;
  }
  pending.current=true;setBusy(true);setError('');
  try{
   if(exiting)await owner.exitFullscreen();
   else await target.requestFullscreen();
   if(mounted.current)setIsFullscreen(owner.fullscreenElement===target);
  }catch{
   report(exiting?'暂时无法退出全屏，请按 Esc 退出。':'浏览器未能进入全屏，请确认页面允许全屏，或在外部浏览器中打开后重试。');
  }finally{
   pending.current=false;
   if(mounted.current)setBusy(false);
  }
 },[targetRef]);

 return {isFullscreen,busy,error,toggle,clearError};
}

export function CanvasFullscreenButton({targetRef,onError}:{targetRef:CanvasTargetRef;onError?:(message:string)=>void}){
 const {isFullscreen,busy,error,toggle,clearError}=useCanvasFullscreen(targetRef,{onError});
 const label=isFullscreen?'退出全屏':'全屏画布';
 return <span className="canvas-fullscreen-control">
  <button type="button" className="quiet-button canvas-fullscreen-button" aria-label={label} aria-pressed={isFullscreen} title={isFullscreen?'退出全屏（Esc）':'全屏画布'} disabled={busy} onClick={()=>void toggle()}>
   {isFullscreen?<Minimize2 size={14}/>:<Maximize2 size={14}/>}<span>{label}</span>
  </button>
  {error&&<span className="canvas-fullscreen-message" role="status"><span>{error}</span><button type="button" className="icon-button" aria-label="关闭全屏提示" onClick={clearError}><X size={13}/></button></span>}
 </span>;
}

export default CanvasFullscreenButton;
