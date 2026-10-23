import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,CornerDownLeft,ExternalLink,LoaderCircle,Maximize2,Minimize2,RefreshCw,Send} from 'lucide-react';
import './BrowserSessionView.css';

type BrowserView={image:string;mimeType:string;url:string;title:string;viewport:{width:number;height:number}};
type BrowserAction={action:'click'|'type'|'press'|'navigate'|'scroll';x?:number;y?:number;text?:string;key?:string;url?:string;deltaY?:number};
export type BrowserSessionViewProps={sessionId:string;viewUrl?:string;disabled?:boolean;onError?:(message:string)=>void};

/** A scoped view of the actual server browser, available only during handoff. */
export default function BrowserSessionView({sessionId,viewUrl,disabled=false,onError}:BrowserSessionViewProps){
 const expected=`/api/browser/sessions/${encodeURIComponent(sessionId)}/view`,endpoint=viewUrl===expected?viewUrl:expected;
 const [view,setView]=useState<BrowserView>(),[error,setError]=useState(''),[address,setAddress]=useState(''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[expanded,setExpanded]=useState(false);
 const abort=useRef<AbortController|null>(null),queue=useRef(Promise.resolve()),sending=useRef(0),image=useRef<HTMLImageElement>(null),addressEditing=useRef(false),mounted=useRef(true),errorCallback=useRef(onError);errorCallback.current=onError;
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  try{const response=await fetch(endpoint,{signal,cache:'no-store'});const body=await response.json();if(signal?.aborted)return;if(!response.ok)throw Error(body.error||'暂时无法读取浏览器画面。');if(typeof body.image!=='string'||body.image.length>16*1024*1024||!['image/jpeg','image/png'].includes(body.mimeType)||!body.viewport?.width||!body.viewport?.height)throw Error('浏览器画面格式不正确。');if(mounted.current){setView(body);setError('');if(!addressEditing.current)setAddress(body.url==='about:blank'?'':body.url);}}
  catch(cause){if(signal?.aborted||!mounted.current)return;const message=cause instanceof Error?cause.message:'读取浏览器画面失败。';setError(message);errorCallback.current?.(message);}
 },[endpoint]);
 useEffect(()=>{
  mounted.current=true;setView(undefined);setError('');setAddress('');setText('');abort.current=new AbortController();const controller=abort.current;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{if(!sending.current)await refresh(controller.signal);if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),1400);};void poll();
  return()=>{mounted.current=false;controller.abort();clearTimeout(timer);};
 },[sessionId,refresh]);
 const act=(action:BrowserAction)=>{
  if(disabled||!mounted.current)return;const actionEndpoint=endpoint.replace(/\/view$/,'/action'),controller=abort.current;sending.current++;setBusy(true);
  queue.current=queue.current.catch(()=>{}).then(async()=>{
   try{if(controller?.signal.aborted)return;const response=await fetch(actionEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action),signal:controller?.signal});const body=await response.json();if(!response.ok)throw Error(body.error||'网页操作未完成。');await refresh(controller?.signal);}
   catch(cause){if(controller?.signal.aborted||!mounted.current)return;const message=cause instanceof Error?cause.message:'网页操作未完成。';setError(message);errorCallback.current?.(message);}
   finally{sending.current--;if(mounted.current)setBusy(sending.current>0);}
  });
 };
 return <section className={`browser-session-view nodrag nopan nowheel ${expanded?'expanded':''}`} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()}>
  <header><span className="browser-view-dot"/><strong>浏览器人工操作</strong>{busy&&<LoaderCircle className="spin" size={13}/>}<span className="browser-view-title">{view?.title||'正在连接真实浏览器'}</span><button type="button" className="icon-button" aria-label="刷新浏览器画面" disabled={disabled||busy} onClick={()=>void refresh(abort.current?.signal)}><RefreshCw size={14}/></button><button type="button" className="icon-button" aria-label={expanded?'收起浏览器画面':'放大浏览器画面'} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button></header>
  <form className="browser-address" onSubmit={event=>{event.preventDefault();addressEditing.current=false;act({action:'navigate',url:address});}}><input aria-label="接管浏览器网页地址" type="url" placeholder="https://example.com" value={address} disabled={disabled} onFocus={()=>{addressEditing.current=true;}} onBlur={()=>{addressEditing.current=false;}} onChange={event=>setAddress(event.target.value)}/><button type="submit" disabled={disabled||busy||!address.trim()}><ExternalLink size={13}/>打开</button></form>
  <p className="browser-view-hint">点击画面操作网页，或先点输入框，再在下方输入文字。完成后使用运行区的「继续」按钮。</p>
  {error&&<p role="status" className="browser-view-error">{error}</p>}
  <div className="browser-viewport" tabIndex={0} role="group" aria-label="远端浏览器交互画面" onKeyDown={event=>{
   if(disabled||event.nativeEvent.isComposing)return;event.preventDefault();const modifiers=[event.ctrlKey?'Control':'',event.metaKey?'Meta':'',event.altKey?'Alt':'',event.shiftKey&&event.key.length!==1?'Shift':''].filter(Boolean);if(event.key.length===1&&!modifiers.length)act({action:'type',text:event.key});else if(!['Control','Meta','Alt','Shift'].includes(event.key))act({action:'press',key:[...modifiers,event.key===' '?'Space':event.key].join('+')});
  }}>
   {view?<img ref={image} draggable={false} src={`data:${view.mimeType};base64,${view.image}`} alt={view.title?`浏览器当前网页：${view.title}`:'真实浏览器当前画面'} onClick={event=>{if(!image.current)return;const rect=image.current.getBoundingClientRect();event.currentTarget.parentElement?.focus();act({action:'click',x:Math.max(0,(event.clientX-rect.left)*view.viewport.width/rect.width),y:Math.max(0,(event.clientY-rect.top)*view.viewport.height/rect.height)});}}/>:<div className="browser-view-loading"><LoaderCircle size={23} className="spin"/><span>{error?'等待重新连接…':'正在读取真实浏览器画面…'}</span></div>}
  </div>
  <div className="browser-keys"><button type="button" disabled={disabled} onClick={()=>act({action:'press',key:'Tab'})}>切换输入框 Tab</button><button type="button" disabled={disabled} onClick={()=>act({action:'press',key:'Enter'})}><CornerDownLeft size={12}/>回车</button><button type="button" disabled={disabled} onClick={()=>act({action:'press',key:'Backspace'})}>删除一字</button><button type="button" disabled={disabled} onClick={()=>act({action:'scroll',deltaY:-550})}><ArrowUp size={12}/>上滚</button><button type="button" disabled={disabled} onClick={()=>act({action:'scroll',deltaY:550})}><ArrowDown size={12}/>下滚</button></div>
  <form className="browser-type" onSubmit={event=>{event.preventDefault();if(text){act({action:'type',text});setText('');}}}><textarea aria-label="填写到网页输入框的文字" rows={2} placeholder="先点击画面中的输入框，再输入文字并点击「填入网页」" value={text} disabled={disabled} onChange={event=>setText(event.target.value)}/><button type="submit" disabled={disabled||!text}><Send size={13}/>填入网页</button></form>
 </section>;
}
