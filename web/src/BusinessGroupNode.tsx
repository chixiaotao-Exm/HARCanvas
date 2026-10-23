import {createContext,useContext} from 'react';
import {Handle,Position,type Node,type NodeProps} from '@xyflow/react';
import {Layers3,ChevronDown,ChevronRight,AlertCircle,LoaderCircle} from 'lucide-react';
import {RuntimeContext,statusLabels} from './WorkspaceNode';
export type GroupData={groupId:string;label:string;nodeIds:string[];names:string[];expanded:boolean};
export type BusinessGroupNodeType=Node<GroupData,'businessGroup'>;
export const GroupActions=createContext<{toggle:(groupId:string)=>void;locate:(id:string)=>void}>({toggle:()=>{},locate:()=>{}});
export default function BusinessGroupNode({data}:NodeProps<BusinessGroupNodeType>){
 const runtime=useContext(RuntimeContext);const actions=useContext(GroupActions);const states=data.nodeIds.map(id=>runtime.events.get(id)).filter(e=>e!==undefined);const failed=states.find(e=>e.status==='error');const waiting=states.find(e=>e.status==='waiting_input');const running=states.find(e=>e.status==='running');const completed=states.filter(e=>['success','skipped','cancelled'].includes(e.status)).length;const cancelled=states.some(e=>e.status==='cancelled'),allSkipped=states.length>0&&states.every(e=>e.status==='skipped');const status=failed?'error':waiting?'waiting_input':running?'running':cancelled?'cancelled':allSkipped?'skipped':states.length>0&&completed===states.length?'success':'pending';const elapsed=running?Math.max(0,runtime.now-Date.parse(running.time)):undefined;
 return <div className={`business-group-node runtime-${status} ${data.expanded?'expanded':''}`}>
  {!data.expanded&&<Handle type="target" position={Position.Left}/>}
  <div className="group-node-heading"><Layers3 size={17}/><strong>{data.label}</strong><span>{data.nodeIds.length}</span></div>
  {!data.expanded&&<><p>业务分组 · 保留每一条原始请求</p><ul>{data.names.slice(0,3).map((name,i)=><li key={i}>{name}</li>)}</ul><div className={`group-runtime ${status}`}>{running?<LoaderCircle size={12} className="spin"/>:failed?<AlertCircle size={12}/>:null}{states.length?`${statusLabels[status]} · 本次 ${states.length}/${data.nodeIds.length} 个步骤${elapsed!==undefined?` · ${(elapsed/1000).toFixed(1)} s`:''}`:'待检查与编排'}</div>{failed&&<button className="text-button nodrag" onClick={()=>actions.locate(failed.nodeId)}>定位失败子步骤</button>}</>}
  <button className="group-expand nodrag" onClick={()=>actions.toggle(data.groupId)}>{data.expanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>} {data.expanded?'折叠分组':`展开 ${data.nodeIds.length} 个子步骤`}</button>
  {!data.expanded&&<Handle type="source" position={Position.Right}/>}
 </div>;
}
