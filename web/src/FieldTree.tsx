import {useState} from 'react';
import {ChevronDown,ChevronRight,Braces} from 'lucide-react';
export default function FieldTree({value,path='body',onPick}:{value:unknown;path?:string;onPick:(path:string)=>void}){
 return <div className="field-tree"><TreeItem name={path} value={value} path={path} depth={0} onPick={onPick}/></div>;
}
function TreeItem({name,value,path,depth,onPick}:{name:string;value:unknown;path:string;depth:number;onPick:(path:string)=>void}){
 const [open,setOpen]=useState(depth<1);const entries=value!==null&&typeof value==='object'?Object.entries(value):null;
 return <div className="tree-item"><div className="tree-row" style={{paddingLeft:depth*10}}>{entries?<button className="tree-toggle" onClick={()=>setOpen(!open)} aria-label={`${open?'收起':'展开'} ${path}`}>{open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button>:<Braces size={10}/>}<button title={`选择 ${path}`} onClick={()=>onPick(path)}><strong>{name}</strong><span>{entries?`${Array.isArray(value)?'数组':'对象'} · ${entries.length}`:String(value).slice(0,65)}</span></button></div>{entries&&open&&depth<6&&<>{entries.slice(0,60).map(([key,item])=><TreeItem key={key} name={key} value={item} path={`${path}.${key}`} depth={depth+1} onPick={onPick}/>)}{entries.length>60&&<small>仅展示前 60 个字段，可在高级模式填写路径。</small>}</>}</div>;
}
