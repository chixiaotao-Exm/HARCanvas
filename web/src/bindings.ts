import type {FlowNode,FlowEdge,ParameterBinding,PreflightIssue} from './types';

const safePath=(path:string)=>path.split('.').every(key=>key&&!['__proto__','prototype','constructor'].includes(key));
export function listFields(value:unknown,path='',depth=0):{path:string;value:unknown}[]{
 if(depth>6||value===null||typeof value!=='object')return path?[{path,value}]:[];
 return Object.entries(value).slice(0,80).flatMap(([key,item])=>listFields(item,path?`${path}.${key}`:key,depth+1)).slice(0,200);
}

// Hash a length-delimited pair rather than normalizing punctuation: node "a-b"
// and "a_b" must never accidentally share a runtime input. IDs stay <128 bytes.
function bindingID(nodeId:string,bindingId:string){
 let hash=0xcbf29ce484222325n;
 for(const byte of new TextEncoder().encode(JSON.stringify([nodeId,bindingId])))hash=BigInt.asUintN(64,(hash^BigInt(byte))*0x100000001b3n);
 return hash.toString(16).padStart(16,'0');
}
export function bindingVariable(nodeId:string,bindingId:string){return `param_${bindingID(nodeId,bindingId)}`;}

type Generators={uuid:()=>string;timestamp:()=>string;random:()=>string};
const defaults:Generators={uuid:()=>crypto.randomUUID(),timestamp:()=>new Date().toISOString(),random:()=>String(Math.floor(Math.random()*1000000))};
function parseBody(text:string){return JSON.parse(text,(_key,value:unknown)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new Error('unsafe JSON number');return value;});}

export function compileBindings(nodes:FlowNode[],edges:FlowEdge[],values:Record<string,string>,generators:Generators=defaults){
 const resultNodes=structuredClone(nodes),resultEdges=structuredClone(edges),inputs:Record<string,string>=Object.create(null),issues:PreflightIssue[]=[],entryMap:Record<string,string>=Object.create(null),nodeMap:Record<string,string>=Object.create(null);
 const nodeIds=new Set(nodes.map(n=>n.id)),declaredVariables=new Set(nodes.flatMap(n=>n.data.variable?[n.data.variable]:[])),generatedVariables=new Set<string>();
 for(const node of resultNodes.slice()){
  const sourceNode=nodes.find(n=>n.id===node.id)!;
  let previousManual:string|undefined;
  const bindings=node.data.bindings??[],seenIds=new Set<string>(),seenTargets=new Set<string>();
  const conflictURL=bindings.some(b=>b.target==='url')&&bindings.some(b=>b.target==='query');
  const conflictBody=bindings.some(b=>b.target==='body'&&!b.path)&&bindings.filter(b=>b.target==='body').length>1;
  for(const binding of bindings){
   const problem=(code:string,message:string,action:string)=>issues.push({code,nodeId:node.id,field:`bindings.${binding.id}`,message,suggestedAction:action});
   const variable=bindingVariable(node.id,binding.id),target=`${binding.target}:${binding.target==='header'?binding.path.toLowerCase():binding.path}`;
   if(seenIds.has(binding.id)){problem('DUPLICATE_BINDING','同一步骤中有重复的参数编号。','删除重复参数后重新添加。');continue;}
   seenIds.add(binding.id);
   if(seenTargets.has(target)||(binding.target==='body'&&conflictBody)||(conflictURL&&(binding.target==='url'||binding.target==='query'))){problem('CONFLICTING_BINDING',`「${binding.name}」与另一个参数写入同一位置。`,'每个字段只保留一个参数；完整地址与查询参数请分开配置。');continue;}
   seenTargets.add(target);
   if(declaredVariables.has(variable)||nodeIds.has(variable)||generatedVariables.has(variable)){problem('BINDING_VARIABLE_COLLISION','自动生成的参数名称与现有步骤或参数重复。','修改冲突的步骤编号或参数名称后重试。');continue;}
   generatedVariables.add(variable);
   if(!['fixed','user','upstream','runtime','manual'].includes(binding.mode)){problem('INVALID_BINDING_MODE','参数来源类型无效。','重新选择参数来源。');continue;}

   let original:unknown;
   try{original=readTarget(sourceNode.data,binding);}catch{problem('INVALID_BINDING_TARGET',`「${binding.name}」的目标字段无法读取。`,'检查正文是否为 JSON，并重新选择字段；表单正文请使用高级编辑。');continue;}
   const typedField=binding.target==='body'&&!!binding.path&&(typeof original==='number'||typeof original==='boolean');
   if(typedField&&binding.mode!=='fixed'){problem('UNSUPPORTED_DYNAMIC_TYPE',`「${binding.name}」是${typeof original==='number'?'数字':'布尔'}字段，目前需要使用固定值。`,'使用相同类型的固定值，或在高级编辑中明确配置完整请求正文。');continue;}

   let value=binding.value??'';
   if(binding.mode==='user'||binding.mode==='fixed'){
    const provided=binding.mode==='user'?(values[variable]??binding.value??''):value;
    if(binding.required!==false&&!provided.trim())problem('MISSING_INPUT',`请填写「${binding.name}」。`,'在运行参数表单或固定值设置中填写这个字段。');
    if(typedField){
     try{const typed:unknown=parseBody(provided);if(typeof typed!==typeof original)throw new Error('wrong type');writeBinding(node.data,binding,typed);}
     catch{problem('INVALID_BINDING_TYPE',`「${binding.name}」的固定值类型或数字精度不支持。`,typeof original==='boolean'?'填写 true 或 false。':'填写有效的 JSON 数字；大整数请使用完整正文高级编辑，避免精度损失。');}
     continue;
    }
    // Fixed text also goes through a variable once, so literal {{braces}} in a
    // value never become an unintended second-stage runtime expression.
    inputs[variable]=provided;value=`{{${variable}}}`;
   }
   if(binding.mode==='runtime'){
    const kind=binding.generator??'uuid';
    if(!Object.hasOwn(generators,kind)||typeof generators[kind]!=='function'){problem('INVALID_GENERATOR','运行时生成方式无效。','选择 UUID、当前时间或随机整数。');continue;}
    inputs[variable]=generators[kind]();value=`{{${variable}}}`;
   }
   if(binding.mode==='upstream'){
    if(!binding.source||!nodes.some(n=>n.id===binding.source)||!binding.sourcePath||!safePath(binding.sourcePath)){problem('MISSING_BINDING_SOURCE',`「${binding.name}」的来源步骤或字段无效。`,'重新选择前序响应步骤和字段。');continue;}
    value=`{{${binding.source}.${binding.sourcePath}}}`;
   }
   if(binding.mode==='manual'){
    const manualId=`manual-${bindingID(node.id,binding.id)}`;
    if(nodeIds.has(manualId)){problem('MANUAL_NODE_COLLISION','人工输入步骤的编号与现有步骤重复。','修改冲突的步骤编号后重试。');continue;}
    nodeIds.add(manualId);
    resultNodes.push({id:manualId,type:'block',position:{x:node.position.x-220,y:node.position.y},data:{kind:'manual',label:`人工填写：${binding.name}`,description:binding.evidence||`流程将在这里暂停，填写「${binding.name}」后继续。`,variable}});
    nodeMap[manualId]=node.id;if(!previousManual)entryMap[node.id]=manualId;
    if(previousManual)resultEdges.push({id:`binding-${manualId}`,source:previousManual,target:manualId});
    else for(const edge of resultEdges)if(edge.target===node.id)edge.target=manualId;
    previousManual=manualId;value=`{{${variable}}}`;
   }
   try{writeBinding(node.data,binding,value);}catch{problem('INVALID_BINDING_TARGET',`「${binding.name}」的目标字段无法写入。`,'检查正文是否为 JSON，并重新选择字段；表单正文请使用高级编辑。');}
  }
  if(previousManual)resultEdges.push({id:`binding-to-${node.id}`,source:previousManual,target:node.id});
 }
 return {nodes:resultNodes,edges:resultEdges,inputs,issues,entryMap,nodeMap};
}

function readTarget(data:FlowNode['data'],binding:ParameterBinding):unknown{
 if(binding.target!=='body')return undefined;
 if(!binding.path)return data.body;
 if(!safePath(binding.path))throw new Error('invalid path');
 let item:unknown=parseBody(data.body||'{}');
 for(const key of binding.path.split('.')){if(item===null||typeof item!=='object'||!Object.hasOwn(item,key))throw new Error('missing field');item=(item as Record<string,unknown>)[key];}
 return item;
}

function writeBinding(data:FlowNode['data'],binding:ParameterBinding,value:unknown){
 if(binding.target==='header'){if(!binding.path.trim())throw new Error('missing header');data.headers={...data.headers,[binding.path]:String(value)};return;}
 if(binding.target==='url'){data.url=String(value);return;}
 if(binding.target==='query'){if(!binding.path)throw new Error('missing query name');const url=new URL(data.url??'');const marker=`__HAR_BIND_${bindingID('',binding.id)}__`;url.searchParams.set(binding.path,marker);data.url=url.toString().replace(marker,encodeURIComponent(String(value)).replace(/%7B/g,'{').replace(/%7D/g,'}').replace(/%2E/g,'.'));return;}
 if(binding.target!=='body')throw new Error('invalid target');
 if(!binding.path){data.body=String(value);return;}
 if(!safePath(binding.path))throw new Error('invalid path');
 const body=parseBody(data.body||'{}');let item=body;const keys=binding.path.split('.');
 for(const key of keys.slice(0,-1)){if(item===null||typeof item!=='object'||!Object.hasOwn(item,key))throw new Error('missing field');item=item[key];}
 if(item===null||typeof item!=='object'||!Object.hasOwn(item,keys.at(-1)!))throw new Error('invalid target');
 item[keys.at(-1)!]=value;data.body=JSON.stringify(body);
}
