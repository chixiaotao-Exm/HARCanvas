import {useEffect,useRef,useState} from 'react';
import {Bot,ChevronDown,LocateFixed,MessageCircle,Send,Square,Undo2,Redo2,Settings2,RotateCcw} from 'lucide-react';
import type {ChatMessage} from './agentChat';
import './ChatPanel.css';

export type ChatPanelProps={
 messages:ChatMessage[];collapsed:boolean;busy:boolean;status?:string;selectedNodes?:{id:string;label:string}[];
 values:Record<string,string>;onValueChange:(variable:string,value:string)=>void;onSend:(text:string)=>void;onStop:()=>void;
 onRetry?:(messageId:string)=>void;onToggle:()=>void;onLocate?:(nodeId:string)=>void;onUndo?:()=>void;onRedo?:()=>void;
 canUndo?:boolean;canRedo?:boolean;onSettings?:()=>void;onRun?:()=>void;disabled?:boolean;
};
const stop=(event:React.SyntheticEvent)=>event.stopPropagation();
export function ChatPanel({messages,collapsed,busy,status,selectedNodes=[],values,onValueChange,onSend,onStop,onRetry,onToggle,onLocate,onUndo,onRedo,canUndo,canRedo,onSettings,onRun,disabled}:ChatPanelProps){
 const [draft,setDraft]=useState(''),[width,setWidth]=useState(390),list=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!collapsed)list.current?.scrollTo({top:list.current.scrollHeight,behavior:'smooth'});},[messages,collapsed,status]);
 const send=()=>{const text=draft.trim();if(!text||busy||disabled)return;onSend(text);setDraft('');};
 const startResize=(event:React.PointerEvent<HTMLButtonElement>)=>{event.preventDefault();const start=event.clientX,initial=width;event.currentTarget.setPointerCapture(event.pointerId);const element=event.currentTarget;const move=(event:PointerEvent)=>setWidth(Math.max(320,Math.min(Math.min(window.innerWidth-32,720),initial+start-event.clientX)));const end=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',end);element.removeEventListener('pointercancel',end);};element.addEventListener('pointermove',move);element.addEventListener('pointerup',end,{once:true});element.addEventListener('pointercancel',end,{once:true});};
 return <aside className={`agent-chat ${collapsed?'agent-chat--collapsed':''}`} style={{'--chat-width':`${width}px`} as React.CSSProperties} aria-label="Agent 对话" onPointerDown={stop} onClick={stop} onKeyDown={stop}>
  {collapsed?<button className="agent-chat-launcher" onClick={onToggle} title="展开 Agent 对话"><MessageCircle size={20}/><span>Agent</span>{busy&&<i className="agent-chat-dot"/>}{status&&<small>{status}</small>}</button>:<>
   <button className="agent-chat-resize" onPointerDown={startResize} aria-label="拖动调整对话宽度" title="拖动调整宽度"/>
   <header className="agent-chat-header"><div className="agent-chat-avatar"><Bot size={20}/></div><div className="agent-chat-heading"><strong>画布助手</strong><small>{busy?(status||'正在整理你的要求…'):'用中文描述想要的操作'}</small></div><div className="agent-chat-toolbar">{onUndo&&<button disabled={!canUndo||busy} onClick={onUndo} title="撤销修改" aria-label="撤销修改"><Undo2 size={17}/></button>}{onRedo&&<button disabled={!canRedo||busy} onClick={onRedo} title="重做修改" aria-label="重做修改"><Redo2 size={17}/></button>}{onSettings&&<button onClick={onSettings} title="模型设置" aria-label="模型设置"><Settings2 size={17}/></button>}<button onClick={onToggle} title="收起对话" aria-label="收起对话"><ChevronDown size={19}/></button></div></header>
   <div className="agent-chat-messages" ref={list} role="log" aria-live="polite">
    {!messages.length&&<div className="agent-chat-welcome"><Bot size={32}/><strong>把步骤交给我来整理</strong><p>选中方块后，告诉我想怎么改。也可以直接描述整个流程。</p>{['把这些步骤连起来并排整齐','把选中的步骤重复 5 次','创建一个代理方块'].map(example=><button key={example} disabled={busy||disabled} onClick={()=>setDraft(example)}>{example}</button>)}</div>}
    {messages.map(message=><article className={`agent-chat-message agent-chat-message--${message.role}`} key={message.id}>
     {message.role==='assistant'&&<div className="agent-chat-message-avatar"><Bot size={17}/></div>}<div className="agent-chat-message-content"><div className="agent-chat-bubble">{message.content}{message.status==='pending'&&!message.content&&<span className="agent-chat-thinking">正在思考<span>···</span></span>}
      {message.questions?.length?<div className="agent-chat-questions">{message.questions.map(question=><label key={question.id}><span>{question.title}{question.required&&<em>必填</em>}</span>{question.help&&<small>{question.help}</small>}<input type="text" value={values[question.variable]??''} onChange={event=>onValueChange(question.variable,event.target.value)} placeholder={question.placeholder} disabled={disabled||busy} onPointerDown={stop} onKeyDown={stop} autoComplete="off"/>{question.nodeId&&onLocate&&<button type="button" className="agent-chat-locate" onClick={()=>onLocate(question.nodeId!)}><LocateFixed size={13}/>查看对应方块</button>}</label>)}<small className="agent-chat-local-note">填写内容会同步到方块和运行参数。</small></div>:null}
      {message.nodeIds?.length&&onLocate?<div className="agent-chat-node-links">{message.nodeIds.map(id=><button key={id} onClick={()=>onLocate(id)}><LocateFixed size={13}/>定位步骤</button>)}</div>:null}
      {message.runIntent&&onRun&&<button type="button" className="agent-chat-send" style={{marginTop:10}} disabled={busy||disabled} onClick={onRun}>运行流程</button>}
     </div>{message.changeCount? <small className="agent-chat-change-count">已修改 {message.changeCount} 项，可撤销</small>:null}{message.error&&<p className="agent-chat-error">{message.error}</p>}{(message.status==='failed'||message.status==='cancelled')&&onRetry&&<button className="agent-chat-retry" onClick={()=>onRetry(message.id)} disabled={busy||disabled}><RotateCcw size={13}/>重新发送这条要求</button>}</div>
    </article>)}
   </div>
   <footer className="agent-chat-footer">{selectedNodes.length>0&&<div className="agent-chat-selection"><span>当前选中</span>{selectedNodes.slice(0,5).map(node=><button key={node.id} onClick={()=>onLocate?.(node.id)} title={node.label}>{node.label}</button>)}{selectedNodes.length>5&&<small>等 {selectedNodes.length} 个步骤</small>}</div>}
    <form onSubmit={event=>{event.preventDefault();send();}}><textarea aria-label="给 Agent 的要求" placeholder="例如：把订单编号交给物流查询，再重复 3 次" value={draft} onChange={event=>setDraft(event.target.value)} disabled={disabled} rows={3} onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send();}}}/><div className="agent-chat-compose-actions"><small>Enter 发送 · Shift+Enter 换行</small>{busy?<button type="button" className="agent-chat-stop" onClick={onStop}><Square size={13}/>停止</button>:<button type="submit" className="agent-chat-send" disabled={!draft.trim()||disabled}><Send size={15}/>发送</button>}</div></form>
   </footer>
  </>}
 </aside>;
}
export default ChatPanel;
