import type {FlowNode,FlowEdge,ResourceBinding} from './types';
export type ResourceDefaults={sessionId?:string;proxyId?:string;profileId?:string};
export type ResourceRelation={id:string;source:string;target:string;label:string};
export function scopeUsesFreshSession(root:{nodes:FlowNode[]},path:string[]):boolean{
 let nodes=root.nodes;
 for(const id of path){const owner=nodes.find(node=>node.id===id);if(!owner?.data.loop)break;if(owner.data.loop.freshSession)return true;nodes=owner.data.loop.nodes;}
 return false;
}
export function freshScopeSessions(nodes:FlowNode[],enabled:boolean):FlowNode[]{
 if(!enabled)return nodes;
 return nodes.map(node=>({...node,data:{...node.data,...(node.data.session?{session:{...node.data.session,persist:false}}:{}),...(node.data.loop?{loop:{...node.data.loop,nodes:freshScopeSessions(node.data.loop.nodes,true)}}:{})}}));
}
export function scopeResourceDefaults(root:{nodes:FlowNode[]},path:string[],defaults:ResourceDefaults,bindings:ResourceBinding[]):ResourceDefaults{
 const value={...defaults};let nodes=root.nodes;
 for(const id of path){const owner=nodes.find(node=>node.id===id);if(!owner?.data.loop)break;
  for(const [key,kind]of [['sessionId','browserSession'],['proxyId','proxy'],['profileId','profile']]as const){
   const explicit=owner.data[key];if(explicit)value[key]=explicit;
   else{const binding=bindings.find(binding=>binding.targetId===id&&findResource(root.nodes,binding.resourceId)?.data.kind===kind);if(binding)value[key]=binding.resourceId;}
  }
  nodes=owner.data.loop.nodes;
 }
 return value;
}
export function applyScopeResources(nodes:FlowNode[],overrides:ResourceDefaults,bindings:ResourceBinding[]=[],resources:FlowNode[]=nodes):FlowNode[]{
 const kinds=new Map<string,string>();
 const collect=(items:FlowNode[])=>{for(const node of items){kinds.set(node.id,node.data.kind);if(node.data.loop)collect(node.data.loop.nodes);}};collect(resources);
 return nodes.map(node=>{
  if(!['request','browser','browserVerification','loop','subflow'].includes(node.data.kind))return node;
  const data={...node.data};
  for(const [key,kind]of [['sessionId','browserSession'],['proxyId','proxy'],['profileId','profile']]as const){
   const explicitBinding=bindings.some(binding=>binding.targetId===node.id&&kinds.get(binding.resourceId)===kind);
   if(!data[key]&&!explicitBinding)data[key]=overrides[key];
  }
  return {...node,data};
 });
}
function findResource(nodes:FlowNode[],id:string):FlowNode|undefined{for(const node of nodes){if(node.id===id)return node;if(node.data.loop){const found=findResource(node.data.loop.nodes,id);if(found)return found;}}}
export function resourceRelations(nodes:FlowNode[],bindings:ResourceBinding[],defaults:ResourceDefaults={}):ResourceRelation[]{
 const known=new Map(nodes.map(node=>[node.id,node])),relations=new Map<string,ResourceRelation>();
 const add=(source:string|undefined,target:string,label:string)=>{if(!source||source===target||!known.has(source)||!known.has(target))return;const id=`config:${source}:${target}`;relations.set(id,{id,source,target,label});};
 for(const node of nodes){
  const data=node.data;
  add(data.sessionId,node.id,'使用会话');add(data.proxyId,node.id,'使用代理');add(data.profileId,node.id,'使用画像');
  add(data.session?.proxyId,node.id,'会话代理');add(data.session?.profileId,node.id,'会话画像');
  if(['request','browser','browserVerification','loop','subflow'].includes(data.kind)){
   if(!data.sessionId)add(defaults.sessionId,node.id,'默认会话');
   if(!data.proxyId&&!data.sessionId&&!defaults.sessionId)add(defaults.proxyId,node.id,'默认代理');
   if(!data.profileId&&!data.sessionId&&!defaults.sessionId)add(defaults.profileId,node.id,'默认画像');
  }
 }
 for(const binding of bindings)add(binding.resourceId,binding.targetId,'配置关联');
 return [...relations.values()];
}
export function configurationEdges(nodes:FlowNode[],bindings:ResourceBinding[],defaults:ResourceDefaults={}):FlowEdge[]{
 return resourceRelations(nodes,bindings,defaults).map(relation=>({...relation,sourceHandle:'resource-out',targetHandle:'resource-in',type:'smoothstep',label:relation.label,deletable:false,selectable:false,focusable:false,style:{stroke:'var(--accent)',strokeDasharray:'5 5',strokeWidth:1.2,opacity:.65},className:'configuration-edge'}));
}
