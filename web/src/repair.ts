import type {FlowNode,FlowEdge,HarRequest,ParameterBinding,PreflightIssue} from './types';
import {bindingVariable,compileBindings} from './bindings.ts';
import {findFieldRelations} from './analysisContext.ts';

export type RepairField={id:string;target:'body'|'header'|'query';path:string;valueType:'string';existingBinding:boolean};
export type RepairSource={id:string;fieldId:string;sourceNodeId:string;sourcePath:string;evidence:string};
export type RepairNode={id:string;label:string;kind:string;readiness:string;description:string;uncertainty:string;issues:string[];fields:RepairField[];sources:RepairSource[]};
export type RepairInput={goal:string;nodes:RepairNode[]};
export type RepairQuestion={id:string;title:string;help:string;placeholder:string;required:boolean};
export type RepairBinding={nodeId:string;fieldId:string;mode:'user'|'manual'|'upstream';questionId?:string;sourceId?:string;reason:string};
export type RepairNote={nodeId:string;title:string;message:string;kind:'manual'|'unsupported'|'review'};
export type RepairPlan={summary:string;questions:RepairQuestion[];bindings:RepairBinding[];notes:RepairNote[];warnings:string[]};
export type RepairSnapshot={input:RepairInput;fingerprint:string};
const encoder=new TextEncoder();
const bytes=(value:string)=>encoder.encode(value).length;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const answerOf=(answers:Record<string,string>,key:string)=>Object.hasOwn(answers,key)&&typeof answers[key]==='string'?answers[key]:'';
const safePath=(path:string)=>path.length>0&&bytes(path)<=1024&&path.split('.').every(key=>key&&!['__proto__','prototype','constructor'].includes(key)&&!/[{}]/.test(key));
const systemHeader=/^(?:cookie|host|content-length|connection|proxy-.*|keep-alive|origin|referer|user-agent|sec-.*|accept.*|cache-control|pragma|priority|content-type|transfer-encoding|te|trailer|upgrade)$/i;
const headerName=(name:string)=>bytes(name)<=1024&&/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)&&!systemHeader.test(name)&&!['__proto__','prototype','constructor'].includes(name.toLowerCase());
const targetKey=(field:{target:string;path:string})=>`${field.target}:${field.target==='header'?field.path.toLowerCase():field.path}`;
const error=()=>new Error('修补建议与当前画布或可用字段不一致，请重新让 Agent 检查。');

export function repairFingerprint(nodes:FlowNode[],edges:FlowEdge[]):string {
  // Kept only in this browser's memory; never sent to a model, logs, or storage.
  return JSON.stringify({nodes:nodes.map(node=>({id:node.id,data:node.data})),edges:edges.map(edge=>({id:edge.id,source:edge.source,target:edge.target,sourceHandle:edge.sourceHandle,targetHandle:edge.targetHandle}))});
}

export function readinessIssues(nodes:FlowNode[]):PreflightIssue[]{
  return nodes.filter(node=>node.data.kind==='request'&&node.data.readiness&&node.data.readiness!=='ready').map(node=>({
    nodeId:node.id,field:'readiness',code:node.data.readiness==='unsupported'?'UNSUPPORTED_STEP':'REVIEW_REQUIRED',
    message:node.data.readiness==='unsupported'?`「${node.data.label}」需要浏览器能力，当前执行器还不能完成。`:node.data.readiness==='manual'?`「${node.data.label}」需要安排本次运行的人工输入。`:`「${node.data.label}」还需要补充或核对本次使用的资料。`,
    suggestedAction:node.data.readiness==='unsupported'?'查看修补助手的说明，在网页中处理，或调整流程。':node.data.readiness==='manual'?'让 Agent 找到需要人工填写的字段，执行到这一步时在页面内输入。':node.data.bindings?.some(binding=>binding.mode==='user')?'在方块内填写本次资料，核对其余参数后标记就绪；不清楚的部分可使用修补助手。':'打开修补助手，用表单补充资料，再逐步确认。',
  }));
}

function ancestors(nodeId:string,edges:FlowEdge[]):Set<string>{
  const result=new Set<string>(),todo=edges.filter(edge=>edge.target===nodeId).map(edge=>edge.source);
  while(todo.length){const next=todo.pop()!;if(next===nodeId||result.has(next))continue;result.add(next);todo.push(...edges.filter(edge=>edge.target===next).map(edge=>edge.source));}
  return result;
}
function responseValue(request:HarRequest,path:string):unknown{
  if(path.startsWith('headers.'))return request.responseHeaders[path.slice(8)];
  if(!path.startsWith('body.'))return;
  try{let item:unknown=JSON.parse(request.responseBody);for(const key of path.slice(5).split('.')){if(!record(item)&&!Array.isArray(item)||item===null||!Object.hasOwn(item,key))return;item=(item as Record<string,unknown>)[key];}return item;}catch{return;}
}
function bodyFields(text:string):{path:string;value:string}[]{
  if(bytes(text)>2*1024*1024)return [];
  try{
    const parsed:unknown=JSON.parse(text,(_key,item:unknown)=>{
      if(typeof item==='number'&&(!Number.isFinite(item)||(Number.isInteger(item)&&!Number.isSafeInteger(item))))throw error();
      return item;
    });
    const result:{path:string;value:string}[]=[];
    const visit=(item:unknown,path:string,depth:number)=>{
      if(typeof item==='string'&&path){result.push({path,value:item});return;}
      if(!item||typeof item!=='object'||depth>=6)return;
      for(const [key,value]of Object.entries(item)){
        if(!key||/[.{}\[\]\x00-\x1f]/.test(key)||['__proto__','prototype','constructor'].includes(key))continue;
        const location=path?`${path}.${key}`:key;
        if(safePath(location))visit(value,location,depth+1);
      }
    };
    visit(parsed,'',0);return result;
  }catch{return [];}
}

/** Build an opaque capability catalog with field names and evidence, never values. */
export function buildRepairSnapshot(nodes:FlowNode[],edges:FlowEdge[],requests:HarRequest[],issues:PreflightIssue[],goal=''):RepairSnapshot{
  if(!nodes.length||nodes.length>100)throw new Error('修补助手一次支持 1–100 个画布步骤，请先缩小流程。');
  if(bytes(goal)>16000)throw new Error('目标说明过长，请缩短后再修补。');
  const known=new Set(nodes.map(node=>node.id));
  if(known.size!==nodes.length||nodes.some(node=>!id(node.id)))throw new Error('画布包含无效或重复的步骤编号，请检查项目。');
  const relations=findFieldRelations(requests),requestById=new Map(requests.map(request=>[request.id,request]));
  const catalog:RepairNode[]=nodes.map(node=>{
    const data=node.data,raw:{target:RepairField['target'];path:string;value:string}[]=[];
    if(data.kind==='request'){
      for(const field of bodyFields(data.body??''))raw.push({target:'body',path:field.path,value:field.value});
      const headers=Object.entries(data.headers??{}),headerCounts=new Map<string,number>();
      for(const [name]of headers)headerCounts.set(name.toLowerCase(),(headerCounts.get(name.toLowerCase())??0)+1);
      const connectionHeaders=new Set(headers.filter(([name])=>name.toLowerCase()==='connection').flatMap(([,value])=>value.split(',').map(name=>name.trim().toLowerCase())));
      for(const [name,value]of headers)if(headerName(name)&&!connectionHeaders.has(name.toLowerCase())&&headerCounts.get(name.toLowerCase())===1)raw.push({target:'header',path:name,value});
      try{const url=new URL(data.url??'');for(const name of new Set(url.searchParams.keys()))if(safePath(name)&&url.searchParams.getAll(name).length===1)raw.push({target:'query',path:name,value:url.searchParams.get(name)!});}catch{/* Address errors are reported by preflight. */}
    }
    raw.sort((left,right)=>targetKey(left).localeCompare(targetKey(right)));
    if(raw.length>80)throw new Error('某个步骤的可填写字段超过 80 个，请先拆分流程或在参数向导中配置。');
    const fields:RepairField[]=raw.map((field,index)=>({id:`field-${index+1}`,target:field.target,path:field.path,valueType:'string',existingBinding:Boolean(data.bindings?.some(binding=>targetKey(binding)===targetKey(field)||(field.target==='body'&&binding.target==='body'&&!binding.path)||(field.target==='query'&&binding.target==='url')))}));
    const sources:RepairSource[]=[],upstream=ancestors(node.id,edges);
    for(const relation of relations.filter(relation=>relation.targetRequestId===data.requestId)){
      const fieldIndex=raw.findIndex(field=>`${field.target==='header'?'headers':field.target}.${field.path}`===relation.targetPath);
      if(fieldIndex<0||!safePath(relation.sourcePath))continue;
      for(const sourceNode of nodes.filter(candidate=>candidate.data.kind==='request'&&candidate.data.requestId===relation.sourceRequestId&&upstream.has(candidate.id))){
        const sourceRequest=requestById.get(relation.sourceRequestId);
        if(!sourceRequest||typeof responseValue(sourceRequest,relation.sourcePath)!=='string'||responseValue(sourceRequest,relation.sourcePath)!==raw[fieldIndex].value)continue;
        sources.push({id:`source-${sources.length+1}`,fieldId:fields[fieldIndex].id,sourceNodeId:sourceNode.id,sourcePath:relation.sourcePath,evidence:relation.evidence});
      }
    }
    if(sources.length>80)throw new Error('某个步骤的来源候选过多，请先缩小流程。');
    const result:RepairNode={id:node.id,label:data.label,kind:data.kind,readiness:data.readiness??'ready',description:data.description??'',uncertainty:data.uncertainty??'',issues:[...new Set(issues.filter(issue=>issue.nodeId===node.id).map(issue=>issue.code))],fields,sources};
    if(!['ready','missing-input','manual','unsupported'].includes(result.readiness))throw new Error('步骤的准备状态无效，请先在步骤设置中核对。');
    if(bytes(result.label)>400||bytes(result.description)>4000||bytes(result.uncertainty)>4000||result.issues.length>30||result.issues.some(code=>bytes(code)>100))throw new Error('某个步骤的说明或问题记录过长，请缩短后再修补。');
    return result;
  });
  const input={goal,nodes:catalog};
  // Match Go's HTML and line-separator escaping so the server has the same budget.
  if(bytes(JSON.stringify(input).replace(/[<>&\u2028\u2029]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`))>512*1024)throw new Error('修补资料超过 512 KiB，请缩小流程。');
  return {input,fingerprint:repairFingerprint(nodes,edges)};
}

/** Reject free-form patches; the model can refer only to submitted capabilities. */
export function parseRepairPlan(value:unknown,input:RepairInput):RepairPlan{
  const text=(value:unknown,limit:number,blank=false):value is string=>typeof value==='string'&&bytes(value)<=limit&&(blank||Boolean(value.trim()));
  const only=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
  if(!record(value)||!only(value,['summary','questions','bindings','notes','warnings'])||!text(value.summary,2000)||!Array.isArray(value.questions)||value.questions.length>32||!Array.isArray(value.bindings)||value.bindings.length>100||!Array.isArray(value.notes)||value.notes.length>100||!Array.isArray(value.warnings)||value.warnings.length>12||!value.warnings.every(warning=>text(warning,1000,true)))throw error();
  const nodes=new Map(input.nodes.map(node=>[node.id,node])),questions:RepairQuestion[]=[],questionIds=new Set<string>();
  for(const question of value.questions){if(!record(question)||!only(question,['id','title','help','placeholder','required'])||!id(question.id)||['__proto__','prototype','constructor'].includes(question.id)||questionIds.has(question.id)||!text(question.title,200)||!text(question.help,1000,true)||!text(question.placeholder,300,true)||typeof question.required!=='boolean')throw error();questionIds.add(question.id);questions.push({id:question.id,title:question.title,help:question.help,placeholder:question.placeholder,required:question.required});}
  const bindings:RepairBinding[]=[],targets=new Set<string>(),usedQuestions=new Set<string>();
  for(const binding of value.bindings){
    if(!record(binding)||!only(binding,['nodeId','fieldId','mode','questionId','sourceId','reason'])||typeof binding.nodeId!=='string'||typeof binding.fieldId!=='string'||!text(binding.reason,1000))throw error();
    const node=nodes.get(binding.nodeId),field=node?.fields.find(field=>field.id===binding.fieldId),key=`${binding.nodeId}:${binding.fieldId}`;
    if(!node||node.kind!=='request'||node.readiness==='unsupported'||!field||field.existingBinding||targets.has(key))throw error();targets.add(key);
    const result:RepairBinding={nodeId:node.id,fieldId:field.id,mode:binding.mode as RepairBinding['mode'],reason:binding.reason};
    if(binding.mode==='user'){if(!id(binding.questionId)||!questionIds.has(binding.questionId)||binding.sourceId!==undefined)throw error();usedQuestions.add(binding.questionId);result.questionId=binding.questionId;}
    else if(binding.mode==='manual'){if(binding.questionId!==undefined||binding.sourceId!==undefined)throw error();}
    else if(binding.mode==='upstream'){if(!id(binding.sourceId)||binding.questionId!==undefined||!node.sources.some(source=>source.id===binding.sourceId&&source.fieldId===field.id))throw error();result.sourceId=binding.sourceId;}
    else throw error();
    bindings.push(result);
  }
  if(usedQuestions.size!==questionIds.size)throw error();
  const notes:RepairNote[]=[],noted=new Set<string>();
  for(const note of value.notes){if(!record(note)||!only(note,['nodeId','title','message','kind'])||typeof note.nodeId!=='string'||!nodes.has(note.nodeId)||!text(note.title,200)||!text(note.message,2000)||!['manual','unsupported','review'].includes(String(note.kind)))throw error();notes.push({nodeId:note.nodeId,title:note.title,message:note.message,kind:note.kind as RepairNote['kind']});noted.add(note.nodeId);}
  if(input.nodes.some(node=>node.readiness!=='ready'&&!noted.has(node.id)))throw error();
  if(input.nodes.some(node=>node.readiness==='unsupported'&&!notes.some(note=>note.nodeId===node.id&&note.kind==='unsupported')))throw error();
  return {summary:value.summary,questions,bindings,notes,warnings:[...value.warnings] as string[]};
}

/** Apply local answers atomically; never rewrite a captured body or clear readiness. */
export function applyRepairPlan(nodes:FlowNode[],edges:FlowEdge[],requests:HarRequest[],snapshot:RepairSnapshot,rawPlan:RepairPlan,answers:Record<string,string>,values:Record<string,string>){
  if(repairFingerprint(nodes,edges)!==snapshot.fingerprint)throw new Error('画布在生成建议后有修改，请重新让 Agent 检查后再应用。');
  const refreshed=buildRepairSnapshot(nodes,edges,requests,[],snapshot.input.goal);
  // Rebuild current evidence independently of model-owned field/source locations.
  for(const original of snapshot.input.nodes){const fresh=refreshed.input.nodes.find(node=>node.id===original.id);if(!fresh||JSON.stringify(fresh.fields)!==JSON.stringify(original.fields)||JSON.stringify(fresh.sources)!==JSON.stringify(original.sources))throw error();}
  const plan=parseRepairPlan(rawPlan,snapshot.input),nextNodes=structuredClone(nodes),nextValues={...values};
  for(const question of plan.questions){const answer=answerOf(answers,question.id);if(bytes(answer)>16384)throw new Error('填写内容过长，请缩短后再应用。');if(question.required&&!answer.trim())throw new Error(`请先填写「${question.title}」。`);}
  for(const draft of plan.bindings){
    const catalog=snapshot.input.nodes.find(node=>node.id===draft.nodeId)!,field=catalog.fields.find(field=>field.id===draft.fieldId)!,node=nextNodes.find(node=>node.id===draft.nodeId)!;
    const existing=(node.data.bindings??[]).filter(binding=>targetKey(binding)===targetKey(field));
    if(existing.length)throw new Error('目标字段已有参数配置，请在参数向导中核对；修补助手不会覆盖已有配置。');
    let bindingId=`repair-${field.id}`,count=1;
    while(node.data.bindings?.some(binding=>binding.id===bindingId))bindingId=`repair-${field.id}-${count++}`;
    const question=plan.questions.find(question=>question.id===draft.questionId);
    const binding:ParameterBinding={id:bindingId,name:question?.title??(draft.mode==='manual'?`${catalog.label}的输入`:field.path),target:field.target,path:field.path,mode:draft.mode,required:question?.required??true,evidence:draft.reason};
    if(draft.mode==='user')nextValues[bindingVariable(node.id,bindingId)]=answerOf(answers,draft.questionId!);
    if(draft.mode==='upstream'){const source=catalog.sources.find(source=>source.id===draft.sourceId)!;binding.source=source.sourceNodeId;binding.sourcePath=source.sourcePath;}
    node.data.bindings=[...(node.data.bindings??[]),binding];
  }
  return {nodes:nextNodes,values:nextValues,plan};
}

export function confirmRepairedNode(nodes:FlowNode[],edges:FlowEdge[],values:Record<string,string>,nodeId:string):FlowNode[]{
  const node=nodes.find(node=>node.id===nodeId);
  if(!node||node.data.kind!=='request'||node.data.readiness==='unsupported')throw new Error('这个步骤仍需要网页能力，修补助手不能将它标记为可运行。');
  if(!node.data.bindings?.length)throw new Error('这一步还没有可用的参数绑定，请先补充输入方式，不能直接清除提醒。');
  if(node.data.readiness==='manual'&&!node.data.bindings.some(binding=>binding.mode==='manual'))throw new Error('这一步需要人工参与，请先安排运行时人工输入；填入固定资料不能代替网页验证。');
  const blocking=compileBindings(nodes,edges,values).issues.find(issue=>issue.nodeId===nodeId);
  if(blocking)throw new Error(blocking.message);
  return nodes.map(node=>node.id===nodeId?{...node,data:{...node.data,readiness:'ready'}}:node);
}
