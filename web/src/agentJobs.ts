import type { AgentConfig, Analysis, HarRequest } from './types';
import type { AnalysisContext } from './analysisContext';

export const AGENT_JOB_POLL_MS = 1000;
const CANCEL_TIMEOUT_MS = 2500;

export type AgentJobProgress = {
  stage: 'preparing' | 'waiting_model' | 'reading_response' | 'validating' | 'completed';
  elapsedMs: number;
  payloadBytes?: number;
  contextBytes?: number;
  responseBytes?: number;
};
export type AgentJobEvent = {
  stage: 'submitted' | 'completed' | 'failed' | 'cancelled';
  jobId?: string;
  requestId?: string;
  status?: number;
  code?: string;
};
export type AgentJobDependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: AgentJobEvent) => void;
  onProgress?: (progress: AgentJobProgress) => void;
};
type ResponseMeta = { status: number; requestId?: string };
type JobResponse = { id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; analysis?: unknown; error?: unknown; errorCode?: unknown; progress?: unknown };

export class AgentJobError extends Error {
  status?: number;
  requestId?: string;
  jobId?: string;
  code?: string;
  constructor(message: string, details: { status?: number; requestId?: string; jobId?: string; code?: string } = {}) {
    super(message);
    this.name = 'AgentJobError';
    this.status = details.status;
    this.requestId = details.requestId;
    this.jobId = details.jobId;
    this.code = details.code;
  }
}

function abortError(message = '分析已取消，后续批次未发送。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw abortError(); }

export function sleepForAgentJob(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validAnalysis(value: unknown): value is Analysis {
  if (!record(value) || typeof value.summary !== 'string' || !Array.isArray(value.suggestions) || !Array.isArray(value.warnings) || !value.warnings.every(w => typeof w === 'string')) return false;
  return value.suggestions.every(s => record(s) && ['requestId', 'label', 'description', 'category', 'confidence'].every(key => typeof s[key] === 'string') && Array.isArray(s.dependencies) && s.dependencies.every(d => typeof d === 'string') && Array.isArray(s.variables) && s.variables.every(v => record(v) && ['name', 'source', 'description'].every(key => typeof v[key] === 'string')));
}
function responseMeta(response: Response): ResponseMeta {
  const requestId = response.headers.get('x-request-id')?.replace(/[\r\n]/g, '').slice(0, 200);
  return { status: response.status, ...(requestId ? { requestId } : {}) };
}
function plainDiagnostic(value: unknown): string {
  if (typeof value !== 'string' || /<[^>]*>/.test(value)) return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 600);
}
function failureMessage(operation: string, meta: ResponseMeta, detail = '') {
  const correlation = meta.requestId ? `；请求编号 ${meta.requestId}` : '';
  const gateway = meta.status === 502 ? '网关未能取得后端的有效响应，可能是连接中断、服务暂不可用或网关超时；请按请求编号检查服务器日志。' : '';
  return `${operation}（HTTP ${meta.status}${correlation}）。${gateway}${detail ? ` ${detail}` : ''}`;
}
function jobFailureMessage(meta: ResponseMeta, detail: string) {
  const correlation = meta.requestId ? `（请求编号 ${meta.requestId}）` : '';
  return `分析任务失败${correlation}。 ${detail}`;
}

/** Start one model job, then poll it. This function never retries a model call. */
export async function analyzeViaJob(
  config: AgentConfig,
  requests: HarRequest[],
  signal: AbortSignal,
  dependencies: AgentJobDependencies = {},
  context?: AnalysisContext,
): Promise<Analysis> {
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = dependencies.sleep ?? sleepForAgentJob;
  const emit = (event: AgentJobEvent) => { try { dependencies.onEvent?.(event); } catch { /* Logging must not alter job execution. */ } };
  const report = (value: unknown, meta: ResponseMeta) => {
    if (value === undefined) return; // Older servers do not publish stage metrics.
    if (!record(value) || typeof value.stage !== 'string' || !['preparing', 'waiting_model', 'reading_response', 'validating', 'completed'].includes(value.stage) || !Number.isSafeInteger(value.elapsedMs) || (value.elapsedMs as number) < 0 || ['payloadBytes', 'contextBytes', 'responseBytes'].some(key => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0))) {
      throw new AgentJobError(failureMessage('分析阶段信息格式不正确', meta), { ...meta, jobId });
    }
    // Copy only fixed stages and numeric metrics; provider-controlled extras are discarded.
    const progress: AgentJobProgress = { stage: value.stage as AgentJobProgress['stage'], elapsedMs: value.elapsedMs as number };
    for (const key of ['payloadBytes', 'contextBytes', 'responseBytes'] as const) if (value[key] !== undefined) progress[key] = value[key] as number;
    if (!signal.aborted) try { dependencies.onProgress?.(progress); } catch { /* UI diagnostics do not alter a model call. */ }
  };
  let jobId: string | undefined;
  let terminal = false;
  let lastMeta: ResponseMeta | undefined;
  let cancellation: Promise<ResponseMeta | undefined> | undefined;

  const cancelJob = (): Promise<ResponseMeta | undefined> => {
    if (!jobId || terminal) return Promise.resolve(undefined);
    if (cancellation) return cancellation;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, CANCEL_TIMEOUT_MS); });
    // This signal is independent from the already-aborted analysis signal.
    const deletion = Promise.resolve().then(() => fetcher(`/api/agent/jobs/${encodeURIComponent(jobId!)}`, { method: 'DELETE', signal: controller.signal, cache: 'no-store' })).then(response => responseMeta(response), () => undefined);
    cancellation = Promise.race([deletion, timeout]).finally(() => clearTimeout(timer));
    return cancellation;
  };
  const onAbort = () => { void cancelJob(); };

  const readJSON = async (path: string, init: RequestInit, operation: string): Promise<{ body: unknown; meta: ResponseMeta }> => {
    let response: Response;
    try { response = await fetcher(path, { ...init, signal, cache: 'no-store' }); }
    catch {
      if (signal.aborted) throw abortError();
      throw new AgentJobError(`${operation}的网络请求失败，无法确认任务状态；未自动重试。`, { jobId });
    }
    const meta = responseMeta(response);
    lastMeta = meta;
    let text: string;
    try { text = await response.text(); }
    catch {
      if (signal.aborted) throw abortError();
      throw new AgentJobError(failureMessage(`${operation}读取响应失败`, meta), { ...meta, jobId });
    }
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new AgentJobError(failureMessage(`${operation}返回非 JSON 内容`, meta), { ...meta, jobId }); }
    if (!response.ok) {
      const detail = record(body) ? plainDiagnostic(body.error) : '';
      throw new AgentJobError(failureMessage(`${operation}失败`, meta, detail), { ...meta, jobId });
    }
    return { body, meta };
  };

  signal.addEventListener('abort', onAbort, { once: true });
  try {
    checkAbort(signal);
    // Serialize once before yielding so later UI edits cannot change this job.
    const payload = JSON.stringify({ config: { ...config }, requests, context });
    const submitted = await readJSON('/api/agent/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }, '启动分析任务');
    // Retain a known identity even if the rest of the start response is invalid,
    // so a possibly accepted task can still be cancelled without resubmitting.
    if (record(submitted.body) && typeof submitted.body.id === 'string' && submitted.body.id.trim()) jobId = submitted.body.id;
    if (!record(submitted.body) || typeof submitted.body.id !== 'string' || !submitted.body.id.trim() || submitted.body.status !== 'running' || submitted.meta.status !== 202) {
      throw new AgentJobError(failureMessage('启动分析任务的响应格式不正确', submitted.meta), { ...submitted.meta, jobId });
    }
    jobId = submitted.body.id;
    emit({ stage: 'submitted', jobId, ...submitted.meta });
    checkAbort(signal);
    report(submitted.body.progress, submitted.meta);
    while (true) {
      await sleep(AGENT_JOB_POLL_MS, signal);
      checkAbort(signal);
      const polled = await readJSON(`/api/agent/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, '查询分析任务');
      checkAbort(signal);
      if (!record(polled.body) || polled.body.id !== jobId || !['running', 'completed', 'failed', 'cancelled'].includes(String(polled.body.status))) {
        throw new AgentJobError(failureMessage('分析任务状态格式不正确', polled.meta), { ...polled.meta, jobId });
      }
      const job = polled.body as JobResponse;
      report(job.progress, polled.meta);
      if (job.status === 'running') continue;
      terminal = true;
      if (job.status === 'cancelled') throw abortError('服务器已取消该分析任务。');
      // HTTP 200 confirms the status query succeeded; it is not the model
      // failure's HTTP status and must not appear as an error code in the UI.
      if (job.status === 'failed') throw new AgentJobError(jobFailureMessage(polled.meta, plainDiagnostic(job.error) || '服务器未提供错误详情，请检查任务日志。'), { requestId: polled.meta.requestId, jobId, ...(typeof job.errorCode === 'string' && /^[a-z_]{1,80}$/.test(job.errorCode) ? { code: job.errorCode } : {}) });
      if (!validAnalysis(job.analysis)) throw new AgentJobError(failureMessage('分析任务已结束，但未返回有效分析结果', polled.meta), { ...polled.meta, jobId });
      emit({ stage: 'completed', jobId, ...polled.meta });
      return job.analysis;
    }
  } catch (failure) {
    if (signal.aborted || (failure instanceof Error && failure.name === 'AbortError')) {
      const deletionMeta = await cancelJob();
      emit({ stage: 'cancelled', jobId, ...(deletionMeta ?? lastMeta ?? {}) });
      throw abortError(failure instanceof Error && failure.name === 'AbortError' ? failure.message : undefined);
    }
    const error = failure instanceof AgentJobError ? failure : new AgentJobError('分析任务处理失败；未自动重试。', { jobId });
    // A transport/protocol failure leaves the model task's state unknown.
    // Release it best-effort, but keep the original diagnosis and never retry
    // POST: submitting again could invoke the provider twice.
    await cancelJob();
    emit({ stage: 'failed', jobId: error.jobId ?? jobId, status: error.status, requestId: error.requestId, ...(error.code ? { code: error.code } : {}) });
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
