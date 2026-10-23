import type {Analysis,FlowEdge,FlowNode,HarRequest,ResourceBinding} from './types';
import {allProjectNodes,migrateLegacyCapture,withCaptureProvenance,type CaptureSource} from './captures.ts';
import {withUserInputBindings,projectInputValues} from './userInputs.ts';
import {bindingVariable} from './bindings.ts';
import type {ChatMessage,ChatQuestion} from './agentChat';
import type {ResourceDefaults} from './resourceRelations';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>!['__proto__','prototype','constructor'].includes(key));
const strings=(value:unknown):value is Record<string,string>=>record(value)&&Object.keys(value).every(key=>!['__proto__','prototype','constructor'].includes(key))&&Object.values(value).every(item=>typeof item==='string'&&item.length<=16384);
const kinds=new Set(['input','request','extract','condition','output','manual','assertion','proxy','profile','browserSession','browser','browserVerification','loop','subflow','break']);
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const opaqueId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\x00-\x1f]/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const text=(value:unknown,max=65536):value is string=>typeof value==='string'&&value.length<=max;
const finite=(value:unknown,min:number,max:number,integer=false)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!integer||Number.isSafeInteger(value));
const only=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const optionalStrings=(value:Record<string,unknown>,keys:string[],max=65536)=>keys.every(key=>value[key]===undefined||text(value[key],max));
const optionalBooleans=(value:Record<string,unknown>,keys:string[])=>keys.every(key=>value[key]===undefined||typeof value[key]==='boolean');
function validRequest(value:unknown):value is HarRequest{
 return record(value)&&safeId(value.id)&&['method','url','domain','path','category','mimeType'].every(key=>text(value[key],16384))&&['body','responseBody'].every(key=>text(value[key],32*1024*1024))&&finite(value.status,0,999,true)&&finite(value.duration,0,Number.MAX_SAFE_INTEGER)&&['headers','responseHeaders','query'].every(key=>record(value[key])&&Object.values(value[key]).every(item=>text(item,1024*1024)))&&optionalStrings(value,['captureId','originalRequestId','pageId','startedDateTime','startedAt','responseDetailUrl'],16384)&&optionalBooleans(value,['responseBodyTruncated'])&&(value.responseBodyBytes===undefined||finite(value.responseBodyBytes,0,Number.MAX_SAFE_INTEGER,true));
}
function validEdges(value:unknown,nodes:FlowNode[]):value is FlowEdge[]{
 if(!Array.isArray(value)||value.length>5000)return false;
 const known=new Set(nodes.map(node=>node.id)),seen=new Set<string>();
 return value.every(edge=>record(edge)&&opaqueId(edge.id)&&!seen.has(edge.id)&&!!seen.add(edge.id)&&safeId(edge.source)&&safeId(edge.target)&&known.has(edge.source)&&known.has(edge.target)&&['sourceHandle','targetHandle'].every(key=>edge[key]===undefined||edge[key]===null||text(edge[key],128)));
}
function validNode(value:unknown,depth=0):value is FlowNode{
 if(depth>4||!record(value)||!safeId(value.id)||value.type!=='block'||!record(value.position)||!finite(value.position.x,-1e7,1e7)||!finite(value.position.y,-1e7,1e7)||!record(value.data))return false;
 const data=value.data;
 if(!kinds.has(String(data.kind))||typeof data.label!=='string'||data.label.length>2000)return false;
 if(!['description','requestId','method','url','body','variable','value','source','path','operator','expected','template','acceptStatus','generatedKey','groupId','groupLabel','readiness','uncertainty','captureId','originalRequestId','sessionId','proxyId','profileId','browserAction','selector','text'].every(key=>data[key]===undefined||typeof data[key]==='string'))return false;
 if(data.body!==undefined&&!text(data.body,32*1024*1024)||data.headers!==undefined&&(!record(data.headers)||!Object.values(data.headers).every(item=>text(item,1024*1024))))return false;
 if(!['evidence','inputs','outputs','dependencies'].every(key=>data[key]===undefined||(Array.isArray(data[key])&&data[key].length<=3000&&data[key].every(item=>typeof item==='string'))))return false;
 if(data.inputFieldsReviewed!==undefined&&typeof data.inputFieldsReviewed!=='boolean')return false;
 if(data.bindings!==undefined&&(!Array.isArray(data.bindings)||data.bindings.length>100||!data.bindings.every(binding=>record(binding)&&opaqueId(binding.id)&&text(binding.name,2000)&&text(binding.path,2048)&&['body','header','query','url'].includes(String(binding.target))&&['fixed','user','upstream','runtime','manual'].includes(String(binding.mode))&&optionalStrings(binding,['value','source','sourcePath','generator','evidence','placeholder'])&&(binding.required===undefined||typeof binding.required==='boolean'))||new Set(data.bindings.map(binding=>(binding as {id:string}).id)).size!==data.bindings.length))return false;
 if(data.proxy!==undefined&&(!record(data.proxy)||!only(data.proxy,['url','sessionToken','rotation','rotationMinutes','credentialsMissing'])||!text(data.proxy.url,16384)||!['fixed','run','request','minutes'].includes(String(data.proxy.rotation))||data.proxy.sessionToken!==undefined&&!text(data.proxy.sessionToken,2000)||data.proxy.rotationMinutes!==undefined&&!finite(data.proxy.rotationMinutes,1,10080,true)||data.proxy.credentialsMissing!==undefined&&typeof data.proxy.credentialsMissing!=='boolean'))return false;
 if(data.profile!==undefined&&(!record(data.profile)||!only(data.profile,['id','name','browser','locale','timezone','viewport','userAgent'])||!['chromium','firefox','webkit'].includes(String(data.profile.browser))||!text(data.profile.locale,100)||!text(data.profile.timezone,100)||!record(data.profile.viewport)||!finite(data.profile.viewport.width,320,7680,true)||!finite(data.profile.viewport.height,200,4320,true)||['id','name','userAgent'].some(key=>(data.profile as Record<string,unknown>)[key]!==undefined&&!text((data.profile as Record<string,unknown>)[key],4000))))return false;
 if(record(data.profile)){try{new Intl.DateTimeFormat(data.profile.locale as string,{timeZone:data.profile.timezone as string});}catch{return false;}}
 if(data.session!==undefined&&(!record(data.session)||typeof data.session.name!=='string'||['proxyId','profileId'].some(key=>(data.session as Record<string,unknown>)[key]!==undefined&&typeof (data.session as Record<string,unknown>)[key]!=='string')||data.session.persist!==undefined&&typeof data.session.persist!=='boolean'))return false;
 if(data.loop!==undefined){
  const loop=data.loop;
  if(!record(loop)||!['loop','subflow'].includes(String(data.kind))||!['count','each'].includes(String(loop.mode))||!finite(loop.count,0,1000,true)||!text(loop.items)||!['itemVariable','indexVariable'].every(key=>safeId(loop[key]))||loop.itemVariable===loop.indexVariable||!Array.isArray(loop.nodes)||loop.nodes.length>3000||!loop.nodes.every(node=>validNode(node,depth+1))||!validEdges(loop.edges,loop.nodes as FlowNode[])||loop.entryId!==undefined&&loop.entryId!==''&&(!safeId(loop.entryId)||!loop.nodes.some(node=>(node as FlowNode).id===loop.entryId))||['continueOnError','freshSession'].some(key=>loop[key]!==undefined&&typeof loop[key]!=='boolean'))return false;
 }
 return true;
}

export type ProjectDocument={version:4;projectId:string;nodes:FlowNode[];edges:FlowEdge[];captures:CaptureSource[];values:Record<string,string>;resourceBindings:ResourceBinding[];defaults?:ResourceDefaults;suppressedRequestIds?:string[];goal:string;manualSteps:string;datasetKey:string;analysis?:Analysis|null;chatMessages?:ChatMessage[];entryId?:string};
function supplementInputs(nodes:FlowNode[]):FlowNode[]{
 return withUserInputBindings(nodes).map(node=>node.data.loop?{...node,data:{...node.data,loop:{...node.data.loop,nodes:supplementInputs(node.data.loop.nodes)}}}:node);
}
function validAnalysis(value:unknown):value is Analysis{
 return record(value)&&text(value.summary,1000000)&&Array.isArray(value.warnings)&&value.warnings.every(w=>text(w))&&Array.isArray(value.suggestions)&&value.suggestions.length<=100000&&value.suggestions.every(s=>record(s)&&safeId(s.requestId)&&['label','description','category','confidence'].every(key=>text(s[key]))&&Array.isArray(s.dependencies)&&s.dependencies.every(safeId)&&Array.isArray(s.variables)&&s.variables.every(variable=>record(variable)&&['name','source','description'].every(key=>text(variable[key])))&&['inputs','outputs','evidence'].every(key=>s[key]===undefined||Array.isArray(s[key])&&s[key].every(item=>text(item)))&&(s.inputFields===undefined||Array.isArray(s.inputFields)&&s.inputFields.length<=80&&s.inputFields.every(field=>record(field)&&text(field.name)&&['body','query'].includes(String(field.target))&&text(field.path,2048)&&optionalStrings(field,['placeholder'])&&optionalBooleans(field,['required']))));
}
function validChatMessage(value:unknown):value is ChatMessage{
 if(!record(value)||!opaqueId(value.id)||!['user','assistant'].includes(String(value.role))||!text(value.content,64000)||!optionalStrings(value,['error'],16000)||value.status!==undefined&&!['pending','completed','failed','cancelled'].includes(String(value.status))||value.createdAt!==undefined&&!finite(value.createdAt,0,Number.MAX_SAFE_INTEGER,true)||value.changeCount!==undefined&&!finite(value.changeCount,0,1000,true)||!optionalBooleans(value,['runIntent'])||value.nodeIds!==undefined&&(!Array.isArray(value.nodeIds)||!value.nodeIds.every(safeId)))return false;
 return value.questions===undefined||Array.isArray(value.questions)&&value.questions.length<=32&&value.questions.every(question=>record(question)&&safeId(question.id)&&text(question.title,2000)&&text(question.help,16000)&&text(question.placeholder,2000)&&typeof question.required==='boolean'&&safeId(question.variable)&&(question.nodeId===undefined||safeId(question.nodeId)));
}
function validateResourceReferences(nodes:FlowNode[],bindings:ResourceBinding[],defaults:ResourceDefaults):void{
 const known=new Map(allProjectNodes(nodes).map(node=>[node.id,node])),kinds=new Set(['proxy','profile','browserSession']);
 // Drafts keep dangling IDs so execution preflight can locate the broken setting.
 const check=(id:string|undefined,kind:string)=>{const target=id?known.get(id):undefined;if(id&&!safeId(id)||target&&target.data.kind!==kind)throw new Error('项目引用的会话、代理或画像格式或类型不匹配。');};
 check(defaults.sessionId,'browserSession');check(defaults.proxyId,'proxy');check(defaults.profileId,'profile');
 for(const node of known.values()){check(node.data.sessionId,'browserSession');check(node.data.proxyId,'proxy');check(node.data.profileId,'profile');check(node.data.session?.proxyId,'proxy');check(node.data.session?.profileId,'profile');}
 const seen=new Set<string>();for(const binding of bindings){const resource=known.get(binding.resourceId);if(seen.has(binding.id)||resource&&!kinds.has(resource.data.kind)||binding.resourceId===binding.targetId)throw new Error('项目资源关联重复或资源类型不匹配。');seen.add(binding.id);}
}
export function readProjectDocument(value:unknown):ProjectDocument{
 if(!record(value)||value.version!==undefined&&![1,2,3,4].includes(value.version as number)||!Array.isArray(value.nodes)||value.nodes.length>3000||!value.nodes.every(node=>validNode(node))||!validEdges(value.edges,value.nodes as FlowNode[]))throw new Error('项目文件的节点或连线格式无效。');
 const flat=allProjectNodes(value.nodes as FlowNode[]);
 if(flat.length>3000||new Set(flat.map(node=>node.id)).size!==flat.length)throw new Error('项目含重复的步骤编号，或总步骤超过 3000 个。');
 if(value.values!==undefined&&!strings(value.values)||value.projectId!==undefined&&!safeId(value.projectId)||!optionalStrings(value,['goal','manualSteps'],1000000)||!optionalStrings(value,['datasetKey'],2000))throw new Error('项目标识或填写资料格式无效。');
 let captures:CaptureSource[];
 if(value.version===4){
  if(!Array.isArray(value.captures)||value.captures.length>100)throw new Error('项目中的录制资料格式无效。');
  captures=value.captures.map(source=>{
   if(!record(source)||!safeId(source.id)||!text(source.name,4000)||!text(source.createdAt,100)||!Array.isArray(source.requests)||source.requests.length>100000||!source.requests.every(validRequest)||!record(source.summary)||!Array.isArray(source.summary.domains)||!source.summary.domains.every(item=>text(item,2000))||!['total','api','static'].every(key=>finite((source.summary as Record<string,unknown>)[key],0,1000000,true))||!Array.isArray(source.warnings)||source.warnings.length>3000||!source.warnings.every(item=>text(item))||!Array.isArray(source.pages)||source.pages.length>100000||!source.pages.every(page=>record(page)&&opaqueId(page.id)&&text(page.title)&&optionalStrings(page,['startedDateTime'],100))||source.fileSize!==undefined&&!finite(source.fileSize,0,Number.MAX_SAFE_INTEGER,true))throw new Error('项目中某份录制资料不完整。');
   if(new Set(source.pages.map(page=>(page as {id:string}).id)).size!==source.pages.length||source.requests.some(request=>request.captureId!==undefined&&request.captureId!==source.id))throw new Error('录制资料的来源或页面编号不一致。');
   return {id:source.id,name:source.name,createdAt:source.createdAt,status:'ready',summary:structuredClone(source.summary),pages:structuredClone(source.pages),warnings:[...source.warnings],requests:structuredClone(source.requests).map(request=>({...request,captureId:source.id,originalRequestId:request.originalRequestId??request.id})),...(source.fileSize===undefined?{}:{fileSize:source.fileSize})} as CaptureSource;
  });
 }else{
  if(value.requests!==undefined&&(!Array.isArray(value.requests)||value.requests.length>100000||!value.requests.every(validRequest)))throw new Error('项目中的 HAR 记录格式无效。');
  captures=migrateLegacyCapture(value.requests as HarRequest[]??[],typeof value.fileName==='string'?value.fileName:'原项目录制',typeof value.datasetKey==='string'?value.datasetKey:undefined);
 }
 const requests=captures.flatMap(source=>source.requests);
 if(requests.length>100000||new Set(captures.map(source=>source.id)).size!==captures.length||new Set(requests.map(request=>request.id)).size!==requests.length)throw new Error('录制资料存在重复编号或超过请求数量上限，请重新导入。');
 const requestById=new Map(requests.map(request=>[request.id,request]));for(const node of flat){const request=node.data.requestId?requestById.get(node.data.requestId):undefined;if(request&&node.data.captureId&&node.data.captureId!==request.captureId)throw new Error('方块的录制来源与原始请求不一致。');}
 const nodes=supplementInputs(withCaptureProvenance(structuredClone(value.nodes as FlowNode[]),requests));
 const resourceBindings=value.resourceBindings??[];
 if(!Array.isArray(resourceBindings)||resourceBindings.length>5000||!resourceBindings.every(binding=>record(binding)&&['id','resourceId','targetId'].every(key=>safeId(binding[key]))))throw new Error('项目中的资源关联格式无效。');
 const fields=allProjectNodes(nodes);
 const defaults=value.defaults??{};if(!record(defaults)||!only(defaults,['sessionId','proxyId','profileId'])||!Object.values(defaults).every(value=>value===''||safeId(value)))throw new Error('项目默认资源格式无效。');validateResourceReferences(nodes,resourceBindings as ResourceBinding[],defaults as ResourceDefaults);
 if(value.entryId!==undefined&&value.entryId!==''&&(!safeId(value.entryId)||!nodes.some(node=>node.id===value.entryId&&!['proxy','profile','browserSession'].includes(node.data.kind))))throw new Error('项目起点不存在，请使用包含起点的完整项目文件。');
 if(value.analysis!==undefined&&value.analysis!==null&&!validAnalysis(value.analysis))throw new Error('项目分析记录格式无效。');
 if(value.chatMessages!==undefined&&(!Array.isArray(value.chatMessages)||value.chatMessages.length>1000||!value.chatMessages.every(validChatMessage)))throw new Error('项目对话记录格式无效。');
 if(value.suppressedRequestIds!==undefined&&(!Array.isArray(value.suppressedRequestIds)||value.suppressedRequestIds.length>100000||!value.suppressedRequestIds.every(safeId)||new Set(value.suppressedRequestIds).size!==value.suppressedRequestIds.length))throw new Error('项目中已删除步骤的记录格式无效。');
 const inputKeys=new Set(fields.flatMap(node=>[...(node.data.kind==='input'&&node.data.variable?[node.data.variable]:[]),...(node.data.bindings??[]).filter(binding=>binding.mode==='user').map(binding=>bindingVariable(node.id,binding.id))]));
 const chatMessages=(value.chatMessages as ChatMessage[]|undefined)?.slice(-200).map(message=>({...message,status:message.status==='pending'?'cancelled' as const:message.status,...(message.questions?{questions:message.questions.filter(question=>inputKeys.has(question.variable))}:{})}));
 return {version:4,projectId:typeof value.projectId==='string'?value.projectId:crypto.randomUUID(),nodes,edges:structuredClone(value.edges as FlowEdge[]),captures,defaults:{...defaults} as ResourceDefaults,suppressedRequestIds:[...(value.suppressedRequestIds as string[]??[])],resourceBindings:structuredClone(resourceBindings as ResourceBinding[]),values:projectInputValues(fields,value.values as Record<string,string>??{}),goal:typeof value.goal==='string'?value.goal:'',manualSteps:typeof value.manualSteps==='string'?value.manualSteps:'',datasetKey:typeof value.datasetKey==='string'?value.datasetKey:crypto.randomUUID(),entryId:typeof value.entryId==='string'?value.entryId:'',...(value.analysis===undefined?{}:{analysis:structuredClone(value.analysis) as Analysis|null}),...(chatMessages?{chatMessages}:{})};
}

function redactChatText(text:string,needles:string[]):string{
 let result=text;for(const needle of needles)if(needle.length>=3)result=result.replaceAll(needle,'[连接凭据已省略]');
 return result.replace(/\b(?:socks5h?|https?):\/\/[^\r\n<>]*?@[^\s<>]*/gi,'[代理连接凭据已省略]');
}
function redactQuestion(question:ChatQuestion,needles:string[]):ChatQuestion{return {...question,title:redactChatText(question.title,needles),help:redactChatText(question.help,needles),placeholder:redactChatText(question.placeholder,needles)};}
export function exportProjectDocument(project:ProjectDocument,includeCredentials=false):ProjectDocument{
 const result=structuredClone(project),needles:string[]=[];
 for(const node of allProjectNodes(result.nodes)){
  delete node.selected;delete node.dragging;delete node.measured;delete node.resizing;
  if(!includeCredentials&&node.data.proxy){
   const proxy=node.data.proxy,original=proxy.url;needles.push(original,proxy.sessionToken??'');let stripped='',missing=Boolean(proxy.credentialsMissing);
   try{const url=new URL(original);if(!['http:','https:','socks5:','socks5h:'].includes(url.protocol)||!url.hostname||url.search||url.hash||url.pathname&&url.pathname!=='/')throw new Error('invalid proxy');if(url.username||url.password){missing=true;for(const part of [url.username,url.password]){needles.push(part);try{needles.push(decodeURIComponent(part));}catch{/* Encoded credentials are still redacted. */}}url.username='';url.password='';}stripped=url.toString();}
   catch{if(original){missing=true;const authority=original.replace(/^[A-Za-z0-9+.-]+:\/\//,'').split('@').slice(0,-1).join('@');if(authority){const split=authority.indexOf(':');needles.push(authority,...(split<0?[]:[authority.slice(0,split),authority.slice(split+1)]));}}}
   node.data.proxy={...proxy,url:stripped,sessionToken:undefined,...(missing?{credentialsMissing:true}:{})};
  }
 }
 if(!includeCredentials){
  const secrets=[...new Set(needles.filter(Boolean))].sort((a,b)=>b.length-a.length);
  result.chatMessages=result.chatMessages?.map(message=>({...message,content:redactChatText(message.content,secrets),...(message.error?{error:redactChatText(message.error,secrets)}:{}),...(message.questions?{questions:message.questions.map(question=>redactQuestion(question,secrets))}:{})}));
  result.goal=redactChatText(result.goal,secrets);result.manualSteps=redactChatText(result.manualSteps,secrets);
 }
 result.captures=result.captures.filter(source=>source.status==='ready');
 result.values=projectInputValues(allProjectNodes(result.nodes),result.values);
 return result;
}
