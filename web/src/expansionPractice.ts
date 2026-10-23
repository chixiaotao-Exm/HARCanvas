import type {FlowEdge,FlowNode} from './types';

export const expansionPracticeGuide=[
 '点击运行，默认会重复两次，每轮都等你填写一条练习备注。',
 '每轮填写任意备注并继续；想提前停止剩余轮次时，在当前轮填写“结束”。',
 '展开“重复两轮”可编辑内部步骤；也可以把次数改为 0、1 或更多。',
 '把“是否开始练习”改成“否”，再运行可查看另一条分支。此练习不访问网络，也不调用模型。',
];

/** Only input, condition, loop, manual, break and output: no network executor. */
export function createExpansionPracticeFlow():{nodes:FlowNode[];edges:FlowEdge[]}{
 const edge=(source:string,target:string,sourceHandle?:'true'|'false'):FlowEdge=>({id:`${source}-${target}`,source,target,type:'smoothstep',...(sourceHandle?{sourceHandle}:{})});
 const body:FlowNode[]=[
  {id:'expansion-note',type:'block',position:{x:60,y:100},data:{kind:'manual',label:'填写这一轮的练习备注',variable:'practiceNote',description:'输入任意备注后继续。想提前结束剩余轮次时，输入“结束”。这里只保存练习文字。'}},
  {id:'expansion-stop',type:'block',position:{x:410,y:100},data:{kind:'condition',label:'你想提前结束吗？',variable:'practiceNote',operator:'eq',expected:'结束',description:'输入“结束”走「是」，停止剩余轮次；其他备注走「否」，显示这一轮结果。'}},
  {id:'expansion-break',type:'block',position:{x:760,y:20},data:{kind:'break',label:'提前结束重复',description:'结束所在循环，继续主流程中的结果步骤。不会重新执行已经完成的轮次。'}},
  {id:'expansion-round-output',type:'block',position:{x:760,y:240},data:{kind:'output',label:'显示这一轮的备注',template:'已记录：{{practiceNote}}',description:'本轮备注会作为单独结果保留，下一轮仍会重新等待你的输入。'}},
 ];
 return {
  nodes:[
   {id:'expansion-name',type:'block',position:{x:40,y:100},data:{kind:'input',label:'练习名称',variable:'practiceName',value:'我的第一次循环',description:'可以直接改名字，后续输出会引用这个输入。'}},
   {id:'expansion-switch',type:'block',position:{x:390,y:100},data:{kind:'input',label:'是否开始练习',variable:'practiceEnabled',value:'是',description:'填写“是”进入循环，填写“否”查看跳过分支。'}},
   {id:'expansion-condition',type:'block',position:{x:740,y:100},data:{kind:'condition',label:'要进入重复步骤吗？',variable:'practiceEnabled',operator:'eq',expected:'是',description:'根据前面填写的选择走不同连线，只有被选中的分支执行。'}},
   {id:'expansion-loop',type:'block',position:{x:1090,y:30},data:{kind:'loop',label:'重复两轮',description:'点击“编辑内部步骤”查看每轮的人工输入、条件判断和输出。每轮执行结果分别保留。',loop:{mode:'count',count:2,items:'',itemVariable:'practiceItem',indexVariable:'practiceIndex',nodes:body,edges:[edge('expansion-note','expansion-stop'),edge('expansion-stop','expansion-break','true'),edge('expansion-stop','expansion-round-output','false')],entryId:'expansion-note',continueOnError:false,freshSession:false}}},
   {id:'expansion-done',type:'block',position:{x:1460,y:30},data:{kind:'output',label:'查看练习总结',template:'{{practiceName}}：本次完成了 {{expansion-loop.count}} 轮。每轮详情可以在运行记录里查看。',description:'只统计这次实际执行的轮次。把循环次数改成 0 也可以正常结束。'}},
   {id:'expansion-skipped',type:'block',position:{x:1090,y:500},data:{kind:'output',label:'这次跳过练习',template:'{{practiceName}}：你选择了跳过，未进入重复步骤。',description:'条件的另一条分支。改回“是”后可再次运行循环练习。'}},
  ],
  edges:[edge('expansion-name','expansion-switch'),edge('expansion-switch','expansion-condition'),edge('expansion-condition','expansion-loop','true'),edge('expansion-loop','expansion-done'),edge('expansion-condition','expansion-skipped','false')],
 };
}
