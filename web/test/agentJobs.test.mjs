import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeViaJob, AgentJobError, AGENT_JOB_POLL_MS, sleepForAgentJob } from '../src/agentJobs.ts';

const config = { baseUrl: 'https://model.test/v1', apiKey: 'never-log-this-key', model: 'test-model' };
const requests = [{ id: 'req-1', method: 'GET', url: 'https://target.test/private', domain: 'target.test', path: '/private', category: 'api', mimeType: 'application/json', status: 200, duration: 1, headers: { Authorization: 'private-header' }, body: 'private-payload', responseBody: '{}', responseHeaders: {}, query: {} }];
const analysis = { summary: '真正的分析结果', suggestions: [{ requestId: 'req-1', label: '查询状态', description: '获取当前处理状态，用于结果确认。', category: 'api', dependencies: [], confidence: 'high', variables: [] }], warnings: [] };
const json = (body, status = 200, requestId) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) } });
const start = () => json({ id: 'job-1', status: 'running' }, 202, 'start-request');
const completed = () => json({ id: 'job-1', status: 'completed', analysis }, 200, 'completed-request');
const immediateSleep = async () => {};

test('starts exactly once and polls sequentially at one-second intervals until actual completion', async () => {
  const calls = [], delays = [], events = [];
  let active = 0;
  let polls = 0;
  const controller = new AbortController();
  const result = await analyzeViaJob(config, requests, controller.signal, {
    fetch: async (url, init) => {
      assert.equal(++active, 1);
      calls.push({ url, method: init.method });
      assert.equal(init.signal, controller.signal);
      await Promise.resolve();
      active--;
      if (init.method === 'POST') { assert.deepEqual(JSON.parse(init.body), { config, requests }); return start(); }
      assert.equal(url, '/api/agent/jobs/job-1');
      return ++polls === 1 ? json({ id: 'job-1', status: 'running' }, 200, 'quiet-poll-request') : completed();
    },
    sleep: async (delay, signal) => { delays.push(delay); assert.equal(signal, controller.signal); },
    onEvent: event => events.push(event),
  });
  assert.deepEqual(result, analysis);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'GET']);
  assert.deepEqual(delays, [AGENT_JOB_POLL_MS, AGENT_JOB_POLL_MS]);
  assert.deepEqual(events, [
    { stage: 'submitted', jobId: 'job-1', status: 202, requestId: 'start-request' },
    { stage: 'completed', jobId: 'job-1', status: 200, requestId: 'completed-request' },
  ]);
  assert.ok(!JSON.stringify(events).includes(config.apiKey));
  controller.abort();
  await Promise.resolve();
  assert.equal(calls.length, 3, 'completion must remove the abort listener');
});

test('gateway HTML creates a useful HTTP 502 error with correlation ID, without HTML or payload echo', async () => {
  const calls = [], events = [];
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (url, init) => { calls.push(init.method); return new Response('<html><body>SECRET gateway dump</body></html>', { status: 502, headers: { 'x-request-id': 'gateway-502-id' } }); },
    sleep: immediateSleep, onEvent: event => events.push(event),
  }), error => {
    assert.ok(error instanceof AgentJobError);
    assert.equal(error.status, 502);
    assert.equal(error.requestId, 'gateway-502-id');
    assert.match(error.message, /HTTP 502/);
    assert.match(error.message, /gateway-502-id/);
    assert.match(error.message, /网关/);
    assert.ok(!error.message.includes('<html>') && !error.message.includes('SECRET'));
    assert.ok(!error.message.includes(config.apiKey) && !error.message.includes('private-payload'));
    return true;
  });
  assert.deepEqual(calls, ['POST']);
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'failed');
  assert.equal(events[0].requestId, 'gateway-502-id');
});

test('a JSON HTTP failure is surfaced once with no model retry', async () => {
  let calls = 0;
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async () => { calls++; return json({ error: '请求过于频繁' }, 429, 'rate-limit-id'); }, sleep: immediateSleep,
  }), error => error.status === 429 && /HTTP 429/.test(error.message) && /rate-limit-id/.test(error.message) && /请求过于频繁/.test(error.message));
  assert.equal(calls, 1);
});

test('poll authentication/expiry failures cancel the known job and never resubmit or silently retry', async () => {
  for (const status of [401, 404]) {
    const methods = [];
    await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
      fetch: async (_, init) => { methods.push(init.method); return init.method === 'POST' ? start() : json({ error: status === 404 ? '任务不存在或已过期' : '认证失败' }, status, `poll-${status}`); },
      sleep: immediateSleep,
    }), error => error.jobId === 'job-1' && error.status === status && error.requestId === `poll-${status}`);
    assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  }
});

test('non-JSON poll errors retain HTTP status, request ID and job ID without echoing HTML', async () => {
  const methods = [];
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (_, init) => { methods.push(init.method); return init.method === 'POST' ? start() : new Response('<html>not-a-result</html>', { status: 200, headers: { 'x-request-id': 'bad-result-id' } }); }, sleep: immediateSleep,
  }), error => error.status === 200 && error.jobId === 'job-1' && error.requestId === 'bad-result-id' && /非 JSON/.test(error.message) && !error.message.includes('not-a-result'));
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
});

test('failed jobs produce a terminal error and failed event, never a fake analysis', async () => {
  const events = [];
  let calls = 0;
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async () => ++calls === 1 ? start() : json({ id: 'job-1', status: 'failed', error: '模型提供商额度不足' }, 200, 'provider-failure-id'),
    sleep: immediateSleep, onEvent: event => events.push(event),
  }), error => error instanceof AgentJobError && /额度不足/.test(error.message) && !/HTTP 200/.test(error.message) && error.jobId === 'job-1' && error.status === undefined);
  assert.equal(calls, 2);
  assert.deepEqual(events.map(event => event.stage), ['submitted', 'failed']);
  assert.equal(events.at(-1).requestId, 'provider-failure-id');
  assert.equal(events.at(-1).status, undefined, 'successful polling is not an error HTTP status');
});

test('invalid completion and mismatched job identity fail explicitly', async () => {
  for (const body of [{ id: 'job-1', status: 'completed' }, { id: 'other-job', status: 'completed', analysis }]) {
    const methods = [];
    await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
      fetch: async (_, init) => { methods.push(init.method); return init.method === 'POST' ? start() : json(body, 200, 'invalid-completion-id'); }, sleep: immediateSleep,
    }), error => error instanceof AgentJobError && error.status === 200 && error.requestId === 'invalid-completion-id');
    assert.deepEqual(methods, body.id === 'job-1' ? ['POST', 'GET'] : ['POST', 'GET', 'DELETE']);
  }
});

test('a failed active poll deletes once with an independent signal and retains its original failure', async () => {
  const controller = new AbortController();
  const methods = [], events = [];
  await assert.rejects(analyzeViaJob(config, requests, controller.signal, {
    fetch: async (_, init) => {
      methods.push(init.method);
      if (init.method === 'POST') return start();
      if (init.method === 'GET') throw new Error('poll connection lost');
      assert.notEqual(init.signal, controller.signal);
      assert.equal(init.signal.aborted, false);
      throw new Error('cleanup also failed');
    }, sleep: immediateSleep, onEvent: event => events.push(event),
  }), error => error instanceof AgentJobError && error.jobId === 'job-1' && /查询分析任务.*网络请求失败/.test(error.message) && !/cleanup/.test(error.message));
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.deepEqual(events.map(event => event.stage), ['submitted', 'failed']);
  controller.abort();
  await Promise.resolve();
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE'], 'failure removes the abort listener');
});

test('a malformed accepted start with a known identity is cancelled without a second POST', async () => {
  const methods = [];
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (_, init) => { methods.push(init.method); return json({ id: 'job-1', status: 'unknown' }, init.method === 'POST' ? 202 : 200, 'malformed-start-id'); },
    sleep: immediateSleep,
  }), error => error instanceof AgentJobError && error.jobId === 'job-1' && /响应格式不正确/.test(error.message));
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('a lost POST response is never retried or followed by an unknown-job DELETE', async () => {
  const methods = [];
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (_, init) => { methods.push(init.method); throw new Error('start response lost'); }, sleep: immediateSleep,
  }), error => error instanceof AgentJobError && error.jobId === undefined && /未自动重试/.test(error.message));
  assert.deepEqual(methods, ['POST']);
});

test('an unresponsive cleanup request has a deadline and does not hide the poll error', { timeout: 7_000 }, async () => {
  const methods = [];
  let deletionSignal;
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (_, init) => {
      methods.push(init.method);
      if (init.method === 'POST') return start();
      if (init.method === 'GET') return json({ error: 'original poll error' }, 502, 'original-poll-id');
      deletionSignal = init.signal;
      return new Promise(() => {});
    }, sleep: immediateSleep,
  }), error => error instanceof AgentJobError && error.status === 502 && error.requestId === 'original-poll-id' && /original poll error/.test(error.message));
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.equal(deletionSignal.aborted, true);
});

test('already-aborted signal never submits a model job', async () => {
  const controller = new AbortController(); controller.abort();
  const events = [];
  await assert.rejects(analyzeViaJob(config, requests, controller.signal, { fetch: async () => { throw new Error('unexpected fetch'); }, onEvent: event => events.push(event) }), { name: 'AbortError' });
  assert.deepEqual(events.map(event => event.stage), ['cancelled']);
});

test('abort during an active poll deletes the known job once with an independent live signal', async () => {
  const controller = new AbortController();
  const methods = [], events = [];
  await assert.rejects(analyzeViaJob(config, requests, controller.signal, {
    fetch: async (_, init) => {
      methods.push(init.method);
      if (init.method === 'POST') return start();
      if (init.method === 'DELETE') {
        assert.notEqual(init.signal, controller.signal);
        assert.equal(init.signal.aborted, false);
        return json({ id: 'job-1', status: 'cancelled' }, 200, 'delete-request-id');
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('network aborted')), { once: true });
        queueMicrotask(() => controller.abort());
      });
    },
    sleep: immediateSleep, onEvent: event => events.push(event),
  }), { name: 'AbortError' });
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.deepEqual(events.map(event => event.stage), ['submitted', 'cancelled']);
  assert.equal(events.at(-1).requestId, 'delete-request-id');
  assert.equal(events.at(-1).jobId, 'job-1');
  controller.abort();
  await Promise.resolve();
  assert.equal(methods.filter(method => method === 'DELETE').length, 1);
});

test('abort while waiting stops polling and a failed best-effort DELETE does not replace AbortError', async () => {
  const controller = new AbortController(); const methods = [];
  await assert.rejects(analyzeViaJob(config, requests, controller.signal, {
    fetch: async (_, init) => { methods.push(init.method); if (init.method === 'POST') return start(); throw new Error('DELETE temporarily unavailable'); },
    sleep: async (_, signal) => { controller.abort(); signal.throwIfAborted(); },
  }), { name: 'AbortError' });
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('aborting before the POST response provides an ID never resubmits an unknown job', async () => {
  const controller = new AbortController(); const methods = [];
  await assert.rejects(analyzeViaJob(config, requests, controller.signal, {
    fetch: async (_, init) => { methods.push(init.method); controller.abort(); throw new Error('response was lost'); }, sleep: immediateSleep,
  }), { name: 'AbortError' });
  assert.deepEqual(methods, ['POST']);
});

test('server-cancelled terminal job throws AbortError without redundant DELETE', async () => {
  const methods = [], events = [];
  await assert.rejects(analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (_, init) => { methods.push(init.method); return init.method === 'POST' ? start() : json({ id: 'job-1', status: 'cancelled' }, 200, 'server-cancel-id'); }, sleep: immediateSleep, onEvent: event => events.push(event),
  }), { name: 'AbortError' });
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(events.at(-1).stage, 'cancelled');
  assert.equal(events.at(-1).requestId, 'server-cancel-id');
});

test('API configuration is serialized before yielding and logging callback failures do not alter completion', async () => {
  const mutableConfig = { ...config }; let sent;
  const result = await analyzeViaJob(mutableConfig, requests, new AbortController().signal, {
    fetch: async (_, init) => { if (init.method === 'POST') { sent = JSON.parse(init.body); mutableConfig.apiKey = 'changed'; mutableConfig.model = 'changed'; return start(); } return completed(); },
    sleep: immediateSleep, onEvent: () => { throw new Error('UI logger failure'); },
  });
  assert.deepEqual(result, analysis);
  assert.equal(sent.config.model, config.model);
  assert.equal(sent.config.apiKey, config.apiKey);
});

test('optional analysis context is snapshotted as the fifth argument and excluded from logs', async () => {
  const context = { goal: 'private-user-goal', catalog: [], groups: [], relations: [], previous: [] };
  const events = [];
  let sent;
  const result = await analyzeViaJob(config, requests, new AbortController().signal, {
    fetch: async (_, init) => {
      if (init.method === 'POST') { sent = JSON.parse(init.body); context.goal = 'changed-after-start'; return start(); }
      return completed();
    }, sleep: immediateSleep, onEvent: event => events.push(event),
  }, context);
  assert.deepEqual(result, analysis);
  assert.equal(sent.context.goal, 'private-user-goal');
  assert.deepEqual(Object.keys(sent).sort(), ['config', 'context', 'requests']);
  assert.ok(!JSON.stringify(events).includes('private-user-goal'));
});

test('default wait supports immediate cancellation without waiting for its timer', async () => {
  const controller = new AbortController();
  const wait = sleepForAgentJob(60000, controller.signal);
  controller.abort();
  await assert.rejects(wait, { name: 'AbortError' });
  await assert.rejects(sleepForAgentJob(60000, controller.signal), { name: 'AbortError' });
});
