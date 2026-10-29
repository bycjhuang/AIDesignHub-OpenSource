'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AgentGateway, MAX_BODY_BYTES } = require('../backend/agent-gateway.cjs');
const { connectionFromEnv } = require('../scripts/hub-mcp.cjs');

const TOKEN = 'test-credential-only';
const principal = { projectId: 'p1', memberId: 'm1', scopes: ['project:read', 'tasks:write'] };
const descriptors = [
  { name: 'hub_project_context', description: 'Read the authorized project', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hub_task_create', description: 'Create a task', inputSchema: { type: 'object', required: ['title'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 40 }, count: { type: 'integer', minimum: 1, maximum: 10 },
  }, additionalProperties: false } },
  { name: 'hub_run_fail', description: 'Synthetic failure', inputSchema: { type: 'object', additionalProperties: false } },
];

async function fixture(t) {
  const calls = [];
  const gateway = new AgentGateway({ hub: {
    authorize(token) { if (token !== TOKEN) throw new Error(`invalid ${token}`); return principal; },
    listTools(who) { assert.equal(who, principal); return descriptors; },
    async callTool(name, args, who) {
      assert.equal(who, principal);
      calls.push({ name, args });
      if (name === 'hub_run_fail') throw new Error(`must not expose ${TOKEN}`);
      return { projectId: who.projectId, name, args };
    },
  } });
  const address = await gateway.start();
  t.after(() => gateway.stop());
  return { gateway, address, calls };
}

function request(address, route, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${TOKEN}`, ...options.headers };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const req = http.request(address.url + route, { method: options.method || 'GET', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : undefined }); });
    });
    req.on('error', reject);
    req.end(options.raw !== undefined ? options.raw : options.body !== undefined ? JSON.stringify(options.body) : undefined);
  });
}

function rpc(address, body, headers = {}) {
  return request(address, '/mcp', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } });
}

function child(script, address, args = [], input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.resolve(__dirname, '..', 'scripts', script), ...args], {
      windowsHide: true, env: { ...process.env, AIDESIGNHUB_URL: address.url, AIDESIGNHUB_TOKEN: TOKEN, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject);
    proc.on('exit', code => resolve({ code, stdout, stderr }));
    proc.stdin.end(input);
  });
}

test('gateway is loopback-only and all methods require a valid Bearer credential', async t => {
  assert.throws(() => new AgentGateway({ host: '0.0.0.0', hub: { authorize() {}, listTools() {}, callTool() {} } }), /loopback/);
  const { gateway, address } = await fixture(t);
  assert.deepEqual(await gateway.start(), address);
  for (const route of ['/v1/tools', '/mcp', '/missing']) {
    const missing = await request(address, route, { headers: { Authorization: undefined } });
    assert.equal(missing.status, 401);
    assert.match(missing.headers['www-authenticate'], /Bearer/);
  }
  const wrong = await request(address, '/v1/tools', { headers: { Authorization: 'Bearer do-not-echo-me' } });
  assert.equal(wrong.status, 401);
  assert.ok(!wrong.text.includes('do-not-echo-me'));
  const tools = await request(address, '/v1/tools');
  assert.equal(tools.status, 200);
  assert.deepEqual(tools.body.tools, descriptors);
});

test('Host and Origin prevent DNS rebinding and cross-origin browser requests', async t => {
  const { address } = await fixture(t);
  for (const headers of [{ Host: 'attacker.example' }, { Host: `127.0.0.1:${address.port + 1}` },
    { Origin: 'https://attacker.example' }, { Origin: 'null' }, { Origin: 'http://localhost:1' }, { Origin: `${address.url}/path` }]) {
    assert.equal((await request(address, '/v1/tools', { headers })).status, 403);
  }
  assert.equal((await request(address, '/v1/tools', { headers: { Origin: address.url } })).status, 200);
});

test('HTTP tool calls validate shape and limits before calling the core', async t => {
  const { address, calls } = await fixture(t);
  const call = body => request(address, '/v1/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  for (const body of [[], { name: 'hub_task_create', arguments: {} }, { name: 'hub_task_create', arguments: { title: '' } },
    { name: 'hub_task_create', arguments: { title: 'x', count: 1.5 } }, { name: 'hub_task_create', arguments: { title: 'x', count: 11 } },
    { name: 'hub_task_create', arguments: { title: 'x', extra: true } }, { name: 'hub_project_context', arguments: [] }]) {
    assert.equal((await call(body)).status, 400);
  }
  assert.equal((await call({ name: 'shell', arguments: { command: 'arbitrary' } })).status, 403);
  assert.equal(calls.length, 0);
  const result = await call({ name: 'hub_task_create', arguments: { title: 'Verified task', count: 2 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.projectId, 'p1');
  assert.equal(calls.length, 1);
  const secretError = await call({ name: 'hub_run_fail' });
  assert.equal(secretError.status, 500);
  assert.ok(!secretError.text.includes(TOKEN));
});

test('body size, malformed JSON, content types, and methods fail closed', async t => {
  const { address } = await fixture(t);
  assert.equal((await request(address, '/v1/call', { method: 'POST', raw: '{}' })).status, 415);
  assert.equal((await request(address, '/v1/call', { method: 'POST', raw: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  for (const knownLength of [true, false]) {
    const raw = 'x'.repeat(MAX_BODY_BYTES + 1);
    const headers = { 'Content-Type': 'application/json', ...(knownLength ? { 'Content-Length': Buffer.byteLength(raw) } : { 'Transfer-Encoding': 'chunked' }) };
    assert.equal((await request(address, '/v1/call', { method: 'POST', raw, headers })).status, 413);
  }
  assert.equal((await request(address, '/mcp')).status, 405);
  assert.equal((await request(address, '/v1/tools', { method: 'DELETE' })).status, 405);
});

test('stateless MCP initialize, notifications, tools and JSON-RPC errors work over HTTP', async t => {
  const { address } = await fixture(t);
  const init = await rpc(address, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal(init.headers['mcp-session-id'], undefined);
  const notification = await rpc(address, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  assert.equal(notification.text, '');
  const response = await rpc(address, { jsonrpc: '2.0', id: 50, result: {} });
  assert.equal(response.status, 202);
  assert.equal((await rpc(address, { jsonrpc: '2.0', id: 'ping', method: 'ping' })).body.id, 'ping');
  assert.deepEqual((await rpc(address, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools, descriptors);
  const call = await rpc(address, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_project_context' } });
  assert.equal(call.body.result.isError, false);
  assert.equal(call.body.result.structuredContent.projectId, 'p1');
  const failure = await rpc(address, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hub_run_fail' } });
  assert.equal(failure.body.result.isError, true);
  assert.ok(!failure.text.includes(TOKEN));
  assert.equal((await rpc(address, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'shell' } })).body.error.code, -32602);
  assert.equal((await rpc(address, { jsonrpc: '2.0', id: 6, method: 'unknown' })).body.error.code, -32601);
  assert.equal((await rpc(address, [])).body.error.code, -32600);
  assert.equal((await rpc(address, { jsonrpc: '2.0', id: 7, method: 'ping' }, { Accept: 'application/json' })).status, 406);
  assert.equal((await rpc(address, { jsonrpc: '2.0', id: 8, method: 'ping' }, { 'MCP-Protocol-Version': '1900-01-01' })).status, 400);
});

test('stdio bridge emits only JSON-RPC and uses the same authorized HTTP service', async t => {
  const { address, calls } = await fixture(t);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_task_create', arguments: { title: 'From stdio' } } },
  ];
  const result = await child('hub-mcp.cjs', address, [], messages.map(JSON.stringify).join('\n') + '\n');
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => line.id), [1, 2, 3]);
  assert.equal(lines[2].result.structuredContent.args.title, 'From stdio');
  assert.equal(calls.length, 1);
  assert.ok(!result.stdout.includes(TOKEN));
  const malformed = await child('hub-mcp.cjs', address, [], '{bad}\n');
  assert.equal(JSON.parse(malformed.stdout).error.code, -32700);
  const missing = await child('hub-mcp.cjs', address, [], '', { AIDESIGNHUB_TOKEN: '' });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
});

test('CLI tool list/call is JSON-only and never accepts arbitrary shell commands', async t => {
  const { address } = await fixture(t);
  const list = await child('hub-cli.cjs', address, ['list', 'tasks']);
  assert.equal(list.code, 0);
  assert.equal(list.stderr, '');
  assert.equal(JSON.parse(list.stdout).tools[0].name, 'hub_task_create');
  const call = await child('hub-cli.cjs', address, ['call', 'hub_project_context', '{}']);
  assert.equal(call.code, 0);
  assert.equal(JSON.parse(call.stdout).result.projectId, 'p1');
  const bad = await child('hub-cli.cjs', address, ['exec', 'whoami']);
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, '');
  assert.throws(() => connectionFromEnv({ AIDESIGNHUB_URL: 'https://example.org', AIDESIGNHUB_TOKEN: TOKEN }), /local/);
  assert.throws(() => connectionFromEnv({ AIDESIGNHUB_URL: 'http://secret:password@localhost:80', AIDESIGNHUB_TOKEN: TOKEN }), /local/);
});
