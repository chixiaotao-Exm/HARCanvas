import {createContext,useContext,useEffect,useRef} from 'react';
import {Handle,Position,useReactFlow,useUpdateNodeInternals,type NodeProps} from '@xyflow/react';
import {Variable,Network,Braces,GitBranch,SquareTerminal,Hand,ShieldCheck,Trash2,LoaderCircle,CheckCircle2,AlertCircle,Clock3,MinusCircle,Globe,Fingerprint,Repeat2,Layers,LogOut,Waypoints,Monitor} from 'lucide-react';
import type {FlowNode,FlowEdge,Kind,RunEvent} from './types';
import {InlineInputContext,InlineInputs,inlineInputModel} from './InlineInputs';
import {ResourceFields} from './ResourceFields';
import {isResourceKind,resourceSummary} from './resources';
export const blockMeta={input:{name:'输入参数',icon:Variable,color:'#7c61d6',help:'为后续步骤提供可复用参数'},request:{name:'请求步骤',icon:Network,color:'#2688a6',help:'执行 HAR 中有明确用途的请求'},extract:{name:'提取字段',icon:Braces,color:'#ae7a29',help:'从前序响应选择字段并存入变量'},condition:{name:'条件判断',icon:GitBranch,color:'#ac5c88',help:'根据变量选择是或否分支'},output:{name:'输出结果',icon:SquareTerminal,color:'#278768',help:'汇总并展示业务结果'},manual:{name:'人工输入',icon:Hand,color:'#b27819',help:'暂停流程，填写信息后继续'},assertion:{name:'结果断言',icon:ShieldCheck,color:'#5d6db7',help:'检查业务字段是否满足成功条件'},proxy:{name:'代理连接',icon:Waypoints,color:'#2c8792',help:'粘贴代理链接，选择会话片段和轮换方式'},profile:{name:'浏览器画像',icon:Fingerprint,color:'#8960b6',help:'配置浏览器、语言、时区和窗口大小'},browserSession:{name:'保持浏览器环境',icon:Monitor,color:'#447bb2',help:'让一组步骤使用同一个 Cookie 会话、代理和画像'},browser:{name:'浏览器操作',icon:Globe,color:'#407cba',help:'在真实浏览器中打开网页并进行支持的操作'},browserVerification:{name:'打开浏览器完成验证',icon:Hand,color:'#b27819',help:'暂停流程，在真实浏览器中完成操作后继续'},loop:{name:'重复步骤',icon:Repeat2,color:'#bf7c32',help:'重复内部流程，保留每轮执行结果'},subflow:{name:'子流程',icon:Layers,color:'#6b70b4',help:'将一组步骤收起为可以复用的流程'},break:{name:'提前结束循环',icon:LogOut,color:'#ad6574',help:'提前结束当前循环，继续后续步骤'}};
export const auxiliaryKinds:Kind[]=['input','extract','condition','manual','assertion','output','proxy','profile','browserSession','browser','browserVerification','loop','subflow','break'];
export const RuntimeContext=createContext<{events:Map<string,RunEvent>;now:number}>({events:new Map(),now:Date.now()});
export const statusLabels={pending:'等待执行',running:'正在运行',waiting_input:'等待人工输入',success:'执行完成',error:'执行失败',skipped:'已跳过',cancelled:'已取消'};
export function WorkspaceNode({id,data,selected}:NodeProps<FlowNode>){
 const info=blockMeta[data.kind];const Icon=info.icon;const {deleteElements}=useReactFlow<FlowNode,FlowEdge>();const runtime=useContext(RuntimeContext);const event=runtime.events.get(id);
 const inputState=useContext(InlineInputContext),inputs=inlineInputModel(id,data,inputState.values),updateNodeInternals=useUpdateNodeInternals(),element=useRef<HTMLDivElement>(null);
 const inputShape=inputs.fields.map(field=>field.key).join('|');
 useEffect(()=>{updateNodeInternals(id);},[id,inputShape,updateNodeInternals]);
 useEffect(()=>{if(!element.current||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(()=>updateNodeInternals(id));observer.observe(element.current);return()=>observer.disconnect();},[id,updateNodeInternals]);
 const readinessLabel=data.readiness==='missing-input'&&inputs.total?(inputs.missingRequired?`还需填写 ${inputs.missingRequired} 项`:'输入已准备，仍需核对步骤'):({'missing-input':'需要补充输入',manual:'需要人工处理',unsupported:'暂不支持'} as Record<string,string>)[data.readiness??'']||'待确认';
 const state=event?.status;const StateIcon=state==='running'?LoaderCircle:state==='success'?CheckCircle2:state==='error'?AlertCircle:state==='waiting_input'?Hand:state==='skipped'||state==='cancelled'?MinusCircle:Clock3;
 const elapsed=event?.durationMs??(state==='running'?Math.max(0,runtime.now-Date.parse(event!.time)):undefined);
 return <div ref={element} className={`block-node ${isResourceKind(data.kind)?'resource-node':''} ${selected?'selected':''} runtime-${state??'idle'}`} style={{'--node-color':info.color} as React.CSSProperties}>
  <Handle id="resource-in" type="target" position={Position.Top} isConnectable={false} className="resource-config-handle"/>
  <Handle id="resource-out" type="source" position={Position.Bottom} isConnectable={false} className="resource-config-handle"/>
  {data.kind!=='input'&&!isResourceKind(data.kind)&&<Handle type="target" position={Position.Left}/>}
  <div className="node-top"><span className="node-icon"><Icon size={15}/></span><span>{info.name}</span><button className="node-delete nodrag nopan" aria-label={`删除积木：${data.label}`} title="删除积木" onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();void deleteElements({nodes:[{id}]});}}><Trash2 size={13}/></button></div>
  {data.groupLabel&&<div className="node-group">{data.groupLabel}</div>}
  <strong className="node-title">{data.label||info.name}</strong><p className="node-purpose">{data.description||info.help}</p>
  <div className="node-detail">{data.kind==='request'?<><b>{data.method||'GET'}</b><span>{data.url?.replace(/^https?:\/\//,'')||'需要请求地址'}</span></>:data.kind==='input'||data.kind==='manual'?<><code>{data.variable||'未填写变量名'}</code>{data.kind==='manual'&&<span>暂停后填写</span>}</>:data.kind==='extract'?<code>{data.path||'请选择响应字段'}</code>:data.kind==='condition'||data.kind==='assertion'?<code>{data.variable||'变量'} {data.operator||'eq'} {data.expected||'…'}</code>:<span>{resourceSummary(data)||data.template||(data.kind==='output'?'设置输出模板':info.help)}</span>}</div>
  <InlineInputs nodeId={id} fields={inputs.fields} total={inputs.total}/>
  <ResourceFields nodeId={id} data={data} compact/>
  {data.readiness&&data.readiness!=='ready'&&<div className={`readiness ${data.readiness}`}><AlertCircle size={11}/>{readinessLabel}</div>}
  {data.kind==='request'&&data.readiness==='missing-input'&&inputs.total>0&&inputs.missingRequired===0&&inputState.onConfirm&&<button type="button" className="node-confirm-inputs nodrag nopan" disabled={inputState.disabled} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();inputState.onConfirm?.(id);}}>已核对其余参数，标记就绪</button>}
  {data.kind==='request'&&data.readiness==='missing-input'&&!inputs.total&&inputState.onConfigure&&<button type="button" className="node-configure-inputs nodrag nopan" disabled={inputState.disabled} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();inputState.onConfigure?.(id);}}>设置要填写的资料</button>}
  {state&&<div className={`node-runtime ${state}`}><StateIcon size={12} className={state==='running'?'spin':''}/><span>{statusLabels[state]}</span>{elapsed!==undefined&&<code>{(elapsed/1000).toFixed(1)} s</code>}</div>}
  {data.kind==='condition'?<><span className="handle-caption true-caption">是</span><span className="handle-caption false-caption">否</span><Handle id="true" type="source" position={Position.Right} style={{top:'68%'}}/><Handle id="false" type="source" position={Position.Right} style={{top:'88%'}}/></>:data.kind!=='output'&&data.kind!=='break'&&!isResourceKind(data.kind)&&<Handle type="source" position={Position.Right}/>}
 </div>;
}
