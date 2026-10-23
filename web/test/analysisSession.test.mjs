import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingAnalysisRequests, retainAnalysis } from '../src/analysisSession.ts';
import { analyzeInBatches } from '../src/agentBatches.ts';

const request = id => ({id,method:'GET',url:`https://example.invalid/${id}`,domain:'example.invalid',path:`/${id}`,category:'api',mimeType:'application/json',status:200,duration:1,headers:{},body:'',responseBody:'{}',responseHeaders:{},query:{}});
const suggestion = requestId => ({requestId,label:'读取记录',description:'读取录制中的记录，并返回其状态。',category:'api',confidence:'high',dependencies:[],variables:[]});

test('repeated cumulative progress does not grow the same explanation summary on each poll',()=>{
 let result={summary:'原来的说明',suggestions:[suggestion('a')],warnings:[]};
 const progress={summary:'原来的说明\n\n新资料的说明',suggestions:[suggestion('b')],warnings:['提示']};
 for(let i=0;i<50;i++)result=retainAnalysis(result,progress);
 assert.equal(result.summary,'原来的说明\n\n新资料的说明');assert.equal(result.suggestions.length,2);assert.equal(result.warnings.length,1);
});

test('only useful explanations skip new paid calls; unanalysed and malformed records stay pending', () => {
  const source = ['a','b','c'].map(request);
  const baseline = {summary:'已有说明',suggestions:[suggestion('a'),{...suggestion('b'),description:' '},suggestion('outside')],warnings:[]};
  assert.deepEqual(pendingAnalysisRequests(source, baseline).map(r=>r.id), ['b','c']);
  assert.equal(pendingAnalysisRequests(source, null).length, 3);
});

test('supplementing or stopping retains previous explanations without mutating either analysis', () => {
  const baseline = {summary:'之前完成',suggestions:[suggestion('a')],warnings:['需核对']};
  const incoming = {summary:'停止时完成',suggestions:[suggestion('b')],warnings:['需核对','已停止']};
  const before = structuredClone({baseline,incoming});
  const result = retainAnalysis(baseline, incoming);
  assert.deepEqual(result.suggestions.map(s=>s.requestId), ['a','b']);
  assert.deepEqual(result.warnings, ['需核对','已停止']);
  assert.deepEqual({baseline,incoming}, before);
  assert.deepEqual(retainAnalysis(result,{summary:'',suggestions:[],warnings:[]}).suggestions, result.suggestions);
});

test('selected details retain omitted source evidence and previous explanations in context without analysing or fabricating source blocks', async () => {
  const source = request('source');
  source.responseBody = JSON.stringify({ticket:'unique-recorded-ticket-9021'});
  const target = request('target');
  target.body = JSON.stringify({ticket:'unique-recorded-ticket-9021'});
  let calls = 0;
  const result = await analyzeInBatches({requests:[target],contextRequests:[source,target],previous:[suggestion('source')],config:{baseUrl:'',apiKey:'',model:''},signal:new AbortController().signal,
    analyzeBatch:async(_,items,_signal,context)=>{
      calls++;
      assert.deepEqual(items.map(r=>r.id), ['target']);
      assert.ok(context.catalog.some(r=>r.id==='source'));
      assert.ok(context.relations.some(r=>r.sourceRequestId==='source'&&r.targetRequestId==='target'));
      assert.ok(context.previous.some(r=>r.requestId==='source'));
      return {summary:'详细解读选中项',suggestions:[suggestion('target')],warnings:[]};
    },
  });
  assert.equal(calls,1);
  assert.deepEqual(result.analysis.suggestions.map(s=>s.requestId), ['target']);
});
