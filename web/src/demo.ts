import type { FlowEdge, FlowNode } from './types';
export const demoNodes: FlowNode[] = [
  {id:'welcome-input',type:'block',position:{x:90,y:150},data:{kind:'input',label:'输入你的名字',variable:'name',value:'探索者',description:'一个不访问网络的示例'}},
  {id:'welcome-output',type:'block',position:{x:440,y:150},data:{kind:'output',label:'显示欢迎消息',template:'你好，{{name}}！你的第一个流程运行成功。'}},
];
export const demoEdges:FlowEdge[] = [{id:'welcome-edge',source:'welcome-input',target:'welcome-output'}];
const entry = (url:string,mimeType:string,body:string,status=200) => ({startedDateTime:'2026-01-01T00:00:00.000Z',time:42,request:{method:'GET',url,httpVersion:'HTTP/1.1',cookies:[],headers:[{name:'Accept',value:'application/json'}],queryString:[],headersSize:-1,bodySize:0},response:{status,statusText:'OK',httpVersion:'HTTP/1.1',cookies:[],headers:[{name:'Content-Type',value:mimeType}],content:{size:body.length,mimeType,text:body},redirectURL:'',headersSize:-1,bodySize:body.length},cache:{},timings:{send:0,wait:40,receive:2}});
export const sampleHar = {log:{version:'1.2',creator:{name:'HAR Canvas 示例',version:'1.0'},entries:[
  entry('https://jsonplaceholder.typicode.com/users/1','application/json',JSON.stringify({id:1,name:'Leanne Graham',username:'Bret'})),
  entry('https://jsonplaceholder.typicode.com/posts?userId=1','application/json',JSON.stringify([{userId:1,id:1,title:'示例文章'}])),
  entry('https://example.com/style.css','text/css','body { color: #333; }'),
]}};
