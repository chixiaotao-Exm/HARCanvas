import type { AgentConfig, Analysis, HarRequest } from './types';

export const ANALYSIS_BATCH_SIZE = 50;
export const ANALYSIS_BATCH_BYTES = 96 * 1024;
const BODY_BYTES = 12000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type AnalysisProgress = {
  batch: number;
  totalBatches: number;
  completedRequests: number;
  totalRequests: number;
};

// Match the backend's body budget before uploading, without changing the HAR
// used by the canvas. Avoid cutting through a UTF-8 code point.
function preview(value: string): string {
  const bytes = encoder.encode(value.slice(0, BODY_BYTES));
  if (bytes.length <= BODY_BYTES) return decoder.decode(bytes);
  let end = BODY_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function planAnalysisBatches(requests: HarRequest[]) {
  const batches: HarRequest[][] = [];
  let batch: HarRequest[] = [];
  let bytes = 2;
  let previewCount = 0;
  for (const original of requests) {
    const body = preview(original.body);
    const responseBody = preview(original.responseBody);
    if (body !== original.body || responseBody !== original.responseBody) previewCount++;
    const request = {
      ...original, body, responseBody,
      responseBodyTruncated: original.responseBodyTruncated || responseBody !== original.responseBody,
    };
    const size = encoder.encode(JSON.stringify(request)).length;
    if (size + 2 > ANALYSIS_BATCH_BYTES) {
      throw new Error(`请求 ${original.id} 的地址或请求头过大，无法放入分析批次。请先筛除该请求。`);
    }
    if (batch.length && (batch.length >= ANALYSIS_BATCH_SIZE || bytes + size + 1 > ANALYSIS_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(request);
  }
  if (batch.length) batches.push(batch);
  const warnings: string[] = [];
  if (previewCount) warnings.push(`${previewCount} 条请求的正文或响应按前 12000 字节预览分析；原始 HAR 和画布请求保持完整。`);
  if (batches.length > 1) warnings.push('各批次独立分析，跨批次的请求依赖需要人工核对。');
  return { batches, warnings };
}

type BatchOptions = {
  requests: HarRequest[];
  config: AgentConfig;
  signal: AbortSignal;
  analyzeBatch: (config: AgentConfig, requests: HarRequest[], signal: AbortSignal) => Promise<Analysis>;
  onProgress?: (progress: AnalysisProgress, analysis: Analysis) => void;
};

export async function analyzeInBatches(options: BatchOptions) {
  const { batches, warnings } = planAnalysisBatches(options.requests);
  const config = { ...options.config };
  const suggestions = new Map<string, Analysis['suggestions'][number]>();
  const summaries: string[] = [];
  let completedRequests = 0;
  let completedBatches = 0;
  let status: 'completed' | 'cancelled' | 'failed' = 'completed';
  let error = '';
  const snapshot = (): Analysis => ({
    summary: [`已处理 ${completedRequests}/${options.requests.length} 条请求，获得 ${suggestions.size} 条建议。`, ...summaries].join('\n\n'),
    suggestions: [...suggestions.values()],
    warnings: [...new Set(warnings)],
  });
  for (let i = 0; i < batches.length; i++) {
    if (options.signal.aborted) { status = 'cancelled'; break; }
    const progress = { batch: i + 1, totalBatches: batches.length, completedRequests, totalRequests: options.requests.length };
    options.onProgress?.(progress, snapshot());
    try {
      const result = await options.analyzeBatch(config, batches[i], options.signal);
      if (options.signal.aborted) { status = 'cancelled'; break; }
      for (const suggestion of result.suggestions) suggestions.set(suggestion.requestId, suggestion);
      summaries.push(`第 ${i + 1}/${batches.length} 批：${result.summary}`);
      warnings.push(...result.warnings);
      completedRequests += batches[i].length;
      completedBatches++;
      options.onProgress?.({ ...progress, completedRequests }, snapshot());
    } catch (failure) {
      status = options.signal.aborted ? 'cancelled' : 'failed';
      error = options.signal.aborted ? '' : (failure instanceof Error ? failure.message : '分析请求失败');
      if (error) warnings.push(`第 ${i + 1}/${batches.length} 批失败：${error}。后续批次未发送，已完成的结果已保留。`);
      break;
    }
  }
  if (status === 'cancelled') warnings.push('分析已停止，未完成的批次不计入结果；已完成的建议已保留。');
  return { analysis: snapshot(), status, error, completedRequests, completedBatches, totalBatches: batches.length };
}
