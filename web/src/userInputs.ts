import type {BlockData,FlowNode,ParameterBinding,UserInputField} from './types';
import {bindingVariable} from './bindings.ts';

const normalize=(value:string)=>value.toLowerCase().replace(/[_-]/g,'');
const labels:Record<string,string>={email:'邮箱',emailaddress:'邮箱',mail:'邮箱',username:'用户名',login:'登录账号',loginhint:'登录账号',password:'密码',newpassword:'新密码',confirmpassword:'确认密码',repeatpassword:'确认密码',currentpassword:'当前密码',name:'姓名',fullname:'姓名',displayname:'显示名称',nickname:'昵称',firstname:'名',givenname:'名',lastname:'姓',familyname:'姓',phone:'手机号码',phonenumber:'手机号码',mobile:'手机号码',mobilenumber:'手机号码',company:'公司',organization:'组织',jobtitle:'职位',address:'地址',addressline1:'地址第一行',addressline2:'地址第二行',street:'街道',streetaddress:'街道地址',city:'城市',state:'州 / 地区',province:'省份',country:'国家',postcode:'邮政编码',postalcode:'邮政编码',zipcode:'邮政编码',birthday:'生日',birthdate:'出生日期',dateofbirth:'出生日期'};
const dynamic=/token|csrf|xsrf|signature|captcha|otp|nonce|session|secret|challenge|verification|verifycode|authcode|onetime|totp/i;
const safePath=(path:string)=>path.length>0&&path.length<=1024&&path.split('.').every(key=>key&&!/[{}\[\]\x00-\x1f]/.test(key)&&!['__proto__','prototype','constructor'].includes(key));
const fieldName=(path:string)=>{const name=normalize(path.split('.').at(-1)!);return safePath(path)&&!dynamic.test(normalize(path))&&Object.hasOwn(labels,name)?labels[name]:undefined;};
const key=(field:{target:string;path:string})=>JSON.stringify([field.target,field.path]);

/** A bounded list of supported business locations. No recorded values escape. */
export function userInputFields(data:BlockData):UserInputField[]{
 if(data.kind!=='request')return [];
 const result:UserInputField[]=[],add=(target:UserInputField['target'],path:string)=>{const name=fieldName(path),parts=path.split('.').map(normalize);if(parts.at(-1)==='state'&&(target==='query'||!parts.slice(0,-1).some(part=>['address','shippingaddress','billingaddress','location'].includes(part))))return;if(parts.at(-1)==='name'&&parts.slice(0,-1).some(part=>['event','action','eventdata'].includes(part)))return;if(name)result.push({name,target,path,placeholder:`请输入${name}`,required:true});};
 const contentTypes=Object.entries(data.headers??{}).filter(([name])=>name.toLowerCase()==='content-type').map(([,value])=>value.split(';')[0].trim().toLowerCase());
 if((data.body??'').length<=2*1024*1024&&contentTypes.length<=1&&(!contentTypes[0]||/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentTypes[0]))){
  try{
   const body:unknown=JSON.parse(data.body??'',(_key,value:unknown)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new Error('unsupported number');return value;});
   let visited=0;
   const visit=(value:unknown,path:string,depth:number)=>{
    if(++visited>4000||depth>6)return;
    if(typeof value==='string'){if(path)add('body',path);return;}
    if(!value||typeof value!=='object')return;
    for(const [name,item]of Object.entries(value).slice(0,200)){if(!name||/[.{}\[\]\x00-\x1f]/.test(name)||['__proto__','prototype','constructor'].includes(name))continue;visit(item,path?`${path}.${name}`:name,depth+1);}
   };
   visit(body,'',0);
  }catch{/* Non-JSON and unsupported typed bodies require the parameter wizard. */}
 }
 try{const url=new URL(data.url??'');for(const path of new Set(url.searchParams.keys()))if(normalize(path)!=='state'&&url.searchParams.getAll(path).length===1)add('query',path);}catch{/* Preflight reports invalid request URLs. */}
 return result.slice(0,16);
}

/** Append supported input bindings without changing the capture or user settings. */
export function addUserInputBindings(data:BlockData,proposed?:UserInputField[]):BlockData{
 const fields=userInputFields(data),byKey=new Map(fields.map(field=>[key(field),field]));
 const accepted:UserInputField[]=[],seen=new Set<string>();
 // Canonical field labels and placeholders never echo a model or captured value.
 for(const item of Array.isArray(proposed)?proposed.slice(0,16):[]){
  if(!item||typeof item.path!=='string'||!['body','query'].includes(item.target)||typeof item.required!=='undefined'&&typeof item.required!=='boolean')continue;
  const field=byKey.get(key(item));if(!field||seen.has(key(field)))continue;
  accepted.push({...field,required:item.required??true});seen.add(key(field));
 }
 // Older projects lack structured model fields. Infer only missing business
 // inputs, keeping protocol constants and ambiguous generic names unchanged.
 if(proposed===undefined&&!data.inputFieldsReviewed&&data.readiness==='missing-input')for(const field of fields){
  const parts=field.path.split('.').map(normalize),leaf=parts.at(-1);
  if(leaf==='name'&&!parts.slice(0,-1).some(part=>['profile','user','person','contact','customer','account','registration','form'].includes(part)))continue;
  if(!seen.has(key(field)))accepted.push(field);
 }
 const bindings=[...(data.bindings??[])],ids=new Set(bindings.map(binding=>binding.id));
 let added=0;
 for(const field of accepted.slice(0,16)){
  if(bindings.some(binding=>key(binding)===key(field)||field.target==='body'&&binding.target==='body'&&!binding.path||field.target==='query'&&binding.target==='url'))continue;
  const base=`input-${field.target}-${field.path}`,bindingId=()=>{let id=base,index=1;while(ids.has(id))id=`${base}-${index++}`;ids.add(id);return id;};
  const binding:ParameterBinding={...field,id:bindingId(),mode:'user',evidence:`请求中的 ${field.target==='body'?'JSON 正文':'查询参数'}字段 ${field.path}，由本次用户填写。`};
  bindings.push(binding);added++;
 }
 return added?{...data,bindings}:data;
}

export function withUserInputBindings(nodes:FlowNode[]):FlowNode[]{return nodes.map(node=>{const data=addUserInputBindings(node.data);return data===node.data?node:{...node,data};});}

/** Project exports contain only local answers belonging to current input fields. */
export function projectInputValues(nodes:FlowNode[],values:Record<string,string>):Record<string,string>{
 const result:Record<string,string>=Object.create(null);
 for(const node of nodes){
  const keys=node.data.kind==='input'&&node.data.variable?[node.data.variable]:[];
  keys.push(...(node.data.bindings??[]).filter(binding=>binding.mode==='user').map(binding=>bindingVariable(node.id,binding.id)));
  for(const name of keys)if(Object.hasOwn(values,name)&&typeof values[name]==='string'&&values[name].length<=16384)result[name]=values[name];
 }
 return result;
}
