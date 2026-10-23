import type {FlowNode,FlowEdge} from './types';

/** Explicitly opened practice flow: no network calls or external side effects. */
export function createPracticeFlow():{nodes:FlowNode[];edges:FlowEdge[]} {
  return {
    nodes:[
      {id:'practice-input',type:'block',position:{x:80,y:130},data:{kind:'input',label:'填写练习名称',variable:'name',value:'HAR Canvas',description:'给这次练习起一个名称。后续步骤可以使用这个参数。'}},
      {id:'practice-manual',type:'block',position:{x:430,y:130},data:{kind:'manual',label:'等待你输入确认内容',variable:'confirmation',description:'输入“继续”来体验暂停与恢复。已经完成的步骤不会重复执行。'}},
      {id:'practice-assertion',type:'block',position:{x:780,y:130},data:{kind:'assertion',label:'检查业务条件',variable:'confirmation',operator:'eq',expected:'继续',description:'检查人工输入是否为“继续”。输入其他文字可观察失败方块和修复入口。'}},
      {id:'practice-output',type:'block',position:{x:1130,y:130},data:{kind:'output',label:'显示练习结果',template:'{{name}}：你已完成输入、暂停、检查与输出。',description:'练习只处理当前流程参数，不会访问任何外部网站。'}},
    ],
    edges:[['practice-input','practice-manual'],['practice-manual','practice-assertion'],['practice-assertion','practice-output']].map(([source,target])=>({id:`${source}-${target}`,source,target,type:'smoothstep'})),
  };
}
