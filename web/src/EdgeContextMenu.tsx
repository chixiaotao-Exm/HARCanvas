import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeftToLine, ArrowRightToLine, Scissors, X } from 'lucide-react';
import { clampMenuPosition, type DeletionKind } from './graph';
type Props={x:number;y:number;sourceLabel:string;targetLabel:string;counts:Record<DeletionKind,{nodes:number;edges:number}>;onDelete:(kind:DeletionKind)=>void;onClose:()=>void};
export default function EdgeContextMenu({x,y,sourceLabel,targetLabel,counts,onDelete,onClose}:Props) {
  const ref=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState({x,y});
  useLayoutEffect(()=>{const rect=ref.current?.getBoundingClientRect();if(!rect)return;setPosition(clampMenuPosition({x,y},{width:rect.width,height:rect.height},{width:window.innerWidth,height:window.innerHeight}));},[x,y,counts.before.nodes,counts.after.nodes,sourceLabel,targetLabel]);
  useEffect(()=>{
    const pointer=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))onClose();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}};
    const scroll=(event:Event)=>{if(!(event.target instanceof Node)||!ref.current?.contains(event.target))onClose();};
    document.addEventListener('pointerdown',pointer,true);
    document.addEventListener('keydown',key,true);
    window.addEventListener('resize',onClose);
    window.addEventListener('scroll',scroll,true);
    return()=>{document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('keydown',key,true);window.removeEventListener('resize',onClose);window.removeEventListener('scroll',scroll,true);};
  },[onClose]);
  return <div ref={ref} className="edge-context-menu" role="menu" aria-label="连线操作" style={{left:position.x,top:position.y}} onContextMenu={event=>event.preventDefault()}>
    <div className="edge-menu-header"><span>连线操作</span><button aria-label="关闭连线菜单" onClick={onClose}><X size={13}/></button></div>
    <div className="edge-menu-route" title={`${sourceLabel} → ${targetLabel}`}><span>{sourceLabel}</span><b>→</b><span>{targetLabel}</span></div>
    <button className="edge-menu-action" role="menuitem" aria-label="删除连线" onClick={()=>onDelete('edge')}><Scissors size={16}/><span><strong>删除连线</strong><small>保留两端积木，仅断开这条连接</small></span><em>1 条</em></button>
    <div className="edge-menu-divider"/>
    <button className="edge-menu-action destructive" role="menuitem" aria-label="删除前段" onClick={()=>onDelete('before')}><ArrowLeftToLine size={16}/><span><strong>删除前段<em>{counts.before.nodes} 个积木</em></strong><small>起点及全部上游 · 保留终点</small><small className="edge-menu-count">同时移除 {counts.before.edges} 条关联连线</small></span></button>
    <button className="edge-menu-action destructive" role="menuitem" aria-label="删除后段" onClick={()=>onDelete('after')}><ArrowRightToLine size={16}/><span><strong>删除后段<em>{counts.after.nodes} 个积木</em></strong><small>终点及全部下游 · 保留起点</small><small className="edge-menu-count">同时移除 {counts.after.edges} 条关联连线</small></span></button>
    <p className="edge-menu-note">共享分支的关联线也会断开，未命中的积木保留。删除后可点击「撤销删除」。</p>
  </div>;
}
