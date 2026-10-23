import {createContext,useContext,useId} from 'react';
import {bindingVariable} from './bindings';
import type {BlockData} from './types';
import './InlineInputs.css';

export type InlineInputState={values:Record<string,string>;disabled:boolean;onChange:(key:string,value:string)=>void;onConfigure?:(nodeId:string)=>void;onConfirm?:(nodeId:string)=>void};
export const InlineInputContext=createContext<InlineInputState>({values:{},disabled:true,onChange:()=>{}});
export type InlineInputField={key:string;name:string;placeholder:string;required:boolean;defaultValue:string};

export function inlineInputModel(nodeId:string,data:BlockData,values:Record<string,string>){
 const all:InlineInputField[]=data.kind==='request'?(data.bindings??[]).filter(binding=>binding.mode==='user').map(binding=>({key:bindingVariable(nodeId,binding.id),name:binding.name,placeholder:binding.placeholder||`请输入${binding.name}`,required:binding.required!==false,defaultValue:binding.value??''})):data.kind==='input'&&data.variable?[{key:data.variable,name:data.label||'输入参数',placeholder:`请输入${data.label||'参数'}`,required:true,defaultValue:data.value??''}]:[];
 const missingRequired=all.filter(field=>field.required&&!inlineInputValue(field,values).trim()).length;
 return {fields:all.slice(0,16),total:all.length,missingRequired};
}

export function inlineInputValue(field:InlineInputField,values:Record<string,string>){
 return Object.hasOwn(values,field.key)&&typeof values[field.key]==='string'?values[field.key]:field.defaultValue;
}

export function InlineInputs({nodeId,fields,total}:{nodeId:string;fields:InlineInputField[];total:number}){
 const state=useContext(InlineInputContext),id=useId();
 if(!fields.length)return null;
 return <div className="node-inputs nodrag nopan nowheel" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
  <div className="node-input-heading">本次输入</div>
  {fields.map((field,index)=><label className="node-input-field" key={field.key} htmlFor={`${id}-${index}`}><span>{field.name}<small>{field.required?'必填':'选填'}</small></span><input id={`${id}-${index}`} className="nodrag nopan nowheel" type="text" value={inlineInputValue(field,state.values)} placeholder={field.placeholder} required={field.required} disabled={state.disabled} maxLength={16384} autoComplete="off" spellCheck={false} onChange={event=>state.onChange(field.key,event.target.value)}/></label>)}
  {total>fields.length&&<p className="node-input-more">还有 {total-fields.length} 项参数，{state.onConfigure?<button type="button" disabled={state.disabled} onClick={()=>state.onConfigure?.(nodeId)}>打开步骤设置</button>:'请在运行准备中填写'}。</p>}
 </div>;
}
