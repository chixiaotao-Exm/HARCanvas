import type {FlowNode,FlowEdge,PreflightIssue} from './types';
import {compileBindings} from './bindings.ts';
import {readinessIssues} from './repair.ts';

export type GraphScope={nodes:FlowNode[];edges:FlowEdge[]};
export function graphScope(root:GraphScope,path:string[]):GraphScope{
 let current=root;
 for(const id of path){const node=current.nodes.find(node=>node.id===id);if(!node?.data.loop)return root;current=node.data.loop;}
 return {nodes:current.nodes,edges:current.edges};
}
export function replaceGraphScope(root:GraphScope,path:string[],next:GraphScope):GraphScope{
 if(!path.length)return next;
 const [id,...rest]=path,owner=root.nodes.find(node=>node.id===id);
 if(!owner?.data.loop)throw new Error('当前子流程已不存在，请返回主流程。');
 const body=replaceGraphScope(owner.data.loop,rest,next);
 return {...root,nodes:root.nodes.map(node=>node.id===id?{...node,data:{...node.data,loop:{...node.data.loop!,...body,entryId:body.nodes.some(child=>child.id===node.data.loop!.entryId)?node.data.loop!.entryId:undefined}}}:node)};
}
export function scopeBreadcrumbs(root:GraphScope,path:string[]){
 const result:{id:string;label:string}[]=[];let current=root;
 for(const id of path){const node=current.nodes.find(node=>node.id===id);if(!node?.data.loop)break;result.push({id,label:node.data.label});current=node.data.loop;}
 return result;
}
export function findNodeScope(root:GraphScope,id:string,path:string[]=[]):{node:FlowNode;path:string[]}|undefined{
 for(const node of root.nodes){if(node.id===id)return {node,path};if(node.data.loop){const nested=findNodeScope(node.data.loop,id,[...path,node.id]);if(nested)return nested;}}
}

/** Compile each body's inputs once; runtime loop iterations still execute separately. */
export function compileProjectBindings(nodes:FlowNode[],edges:FlowEdge[],values:Record<string,string>){
 const current=compileBindings(nodes,edges,values);
 const issues:PreflightIssue[]=[...current.issues];
 for(const node of current.nodes){
  if(!node.data.loop)continue;
  const original=nodes.find(candidate=>candidate.id===node.id)!.data.loop!;
  const nested=compileProjectBindings(original.nodes,original.edges,values);
  node.data.loop={...original,nodes:nested.nodes,edges:nested.edges,entryId:nested.entryMap[original.entryId??'']||original.entryId};
  Object.assign(current.inputs,nested.inputs);Object.assign(current.nodeMap,nested.nodeMap);
  issues.push(...nested.issues,...readinessIssues(original.nodes));
 }
 return {...current,issues};
}
