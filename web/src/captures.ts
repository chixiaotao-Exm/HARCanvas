import type {Analysis,FlowNode,HarRequest,ParseResult} from './types';

export type CaptureStatus='queued'|'reading'|'ready'|'failed'|'cancelled';
export type CaptureSource={
 id:string;name:string;createdAt:string;status:CaptureStatus;requests:HarRequest[];
 summary:ParseResult['summary'];pages:NonNullable<ParseResult['pages']>;warnings:string[];
 fileSize?:number;error?:string;
};
export const emptySummary=()=>({total:0,api:0,static:0,domains:[] as string[]});
export const newCaptureId=()=>`capture-${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
export function capturePlaceholder(id:string,name:string,fileSize?:number):CaptureSource{
 return {id,name,createdAt:new Date().toISOString(),status:'queued',requests:[],summary:emptySummary(),pages:[],warnings:[],fileSize};
}

/** Recorded IDs are local to one HAR. The public IDs are bounded project-wide IDs. */
export function normalizeCapture(data:ParseResult,name:string,id=newCaptureId(),createdAt=new Date().toISOString()):CaptureSource{
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw new Error('录制资料编号无效。');
 const pages=(data.pages??[]).map((page,index)=>({...page,id:`${id}-page-${index+1}`}));
 const pageIds=new Map((data.pages??[]).map((page,index)=>[page.id,pages[index].id]));
 const requests=data.requests.map((request,index)=>({...request,id:`${id}-req-${index+1}`,captureId:id,originalRequestId:request.originalRequestId??request.id,...(request.pageId?{pageId:pageIds.get(request.pageId)??`${id}-page-unknown`}:{})}));
 return {id,name,createdAt,status:'ready',requests,summary:structuredClone(data.summary),pages,warnings:[...data.warnings]};
}

export function captureProgress(source:CaptureSource,analysis:Analysis|null){
 const ids=new Set(source.requests.map(request=>request.id));
 return new Set((analysis?.suggestions??[]).filter(suggestion=>ids.has(suggestion.requestId)).map(suggestion=>suggestion.requestId)).size;
}

/** Old files keep IDs and bindings intact; only provenance is supplemented. */
export function migrateLegacyCapture(requests:HarRequest[],name:string,datasetKey?:string):CaptureSource[]{
 if(!requests.length)return [];
 const candidate=datasetKey?.replaceAll(/[^A-Za-z0-9_-]/g,'').slice(0,48);
 const id=candidate?`legacy-${candidate}`:'legacy-recording';
 const normalized=requests.map(request=>({...request,captureId:request.captureId??id,originalRequestId:request.originalRequestId??request.id}));
 return [{id,name:name||'原项目录制',createdAt:new Date().toISOString(),status:'ready',requests:normalized,summary:{total:requests.length,api:requests.filter(r=>r.category==='api').length,static:requests.filter(r=>r.category==='static').length,domains:[...new Set(requests.map(r=>r.domain))]},pages:[...new Set(requests.map(r=>r.pageId).filter(Boolean))].map(id=>({id:id!,title:id!,startedDateTime:''})),warnings:[]}];
}

export function withCaptureProvenance(nodes:FlowNode[],requests:HarRequest[]):FlowNode[]{
 const byId=new Map(requests.map(request=>[request.id,request]));
 return nodes.map(node=>{
  const request=node.data.requestId?byId.get(node.data.requestId):undefined;
  const data=request?{...node.data,captureId:node.data.captureId??request.captureId,originalRequestId:node.data.originalRequestId??request.originalRequestId}:node.data;
  return {...node,data:data.loop?{...data,loop:{...data.loop,nodes:withCaptureProvenance(data.loop.nodes,requests)}}:data};
 });
}

export function allProjectNodes(nodes:FlowNode[]):FlowNode[]{
 return nodes.flatMap(node=>[node,...(node.data.loop?allProjectNodes(node.data.loop.nodes):[])]);
}
