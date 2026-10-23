import type {BlockData,FlowNode,FlowEdge,HarRequest,Kind,ParameterBinding,ResourceBinding} from './types';
import {bindingVariable} from './bindings.ts';

export type GraphState={nodes:FlowNode[];edges:FlowEdge[];values:Record<string,string>;revision:number;resourceBindings?:ResourceBinding[]};
export type GraphCommand=
 |{op:'create';id:string;kind:Kind;label:string;position?:{x:number;y:number};requestId?:string;scopeId?:string;data?:Partial<BlockData>}
 |{op:'patch';nodeId:string;data:Partial<BlockData>}
 |{op:'delete';nodeIds:string[]}
 |{op:'duplicate';nodeIds:string[];idMap:Record<string,string>;offset?:{x:number;y:number}}
 |{op:'connect';id:string;source:string;target:string;sourceHandle?:string}
 |{op:'disconnect';edgeIds:string[]}
 |{op:'bind';nodeId:string;binding:ParameterBinding}
 |{op:'unbind';nodeId:string;bindingId:string}
 |{op:'move';positions:{nodeId:string;x:number;y:number}[]}
 |{op:'layout';nodeIds?:string[]}
 |{op:'group';nodeIds:string[];groupId:string;label:string}
 |{op:'resource';id:string;resourceId:string;targetId:string;remove?:boolean}
 |{op:'wrap';nodeIds:string[];id:string;label:string;kind:'loop'|'subflow';count:number};
export type GraphTransaction={baseRevision:number;commands:GraphCommand[]};
export type GraphCommandOptions={requests?:HarRequest[]};
export const BLOCK_KINDS:Kind[]=['input','request','extract','condition','output','manual','assertion','proxy','profile','browserSession','browser','browserVerification','loop','subflow','break'];
const resourceKinds=new Set(['proxy','profile','browserSession']);
const safeID=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const bindingID=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).length<=2048&&!/[\x00-\x1f]/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const point=(p:unknown):p is {x:number;y:number}=>object(p)&&typeof p.x==='number'&&typeof p.y==='number'&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<1e7&&Math.abs(p.y)<1e7;
const text=(value:unknown,max=4000):value is string=>typeof value==='string'&&new TextEncoder().encode(value).length<=max;
function fail(message='画布指令无效，请重新描述需要修改的步骤。'):never{throw new Error(message);}
function bounded(value:unknown,depth=0):void{
 if(depth>40)fail('配置嵌套过深。');
 if(typeof value==='string'&&!text(value,65536))fail('单项配置内容过长。');
 if(typeof value==='number'&&!Number.isFinite(value))fail();
 if(Array.isArray(value)){if(value.length>2000)fail();for(const item of value)bounded(item,depth+1);}
 else if(object(value)){for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))fail();bounded(item,depth+1);}}
}
const editable=new Set(['label','description','method','url','headers','body','variable','value','source','path','operator','expected','template','acceptStatus','bindings','groupId','groupLabel','sessionId','proxyId','profileId','proxy','profile','session','loop','browserAction','selector','text']);
function checkData(data:unknown):asserts data is Partial<BlockData>{
 if(!object(data)||Object.keys(data).some(key=>!editable.has(key)))fail('只能编辑已支持的方块字段。');bounded(data);
 for(const key of ['label','description','method','url','body','variable','value','source','path','operator','expected','template','acceptStatus','groupId','groupLabel','sessionId','proxyId','profileId','browserAction','selector','text'])if(data[key]!==undefined&&!text(data[key],key==='body'?65536:4000))fail();
 if(data.browserAction!==undefined&&!['navigate','click','fill','read','wait'].includes(String(data.browserAction)))fail('浏览器操作暂不支持，请选择打开、点击、填写、读取或等待。');
 if(data.label!==undefined&&(!(data.label as string).trim()||!text(data.label,400)))fail('步骤名称不能为空。');
 if(data.headers!==undefined&&(!object(data.headers)||Object.entries(data.headers).some(([key,val])=>!text(key,256)||!text(val,16384)||/[\r\n]/.test(key+val))))fail('请求头格式无效。');
 if(data.bindings!==undefined){if(!Array.isArray(data.bindings)||data.bindings.length>80)fail();const ids=new Set();for(const binding of data.bindings){checkBinding(binding);if(ids.has(binding.id))fail('参数编号重复。');ids.add(binding.id);}}
 if(data.proxy!==undefined){const p=data.proxy;if(!object(p)||!text(p.url,16000)||!['fixed','run','request','minutes'].includes(String(p.rotation))||p.rotation==='minutes'&&(!Number.isInteger(p.rotationMinutes)||Number(p.rotationMinutes)<1||Number(p.rotationMinutes)>10080)||p.sessionToken!==undefined&&!text(p.sessionToken,200))fail('代理配置无效。');if(p.url){try{const u=new URL(p.url as string);if(!['http:','https:','socks5:','socks5h:'].includes(u.protocol)||!u.hostname)fail();}catch{fail('请输入完整的代理链接。');}}}
 if(data.profile!==undefined){const p=data.profile;if(!object(p)||!['chromium','firefox','webkit'].includes(String(p.browser))||!text(p.locale,100)||!text(p.timezone,100)||!object(p.viewport)||!Number.isInteger(p.viewport.width)||!Number.isInteger(p.viewport.height)||Number(p.viewport.width)<320||Number(p.viewport.height)<200||Number(p.viewport.width)>7680||Number(p.viewport.height)>4320)fail('浏览器画像配置无效。');try{new Intl.DateTimeFormat(String(p.locale),{timeZone:String(p.timezone)});}catch{fail('语言或时区无法识别。');}}
 if(data.session!==undefined){const s=data.session;if(!object(s)||!text(s.name,400)||['proxyId','profileId'].some(key=>s[key]!==undefined&&s[key]!==''&&!safeID(s[key]))||s.persist!==undefined&&typeof s.persist!=='boolean')fail('会话配置无效。');}
 if(data.loop!==undefined){const l=data.loop;if(!object(l)||!['count','each'].includes(String(l.mode))||!Number.isInteger(l.count)||Number(l.count)<0||Number(l.count)>1000||!text(l.items,16000)||!safeID(l.itemVariable)||!safeID(l.indexVariable)||!Array.isArray(l.nodes)||!Array.isArray(l.edges))fail('循环配置无效。');}
}
function checkBinding(value:unknown):asserts value is ParameterBinding{
 if(!object(value)||!bindingID(value.id)||!text(value.name,400)||!['body','header','query','url'].includes(String(value.target))||!text(value.path,1024)||String(value.path).split('.').some(key=>['__proto__','constructor','prototype'].includes(key))||!['fixed','user','upstream','runtime','manual'].includes(String(value.mode))||value.value!==undefined&&!text(value.value,16384)||value.source!==undefined&&!safeID(value.source)||value.sourcePath!==undefined&&!text(value.sourcePath,1024)||value.required!==undefined&&typeof value.required!=='boolean')fail('参数绑定格式无效。');
}
function defaults(kind:Kind,label:string):BlockData{
 const base:BlockData={kind,label};
 if(kind==='proxy')base.proxy={url:'',rotation:'fixed'};
 if(kind==='profile')base.profile={browser:'chromium',locale:'zh-CN',timezone:'Asia/Shanghai',viewport:{width:1366,height:768}};
 if(kind==='browserSession')base.session={name:label,persist:false};
 if(kind==='loop'||kind==='subflow')base.loop={mode:'count',count:1,items:'',itemVariable:'item',indexVariable:'index',nodes:[],edges:[]};
 if(kind==='request'){base.method='GET';base.url='';base.headers={};base.readiness='missing-input';}
 if(kind==='condition'){base.operator='exists';base.expected='';}
 if(kind==='browserVerification')base.variable='verificationDone';
 return base;
}
function allNodes(nodes:FlowNode[]):FlowNode[]{return nodes.flatMap(node=>[node,...allNodes(node.data.loop?.nodes??[])]);}
type ResourceReference={ownerId:string;field:string;resourceId:string;kind:string};
function resourceReferences(nodes:FlowNode[]):ResourceReference[]{return allNodes(nodes).flatMap(node=>{
 const refs:ResourceReference[]=[];
 for(const [field,kind]of [['sessionId','browserSession'],['proxyId','proxy'],['profileId','profile']]as const){const id=node.data[field];if(id)refs.push({ownerId:node.id,field,resourceId:id,kind});}
 for(const [field,kind]of [['proxyId','proxy'],['profileId','profile']]as const){const id=node.data.session?.[field];if(id)refs.push({ownerId:node.id,field:`session.${field}`,resourceId:id,kind});}
 return refs;
});}
const resourceReferenceKey=(ref:ResourceReference)=>JSON.stringify([ref.field,ref.resourceId]);
const resourceRelationKey=(binding:ResourceBinding)=>JSON.stringify([binding.id,binding.resourceId,binding.targetId]);
type Scope={nodes:FlowNode[];edges:FlowEdge[]};
function scopes(scope:Scope):Scope[]{return [scope,...scope.nodes.flatMap(node=>node.data.loop?scopes(node.data.loop):[])];}
function mergedPatch(base:BlockData,patch:unknown):Partial<BlockData>{
 if(!object(patch)||Object.keys(patch).some(key=>!editable.has(key)))fail('只能编辑已支持的方块字段。');
 const result={...patch};
 for(const key of ['proxy','profile','session','loop']as const)if(object(patch[key])){
  const previous=base[key];result[key]={...(object(previous)?previous:{}),...patch[key]};
  if(key==='profile'&&object(patch[key].viewport)&&base.profile)(result[key] as Record<string,unknown>).viewport={...base.profile.viewport,...patch[key].viewport};
 }
 checkData(result);return result;
}
function shortHash(value:string):string{let hash=0xcbf29ce484222325n;for(const byte of new TextEncoder().encode(value))hash=BigInt.asUintN(64,(hash^BigInt(byte))*0x100000001b3n);return hash.toString(16).padStart(16,'0');}
function duplicateSelection(state:GraphState,scope:Scope,originals:FlowNode[],command:Extract<GraphCommand,{op:'duplicate'}>):void{
 const offset=command.offset??{x:60,y:100};
 if(!point(offset)||!object(command.idMap)||Object.keys(command.idMap).length!==originals.length)fail('请选择要复制的步骤，并为副本提供唯一编号。');
 const taken=new Set(allNodes(state.nodes).map(node=>node.id)),mapping=new Map<string,string>(),seed=Object.values(command.idMap).join(':'),copiedIds=new Set(allNodes(originals).map(node=>node.id));
 const reserve=(candidate:string,used:Set<string>)=>{let next=candidate,index=1;while(used.has(next))next=`${candidate.slice(0,110)}-${index++}`;used.add(next);return next;};
 for(const original of originals){const id=command.idMap[original.id];if(!safeID(id)||taken.has(id))fail('副本的步骤编号已经存在，请更换编号。');taken.add(id);mapping.set(original.id,id);}
 for(const original of allNodes(originals))if(!mapping.has(original.id))mapping.set(original.id,reserve(`copy-${shortHash(`${seed}:${original.id}`)}`,taken));
 const edgeTaken=new Set(scopes(state).flatMap(scope=>scope.edges.map(edge=>edge.id))),groupMap=new Map<string,string>(),parameterMap=new Map<string,string>();
 for(const original of allNodes(originals))for(const binding of original.data.bindings??[]){const from=bindingVariable(original.id,binding.id),to=bindingVariable(mapping.get(original.id)!,binding.id);parameterMap.set(from,to);if(binding.mode==='user'&&Object.hasOwn(state.values,from))state.values[to]=state.values[from];}
 const declarations=new Set(['input','manual','extract','browser','browserVerification']);
 const cloneScope=(nodes:FlowNode[],edges:FlowEdge[],inherited:Map<string,string>,outer=false):Scope=>{
  const variables=new Map(inherited),declared=new Set<string>();
  for(const original of nodes){const name=original.data.variable;if(!name||!declarations.has(original.data.kind))continue;if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)||declared.has(name))fail('要复制的范围中有无效或重复的参数名称，请先在方块内修正。');declared.add(name);const renamed=`${name.slice(0,70)}_${shortHash(`${mapping.get(original.id)}:${name}`).slice(0,12)}`;variables.set(name,renamed);if(original.data.kind==='input'&&Object.hasOwn(state.values,name))state.values[renamed]=state.values[name];}
  const reference=(reference:string)=>{const match=/^([A-Za-z0-9_-]+)(.*)$/.exec(reference);if(!match)return reference;const renamed=variables.get(match[1])??mapping.get(match[1]);if(!renamed)return reference;if(match[2]&&!/^(?:\.[A-Za-z0-9_-]+)+$/.test(match[2]))fail('这部分包含无法自动改写的参数表达式，请先改为明确的字段绑定。');return renamed+match[2];};
  const template=(value:string|undefined)=>value?.replace(/{{([^{}]*)}}/g,(_whole,inner:string)=>`{{${reference(inner.trim())}}}`);
  const result=nodes.map(original=>{
   const copy=structuredClone(original),data=copy.data;copy.id=mapping.get(original.id)!;copy.selected=false;delete copy.dragging;delete copy.measured;
   if(outer){copy.position={x:copy.position.x+offset.x,y:copy.position.y+offset.y};data.label=`${data.label}（副本）`;}
   delete data.generatedKey;
   if(data.source&&mapping.has(data.source))data.source=mapping.get(data.source);
   if(data.variable)data.variable=declarations.has(data.kind)?variables.get(data.variable)??data.variable:reference(data.variable);
   for(const key of ['url','body','template','expected','text']as const)if(data[key]!==undefined)data[key]=template(data[key]);
   if(data.headers)data.headers=Object.fromEntries(Object.entries(data.headers).map(([name,value])=>[name,template(value)!]));
   for(const key of ['sessionId','proxyId','profileId']as const)if(data[key]&&mapping.has(data[key]!))data[key]=mapping.get(data[key]!);
   if(data.session)for(const key of ['proxyId','profileId']as const)if(data.session[key]&&mapping.has(data.session[key]!))data.session[key]=mapping.get(data.session[key]!);
   for(const binding of data.bindings??[])if(binding.source&&mapping.has(binding.source))binding.source=mapping.get(binding.source);
   if(data.groupId){if(!groupMap.has(data.groupId))groupMap.set(data.groupId,`copy-group-${shortHash(`${seed}:${data.groupId}`)}`);data.groupId=groupMap.get(data.groupId);}
   if(data.loop){const loop=data.loop,childVariables=new Map(variables);childVariables.set(loop.itemVariable,loop.itemVariable);childVariables.set(loop.indexVariable,loop.indexVariable);const child=cloneScope(loop.nodes,loop.edges,childVariables);data.loop={...loop,nodes:child.nodes,edges:child.edges,entryId:loop.entryId?mapping.get(loop.entryId):undefined,items:loop.mode==='each'&&!loop.items.trim().startsWith('[')?template(loop.items)??'':loop.items};}
   return copy;
  });
  return {nodes:result,edges:edges.map(edge=>({...structuredClone(edge),id:reserve(`copy-edge-${shortHash(`${seed}:${edge.id}:${mapping.get(edge.source)}:${mapping.get(edge.target)}`)}`,edgeTaken),source:mapping.get(edge.source)!,target:mapping.get(edge.target)!}))};
 };
 const roots=new Set(originals.map(node=>node.id)),copied=cloneScope(originals,scope.edges.filter(edge=>roots.has(edge.source)&&roots.has(edge.target)),parameterMap,true);
 scope.nodes.push(...copied.nodes);scope.edges.push(...copied.edges);
 const relationTaken=new Set((state.resourceBindings??[]).map(binding=>binding.id)),extra=(state.resourceBindings??[]).filter(binding=>copiedIds.has(binding.targetId)).map(binding=>({...binding,id:reserve(`copy-resource-${shortHash(`${seed}:${binding.id}:${mapping.get(binding.targetId)}`)}`,relationTaken),resourceId:mapping.get(binding.resourceId)??binding.resourceId,targetId:mapping.get(binding.targetId)!}));
 if(extra.length)state.resourceBindings=[...(state.resourceBindings??[]),...extra];
}
function validateScope(nodes:FlowNode[],edges:FlowEdge[],depth=0):void{
 if(depth>4||nodes.length>1000||edges.length>3000)fail('流程超过可编辑范围，请拆分子流程。');
 const known=new Map(nodes.map(node=>[node.id,node]));if(known.size!==nodes.length)fail('步骤编号重复。');
 const edgeIds=new Set<string>(),pairs=new Set<string>(),adj=new Map<string,string[]>(),degree=new Map(nodes.map(node=>[node.id,0]));
 for(const node of nodes){if(!safeID(node.id)||!BLOCK_KINDS.includes(node.data.kind)||!point(node.position))fail();if(node.data.loop)validateScope(node.data.loop.nodes,node.data.loop.edges,depth+1);}
 for(const edge of edges){const from=known.get(edge.source),to=known.get(edge.target),pair=JSON.stringify([edge.source,edge.target,edge.sourceHandle??'']);if(!safeID(edge.id)||edgeIds.has(edge.id)||pairs.has(pair)||!from||!to||from===to||resourceKinds.has(from.data.kind)||resourceKinds.has(to.data.kind))fail('执行连线存在重复、缺失步骤或资源方块。');if(edge.sourceHandle&&!['yes','no','true','false','success','error'].includes(edge.sourceHandle))fail('分支出口无效。');edgeIds.add(edge.id);pairs.add(pair);adj.set(edge.source,[...(adj.get(edge.source)??[]),edge.target]);degree.set(edge.target,(degree.get(edge.target)??0)+1);}
 const queue=[...degree].filter(([,d])=>d===0).map(([id])=>id);let visited=0;while(queue.length){const id=queue.shift()!;visited++;for(const next of adj.get(id)??[]){degree.set(next,degree.get(next)!-1);if(degree.get(next)===0)queue.push(next);}}if(visited!==nodes.length)fail('执行线不能直接回连，请使用「重复」方块。');
}
function validateUpstream(scope:Scope,inherited=new Set<string>()):void{
 // Propagate compact ancestry bitsets once in topological order. Repeatedly
 // scanning every edge for each ancestor made a long 1000-node chain quadratic.
 const index=new Map(scope.nodes.map((node,i)=>[node.id,i])),words=Math.ceil(scope.nodes.length/32),bits=scope.nodes.map(()=>new Uint32Array(words)),out=scope.nodes.map(()=>[] as number[]),degree=scope.nodes.map(()=>0);
 for(const edge of scope.edges){const from=index.get(edge.source),to=index.get(edge.target);if(from===undefined||to===undefined)continue;out[from].push(to);degree[to]++;}
 const queue=degree.flatMap((value,i)=>value===0?[i]:[]);
 for(let cursor=0;cursor<queue.length;cursor++){const from=queue[cursor];for(const to of out[from]){bits[to][from>>>5]|=1<<(from&31);for(let word=0;word<words;word++)bits[to][word]|=bits[from][word];if(--degree[to]===0)queue.push(to);}}
 for(let i=0;i<scope.nodes.length;i++){const target=scope.nodes[i],has=(id:string)=>inherited.has(id)||(index.has(id)&&Boolean(bits[i][index.get(id)!>>>5]&(1<<(index.get(id)!&31))));for(const binding of target.data.bindings??[])if(binding.mode==='upstream'&&(!binding.source||!has(binding.source)))fail('参数来源必须位于当前步骤之前，请先连线或调整来源。');if(target.data.kind==='extract'&&target.data.source&&!has(target.data.source))fail('提取结果的来源必须位于当前步骤之前。');if(target.data.loop){const available=new Set(inherited);for(let source=0;source<scope.nodes.length;source++)if(bits[i][source>>>5]&(1<<(source&31)))available.add(scope.nodes[source].id);validateUpstream(target.data.loop,available);}}
}
/** Apply a complete edit to a private clone. Any invalid command leaves the original untouched. */
export function applyGraphTransaction(state:GraphState,transaction:GraphTransaction,options:GraphCommandOptions={}):GraphState{
 if(!Number.isSafeInteger(transaction.baseRevision)||transaction.baseRevision!==state.revision)fail('画布已修改，本次回复没有覆盖你的新内容。请重新发送要求。');
 if(!Array.isArray(transaction.commands)||transaction.commands.length>100)fail('一次最多修改 100 项，请分步编辑。');
 if(!transaction.commands.length)return state;
 const next=structuredClone(state),requestById=new Map((options.requests??[]).map(request=>[request.id,request]));
 const originalNodes=new Map(allNodes(state.nodes).map(node=>[node.id,node])),allowedMissingRefs=new Map<string,Set<string>>(),allowedMissingRelations=new Set((state.resourceBindings??[]).filter(binding=>!originalNodes.has(binding.resourceId)||!originalNodes.has(binding.targetId)).map(resourceRelationKey));
 const keepMissingRef=(ref:ResourceReference)=>{const allowed=allowedMissingRefs.get(ref.ownerId)??new Set<string>();allowed.add(resourceReferenceKey(ref));allowedMissingRefs.set(ref.ownerId,allowed);};
 for(const ref of resourceReferences(state.nodes))if(!originalNodes.has(ref.resourceId))keepMissingRef(ref);
 const node=(id:string)=>{const found=allNodes(next.nodes).find(candidate=>candidate.id===id);if(!found)fail('找不到需要修改的方块。');return found;};
 const scopeOf=(id:string)=>{const found=scopes(next).find(scope=>scope.nodes.some(node=>node.id===id));if(!found)fail('找不到步骤所在的子流程。');return found;};
 const commonScope=(ids:string[])=>{const scope=scopeOf(ids[0]);if(ids.some(id=>scopeOf(id)!==scope))fail('请选择同一层子流程中的步骤。');return scope;};
 const selected=(ids:string[])=>{if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)fail();return ids.map(node);};
 for(const command of transaction.commands){
  if(!object(command)||!text(command.op,30))fail();bounded(command);
  switch(command.op){
   case 'create':{if(!safeID(command.id)||allNodes(next.nodes).some(node=>node.id===command.id)||!BLOCK_KINDS.includes(command.kind)||!text(command.label,400)||!command.label.trim())fail('新方块编号、类型或名称无效。');const destination=command.scopeId?node(command.scopeId).data.loop:next;if(!destination)fail('新方块需要放在已有的子流程中。');const base=defaults(command.kind,command.label);let data={...base,...mergedPatch(base,command.data??{})};if(command.requestId){const request=requestById.get(command.requestId);if(!request||command.kind!=='request')fail('新方块必须引用当前项目中的录制请求。');data={...data,requestId:request.id,captureId:request.captureId,originalRequestId:request.originalRequestId,method:request.method,url:request.url,headers:{...request.headers},body:request.body};}const position=command.position??{x:80+destination.nodes.length%4*380,y:80+Math.floor(destination.nodes.length/4)*260};if(!point(position))fail();destination.nodes.push({id:command.id,type:'block',position:{...position},data});break;}
   case 'patch':{const target=node(command.nodeId);target.data={...target.data,...mergedPatch(target.data,command.data)};break;}
   case 'delete':{const targets=selected(command.nodeIds),removed=allNodes(targets),ids=new Set(removed.map(node=>node.id)),removedKinds=new Map(removed.map(node=>[node.id,node.data.kind]));for(const ref of resourceReferences(next.nodes))if(removedKinds.get(ref.resourceId)===ref.kind)keepMissingRef(ref);for(const id of ids)allowedMissingRefs.delete(id);for(const binding of next.resourceBindings??[])if(resourceKinds.has(removedKinds.get(binding.resourceId)??''))allowedMissingRelations.add(resourceRelationKey(binding));for(const scope of scopes(next)){scope.nodes=scope.nodes.filter(node=>!ids.has(node.id));scope.edges=scope.edges.filter(edge=>!ids.has(edge.source)&&!ids.has(edge.target));}next.resourceBindings=next.resourceBindings?.filter(binding=>!ids.has(binding.targetId));for(const target of allNodes(next.nodes)){if(ids.has(target.data.source??''))fail('其他方块仍在引用待删除步骤，请先修改这些引用。');if(target.data.bindings?.some(binding=>ids.has(binding.source??'')))fail('其他方块的参数仍在引用待删除步骤，请一起调整。');}for(const target of removed)for(const binding of target.data.bindings??[])delete next.values[bindingVariable(target.id,binding.id)];break;}
   case 'duplicate':{const originals=selected(command.nodeIds),scope=commonScope(command.nodeIds);duplicateSelection(next,scope,originals,command);break;}
   case 'connect':{node(command.source);node(command.target);const scope=commonScope([command.source,command.target]);scope.edges.push({id:command.id,source:command.source,target:command.target,sourceHandle:command.sourceHandle==='yes'?'true':command.sourceHandle==='no'?'false':command.sourceHandle});break;}
   case 'disconnect':{if(!Array.isArray(command.edgeIds)||command.edgeIds.some(id=>!scopes(next).some(scope=>scope.edges.some(edge=>edge.id===id))))fail('找不到需要删除的连线。');const ids=new Set(command.edgeIds);for(const scope of scopes(next))scope.edges=scope.edges.filter(edge=>!ids.has(edge.id));break;}
   case 'bind':{checkBinding(command.binding);const target=node(command.nodeId);if(target.data.kind!=='request')fail('参数绑定只能添加到请求步骤。');target.data.bindings=[...(target.data.bindings??[]).filter(binding=>binding.id!==command.binding.id),structuredClone(command.binding)];break;}
   case 'unbind':{const target=node(command.nodeId);if(!target.data.bindings?.some(binding=>binding.id===command.bindingId))fail('找不到要移除的参数。');target.data.bindings=target.data.bindings.filter(binding=>binding.id!==command.bindingId);delete next.values[bindingVariable(target.id,command.bindingId)];break;}
   case 'move':if(!Array.isArray(command.positions)||!command.positions.length)fail();for(const position of command.positions){if(!point(position))fail();node(position.nodeId).position={x:position.x,y:position.y};}break;
   case 'layout':{const targets=command.nodeIds?selected(command.nodeIds):next.nodes,scope=command.nodeIds?.length?commonScope(command.nodeIds):next;const ids=new Set(targets.map(node=>node.id)),rank=new Map(targets.map(node=>[node.id,0])),out=new Map<string,string[]>(),degree=new Map(targets.map(node=>[node.id,0]));for(const edge of scope.edges)if(ids.has(edge.source)&&ids.has(edge.target)){out.set(edge.source,[...(out.get(edge.source)??[]),edge.target]);degree.set(edge.target,(degree.get(edge.target)??0)+1);}const queue=[...degree].filter(([,value])=>value===0).map(([id])=>id);for(let cursor=0;cursor<queue.length;cursor++)for(const target of out.get(queue[cursor])??[]){rank.set(target,Math.max(rank.get(target)!,rank.get(queue[cursor])!+1));degree.set(target,degree.get(target)!-1);if(degree.get(target)===0)queue.push(target);}const rows=new Map<number,number>();for(const target of targets){const column=rank.get(target.id)??0,row=rows.get(column)??0;target.position={x:80+column*400,y:80+row*340};rows.set(column,row+1);}break;}
   case 'group':{if(!safeID(command.groupId)||!text(command.label,400))fail();for(const target of selected(command.nodeIds)){target.data.groupId=command.groupId;target.data.groupLabel=command.label;}break;}
   case 'resource':{if(!safeID(command.id))fail();if(command.remove){const existing=next.resourceBindings?.find(binding=>binding.id===command.id);if(!existing||existing.resourceId!==command.resourceId||existing.targetId!==command.targetId)fail('找不到要移除的资源关联。');}else{const resource=node(command.resourceId);node(command.targetId);if(!resourceKinds.has(resource.data.kind))fail('请选择代理、画像或会话方块。');}next.resourceBindings=(next.resourceBindings??[]).filter(binding=>binding.id!==command.id);if(!command.remove)next.resourceBindings.push({id:command.id,resourceId:command.resourceId,targetId:command.targetId});break;}
   case 'wrap':{const targets=selected(command.nodeIds),scope=commonScope(command.nodeIds),ids=new Set(command.nodeIds);if(!safeID(command.id)||allNodes(next.nodes).some(node=>node.id===command.id)||!['loop','subflow'].includes(command.kind)||!Number.isInteger(command.count)||command.count<0||command.count>1000||!text(command.label,400)||targets.some(target=>resourceKinds.has(target.data.kind)))fail('重复范围或次数无效。');for(const outside of allNodes(next.nodes).filter(target=>!ids.has(target.id))){const refs=[outside.data.source,...(outside.data.bindings??[]).filter(binding=>binding.mode==='upstream').map(binding=>binding.source)];if(refs.some(ref=>ref&&ids.has(ref)))fail('其他步骤正在读取这部分的结果，请先通过重复方块的输出重新绑定。');const templates=[outside.data.variable,outside.data.body,outside.data.url,outside.data.template,outside.data.expected,...Object.values(outside.data.headers??{})];if(templates.some(value=>typeof value==='string'&&[...ids].some(id=>value.includes('{{'+id+'.')||value.startsWith(id+'.'))))fail('其他步骤正在引用这部分的内部参数，请先调整结果绑定。');}const incoming=scope.edges.filter(edge=>!ids.has(edge.source)&&ids.has(edge.target)),outgoing=scope.edges.filter(edge=>ids.has(edge.source)&&!ids.has(edge.target));if(new Set(incoming.map(edge=>edge.target)).size>1||new Set(outgoing.map(edge=>edge.source)).size>1)fail('这部分有多个入口或出口，请先整理成一个入口和一个出口。');const innerEdges=scope.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),entries=targets.filter(target=>!innerEdges.some(edge=>edge.target===target.id));if(entries.length!==1)fail('请选择首尾相连的一组步骤。');const loop={mode:'count' as const,count:command.count,items:'',itemVariable:'item',indexVariable:'index',nodes:targets,edges:innerEdges,entryId:entries[0].id};scope.nodes=scope.nodes.filter(target=>!ids.has(target.id));scope.nodes.push({id:command.id,type:'block',position:{...targets[0].position},data:{kind:command.kind,label:command.label,loop}});scope.edges=scope.edges.filter(edge=>!ids.has(edge.source)&&!ids.has(edge.target));for(const edge of incoming)scope.edges.push({...edge,target:command.id});for(const edge of outgoing)scope.edges.push({...edge,source:command.id,sourceHandle:undefined});break;}
   default:fail('Agent 返回了尚不支持的画布工具。');
  }
 }
 validateScope(next.nodes,next.edges);validateUpstream(next);const every=allNodes(next.nodes),ids=new Set(every.map(node=>node.id));if(ids.size!==every.length||every.length>1000)fail('嵌套流程包含重复编号或超过 1000 个步骤。');
 const byId=new Map(every.map(node=>[node.id,node]));
 // Preserve exact broken draft settings for preflight; newly invented references
 // and existing nodes of the wrong kind still reject the complete transaction.
 for(const ref of resourceReferences(next.nodes)){const resource=byId.get(ref.resourceId);if(!safeID(ref.resourceId)||(resource?resource.data.kind!==ref.kind:!allowedMissingRefs.get(ref.ownerId)?.has(resourceReferenceKey(ref))))fail('步骤引用的会话、代理或画像不存在。');}
 for(const target of every)for(const binding of target.data.bindings??[])if(binding.mode==='upstream'&&(!binding.source||!ids.has(binding.source)))fail('参数引用的上游方块不存在。');
 for(const binding of next.resourceBindings??[]){const resource=byId.get(binding.resourceId);if(resource&&!resourceKinds.has(resource.data.kind)||(!resource||!ids.has(binding.targetId))&&!allowedMissingRelations.has(resourceRelationKey(binding)))fail('资源关联的方块不存在。');}
 next.revision=state.revision+1;return next;
}

export type GraphHistory={past:GraphState[];present:GraphState;future:GraphState[];limit:number};
export function createGraphHistory(state:GraphState,limit=50):GraphHistory{return {past:[],present:structuredClone(state),future:[],limit};}
export function commitGraphHistory(history:GraphHistory,state:GraphState):GraphHistory{if(state===history.present)return history;return {...history,past:[...history.past,structuredClone(history.present)].slice(-history.limit),present:structuredClone(state),future:[]};}
export function undoGraphHistory(history:GraphHistory):GraphHistory{if(!history.past.length)return history;return {...history,past:history.past.slice(0,-1),present:{...structuredClone(history.past.at(-1)!),revision:history.present.revision+1},future:[structuredClone(history.present),...history.future]};}
export function redoGraphHistory(history:GraphHistory):GraphHistory{if(!history.future.length)return history;return {...history,past:[...history.past,structuredClone(history.present)].slice(-history.limit),present:{...structuredClone(history.future[0]),revision:history.present.revision+1},future:history.future.slice(1)};}
