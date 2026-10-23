import {createInterface} from 'node:readline';
import {chromium,firefox,webkit} from 'playwright';

// This process is an application executor. It uses ordinary browser contexts,
// without injected device patches or automated challenge handling.
const contexts=new Map(),inflight=new Map(),cancelled=new Set(),engines={chromium,firefox,webkit};
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const safeError=error=>{
 const message=String(error?.message??'浏览器操作失败。').split('\n')[0];
 if(/Executable doesn't exist|browserType.launch|Host system is missing/.test(message))return {code:'browser_unavailable',message:'浏览器执行环境尚未安装，请安装 Playwright 与对应浏览器。'};
 if(/Timeout/.test(message))return {code:'browser_timeout',message:'网页操作超时，请检查网页状态或元素定位方式。'};
 if(/ERR_PROXY|ERR_TUNNEL|ERR_SOCKS/.test(message))return {code:'browser_connection',message:'浏览器连接失败，请检查代理和目标网站。'};
 if(/^HTTP \d+$/.test(message))return {code:'browser_http_status',message:`网页返回 ${message}，请检查网站状态与连接设置。`};
 if(/closed|disposed/i.test(message))return {code:'browser_closed',message:'浏览器会话已结束，请重新运行流程。'};
 return {code:'browser_action_failed',message:'浏览器操作未完成，请检查网页地址、元素定位和当前网页状态。'};
};
const absoluteURL=value=>{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('unsupported URL');return url.href;};
async function create(params){
 if(contexts.has(params.sessionId))return {created:false};
 const profile=params.profile??{},engine=engines[profile.browser??'chromium'];if(!engine)throw Error('unsupported browser');
 const browser=await engine.launch({headless:true,...(!profile.browser||profile.browser==='chromium'?{chromiumSandbox:true}:{}),args:profile.browser==='firefox'||profile.browser==='webkit'?[]:['--disable-dev-shm-usage','--proxy-bypass-list=<-loopback>'],proxy:params.proxy});
 try{
  const context=await browser.newContext({locale:profile.locale||'zh-CN',timezoneId:profile.timezone||'Asia/Shanghai',viewport:profile.viewport?.width?profile.viewport:{width:1280,height:800},userAgent:profile.userAgent||undefined,serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*',async route=>{const url=route.request().url();if(!/^https?:\/\//i.test(url))return route.abort('blockedbyclient');return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(25000);
  page.on('dialog',dialog=>void dialog.dismiss());page.on('download',download=>void download.cancel());
  context.on('page',popup=>{if(popup!==page)void popup.close();});
  if(cancelled.has(params.sessionId)){cancelled.delete(params.sessionId);await browser.close();throw Error('browser closed');}
  contexts.set(params.sessionId,{browser,context,page,queue:Promise.resolve(),profile});return {created:true};
 }catch(error){await browser.close();throw error;}
}
async function close(sessionId){const session=contexts.get(sessionId);contexts.delete(sessionId);if(session)await session.browser.close();else cancelled.add(sessionId);return {closed:true};}
async function queued(sessionId,callback){const session=contexts.get(sessionId);if(!session)throw Error('browser closed');const current=session.queue.catch(()=>{}).then(()=>callback(session));session.queue=current.catch(()=>{});return current;}
async function result(session,extra={}){const {page,profile}=session;return {url:page.url(),title:await page.title(),applied:{browser:profile.browser||'chromium',locale:await page.evaluate(()=>navigator.language),timezone:await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone),viewport:page.viewportSize(),userAgent:await page.evaluate(()=>navigator.userAgent)},...extra};}
async function dispatch(method,params){
 if(method==='create')return create(params);
 if(method==='close')return close(params.sessionId);
 if(method==='closeAll'){await Promise.all([...contexts.keys()].map(close));return {closed:true};}
 return queued(params.sessionId,async session=>{
  const {page}=session;
  if(method==='manualStart'){session.manualToken=params.viewToken;return {ready:true};}
  if(method==='manualEnd'){if(session.manualToken===params.viewToken)session.manualToken=undefined;return {ended:true};}
  if(['view','action'].includes(method)&&(!params.viewToken||params.viewToken!==session.manualToken))throw Error('browser handoff closed');
  if(method==='execute'){
   const {action='navigate',url,selector,text}=params;
   if(action==='navigate'){const response=await page.goto(absoluteURL(url),{waitUntil:'domcontentloaded'});if(response?.status()>=400)throw Error(`HTTP ${response.status()}`);}
   else if(action==='click')await page.locator(selector).first().click();
   else if(action==='fill')await page.locator(selector).first().fill(String(text??''));
   else if(action==='read')return result(session,{text:(await page.locator(selector).first().innerText()).slice(0,262144)});
   else if(action==='wait')await page.locator(selector).first().waitFor({state:'visible'});
   else throw Error('unsupported action');
   return result(session);
  }
  if(method==='view'){
   const image=await page.screenshot({type:'jpeg',quality:70,fullPage:false,timeout:10000});
   return {image:image.toString('base64'),mimeType:'image/jpeg',url:page.url(),title:await page.title(),viewport:page.viewportSize()};
  }
  if(method==='action'){
   if(params.action==='click')await page.mouse.click(params.x,params.y);
   else if(params.action==='type')await page.keyboard.insertText(String(params.text??''));
   else if(params.action==='press')await page.keyboard.press(params.key);
   else if(params.action==='navigate'){const response=await page.goto(absoluteURL(params.url),{waitUntil:'domcontentloaded'});if(response?.status()>=400)throw Error(`HTTP ${response.status()}`);}
   else if(params.action==='scroll')await page.mouse.wheel(0,params.deltaY);
   else throw Error('unsupported action');
   return {url:page.url()};
  }
  throw Error('unsupported method');
 });
}
const reader=createInterface({input:process.stdin,crlfDelay:Infinity});
reader.on('line',line=>{
 let request;try{request=JSON.parse(line);}catch{return;}
 if(request.method==='cancel'){const running=inflight.get(request.params?.requestId);if(running?.sessionId&&['execute','action','create'].includes(running.method))void close(running.sessionId);return;}
 const {id,method,params={}}=request;if(typeof id!=='string'||typeof method!=='string')return;
 inflight.set(id,{sessionId:params.sessionId,method});
 void dispatch(method,params).then(result=>send({id,result})).catch(error=>send({id,error:safeError(error)})).finally(()=>inflight.delete(id));
});
reader.on('close',()=>{void Promise.all([...contexts.keys()].map(close)).finally(()=>process.exit(0));});
process.on('SIGTERM',()=>{void Promise.all([...contexts.keys()].map(close)).finally(()=>process.exit(0));});
