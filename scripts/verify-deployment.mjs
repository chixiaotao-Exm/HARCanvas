import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Read credentials from an ignored private file, never from command arguments.
const base = new URL(process.env.HAR_CANVAS_URL);
assert.ok(base.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(base.hostname), 'Use HTTPS for remote authentication');
const config = parseEnv(await readFile(process.env.HAR_CANVAS_ENV_FILE || '.deployment/service.env', 'utf8'));
assert.ok(config.HAR_CANVAS_USER && config.HAR_CANVAS_PASSWORD, 'Missing deployment credentials');
const authorization = `Basic ${Buffer.from(`${config.HAR_CANVAS_USER}:${config.HAR_CANVAS_PASSWORD}`).toString('base64')}`;
const request = (path, init = {}, authenticated = true) => fetch(new URL(path, base), {
  ...init,
  headers: { ...(authenticated ? { Authorization: authorization } : {}), ...init.headers },
  signal: AbortSignal.timeout(120_000),
  redirect: 'error',
});

for (const path of ['/', '/api/health', '/api/har/example', '/api/har/example/requests/req-1', '/api/flow/run']) {
  const response = await request(path, path.endsWith('/run') ? { method: 'POST' } : {}, false);
  assert.equal(response.status, 401, `Anonymous access: ${path}`);
  assert.match(response.headers.get('www-authenticate') || '', /^Basic /);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await response.body.cancel();
}
const wrong = await request('/api/health', { headers: { Authorization: 'Basic d3Jvbmc6d3Jvbmc=' } }, false);
assert.equal(wrong.status, 401);
await wrong.body.cancel();
console.log('PASS anonymous and incorrect credentials rejected');

const health = await request('/api/health');
assert.equal(health.status, 200);
assert.equal((await health.json()).status, 'ok');
const page = await request('/');
assert.equal(page.status, 200);
const html = await page.text();
const asset = html.match(/src="([^"]+\.js)"/);
assert.ok(asset, 'Built frontend entrypoint missing');
assert.equal(new URL(asset[1], base).origin, base.origin, 'Frontend asset must be same-origin');
const script = await request(asset[1]);
assert.equal(script.status, 200);
assert.ok((await script.text()).length > 1000);
for (const path of ['/samples/re.har', '/.env', '/.git/config']) {
  const response = await request(path);
  assert.equal(response.status, 404, `Private filesystem path exposed: ${path}`);
  await response.body.cancel();
}
console.log('PASS authenticated health, frontend and private file boundaries');

const flow = await request('/api/flow/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nodes: [
      { id: 'input', type: 'block', position: { x: 0, y: 0 }, data: { kind: 'input', label: 'Input', variable: 'name', value: 'HAR Canvas' } },
      { id: 'output', type: 'block', position: { x: 200, y: 0 }, data: { kind: 'output', label: 'Output', template: 'Hello {{name}}' } },
    ],
    edges: [{ id: 'input-output', source: 'input', target: 'output' }], inputs: {},
  }),
});
assert.equal(flow.status, 200);
const result = await flow.json();
assert.equal(result.status, 'success');
assert.equal(result.output, 'Hello HAR Canvas');
console.log('PASS input -> output flow (no external request)');

if (process.env.HAR_CANVAS_VERIFY_EXAMPLE === '1') {
  const response = await request('/api/har/example');
  assert.equal(response.status, 200);
  const example = await response.json();
  assert.ok(example.summary.total > 0);
  assert.equal(example.requests.length, example.summary.total);
  const reference = example.requests.find(item => item.responseBodyTruncated) || example.requests[0];
  if (reference) {
    const detail = await request(`/api/har/example/requests/${encodeURIComponent(reference.id)}`);
    assert.equal(detail.status, 200);
    const full = (await detail.json()).request;
    assert.equal(full.id, reference.id);
    assert.ok(full.responseBody.length >= reference.responseBody.length);
    assert.ok(!full.responseBodyTruncated);
  }
  console.log(`PASS protected default HAR: ${example.summary.total} requests; lazy response detail verified`);
}
console.log('Deployment checks passed. No model or captured request was executed.');
