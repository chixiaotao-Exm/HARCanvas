import type { BlockData, HarRequest, Suggestion } from './types';

export type HarBlock = { request: HarRequest; suggestion: Suggestion; data: BlockData };

/** Only a real analysis with a useful name and purpose can create a HAR block. */
export function getHarBlocks(requests: HarRequest[], suggestions: Suggestion[]): HarBlock[] {
  const requestIds = new Set(requests.map(request => request.id));
  const accepted = new Map<string, Suggestion>();
  for (const suggestion of suggestions) {
    if (!suggestion || !requestIds.has(suggestion.requestId) || accepted.has(suggestion.requestId)) continue;
    if (typeof suggestion.label !== 'string' || typeof suggestion.description !== 'string') continue;
    const label = suggestion.label.trim();
    const description = suggestion.description.trim();
    if (!label || !description) continue;
    accepted.set(suggestion.requestId, { ...suggestion, label, description });
  }

  const blocks: HarBlock[] = [];
  const emitted = new Set<string>();
  for (const request of requests) {
    const suggestion = accepted.get(request.id);
    if (!suggestion || emitted.has(request.id)) continue;
    emitted.add(request.id);
    blocks.push({
      request,
      suggestion,
      data: {
        kind: 'request',
        requestId: request.id,
        label: suggestion.label,
        description: suggestion.description,
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: request.body,
      },
    });
  }
  return blocks;
}
