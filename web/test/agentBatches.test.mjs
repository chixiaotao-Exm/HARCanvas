import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_BATCH_BYTES, ANALYSIS_BATCH_SIZE, analyzeInBatches, planAnalysisBatches } from '../src/agentBatches.ts';

const request = id => ({ id, method: 'GET', url: `https://example.com/${id}`, domain: 'example.com', path: `/${id}`, category: 'api', mimeType: 'application/json', status: 200, duration: 1, headers: {}, body: '', responseBody: '{}', responseHeaders: {}, query: {} });
const requests = count => Array.from({ length: count }, (_, i) => request(`req-${i + 1}`));
const config = { baseUrl: 'https://example.com/v1', apiKey: 'fake-test-key', model: 'test' };
const answer = batch => ({ summary: '模拟分析', suggestions: batch.map(r => ({ requestId: r.id, label: r.id, description: '', category: 'api', confidence: 'high', dependencies: [], variables: [] })), warnings: [] });

test('more than 300 requests are sent once each in sequential bounded batches', async () => {
  const source = requests(470);
  const calls = [];
  const progress = [];
  let active = 0;
  const result = await analyzeInBatches({ requests: source, config, signal: new AbortController().signal,
    analyzeBatch: async (_, batch) => { assert.equal(++active, 1); calls.push(batch); await Promise.resolve(); active--; return answer(batch); },
    onProgress: p => progress.push({ ...p }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.completedRequests, 470);
  assert.equal(result.analysis.suggestions.length, 470);
  assert.equal(calls.length, 10);
  assert.ok(calls.every(batch => batch.length <= ANALYSIS_BATCH_SIZE));
  assert.deepEqual(calls.flat().map(r => r.id), source.map(r => r.id));
  assert.equal(progress.at(-1).completedRequests, 470);
  assert.ok(result.analysis.warnings.some(w => w.includes('跨批次')));
});

test('large Unicode response previews split by bytes and preserve original HAR data', () => {
  const source = requests(25).map(r => ({ ...r, body: '界'.repeat(10000), responseBody: '😀'.repeat(18000) }));
  const { batches, warnings } = planAnalysisBatches(source);
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= ANALYSIS_BATCH_BYTES);
    for (const r of batch) {
      assert.ok(Buffer.byteLength(r.body) <= 12000);
      assert.ok(Buffer.byteLength(r.responseBody) <= 12000);
      assert.ok(!r.body.includes('\ufffd') && !r.responseBody.includes('\ufffd'));
      assert.equal(r.responseBodyTruncated, true);
    }
  }
  assert.equal(source[0].body.length, 10000);
  assert.equal(source[0].responseBody, '😀'.repeat(18000));
  assert.ok(warnings.some(w => w.includes('原始 HAR')));
});

test('provider failure keeps successful results and never retries or sends later batches', async () => {
  let calls = 0;
  const result = await analyzeInBatches({ requests: requests(140), config, signal: new AbortController().signal,
    analyzeBatch: async (_, batch) => { if (++calls === 2) throw new Error('HTTP 429'); return answer(batch); },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.completedRequests, 50);
  assert.equal(result.analysis.suggestions.length, 50);
  assert.equal(result.error, 'HTTP 429');
  assert.ok(result.analysis.warnings.some(w => w.includes('后续批次未发送')));
});

test('cancellation aborts the active call and preserves earlier batches', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await analyzeInBatches({ requests: requests(120), config, signal: controller.signal,
    analyzeBatch: async (_, batch, signal) => { if (++calls === 2) { controller.abort(); signal.throwIfAborted(); } return answer(batch); },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls, 2);
  assert.equal(result.completedRequests, 50);
  assert.equal(result.analysis.suggestions.length, 50);
});

test('an aborted operation never starts a provider call and config is snapshotted', async () => {
  const controller = new AbortController(); controller.abort();
  const stopped = await analyzeInBatches({ requests: requests(1), config, signal: controller.signal, analyzeBatch: async () => { throw new Error('must not be called'); } });
  assert.equal(stopped.status, 'cancelled');
  const mutableConfig = { ...config };
  await analyzeInBatches({ requests: requests(51), config: mutableConfig, signal: new AbortController().signal,
    analyzeBatch: async (sent, batch) => { mutableConfig.model = 'changed'; assert.equal(sent.model, 'test'); return answer(batch); },
  });
});

test('an oversized metadata record fails explicitly before sending any batch', () => {
  assert.throws(() => planAnalysisBatches([{ ...request('huge'), headers: { huge: 'x'.repeat(ANALYSIS_BATCH_BYTES) } }]), /huge.*过大/);
});
