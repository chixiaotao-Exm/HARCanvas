import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeViaJob } from '../web/src/agentJobs.ts';
import { mergeGeneratedFlow } from '../web/src/generation.ts';
import { compileBindings } from '../web/src/bindings.ts';

// This script launches its own isolated API process and local model/HTTP mocks.
// It never reads a real HAR, application credentials, or an existing deployment.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsRoot = path.join(workspace, 'test-results');
const modelDelay = 21_500;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const node = (id, kind, fields = {}) => ({ id, type: 'block', position: { x: 0, y: 0 }, data: { kind, label: id, ...fields } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const flow = (nodes, edges = [], entryId = nodes[0]?.id) => ({ nodes, edges, entryId, inputs: {} });
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: workspace, windowsHide: true, ...options });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + chunk).slice(-12_000); });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable} failed (${code ?? signal}): ${output}`)));
  });
}

const harness = String.raw`package main

import (
  "context"
  "fmt"
  "net"
  "net/http"
  "net/netip"
  "os"
  "time"
  "harcanvas/internal/app"
)

func main() {
  server := app.NewServer(os.Args[1])
  server.SampleHAR = os.Args[1] + "/no-example.har"
  // Preserve URL/destination validation. Only this test harness replaces DNS
  // and a checked public-IP dial with a local mock; all other hosts fail shut.
  server.Runner.Guard.Lookup = func(_ context.Context, _, hostname string) ([]netip.Addr, error) {
    if hostname != "smoke-target.invalid" { return nil, fmt.Errorf("unexpected smoke target") }
    return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
  }
  server.Runner.Guard.Dial = func(ctx context.Context, network, address string) (net.Conn, error) {
    if address != "93.184.216.34:80" { return nil, fmt.Errorf("unexpected smoke dial target") }
    return (&net.Dialer{}).DialContext(ctx, network, os.Args[2])
  }
  listener, err := net.Listen("tcp", "127.0.0.1:0")
  if err != nil { panic(err) }
  fmt.Printf("SMOKE_SERVER=http://%s\n", listener.Addr())
  httpServer := &http.Server{Handler: app.RequestLogging(server), ReadHeaderTimeout: 5*time.Second}
  if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed { panic(err) }
}
`;

await mkdir(resultsRoot, { recursive: true });
const temporary = await mkdtemp(path.join(resultsRoot, 'smoke-runtime-'));
let child;
let childExit;
let base;
let serverLog = '';
let modelCalls = 0;
let targetCalls = 0;
const modelTimers = new Set();
const model = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(input.model, 'test-only-model');
    modelCalls++;
    const timer = setTimeout(() => {
      modelTimers.delete(timer);
      json(response, 200, { choices: [{ message: { role: 'assistant', content: JSON.stringify({
        summary: '受控模型分析完成。',
        suggestions: [{ requestId: 'req-1', label: '读取模拟业务状态', description: '读取模拟接口的状态字段，作为后续结果确认步骤的依据。', category: 'api', dependencies: [], confidence: 'high', variables: [] }], warnings: [],
      }) } }] });
    }, modelDelay);
    modelTimers.add(timer);
  } catch { json(response, 400, { error: 'Invalid synthetic model request' }); }
});
const target = http.createServer(async (request, response) => {
  targetCalls++;
  if (request.url === '/failure') { await sleep(600); json(response, 503, { message: 'synthetic HTTP failure' }); }
  else if (request.url.startsWith('/echo?')) {
    let body = '';
    for await (const chunk of request) body += chunk;
    json(response, 200, { query: Object.fromEntries(new URL(request.url, 'http://synthetic.invalid').searchParams), body: JSON.parse(body) });
  }
  else json(response, 200, { state: 'ready', id: 'synthetic-item-1' });
});

async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(8_000), cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

async function startRun(definition) {
  const started = await api('/api/flow/jobs', definition);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(typeof started.data.id, 'string');
  return { id: started.data.id, seq: 0, events: [], status: 'running' };
}

async function pollRun(run, predicate = value => ['completed', 'failed', 'cancelled'].includes(value.status)) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const polled = await api(`/api/flow/jobs/${encodeURIComponent(run.id)}?after=${run.seq}`);
    assert.equal(polled.status, 200, JSON.stringify(polled.data));
    assert.equal(polled.data.id, run.id);
    assert.ok(Array.isArray(polled.data.events));
    for (const event of polled.data.events) {
      assert.equal(event.runId, run.id);
      assert.ok(event.seq > run.seq, 'event cursor must be strictly increasing');
      run.seq = event.seq;
      run.events.push(event);
    }
    assert.ok(polled.data.seq >= run.seq);
    run.seq = polled.data.seq;
    run.status = polled.data.status;
    if (predicate(polled.data)) return polled.data;
    await sleep(30);
  }
  throw new Error(`Timed out waiting for synthetic run ${run.id} (${run.status})`);
}

async function resultOf(run) {
  const result = await api(`/api/flow/jobs/${encodeURIComponent(run.id)}/result`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

try {
  const modelPort = await listen(model);
  const targetPort = await listen(target);
  const web = path.join(temporary, 'web');
  await mkdir(web);
  await writeFile(path.join(web, 'index.html'), '<!doctype html><title>Isolated smoke harness</title>');
  const source = path.join(temporary, 'main.go');
  const binary = path.join(temporary, process.platform === 'win32' ? 'smoke-server.exe' : 'smoke-server');
  await writeFile(source, harness);
  await command('go', ['build', '-o', binary, source]);
  child = spawn(binary, [web, `127.0.0.1:${targetPort}`], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  childExit = new Promise(resolve => child.once('exit', resolve));
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Smoke API did not start')), 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Smoke API exited (${code}): ${serverLog}`)); });
    child.stdout.on('data', chunk => {
      serverLog = (serverLog + chunk).slice(-12_000);
      const match = serverLog.match(/SMOKE_SERVER=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-12_000); });
  });
  assert.equal((await api('/api/health')).data.status, 'ok');
  console.log('PASS isolated API started; real HAR and deployment credentials are unused');

  const capture = { log: { entries: [{
    request: { method: 'GET', url: 'http://smoke-target.invalid/state', headers: [], queryString: [], cookies: [] },
    response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{"state":"ready"}' } }, time: 10,
  }] } };
  const parsed = await api('/api/har/parse', { har: capture });
  assert.equal(parsed.status, 200);
  assert.equal(targetCalls, 0, 'HAR import must not replay a request');
  const analysisEvents = [];
  console.log('CHECK asynchronous model completion after a real 21.5-second response delay');
  const analysisStart = Date.now();
  const analyzed = await analyzeViaJob({ baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'test-only-key', model: 'test-only-model' }, parsed.data.requests, new AbortController().signal, {
    fetch: (route, init) => fetch(new URL(route, base), init),
    onEvent: event => analysisEvents.push(event),
  });
  assert.ok(Date.now() - analysisStart > 20_000, 'model response must cross the former 20-second timeout');
  assert.equal(modelCalls, 1, 'analysis must not be resubmitted');
  assert.equal(analyzed.suggestions[0].label, '读取模拟业务状态');
  assert.deepEqual(analysisEvents.map(event => event.stage), ['submitted', 'completed']);
  assert.equal(targetCalls, 0, 'model analysis must not replay a request');
  console.log('PASS delayed async analysis, one provider call, no automatic replay');

  const invalid = await api('/api/flow/validate', flow([node('extract', 'extract', { variable: 'value', source: 'deleted-node', path: 'body.value' })]));
  assert.equal(invalid.status, 200);
  assert.equal(invalid.data.valid, false);
  assert.ok(invalid.data.issues.some(issue => issue.nodeId === 'extract' && issue.field === 'source' && issue.code && issue.message));
  const denied = await api('/api/flow/jobs', flow([node('extract', 'extract', { variable: 'value', source: '', path: 'body.value' })]));
  assert.equal(denied.status, 400);
  assert.equal(denied.data.valid, false);
  console.log('PASS structured preflight locates a missing extraction source before execution');

  const paused = await startRun(flow([
    node('name', 'input', { variable: 'name', value: 'Smoke' }),
    node('manual-code', 'manual', { variable: 'code', description: '输入模拟验证码' }),
    node('verify-code', 'assertion', { variable: 'code', operator: 'eq', expected: '123456' }),
    node('done', 'output', { template: '{{name}}:{{code}}' }),
  ], [edge('name', 'manual-code'), edge('manual-code', 'verify-code'), edge('verify-code', 'done')]));
  const waiting = await pollRun(paused, job => job.status === 'waiting_input');
  assert.equal(waiting.pendingInput.nodeId, 'manual-code');
  assert.equal(waiting.pendingInput.variable, 'code');
  assert.ok(paused.events.some(event => event.nodeId === 'manual-code' && event.status === 'waiting_input'));
  assert.ok(!paused.events.some(event => event.nodeId === 'verify-code' && event.status === 'success'));
  const resumed = await api(`/api/flow/jobs/${encodeURIComponent(paused.id)}/resume`, { inputs: { code: '123456' } });
  assert.ok(resumed.status >= 200 && resumed.status < 300, JSON.stringify(resumed.data));
  await pollRun(paused);
  assert.equal(paused.status, 'completed');
  const resumedResult = await resultOf(paused);
  assert.equal(resumedResult.status, 'success');
  assert.equal(resumedResult.output, 'Smoke:123456');
  assert.ok(paused.events.some(event => event.nodeId === 'verify-code' && event.status === 'success'));
  console.log('PASS manual pause/resume, real node events, successful business assertion');

  const failedAssertion = await startRun(flow([
    node('value', 'input', { variable: 'value', value: 'actual' }),
    node('assert', 'assertion', { variable: 'value', operator: 'eq', expected: 'expected' }),
    node('after', 'output', { template: 'must be skipped' }),
  ], [edge('value', 'assert'), edge('assert', 'after')]));
  await pollRun(failedAssertion);
  assert.equal(failedAssertion.status, 'failed');
  const assertionResult = await resultOf(failedAssertion);
  assert.equal(assertionResult.status, 'error');
  assert.ok(assertionResult.steps.some(step => step.nodeId === 'assert' && step.status === 'error'));
  assert.ok(assertionResult.steps.some(step => step.nodeId === 'after' && step.status === 'skipped'));
  console.log('PASS failed assertion is a node error and later steps are skipped');

  const failedHTTP = await startRun(flow([
    node('http', 'request', { method: 'GET', url: 'http://smoke-target.invalid/failure' }),
    node('after-http', 'output', { template: 'must be skipped' }),
  ], [edge('http', 'after-http')]));
  await pollRun(failedHTTP);
  assert.equal(failedHTTP.status, 'failed');
  assert.ok(failedHTTP.events.some(event => event.nodeId === 'http' && event.status === 'running'));
  assert.ok(failedHTTP.events.some(event => event.nodeId === 'http' && event.status === 'error'));
  const httpResult = await resultOf(failedHTTP);
  assert.ok(httpResult.steps.some(step => step.nodeId === 'http' && step.status === 'error' && /503/.test(step.error)));
  assert.ok(httpResult.steps.some(step => step.nodeId === 'after-http' && step.status === 'skipped'));
  const acceptedHTTP = await startRun(flow([node('accepted', 'request', { method: 'GET', url: 'http://smoke-target.invalid/failure', acceptStatus: '503' })]));
  await pollRun(acceptedHTTP);
  assert.equal(acceptedHTTP.status, 'completed');
  console.log('PASS HTTP 503 fails by default, explicit accepted status works, node events are real');
  assert.equal(targetCalls, 2);

  const special = 'a"b\nline & extra=1 + plus 中';
  const encoded = await startRun(flow([
    node('input-value', 'input', { variable: 'value', value: special }),
    node('echo', 'request', { method: 'POST', url: 'http://smoke-target.invalid/echo?value={{value}}&keep=raw%2Bplus', headers: { 'Content-Type': 'application/json' }, body: '{"value":"{{value}}","large":12345678901234567890,"boolean":true,"nested":["{{value}}"]}' }),
    node('verify-query', 'assertion', { variable: 'echo.body.query.value', operator: 'eq', expected: special }),
    node('verify-body', 'assertion', { variable: 'echo.body.body.value', operator: 'eq', expected: special }),
    node('encoded-output', 'output', { template: '{{echo.body.body.value}}' }),
  ], [edge('input-value', 'echo'), edge('echo', 'verify-query'), edge('verify-query', 'verify-body'), edge('verify-body', 'encoded-output')]));
  await pollRun(encoded);
  assert.equal(encoded.status, 'completed');
  assert.equal((await resultOf(encoded)).output, special);
  console.log('PASS quotes, Unicode, newlines and query separators remain individual JSON/query values through a real HTTP run');

  const dynamicBase = await startRun(flow([
    node('base-value', 'input', { variable: 'base', value: 'http://smoke-target.invalid' }),
    node('dynamic-request', 'request', { url: '{{base}}/state' }),
    node('dynamic-result', 'output', { template: '{{dynamic-request.body.state}}' }),
  ], [edge('base-value', 'dynamic-request'), edge('dynamic-request', 'dynamic-result')]));
  await pollRun(dynamicBase);
  assert.equal(dynamicBase.status, 'completed');
  assert.equal((await resultOf(dynamicBase)).output, 'ready');
  assert.equal(targetCalls, 4);
  console.log('PASS a validated dynamic HTTP base URL resolves at execution and still goes through the destination guard');

  const recorded = (id, extra = {}) => ({ id, method: 'GET', url: 'http://smoke-target.invalid/state', domain: 'smoke-target.invalid', path: '/state', category: 'api', mimeType: 'application/json', status: 200, duration: 1, headers: {}, body: '', responseBody: '{}', responseHeaders: {}, query: {}, ...extra });
  const recordedID = 'synthetic-recorded-id';
  const captured = [recorded('source', { responseBody: JSON.stringify({ id: recordedID }) }), recorded('submit', { method: 'POST', url: 'http://smoke-target.invalid/echo?mode=generated', path: '/echo', body: JSON.stringify({ id: recordedID }) })];
  const recognized = captured.map(request => ({ requestId: request.id, label: '读取合成业务结果', description: '按录制字段证据传递业务编号。', category: 'api', confidence: 'high', dependencies: [], variables: [], readiness: 'ready' }));
  const generated = mergeGeneratedFlow([], [], captured, recognized, 'synthetic-auto-bindings');
  assert.equal(generated.nodes[1].data.bindings[0].mode, 'upstream');
  const compiled = compileBindings(generated.nodes, generated.edges, {});
  assert.deepEqual(compiled.issues, []);
  const submittedID = generated.nodes[1].id;
  const generatedRun = await startRun({ ...flow([
    ...compiled.nodes,
    node('verify-generated-binding', 'assertion', { variable: `${submittedID}.body.body.id`, operator: 'eq', expected: 'synthetic-item-1' }),
  ], [...compiled.edges, edge(submittedID, 'verify-generated-binding')], generated.nodes[0].id), inputs: compiled.inputs });
  await pollRun(generatedRun);
  assert.equal(generatedRun.status, 'completed');
  assert.equal(targetCalls, 6);
  console.log('PASS automatic field-evidence binding sends the current upstream ID instead of replaying the recorded ID');
  console.log('All runtime smoke checks passed. Only isolated local mocks were contacted.');
} finally {
  if (child && child.exitCode === null) { child.kill(); await Promise.race([childExit, sleep(5_000)]); }
  for (const timer of modelTimers) clearTimeout(timer);
  await Promise.all([close(model), close(target)]);
  const relative = path.relative(resultsRoot, temporary);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to remove an unexpected smoke directory');
  await rm(temporary, { recursive: true, force: true });
}
