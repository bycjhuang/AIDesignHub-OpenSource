'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDshModelProxy } = require('../backend/dsh-model-proxy.cjs');

test('Harness proxy authenticates loopback requests and routes profile IDs with server-side credentials', async t => {
  const sent = [];
  const proxy = await startDshModelProxy({ modelService: { getConnection(id) { assert.equal(id, 'text-sol'); return { baseUrl: 'https://relay.example/v1', model: 'gpt-6.1-sol', apiKey: 'secret-upstream' }; } },
    fetchImpl: async (url, options) => { sent.push({ url, options, body: JSON.parse(options.body) }); return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); } });
  t.after(() => proxy.stop());
  const call = (token, model = 'text-sol', url = '/chat/completions') => fetch(proxy.baseUrl + url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'synthetic' }], tools: [{ type: 'function' }] }) });
  assert.equal((await call('invalid')).status, 401);
  assert.equal((await call(proxy.token, 'text-sol', '/anything')).status, 404);
  assert.equal((await call(proxy.token, 'unknown')).status, 400);
  assert.equal(sent.length, 0);
  const response = await call(proxy.token);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /event-stream/);
  assert.match(await response.text(), /data: \[DONE\]/);
  assert.equal(sent[0].url, 'https://relay.example/v1/chat/completions');
  assert.equal(sent[0].options.headers.Authorization, 'Bearer secret-upstream');
  assert.equal(sent[0].options.redirect, 'manual');
  assert.equal(sent[0].body.model, 'gpt-6.1-sol'); assert.equal(sent[0].body.stream, true); assert.equal(sent[0].body.tools.length, 1);
});

test('Harness proxy blocks redirects and replaces upstream error bodies without retrying', async t => {
  let calls = 0;
  const proxy = await startDshModelProxy({ modelService: { getConnection: () => ({ baseUrl: 'https://relay.example/v1', model: 'fixture', apiKey: 'private-key' }) },
    fetchImpl: async () => { calls++; return calls === 1 ? new Response('', { status: 302, headers: { location: 'https://other.example' } }) : new Response('private-key', { status: 401 }); } });
  t.after(() => proxy.stop());
  const request = () => fetch(proxy.baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model: 'fixture', messages: [] }) });
  const redirect = await request(); assert.equal(redirect.status, 502);
  const authError = await request(); assert.equal(authError.status, 401); assert.ok(!(await authError.text()).includes('private-key'));
  assert.equal(calls, 2);
});

test('Harness Responses traffic preserves tool and reasoning events with the configured upstream model', async t => {
  const proxy = await startDshModelProxy({ modelService: { getConnection: () => ({ baseUrl: 'https://relay.example/v1', model: 'gpt-6-astra', apiKey: 'upstream' }) }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://relay.example/v1/responses'); const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-astra'); assert.deepEqual(body.reasoning, { effort: 'high' }); assert.equal(body.tools[0].name, 'inspect_canvas');
    return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(() => proxy.stop());
  const response = await fetch(proxy.baseUrl + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model: 'text-astra', input: [{ role: 'user', content: 'synthetic' }], tools: [{ type: 'function', name: 'inspect_canvas' }], reasoning: { effort: 'high' }, stream: true }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
});
