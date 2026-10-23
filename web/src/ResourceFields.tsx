import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowUpRight,FlaskConical,LoaderCircle} from 'lucide-react';
import type {BlockData,FlowNode,ProxyConfig} from './types';
import type {ResourceDefaults} from './resourceRelations';
import {buildProxyUrl,currentEnvironmentProfile,defaultResourceData,detectedSessionToken,isResourceKind,parseProxyUrl,selectProxySessionToken,usernameSegments,type ProxyParts} from './resources';
import './ResourceFields.css';

export type ProxyTestResult={ok:boolean;durationMs?:number;exitIp?:string;error?:string};
export type ResourceFieldState={nodes:FlowNode[];defaults?:ResourceDefaults;disabled?:boolean;onPatch:(nodeId:string,patch:Partial<BlockData>)=>void;onOpenSubflow?:(nodeId:string)=>void;onTestProxy?:(nodeId:string)=>Promise<ProxyTestResult>;onLocate?:(nodeId:string)=>void;onCreateEnvironment?:(targetNodeId:string)=>void};
const defaultResourceState:ResourceFieldState={nodes:[],disabled:true,onPatch:()=>{}};
export const ResourceFieldContext=createContext<ResourceFieldState>(defaultResourceState);
const emptyParts:ProxyParts={protocol:'socks5',host:'',port:'1080',username:'',password:''};
const rotationNames:Record<ProxyConfig['rotation'],string>={fixed:'固定会话片段',run:'每次运行随机',request:'每次请求随机',minutes:'每 X 分钟轮换'};

export function ResourceFields({nodeId,data,onChange,nodes:providedNodes,compact=false}:{nodeId:string;data:BlockData;onChange?:(patch:Partial<BlockData>)=>void;nodes?:FlowNode[];compact?:boolean}){
 const state=useContext(ResourceFieldContext),nodes=providedNodes??state.nodes,disabled=state===defaultResourceState?!onChange:!!state.disabled;
 const patch=(value:Partial<BlockData>)=>onChange?onChange(value):state.onPatch(nodeId,value);
 const config=data.proxy??{url:'',rotation:'fixed' as const};
 const [parts,setParts]=useState<ProxyParts>(()=>parseProxyUrl(config.url).value??emptyParts);
 const [testing,setTesting]=useState(false),[testResult,setTestResult]=useState<ProxyTestResult>();const testVersion=useRef(0);
 useEffect(()=>{const parsed=parseProxyUrl(config.url);if(parsed.value)setParts(parsed.value);else if(!config.url.trim())setParts(emptyParts);testVersion.current++;setTesting(false);setTestResult(undefined);},[config.url,config.rotation,config.sessionToken,config.rotationMinutes,nodeId]);
 const setUrl=(url:string)=>{const parsed=parseProxyUrl(url);const sessionToken=parsed.value?detectedSessionToken(parsed.value.username):undefined;patch({proxy:{...config,url:parsed.value?buildProxyUrl(parsed.value):url,credentialsMissing:config.credentialsMissing&&!(parsed.value?.username||parsed.value?.password)?true:undefined,sessionToken:config.sessionToken&&parsed.value?.username.includes(config.sessionToken)?config.sessionToken:sessionToken}});};
 const setPart=(key:keyof ProxyParts,value:string)=>{const next={...parts,[key]:value};setParts(next);setUrl(buildProxyUrl(next));};
 const select=(kind:FlowNode['data']['kind'],value:string|undefined,onSelect:(id:string)=>void,label:string,placeholder='继承当前流程设置')=><Field label={label}><select value={value??''} disabled={disabled} onChange={event=>onSelect(event.target.value)}><option value="">{placeholder}</option>{nodes.filter(node=>node.id!==nodeId&&node.data.kind===kind).map(node=><option key={node.id} value={node.id}>{node.data.label}</option>)}{value&&!nodes.some(node=>node.id===value&&node.data.kind===kind)&&<option value={value}>引用已失效，请重新选择</option>}</select>{value&&state.onLocate&&<button type="button" className="resource-locate" onClick={()=>state.onLocate?.(value)}>查看对应方块<ArrowUpRight size={10}/></button>}</Field>;
 const test=async()=>{if(!state.onTestProxy)return;const current=++testVersion.current;setTesting(true);setTestResult(undefined);try{const result=await state.onTestProxy(nodeId);if(current===testVersion.current)setTestResult(result);}catch{if(current===testVersion.current)setTestResult({ok:false,error:'测试未完成，请稍后重试。'});}finally{if(current===testVersion.current)setTesting(false);}};
 const parsed=parseProxyUrl(config.url),tokenCheck=selectProxySessionToken(parts.username,config.sessionToken??'');
 const profile=data.profile??defaultResourceData('profile').profile!;
 const session=data.session??defaultResourceData('browserSession').session!;
 const loop=data.loop??defaultResourceData(data.kind==='subflow'?'subflow':'loop').loop!;
 const updateLoop=(value:Partial<NonNullable<BlockData['loop']>>)=>patch({loop:{...loop,...value}});
 const execution=['request','browser','browserVerification','loop','subflow'].includes(data.kind);
 if(!isResourceKind(data.kind)&&!execution&&data.kind!=='break')return null;
 return <div className={`resource-fields nodrag nopan nowheel ${compact?'compact':''}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
  {data.kind==='proxy'&&<>
   <Field label="代理链接"><textarea aria-label="代理链接" rows={compact?2:3} value={config.url} placeholder="socks5://账号:密码@地址:端口" disabled={disabled} autoComplete="off" spellCheck={false} onChange={event=>setUrl(event.target.value)}/></Field>
   {config.credentialsMissing&&<><p className="resource-warning">导出未包含连接凭据，请补充账号和密码。</p>{parsed.value&&!parsed.value.username&&!parsed.value.password&&<button type="button" className="resource-locate" disabled={disabled} onClick={()=>patch({proxy:{...config,credentialsMissing:undefined}})}>我填写的新代理不需要账号密码</button>}</>}
   {config.url&&!parsed.value&&<p className="resource-warning" role="status">{parsed.error}</p>}
   <details className="resource-details" open={!compact}><summary>拆分连接信息</summary><div className="resource-pair"><Field label="协议"><select value={parts.protocol} disabled={disabled} onChange={event=>setPart('protocol',event.target.value)}><option value="socks5">SOCKS5</option><option value="http">HTTP</option><option value="https">HTTPS</option></select></Field><Field label="端口"><input aria-label="代理端口" inputMode="numeric" value={parts.port} disabled={disabled} onChange={event=>setPart('port',event.target.value)}/></Field></div><Field label="服务器地址"><input aria-label="代理服务器地址" value={parts.host} disabled={disabled} spellCheck={false} onChange={event=>setPart('host',event.target.value)}/></Field><Field label="用户名"><input aria-label="代理用户名" value={parts.username} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event=>setPart('username',event.target.value)}/></Field><Field label="密码"><input aria-label="代理密码" type="text" value={parts.password} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event=>setPart('password',event.target.value)}/></Field></details>
   {parts.username&&<><span className="resource-caption">点击账号中需要变化的片段</span><div className="resource-username" aria-label="选择代理会话片段">{usernameSegments(parts.username).map(segment=>segment.selectable?<button type="button" key={segment.start} className={segment.text===config.sessionToken?'selected':''} aria-pressed={segment.text===config.sessionToken} disabled={disabled} onClick={()=>patch({proxy:{...config,sessionToken:segment.text}})}>{segment.text}</button>:<span key={segment.start}>{segment.text}</span>)}</div></>}
   <Field label="会话片段（原文）"><input aria-label="代理会话片段" value={config.sessionToken??''} placeholder="例如账号中 sid 后面的片段" disabled={disabled} spellCheck={false} onChange={event=>patch({proxy:{...config,sessionToken:event.target.value}})}/></Field>
   <Field label="何时改变这个片段？"><select aria-label="代理轮换方式" value={config.rotation} disabled={disabled} onChange={event=>patch({proxy:{...config,rotation:event.target.value as ProxyConfig['rotation']}})}>{Object.entries(rotationNames).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></Field>
   {config.rotation==='minutes'&&<Field label="每隔多少分钟？"><input aria-label="代理轮换分钟" type="number" min={1} max={1440} value={config.rotationMinutes??5} disabled={disabled} onChange={event=>patch({proxy:{...config,rotationMinutes:Math.max(1,Math.min(1440,Number(event.target.value)||1))}})}/></Field>}
   {config.rotation!=='fixed'&&!tokenCheck.valid&&<p className="resource-warning">{tokenCheck.error}</p>}
   <p className="resource-note">{config.rotation==='request'?'登录会话通常需要固定出口；逐请求轮换会在运行前检查冲突。':'改变片段不保证服务商更换出口 IP。'} 不自行解释服务商的地区、时长字段。</p>
   <button type="button" className="resource-action" disabled={disabled||testing||!parsed.value||!state.onTestProxy} onClick={()=>void test()}>{testing?<LoaderCircle size={12} className="spin"/>:<FlaskConical size={12}/>} {testing?'正在测试连接…':'测试连接'}</button>
   {testResult&&<p role="status" className={testResult.ok?'resource-success':'resource-warning'}>{testResult.ok?`连接成功${testResult.durationMs!==undefined?` · ${testResult.durationMs} ms`:''}${testResult.exitIp?` · 出口 ${testResult.exitIp}`:''}`:testResult.error||'连接失败，请检查代理配置。'}</p>}
   <ResourceUsage nodeId={nodeId} nodes={nodes}/>
  </>}
  {data.kind==='profile'&&<>
   <button type="button" className="resource-action" disabled={disabled} onClick={()=>patch({profile:currentEnvironmentProfile(profile,{locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,width:window.innerWidth,height:window.innerHeight})})}>使用当前浏览器环境</button>
   <p className="resource-note">读取当前网页的语言、时区和窗口大小。执行时使用下方选定的服务器浏览器。</p>
   {nodes.some(node=>node.id!==nodeId&&node.data.kind==='profile'&&node.data.profile)&&<Field label="从已有画像复制配置"><select aria-label="复制已有浏览器画像" value="" disabled={disabled} onChange={event=>{const selected=nodes.find(node=>node.id===event.target.value)?.data.profile;if(selected)patch({profile:{...selected,id:undefined,viewport:{...selected.viewport}}});}}><option value="">选择一个画像作为起点</option>{nodes.filter(node=>node.id!==nodeId&&node.data.kind==='profile'&&node.data.profile).map(node=><option key={node.id} value={node.id}>{node.data.label}</option>)}</select></Field>}
   <Field label="浏览器类型"><select value={profile.browser} disabled={disabled} onChange={event=>patch({profile:{...profile,browser:event.target.value as typeof profile.browser}})}><option value="chromium">Chromium</option><option value="firefox">Firefox</option><option value="webkit">WebKit</option></select></Field>
   <div className="resource-pair"><Field label="语言"><input value={profile.locale} placeholder="zh-CN" disabled={disabled} onChange={event=>patch({profile:{...profile,locale:event.target.value}})}/></Field><Field label="时区"><input value={profile.timezone} placeholder="Asia/Shanghai" disabled={disabled} onChange={event=>patch({profile:{...profile,timezone:event.target.value}})}/></Field></div>
   <div className="resource-pair"><Field label="窗口宽度"><input type="number" min={320} max={7680} value={profile.viewport.width} disabled={disabled} onChange={event=>patch({profile:{...profile,viewport:{...profile.viewport,width:Math.max(320,Math.min(7680,Number(event.target.value)||1280))}}})}/></Field><Field label="窗口高度"><input type="number" min={240} max={4320} value={profile.viewport.height} disabled={disabled} onChange={event=>patch({profile:{...profile,viewport:{...profile.viewport,height:Math.max(240,Math.min(4320,Number(event.target.value)||800))}}})}/></Field></div>
   <details className="resource-details"><summary>高级环境配置</summary><Field label="User-Agent（留空使用浏览器默认值）"><textarea rows={3} value={profile.userAgent??''} disabled={disabled} onChange={event=>patch({profile:{...profile,userAgent:event.target.value}})}/></Field><p className="resource-note">自定义请求头不会改变真实设备、TLS 或浏览器内核。</p></details>
   <p className="resource-note">配置：语言、时区、窗口与可选 User-Agent。实际应用值：在浏览器步骤运行结果中查看。HTTP 请求只应用支持的请求头，不应用窗口或时区；不会改变 TLS 指纹。导出项目即可保存此画像。</p><ResourceUsage nodeId={nodeId} nodes={nodes}/>
  </>}
  {data.kind==='browserSession'&&<>
   <Field label="会话名称"><input value={session.name} disabled={disabled} onChange={event=>patch({session:{...session,name:event.target.value}})}/></Field>
   {select('proxy',session.proxyId,proxyId=>patch({session:{...session,proxyId:proxyId||undefined}}),'使用哪个代理？','直接连接（不使用代理）')}
   {select('profile',session.profileId,profileId=>patch({session:{...session,profileId:profileId||undefined}}),'使用哪个画像？','使用执行器默认环境')}
   <p className="resource-note">同类步骤共用 Cookie 与固定环境，不同会话独立。浏览器与 HTTP 请求分别保留登录状态，目前不自动互换 Cookie；运行中的配置保持不变。</p>
   <label className="resource-check"><input type="checkbox" checked={!!session.persist} disabled={disabled} onChange={event=>patch({session:{...session,persist:event.target.checked}})}/>下次运行继续使用这个会话</label>
   {session.persist&&<p className="resource-note">在当前服务内保存，空闲 30 分钟后释放，服务重启后需重新登录；同一会话按顺序使用。</p>}
   <ResourceUsage nodeId={nodeId} nodes={nodes}/>
  </>}
  {(data.kind==='loop'||data.kind==='subflow')&&<>
   {data.kind==='loop'&&<><Field label="如何重复？"><select value={loop.mode} disabled={disabled} onChange={event=>updateLoop({mode:event.target.value as typeof loop.mode})}><option value="count">重复固定次数</option><option value="each">逐项处理列表</option></select></Field>{loop.mode==='count'?<Field label="重复多少次？"><input aria-label="循环次数" type="number" min={0} max={1000} value={loop.count} disabled={disabled} onChange={event=>updateLoop({count:Math.max(0,Math.min(1000,Number(event.target.value)||0))})}/></Field>:<><Field label="列表变量名称"><input value={loop.items} placeholder="例如 orders" disabled={disabled} onChange={event=>updateLoop({items:event.target.value})}/></Field><div className="resource-pair"><Field label="当前一项名称"><input value={loop.itemVariable} disabled={disabled} onChange={event=>updateLoop({itemVariable:event.target.value})}/></Field><Field label="当前序号名称"><input value={loop.indexVariable} disabled={disabled} onChange={event=>updateLoop({indexVariable:event.target.value})}/></Field></div></>}</>}
   <button type="button" className="resource-action" disabled={disabled||!state.onOpenSubflow} onClick={()=>state.onOpenSubflow?.(nodeId)}>编辑内部 {loop.nodes.length} 个步骤<ArrowUpRight size={12}/></button>
   {data.kind==='loop'&&<details className="resource-details"><summary>每轮遇到问题时</summary><label className="resource-check"><input type="checkbox" checked={!!loop.continueOnError} disabled={disabled} onChange={event=>updateLoop({continueOnError:event.target.checked})}/>记录失败，继续下一轮</label><label className="resource-check"><input type="checkbox" checked={!!loop.freshSession} disabled={disabled} onChange={event=>updateLoop({freshSession:event.target.checked})}/>每轮使用新的独立会话</label></details>}
   <p className="resource-note">{loop.nodes.length?'运行时保留每轮结果，失败会定位到具体步骤。':'将要重复的步骤放入内部流程，或框选后选择「重复这部分」。'}</p>
  </>}
  {data.kind==='browser'&&<Field label="在网页里做什么？"><select value={data.browserAction??'navigate'} disabled={disabled} onChange={event=>patch({browserAction:event.target.value as BlockData['browserAction']})}><option value="navigate">打开网页</option><option value="click">点击按钮或链接</option><option value="fill">填写网页输入框</option><option value="read">读取网页文字</option><option value="wait">等待网页元素出现</option></select></Field>}
  {(data.kind==='browserVerification'||data.kind==='browser'&&(!data.browserAction||data.browserAction==='navigate'))&&<Field label="网页地址"><input type="url" value={data.url??''} placeholder="https://example.com" disabled={disabled} onChange={event=>patch({url:event.target.value})}/></Field>}
  {data.kind==='browser'&&data.browserAction&&data.browserAction!=='navigate'&&<><Field label="操作网页中的哪个元素？"><input value={data.selector??''} placeholder="可请 Agent 根据网页填写定位方式" disabled={disabled} onChange={event=>patch({selector:event.target.value})}/></Field>{data.browserAction==='fill'&&<Field label="要填写的内容"><input value={data.text??''} placeholder="也可使用已有变量，如 {{email}}" disabled={disabled} onChange={event=>patch({text:event.target.value})}/></Field>}{data.browserAction==='read'&&<Field label="保存到哪个变量？"><input value={data.variable??''} placeholder="例如 pageTitle" disabled={disabled} onChange={event=>patch({variable:event.target.value})}/></Field>}</>}
  {data.kind==='browserVerification'&&<Field label="完成后保存到"><input aria-label="验证结果名称" value={data.variable??''} placeholder="例如 verificationDone" disabled={disabled} onChange={event=>patch({variable:event.target.value})}/></Field>}
  {(data.kind==='browser'||data.kind==='browserVerification')&&<p className="resource-note">{data.kind==='browserVerification'?'运行到这里时暂停，在真实浏览器完成正常操作后继续同一会话。':'在受支持的真实浏览器环境中操作，使用下方选定会话。'} 浏览器不可用时会说明缺少的能力。</p>}
  {execution&&<details className="resource-details resource-references" open={!compact||data.kind==='browser'||data.kind==='browserVerification'}><summary>使用的会话与连接</summary>
   {select('browserSession',data.sessionId,sessionId=>patch({sessionId:sessionId||undefined}),'会话',data.captureId?'本录制独立会话':'继承所在流程会话')}
   {select('proxy',data.proxyId,proxyId=>patch({proxyId:proxyId||undefined}),'代理','继承会话代理')}
   {select('profile',data.profileId,profileId=>patch({profileId:profileId||undefined}),'环境画像','继承会话画像')}
   {!data.sessionId&&state.onCreateEnvironment&&<button type="button" className="resource-action" disabled={disabled} onClick={()=>state.onCreateEnvironment?.(nodeId)}>创建固定浏览器环境</button>}
   <p className="resource-note">这些是配置关系，不改变步骤执行顺序。</p>
  </details>}
  {data.kind==='break'&&<p className="resource-note">与条件判断的「是」分支相连，可提前结束所在循环；循环外不能使用。</p>}
 </div>;
}

function Field({label,children}:{label:string;children:ReactNode}){return <label className="resource-field"><span>{label}</span>{children}</label>;}
function ResourceUsage({nodeId,nodes}:{nodeId:string;nodes:FlowNode[]}){
 const {defaults}=useContext(ResourceFieldContext);
 const using=nodes.filter(node=>node.data.sessionId===nodeId||node.data.proxyId===nodeId||node.data.profileId===nodeId||node.data.session?.proxyId===nodeId||node.data.session?.profileId===nodeId);
 const names=[...(defaults&&[defaults.sessionId,defaults.proxyId,defaults.profileId].includes(nodeId)?['项目默认环境']:[]),...using.map(node=>node.data.label)];
 return <p className="resource-note resource-usage">{names.length?`已关联：${names.slice(0,3).join('、')}${names.length>3?` 等 ${names.length} 处`:''}`:'尚未关联。在请求或会话的「使用的会话与连接」中选择此方块。'}</p>;
}
