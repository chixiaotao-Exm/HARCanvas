import type { Analysis, HarRequest } from './types';
import { getHarBlocks } from './harBlocks.ts';

/** Reuse only explanations that passed the same gate as generated blocks. */
export function pendingAnalysisRequests(requests: HarRequest[], analysis: Analysis | null): HarRequest[] {
  const explained = new Set(getHarBlocks(requests, analysis?.suggestions ?? []).map(block => block.request.id));
  return requests.filter(request => !explained.has(request.id));
}

/** Keep successful work when another selection, batch, or cancellation completes. */
export function retainAnalysis(previous: Analysis | null, incoming: Analysis): Analysis {
  const suggestions = new Map((previous?.suggestions ?? []).map(suggestion => [suggestion.requestId, suggestion]));
  for (const suggestion of incoming.suggestions) suggestions.set(suggestion.requestId, suggestion);
  return {
    summary: [previous?.summary, incoming.summary].filter(Boolean).join('\n\n'),
    suggestions: [...suggestions.values()],
    warnings: [...new Set([...(previous?.warnings ?? []), ...incoming.warnings])],
  };
}
