import type {BlockData,BrowserProfileConfig,FlowNode,Kind} from './types';

export type ProxyParts={protocol:'socks5'|'http'|'https';host:string;port:string;username:string;password:string};
export type ProxyParseResult={value?:ProxyParts;error?:string};
export const resourceKinds=['proxy','profile','browserSession'] as const;
export function isResourceKind(kind:Kind|string){return (resourceKinds as readonly string[]).includes(kind);}

/** Parse only a proxy endpoint. Paths and fragments usually indicate an accidental paste. */
export function parseProxyUrl(input:string):ProxyParseResult{
 if(!input.trim())return {error:'粘贴代理链接后，这里会自动拆分。'};
 if(input.length>4096)return {error:'代理链接过长，请检查。'};
 try{
  const url=new URL(input.trim()),protocol=url.protocol.slice(0,-1);
  if(!['socks5','http','https'].includes(protocol))return {error:'请选择 SOCKS5、HTTP 或 HTTPS 代理。'};
  if(!url.hostname||(url.pathname&&url.pathname!=='/')||url.search||url.hash)return {error:'代理链接只需协议、账号、密码、地址和端口，不包含网页路径。'};
  const username=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
  const port=url.port||(protocol==='socks5'?'1080':protocol==='https'?'443':'80');
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)return {error:'端口应在 1 到 65535 之间。'};
  if(/[\u0000-\u0020\u007f]/.test(url.hostname)||/[\u0000-\u001f\u007f]/.test(username+password))return {error:'代理链接包含无法使用的控制字符。'};
  return {value:{protocol:protocol as ProxyParts['protocol'],host:url.hostname,port,username,password}};
 }catch{return {error:'暂时无法识别链接。请检查协议、地址、端口及特殊字符编码。'};}
}

export function buildProxyUrl(parts:ProxyParts):string{
 const host=parts.host.includes(':')&&!parts.host.startsWith('[')?`[${parts.host}]`:parts.host;
 const auth=parts.username||parts.password?`${encodeURIComponent(parts.username)}${parts.password?`:${encodeURIComponent(parts.password)}`:''}@`:'';
 return `${parts.protocol}://${auth}${host}${parts.port?`:${parts.port}`:''}`;
}

export function usernameSegments(username:string):{text:string;start:number;selectable:boolean;session:boolean}[]{
 const matches=[...username.matchAll(/[^\-_:]+|[\-_:]+/g)];
 return matches.map((match,index)=>({text:match[0],start:match.index!,selectable:!/^[\-_:]+$/.test(match[0]),session:index>1&&/^sid$/i.test(matches[index-2][0])&&/^-$/.test(matches[index-1][0])}));
}

export function selectProxySessionToken(username:string,token:string):{valid:boolean;error?:string}{
 if(!token)return {valid:false,error:'点击账号中的会话片段，或填写要轮换的原始片段。'};
 const first=username.indexOf(token);
 if(first<0)return {valid:false,error:'会话片段需要与账号中的原文一致。'};
 if(username.indexOf(token,first+1)>=0)return {valid:false,error:'这段内容在账号中出现多次，请选择更完整且唯一的片段。'};
 return {valid:true};
}

export function detectedSessionToken(username:string):string|undefined{
 const segments=usernameSegments(username).filter(segment=>segment.session);
 return segments.length===1&&selectProxySessionToken(username,segments[0].text).valid?segments[0].text:undefined;
}

export function defaultResourceData(kind:Kind):Partial<BlockData>{
 if(kind==='proxy')return {proxy:{url:'',rotation:'fixed'}};
 if(kind==='profile')return {profile:{name:'我的浏览器环境',browser:'chromium',locale:'zh-CN',timezone:'Asia/Shanghai',viewport:{width:1280,height:800}}};
 if(kind==='browserSession')return {session:{name:'独立会话',persist:false}};
 if(kind==='browser')return {url:'',browserAction:'navigate',description:'在真实浏览器中打开网页，使用选定会话继续操作。'};
 if(kind==='browserVerification')return {url:'',variable:'verificationDone',description:'在真实浏览器中完成操作，确认后继续同一次运行。'};
 if(kind==='loop')return {loop:{mode:'count',count:3,items:'',itemVariable:'item',indexVariable:'index',nodes:[],edges:[]}};
 if(kind==='subflow')return {loop:{mode:'count',count:1,items:'',itemVariable:'item',indexVariable:'index',nodes:[],edges:[]}};
 return {};
}

export function currentEnvironmentProfile(profile:BrowserProfileConfig,environment:{locale:string;timezone:string;width:number;height:number}):BrowserProfileConfig{
 return {...profile,locale:environment.locale||profile.locale,timezone:environment.timezone||profile.timezone,viewport:{width:Math.max(320,Math.min(7680,Math.round(environment.width)||1280)),height:Math.max(240,Math.min(4320,Math.round(environment.height)||800))}};
}

export function resourceSummary(data:BlockData,nodes:FlowNode[]=[]):string{
 if(data.kind==='proxy'){const parsed=parseProxyUrl(data.proxy?.url??'');return parsed.value?`${parsed.value.protocol.toUpperCase()} · ${parsed.value.host}:${parsed.value.port}`:'粘贴代理链接';}
 if(data.kind==='profile'){const profile=data.profile;return profile?`${profile.browser} · ${profile.locale} · ${profile.viewport.width} × ${profile.viewport.height}`:'设置语言、时区和窗口';}
 if(data.kind==='browserSession')return data.session?.name||'为一组步骤保持相同环境';
 if(data.kind==='loop')return data.loop?.mode==='each'?'逐项处理列表':`重复 ${data.loop?.count??3} 次`;
 if(data.kind==='subflow')return `包含 ${data.loop?.nodes.length??0} 个步骤`;
 if(data.kind==='browser'||data.kind==='browserVerification')return nodes.find(node=>node.id===data.sessionId)?.data.label||(data.sessionId?'使用已选择的浏览器会话':'继承流程环境或选择会话');
 if(data.kind==='break')return '结束当前循环，继续循环后的步骤';
 return '';
}
