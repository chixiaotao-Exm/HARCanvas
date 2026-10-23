import {createContext,useContext} from 'react';
import {Handle,Position,useReactFlow,type NodeProps} from '@xyflow/react';
import {Variable,Network,Braces,GitBranch,SquareTerminal,Hand,ShieldCheck,Trash2,LoaderCircle,CheckCircle2,AlertCircle,Clock3,MinusCircle} from 'lucide-react';
import type {FlowNode,FlowEdge,Kind,RunEvent} from './types';
export const blockMeta={input:{name:'输入参数',icon:Variable,color:'#7c61d6',help:'为后续步骤提供可复用参数'},request:{name:'请求步骤',icon:Network,color:'#2688a6',help:'执行 HAR 中有明确用途的请求'},extract:{name:'提取字段',icon:Braces,color:'#ae7a29',help:'从前序响应选择字段并存入变量'},condition:{name:'条件判断',icon:GitBranch,color:'#ac5c88',help:'根据变量选择是或否分支'},output:{name:'输出结果',icon:SquareTerminal,color:'#278768',help:'汇总并展示业务结果'},manual:{name:'人工输入',icon:Hand,color:'#b27819',help:'暂停流程，填写信息后继续'},assertion:{name:'结果断言',icon:ShieldCheck,color:'#5d6db7',help:'检查业务字段是否满足成功条件'}};
export const auxiliaryKinds:Kind[]=['input','extract','condition','manual','assertion','output'];
export const RuntimeContext=createContext<{events:Map<string,RunEvent>;now:number}>({events:new Map(),now:Date.now()});
export const statusLabels={pending:'等待执行',running:'正在运行',waiting_input:'等待人工输入',success:'执行完成',error:'执行失败',skipped:'已跳过',cancelled:'已取消'};
export function WorkspaceNode({id,data,selected}:NodeProps<FlowNode>){
 const info=blockMeta[data.kind];const Icon=info.icon;const {deleteElements}=useReactFlow<FlowNode,FlowEdge>();const runtime=useContext(RuntimeContext);const event=runtime.events.get(id);
 const state=event?.status;const StateIcon=state==='running'?LoaderCircle:state==='success'?CheckCircle2:state==='error'?AlertCircle:state==='waiting_input'?Hand:state==='skipped'||state==='cancelled'?MinusCircle:Clock3;
 const elapsed=event?.durationMs??(state==='running'?Math.max(0,runtime.now-Date.parse(event!.time)):undefined);
 return <div className={`block-node ${selected?'selected':''} runtime-${state??'idle'}`} style={{'--node-color':info.color} as React.CSSProperties}>
  {data.kind!=='input'&&<Handle type="target" position={Position.Left}/>}
  <div className="node-top"><span className="node-icon"><Icon size={15}/></span><span>{info.name}</span><button className="node-delete nodrag nopan" aria-label={`删除积木：${data.label}`} title="删除积木" onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();void deleteElements({nodes:[{id}]});}}><Trash2 size={13}/></button></div>
  {data.groupLabel&&<div className="node-group">{data.groupLabel}</div>}
  <strong className="node-title">{data.label||info.name}</strong><p className="node-purpose">{data.description||info.help}</p>
  <div className="node-detail">{data.kind==='request'?<><b>{data.method||'GET'}</b><span>{data.url?.replace(/^https?:\/\//,'')||'需要请求地址'}</span></>:data.kind==='input'||data.kind==='manual'?<><code>{data.variable||'未填写变量名'}</code>{data.kind==='manual'&&<span>暂停后填写</span>}</>:data.kind==='extract'?<code>{data.path||'请选择响应字段'}</code>:data.kind==='condition'||data.kind==='assertion'?<code>{data.variable||'变量'} {data.operator||'eq'} {data.expected||'…'}</code>:<span>{data.template||'设置输出模板'}</span>}</div>
  {data.readiness&&data.readiness!=='ready'&&<div className={`readiness ${data.readiness}`}><AlertCircle size={11}/>{({'missing-input':'需要补充输入',manual:'需要人工处理',unsupported:'暂不支持'} as Record<string,string>)[data.readiness]||'待确认'}</div>}
  {state&&<div className={`node-runtime ${state}`}><StateIcon size={12} className={state==='running'?'spin':''}/><span>{statusLabels[state]}</span>{elapsed!==undefined&&<code>{(elapsed/1000).toFixed(1)} s</code>}</div>}
  {data.kind==='condition'?<><span className="handle-caption true-caption">是</span><span className="handle-caption false-caption">否</span><Handle id="true" type="source" position={Position.Right} style={{top:'68%'}}/><Handle id="false" type="source" position={Position.Right} style={{top:'88%'}}/></>:data.kind!=='output'&&<Handle type="source" position={Position.Right}/>}
 </div>;
}
