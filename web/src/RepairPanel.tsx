import {useId} from 'react';
import {Sparkles,LoaderCircle,Square,LocateFixed,ArrowRight,CheckCircle2,ClipboardCheck,Hand,AlertCircle,Link2,SlidersHorizontal} from 'lucide-react';
import type {FlowNode,PreflightIssue} from './types';
import type {AgentJobProgress} from './agentJobs';
import type {RepairInput,RepairPlan} from './repair';
import './repairPanel.css';

export type RepairPanelProps={
 nodes:FlowNode[];issues:PreflightIssue[];goal:string;onGoal:(value:string)=>void;
 loading:boolean;progress:AgentJobProgress|null;error:string;plan:RepairPlan|null;input:RepairInput|null;
 answers:Record<string,string>;onAnswers:(values:Record<string,string>)=>void;applied:boolean;stale:boolean;disabled:boolean;
 onAnalyze:()=>void;onStop:()=>void;onApply:()=>void;onConfirmNode:(id:string)=>void;onCheck:()=>void;onLocate:(id:string,field?:string)=>void;
};

const stageNames:Record<AgentJobProgress['stage'],string>={preparing:'正在整理步骤和可用字段',waiting_model:'正在等待 Agent 整理建议',reading_response:'正在接收修补建议',validating:'正在核对建议与画布',completed:'修补建议已返回'};
const readinessNames:Record<string,string>={ready:'当前标记为就绪','missing-input':'待补充或核对',manual:'需要人工处理',unsupported:'暂不支持'};
const fieldNames:Record<string,string>={email:'邮箱',username:'用户名',password:'密码',phone:'手机号码',name:'名称',code:'验证码',token:'访问凭据',csrf:'会话校验值',orderId:'订单编号',id:'编号'};
type PreparationKind='input'|'manual'|'unsupported'|'structure';
type PreparationStep={id:string;label:string;node?:FlowNode;issues:PreflightIssue[];kind:PreparationKind};
const categories:{kind:PreparationKind;name:string;icon:typeof SlidersHorizontal}[]=[
 {kind:'input',name:'填写与核对',icon:SlidersHorizontal},{kind:'manual',name:'人工处理',icon:Hand},
 {kind:'unsupported',name:'暂不支持',icon:AlertCircle},{kind:'structure',name:'结构与连接',icon:Link2},
];

function preparationSteps(nodes:FlowNode[],issues:PreflightIssue[]):PreparationStep[]{
 const byId=new Map<string,PreparationStep>(),nodeById=new Map(nodes.map(node=>[node.id,node]));
 for(const issue of issues){
  const key=issue.nodeId??'__workflow__',node=issue.nodeId?nodeById.get(issue.nodeId):undefined;
  if(!byId.has(key))byId.set(key,{id:key,label:node?.data.label||(issue.nodeId?'未找到的步骤':'流程整体'),node,issues:[],kind:'structure'});
  byId.get(key)!.issues.push(issue);
 }
 for(const node of nodes)if(node.data.kind==='request'&&node.data.readiness&&node.data.readiness!=='ready'&&!byId.has(node.id))byId.set(node.id,{id:node.id,label:node.data.label,node,issues:[],kind:'input'});
 for(const step of byId.values()){
  const readiness=step.node?.data.readiness;
  step.kind=readiness==='unsupported'||step.issues.some(issue=>issue.code.startsWith('UNSUPPORTED'))?'unsupported':readiness==='manual'?'manual':readiness==='missing-input'||step.issues.some(issue=>['MISSING_INPUT','REVIEW_REQUIRED'].includes(issue.code))?'input':'structure';
 }
 return [...byId.values()];
}

export default function RepairPanel(p:RepairPanelProps){
 const formId=useId(),steps=preparationSteps(p.nodes,p.issues),nodeById=new Map(p.nodes.map(node=>[node.id,node]));
 const plan=p.plan,changeDisabled=p.disabled||p.loading,answerDisabled=changeDisabled||p.stale;
 const answerOf=(id:string)=>Object.hasOwn(p.answers,id)&&typeof p.answers[id]==='string'?p.answers[id]:'';
 const readinessLabel=(readiness:string)=>Object.hasOwn(readinessNames,readiness)?readinessNames[readiness]:'待核对';
 const missing=plan?.questions.filter(question=>question.required&&!answerOf(question.id).trim()).length??0;
 const reviewIds=plan?[...new Set([...plan.notes.map(note=>note.nodeId),...plan.bindings.map(binding=>binding.nodeId)])]:[];
 const elapsed=p.progress?Math.max(0,Math.floor(p.progress.elapsedMs/1000)):0;
 return <section className="repair-panel" aria-label="Agent 修补助手">
  <div className="repair-heading"><span className="repair-heading-icon"><Sparkles size={17}/></span><div><h3>Agent 修补助手</h3><p>把准备条件整理成表单，在这里填写和核对。</p></div></div>
  {p.issues.length>0?<p className="repair-intro"><strong>{p.issues.length} 项是准备条件，不等于 {p.issues.length} 个空格。</strong>有些需要填写，有些需要人工处理或调整连接。</p>:<p className="repair-intro">让 Agent 检查当前步骤，整理本次要填写的资料和需要核对的地方。</p>}

  {steps.length>0&&<details className="repair-preparation"><summary>查看准备条件 · {steps.length} 个步骤或流程位置</summary><div className="repair-category-grid">{categories.map(({kind,name,icon:Icon})=>{
   const items=steps.filter(step=>step.kind===kind);if(!items.length)return null;
   return <section key={kind} className={`repair-category ${kind}`}><h4><Icon size={13}/>{name}<span>{items.length} 个步骤</span></h4>{items.map(step=><div className="repair-preparation-step" key={step.id}><button type="button" className="repair-locate" disabled={!step.node} onClick={()=>step.node&&p.onLocate(step.node.id,step.issues[0]?.field)}><span>{step.label}</span>{step.node&&<LocateFixed size={12}/>}</button><p>{step.node?.data.uncertainty||step.issues[0]?.suggestedAction||step.issues[0]?.message||'需要核对这个步骤的资料和执行方式。'}</p>{step.issues.length>0&&<details className="repair-technical"><summary>检查详情 · {step.issues.length} 项</summary>{step.issues.map((issue,index)=><div key={index}><p>{issue.message}</p><code>{issue.code}{issue.field?` · ${issue.field}`:''}</code></div>)}</details>}</div>)}</section>;
  })}</div></details>}

  <label className="field repair-goal">这次想怎样继续？<span className="repair-optional">选填</span><textarea rows={2} value={p.goal} onChange={event=>p.onGoal(event.target.value)} disabled={changeDisabled} placeholder="例如：告诉我哪些资料要现在填写，哪些要等运行到这一步再处理。"/></label>
  <div className="repair-actions"><button type="button" className="primary-button" disabled={changeDisabled||!p.nodes.length} onClick={p.onAnalyze}><Sparkles size={14}/>{p.stale?'重新生成修补建议':plan?'重新让 Agent 检查':'让 Agent 整理修补表单'}</button><button type="button" className="quiet-button" disabled={changeDisabled||!p.nodes.length} onClick={p.onCheck}><ClipboardCheck size={14}/>仅重新检查</button></div>
  {p.disabled&&<p className="hint">本次运行结束后，可以继续修改和修补。</p>}
  {p.loading&&<div className="repair-progress" role="status"><LoaderCircle size={15} className="spin"/><span><strong>{p.progress?stageNames[p.progress.stage]:'正在准备修补检查'}</strong>{p.progress&&<small>已用时 {elapsed} 秒 · 完成后在本页显示填写表单</small>}</span><button type="button" className="quiet-button" onClick={p.onStop}><Square size={12}/>停止</button></div>}
  {p.error&&<div className="repair-error" role="alert">{p.error}</div>}

  {plan&&<div className={`repair-result ${p.stale?'stale':''}`}>
   {p.stale&&<div className="repair-stale" role="status"><AlertCircle size={15}/><p>画布已改变，这份建议需要重新生成。已有填写暂时保留，重新核对后再应用。</p></div>}
   <div className="repair-result-heading"><span className="eyebrow">修补建议</span><p>{plan.summary}</p></div>
   {plan.questions.length>0&&<section className="repair-questions"><div className="repair-section-title"><h4>在这里填写 · {plan.questions.length} 项</h4><span>填写内容不发给模型</span></div><div className="repair-question-grid">{plan.questions.map((question,index)=>{
    const inputId=`${formId}-question-${index}`,helpId=`${inputId}-help`;
    const consumers=[...new Set(plan.bindings.filter(binding=>binding.questionId===question.id).map(binding=>nodeById.get(binding.nodeId)?.data.label||'对应步骤'))];
    return <div className="repair-question" key={question.id}><label htmlFor={inputId}>{question.title}<span className={question.required?'repair-required':'repair-optional'}>{question.required?'必填':'选填'}</span></label><input id={inputId} type="text" value={answerOf(question.id)} onChange={event=>p.onAnswers({...p.answers,[question.id]:event.target.value})} placeholder={question.placeholder} required={question.required} disabled={answerDisabled||p.applied} autoComplete="off" aria-describedby={helpId}/><div id={helpId}>{question.help&&<p>{question.help}</p>}{consumers.length>0&&<small>用于：{consumers.join('、')}</small>}</div></div>;
   })}</div><p className="hint">{p.applied?'以上内容已写入参数草稿，后续可在「运行准备」的业务参数中修改。':'以上内容只用于本地参数草稿和你随后启动的运行。'}</p></section>}

   {plan.bindings.length>0&&<section className="repair-binding-preview"><div className="repair-section-title"><h4>准备应用的参数 · {plan.bindings.length} 项</h4><span>先查看涉及哪些步骤</span></div><div className="repair-binding-list">{plan.bindings.map((binding,index)=>{
    const catalog=p.input?.nodes.find(node=>node.id===binding.nodeId),field=catalog?.fields.find(field=>field.id===binding.fieldId),source=catalog?.sources.find(source=>source.id===binding.sourceId),question=plan.questions.find(question=>question.id===binding.questionId);
    const fieldKey=field?.path.split('.').at(-1)??'',name=question?.title||(binding.mode==='manual'?'运行时填写的资料':binding.mode==='upstream'?'前序步骤返回的资料':undefined)||(Object.hasOwn(fieldNames,fieldKey)?fieldNames[fieldKey]:'待核对参数');
    return <article className="repair-binding" key={`${binding.nodeId}-${binding.fieldId}`}><div><span className="repair-number">{index+1}</span><strong>{name}</strong><span className={`repair-mode ${binding.mode}`}>{{user:'本次填写',manual:'运行时人工填写',upstream:'读取前序结果'}[binding.mode]}</span></div><button type="button" className="repair-locate" onClick={()=>p.onLocate(binding.nodeId)}><span>{nodeById.get(binding.nodeId)?.data.label||catalog?.label||'对应步骤'}</span><LocateFixed size={12}/></button>{source&&<p className="repair-source">来自：{nodeById.get(source.sourceNodeId)?.data.label||'前序步骤'}</p>}<details className="repair-technical"><summary>查看字段位置与依据</summary>{field&&<p>{{body:'JSON 正文',header:'请求头',query:'查询参数'}[field.target]} · <code>{field.path}</code></p>}{source&&<p>来源字段：<code>{source.sourcePath}</code></p>}<p>{binding.reason}</p></details></article>;
   })}</div><div className="repair-apply-row"><button type="button" className="primary-button" disabled={answerDisabled||p.applied||missing>0} onClick={p.onApply}>{p.applied?<CheckCircle2 size={14}/>:<ArrowRight size={14}/>} {p.applied?'参数草稿已应用':'填写并应用参数草稿'}</button>{missing>0&&!p.applied&&<span>还需填写 {missing} 项必填资料</span>}</div></section>}

   {p.applied&&<p className="repair-applied" role="status"><CheckCircle2 size={15}/><span>参数草稿已应用，步骤的准备状态仍保留。请逐步核对会话和参数，再确认并重新检查。</span></p>}
   {!plan.bindings.length&&<p className="hint">这轮没有可应用的参数草稿，请查看下面的处理建议。</p>}

   {reviewIds.length>0&&<section className="repair-review"><div className="repair-section-title"><h4>逐步核对</h4><span>检查通过后仍由你启动运行</span></div>{reviewIds.map(nodeId=>{
    const node=nodeById.get(nodeId),notes=plan.notes.filter(note=>note.nodeId===nodeId),hasBinding=plan.bindings.some(binding=>binding.nodeId===nodeId),unsupported=node?.data.readiness==='unsupported'||notes.some(note=>note.kind==='unsupported');
    return <article key={nodeId} className={`repair-review-card ${unsupported?'unsupported':notes.some(note=>note.kind==='manual')?'manual':'review'}`}><div className="repair-review-title"><button type="button" className="repair-locate" onClick={()=>p.onLocate(nodeId)}><span>{node?.data.label||p.input?.nodes.find(item=>item.id===nodeId)?.label||'对应步骤'}</span><LocateFixed size={12}/></button><span>{unsupported?'暂不支持':readinessLabel(node?.data.readiness??'ready')}</span></div>{notes.map((note,index)=><div className="repair-review-note" key={index}><h5>{note.title}</h5><p>{note.message}</p></div>)}{unsupported?<p className="repair-review-hint">这一步需要按说明在网页中处理，或调整当前流程。</p>:hasBinding?<><p className="repair-review-hint">请先确认会话有效、参数来源正确，本步可由当前执行器完成。确认后仍需重新检查流程。</p>{p.applied&&<button type="button" className="quiet-button" disabled={changeDisabled||p.stale||!node||node.data.readiness==='ready'} onClick={()=>p.onConfirmNode(nodeId)}><CheckCircle2 size={13}/>{node?.data.readiness==='ready'?'这一步已核对':'我已核对这一步'}</button>}</>:<p className="repair-review-hint">请按建议检查这一步；本轮没有为它生成参数草稿。</p>}</article>;
   })}</section>}
   {plan.warnings.length>0&&<details className="repair-warnings"><summary>补充说明 · {plan.warnings.length}</summary>{plan.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
   <div className="repair-final-check"><p>核对完成后，先查看还剩哪些准备条件。</p><button type="button" className="quiet-button" disabled={changeDisabled||!p.nodes.length} onClick={p.onCheck}><ClipboardCheck size={14}/>仅重新检查</button></div>
  </div>}
 </section>;
}
