import test from 'node:test';
import assert from 'node:assert/strict';
import { getHarBlocks } from '../src/harBlocks.ts';

const request = (id, overrides = {}) => ({
  id, method: 'POST', url: `https://example.test/${id}`, domain: 'example.test', path: `/${id}`,
  category: 'api', mimeType: 'application/json', status: 200, duration: 12,
  headers: { Accept: 'application/json', Authorization: 'Bearer original-token' },
  body: '{"message":"原始请求内容"}', responseBody: '{"ok":true}', responseHeaders: {}, query: {},
  ...overrides,
});
const suggestion = (requestId, overrides = {}) => ({
  requestId, label: '提交业务表单', description: '将用户填写的业务信息提交给服务器，并返回处理结果。',
  category: 'api', dependencies: [], confidence: 'high', variables: [], ...overrides,
});

test('no analysis means no generated HAR blocks and no invented purposes', () => {
  assert.deepEqual(getHarBlocks([request('req-1')], []), []);
  assert.deepEqual(getHarBlocks([], [suggestion('req-1')]), []);
});

test('requires both a nonblank analyzed label and nonblank description', () => {
  const requests = ['empty-label', 'space-label', 'empty-description', 'space-description', 'valid'].map(id => request(id));
  const suggestions = [
    suggestion('empty-label', { label: '' }),
    suggestion('space-label', { label: ' \n\t ' }),
    suggestion('empty-description', { description: '' }),
    suggestion('space-description', { description: ' \r\n\t ' }),
    suggestion('valid'),
  ];
  assert.deepEqual(getHarBlocks(requests, suggestions).map(block => block.request.id), ['valid']);
});

test('unknown IDs are rejected and analysis order cannot reorder original requests', () => {
  const requests = [request('req-1'), request('req-2'), request('req-3')];
  const blocks = getHarBlocks(requests, [suggestion('unknown'), suggestion('req-3'), suggestion('req-1')]);
  assert.deepEqual(blocks.map(block => block.data.requestId), ['req-1', 'req-3']);
  assert.equal(blocks[0].request, requests[0]);
  assert.equal(blocks[1].request, requests[2]);
});

test('each request is emitted once, using its first valid suggestion', () => {
  const blocks = getHarBlocks([request('req-1'), request('req-1')], [
    suggestion('req-1', { description: '  ' }),
    suggestion('req-1', { label: '第一次有效分析', description: '第一次有效用途' }),
    suggestion('req-1', { label: '后续重复分析', description: '后续重复用途' }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].data.label, '第一次有效分析');
  assert.equal(blocks[0].data.description, '第一次有效用途');
});

test('preserves complete original method, URL, body and headers instead of model replacements', () => {
  const original = request('req-1', {
    method: 'PATCH',
    url: 'https://example.test/path?token=原始参数&next=%2Fdetail',
    body: '带有换行的原始正文\n' + '完整数据'.repeat(50000),
    headers: { 'X-Custom': '原始值', Cookie: 'session=original; csrf=retained', 'Content-Type': 'application/json' },
  });
  const analyzed = suggestion('req-1', { method: 'DELETE', url: 'https://other.test', headers: {}, body: '模型不能覆盖正文' });
  const block = getHarBlocks([original], [analyzed])[0];
  assert.equal(block.data.kind, 'request');
  assert.equal(block.data.method, original.method);
  assert.equal(block.data.url, original.url);
  assert.equal(block.data.body, original.body);
  assert.deepEqual(block.data.headers, original.headers);
  assert.notEqual(block.data.headers, original.headers);
  block.data.headers.Cookie = 'edited-by-user';
  assert.equal(original.headers.Cookie, 'session=original; csrf=retained');
});

test('keeps Chinese purpose text, trimming only surrounding whitespace without mutating analysis', () => {
  const analyzed = suggestion('req-1', {
    label: '  查询订单状态  ',
    description: '\n查询指定订单的处理状态；成功时返回订单编号、物流信息。\n适用于结果确认步骤。  ',
  });
  const block = getHarBlocks([request('req-1')], [analyzed])[0];
  assert.equal(block.data.label, '查询订单状态');
  assert.equal(block.data.description, '查询指定订单的处理状态；成功时返回订单编号、物流信息。\n适用于结果确认步骤。');
  assert.equal(block.suggestion.label, block.data.label);
  assert.equal(block.suggestion.description, block.data.description);
  assert.equal(analyzed.label, '  查询订单状态  ');
});

test('malformed optional runtime suggestions cannot unlock a raw request', () => {
  const blocks = getHarBlocks([request('req-1')], [
    null, suggestion('req-1', { label: undefined }), suggestion('req-1', { description: 42 }),
  ]);
  assert.deepEqual(blocks, []);
});
