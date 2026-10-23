import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.HAR_CANVAS_URL || 'http://127.0.0.1:8090';
async function api(path, body) {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}
const entry = (url, mimeType, text, method = 'GET') => ({
  startedDateTime: '2026-10-23T12:00:00.000Z', time: 24,
  request: { method, url, headers: [{ name: 'Accept', value: 'application/json' }], queryString: [], cookies: [] },
  response: { status: 200, headers: [{ name: 'Content-Type', value: mimeType }], content: { mimeType, text } },
});
const node = (id, kind, fields) => ({ id, type: 'block', position: { x: 0, y: 0 }, data: { kind, label: id, ...fields } });
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

assert.equal((await api('/api/health')).data.status, 'ok');
console.log('PASS health');

const har = { log: { version: '1.2', entries: [
  entry('https://example.com/api/items', 'application/json', '{"items":[{"id":42}]}'),
  entry('https://example.com/site.css', 'text/css', 'body {}'),
] } };
const parsed = await api('/api/har/parse', { har });
assert.equal(parsed.response.status, 200);
assert.equal(parsed.data.requests.length, 2);
assert.equal(parsed.data.summary.total, 2);
assert.equal(parsed.data.requests[0].url, har.log.entries[0].request.url);
assert.equal(parsed.data.requests[0].body, '');
assert.equal(parsed.data.requests[0].category, 'api');
assert.equal(parsed.data.requests[1].category, 'static');
console.log('PASS HAR normalized and static assets classified');

const malformed = await api('/api/har/parse', { har: { log: { entries: 'wrong' } } });
assert.ok(malformed.response.status >= 400);
console.log('PASS malformed HAR rejected');

const nodes = [
  node('input', 'input', { variable: 'name', value: 'HAR Canvas' }),
  node('check', 'condition', { variable: 'name', operator: 'eq', expected: 'HAR Canvas' }),
  node('yes', 'output', { template: 'Hello {{name}}' }),
  node('no', 'output', { template: 'Wrong branch' }),
];
const run = await api('/api/flow/run', { nodes, edges: [edge('input', 'check'), edge('check', 'yes', 'true'), edge('check', 'no', 'false')], inputs: {} });
assert.equal(run.data.status, 'success', JSON.stringify(run.data));
assert.ok(run.data.steps.some(step => step.nodeId === 'yes' && step.status === 'success'));
assert.ok(run.data.steps.some(step => step.nodeId === 'no' && step.status === 'skipped'));
assert.equal(run.data.output, 'Hello HAR Canvas');
console.log('PASS input -> condition -> selected branch -> output');

const cycle = await api('/api/flow/run', { nodes: nodes.slice(0, 2), edges: [edge('input', 'check'), edge('check', 'input')], inputs: {} });
assert.ok(cycle.response.status >= 400 || cycle.data.status === 'error');
const blocked = await api('/api/flow/run', { nodes: [node('private', 'request', { method: 'GET', url: 'http://127.0.0.1:8090/api/health' })], edges: [], inputs: {} });
assert.ok(blocked.response.status >= 400 || blocked.data.status === 'error');
console.log('PASS cycles and private-network replay rejected');

const missing = await api('/api/agent/analyze', { config: { baseUrl: '', apiKey: '', model: '' }, requests: parsed.data.requests });
assert.ok(missing.response.status >= 400);
console.log('PASS missing agent configuration does not fake an AI response');

let providerRequest;
const provider = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  providerRequest = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) };
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
    summary: 'Mock provider integration verified',
    suggestions: [{ requestId: parsed.data.requests[0].id, label: 'List items', description: 'Loads items.', category: 'api', dependencies: [], confidence: 'high', variables: [] }],
    warnings: [],
  }) } }] }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
try {
  const address = provider.address();
  const analyzed = await api('/api/agent/analyze', { config: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key-not-a-secret', model: 'test-model' }, requests: parsed.data.requests });
  assert.equal(analyzed.response.status, 200, JSON.stringify(analyzed.data));
  assert.equal(providerRequest.url, '/v1/chat/completions');
  assert.equal(providerRequest.authorization, 'Bearer test-key-not-a-secret');
  assert.equal(providerRequest.body.model, 'test-model');
  assert.ok(analyzed.data.suggestions.some(suggestion => suggestion.label === 'List items'));
  console.log('PASS user-configured /v1 provider, credentials, model, and parsed suggestions');
} finally {
  await new Promise(resolve => provider.close(resolve));
}

console.log('All smoke checks passed. No external target was contacted.');
