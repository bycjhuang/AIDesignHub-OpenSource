'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { executeAgent, probeAgentConnection } = require('../backend/agent-executors.cjs');
const fixture = path.join(__dirname, 'fixtures', 'fake-agent.cjs');
const cwd = path.join(__dirname, '..');
const cli = (mode, extra = {}) => ({ mode: 'cli', command: process.execPath, args: [fixture, mode], timeoutMs: 3000, ...extra });
const run = (connection, extra = {}) => executeAgent(connection, { prompt: '测试 $() `not shell` "quoted"', cwd, ...extra });
const hasCode = code => cause => cause.code === code;
function promptFileFor(t, prompt) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-adapter-test-'));
  const file = path.join(directory, 'prompt.txt');
  fs.writeFileSync(file, prompt, 'utf8');
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^aidesignhub-adapter-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return file;
}

test('CLI stdin is verbatim and never shell interpreted', async () => {
  const prompt = '你好 $(bad) `bad` & < > " \'\n第二行';
  assert.equal((await run(cli('echo'), { prompt })).text, prompt);
});
test('CLI prompt placeholder is one argv value and does not also write stdin', async () => {
  const connection = cli('args'); connection.args.push('--prompt', '{prompt}');
  assert.deepEqual(JSON.parse((await run(connection)).text), { args: ['--prompt', '测试 $() `not shell` "quoted"'], stdin: '' });
});
test('CLI run placeholders are replaced once and prompt templates stay literal', async () => {
  const connection = cli('args');
  connection.args.push('--run={runId}', '{projectId}', '--session-id', '{sessionId}', '{sessionKey}', '{prompt}');
  for (const number of [1, 2]) {
    const context = { runId: `run_${number}`, projectId: `project_${number}`, sessionId: crypto.randomUUID(), sessionKey: `agent:main:aidesignhub:project_${number}:run_${number}`, prompt: 'User text {sessionId} {promptFile} {unknown} $&' };
    const result = JSON.parse((await run(connection, context)).text);
    assert.deepEqual(result, { args: [`--run=${context.runId}`, context.projectId, '--session-id', context.sessionId, context.sessionKey, context.prompt], stdin: '' });
  }
  assert.equal(connection.args[2], '--run={runId}');
});
test('CLI rejects unknown, missing and invalid per-run placeholders before spawn', async () => {
  for (const name of ['runId', 'projectId', 'sessionId', 'sessionKey', 'unknown']) {
    await assert.rejects(run(cli('args', { args: [fixture, 'args', `{${name}}`] })), hasCode('INVALID_TEMPLATE'));
  }
  await assert.rejects(run(cli('args', { args: [fixture, 'args', '{sessionKey}'] }), { sessionKey: 'secret\r\nheader' }), cause => cause.code === 'INVALID_TEMPLATE' && !cause.message.includes('secret'));
});
test('CLI long UTF-8 promptFile bypasses argv, matches prompt exactly and is caller-owned', async t => {
  const prompt = '很长的资料 {sessionId} {unknown}\n'.repeat(6000);
  const promptFile = promptFileFor(t, prompt);
  const connection = cli('prompt-file'); connection.args.push('{promptFile}', '{runId}');
  const result = JSON.parse((await run(connection, { prompt, promptFile, runId: 'run_file' })).text);
  assert.deepEqual(result, { promptBytes: Buffer.byteLength(prompt), promptHash: crypto.createHash('sha256').update(prompt).digest('hex'), args: ['run_file'], stdin: '' });
  assert.equal(fs.readFileSync(promptFile, 'utf8'), prompt);
});
test('CLI rejects missing, relative, directory, mismatched and dual prompt files', async t => {
  const prompt = 'expected prompt';
  const promptFile = promptFileFor(t, 'incorrect file');
  const connection = cli('prompt-file'); connection.args.push('{promptFile}');
  for (const file of [undefined, 'relative.txt', `${promptFile}.missing`, path.dirname(promptFile), promptFile]) {
    await assert.rejects(run(connection, { prompt, promptFile: file }), hasCode('INVALID_PROMPT_FILE'));
  }
  const validFile = promptFileFor(t, prompt);
  await assert.rejects(run({ ...connection, args: [...connection.args, '{prompt}'] }, { prompt, promptFile: validFile }), hasCode('INVALID_TEMPLATE'));
});
test('Windows command-line preflight rejects expanded and quote-escaped overflows', { skip: process.platform !== 'win32' }, async () => {
  const connection = cli('args'); connection.args.push('{prompt}');
  for (const prompt of ['x'.repeat(40000), '"'.repeat(18000)]) {
    await assert.rejects(run(connection, { prompt }), cause => cause.code === 'ARGUMENT_LIMIT' && cause.message.includes('message-file'));
  }
  await assert.rejects(run(cli('args', { args: [fixture, 'args', 'x'.repeat(17000), 'y'.repeat(17000)] })), hasCode('ARGUMENT_LIMIT'));
  assert.equal((await run(cli('echo'), { prompt: 'x'.repeat(40000) })).text.length, 40000);
});
test('Temporary Hub env is inherited only by child and never echoed by adapter', async () => {
  const events = [];
  const original = process.env.AIDESIGNHUB_TOKEN;
  const result = await run(cli('env-check'), { env: { AIDESIGNHUB_URL: 'http://127.0.0.1:9000', AIDESIGNHUB_TOKEN: 'temporary-test-token' }, onEvent: event => events.push(event) });
  assert.deepEqual(JSON.parse(result.text), { urlMatches: true, tokenMatches: true });
  assert.equal(process.env.AIDESIGNHUB_TOKEN, original);
  assert.equal(JSON.stringify({ result, events }).includes('temporary-test-token'), false);
  await assert.rejects(run(cli('echo'), { env: { NODE_OPTIONS: '--require malicious' } }), hasCode('INVALID_ENV'));
});
test('Hermes parses structured progress and trusts terminal text', async () => {
  const events = [];
  const result = await run(cli('hermes', { provider: 'hermes' }), { onEvent: event => events.push(event) });
  assert.equal(result.sessionId, 'hermes-session'); assert.match(result.text, /测试/);
  assert.equal(result.metadata.usage.total, 9); assert.equal(events.filter(event => event.type === 'tool').length, 2);
});
test('Hermes failure and invalid JSON fail closed', async () => {
  await assert.rejects(run(cli('hermes-partial', { provider: 'hermes' })), hasCode('AGENT_FAILED'));
  await assert.rejects(run(cli('bad-json', { provider: 'hermes' })), hasCode('PROTOCOL_ERROR'));
});
test('Stray non-JSON stdout lines are diagnostics, not fatal protocol errors', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-noise-test-'));
  const diagnosticsFile = path.join(directory, 'agent-stdout-noise.log');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hermes = await run(cli('hermes-noisy', { provider: 'hermes' }), { diagnosticsFile });
  assert.match(hermes.text, /测试/);
  const acp = await run(cli('acp-noisy', { mode: 'acp' }), { diagnosticsFile });
  assert.equal(acp.text, 'ACP verified');
  const log = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.match(log, /chromium sandbox log line/); assert.match(log, /browser helper started/);
});
test('OpenClaw CLI unwraps Gateway result and rejects error envelope', async () => {
  const result = await run(cli('openclaw', { provider: 'openclaw' }));
  assert.equal(result.text, 'OpenClaw verified'); assert.equal(result.sessionId, 'claw-session');
  await assert.rejects(run(cli('openclaw-failed', { provider: 'openclaw' })), hasCode('AGENT_FAILED'));
});
test('CLI rejects nonzero process exit and limits output', async () => {
  await assert.rejects(run(cli('exit-fail')), hasCode('AGENT_FAILED'));
  await assert.rejects(run(cli('flood', { maxOutputBytes: 1024 })), hasCode('OUTPUT_LIMIT'));
});
test('CLI diagnostics expose fixed failure category, never raw stderr secrets', async () => {
  await assert.rejects(run(cli('auth-fail')), cause => cause.code === 'AGENT_FAILED' && cause.category === 'gateway-auth-required' && !cause.message.includes('private-token'));
});

function installedClaw(t, health) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-claw-test-'));
  const entry = path.join(root, 'openclaw.mjs'), calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', bin: { openclaw: 'openclaw.mjs' } }));
  fs.writeFileSync(entry, `import fs from 'node:fs';
const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args.includes('health')) { console.log(JSON.stringify(${JSON.stringify(health)})); process.exitCode=${Number(health.exitCode)||0}; }
else { console.log(JSON.stringify({ok:true,result:{payloads:[{text:'verified task'}]}})); }
`);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { connection: { provider: 'openclaw', mode: 'cli', command: process.execPath, args: [entry, 'agent', '--session-id', '{sessionId}', '--message', '{prompt}', '--json'], timeoutMs: 3000 }, calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('OpenClaw preflight blocks an unavailable Gateway without sending a task or retrying', async t => {
  const value = installedClaw(t, { ok: false });
  await assert.rejects(run(value.connection, { sessionId: crypto.randomUUID() }), cause => cause.code === 'GATEWAY_UNREACHABLE' && cause.phase === 'preflight');
  assert.deepEqual(value.calls(), [['health', '--json', '--timeout', '2500']]);
});

test('an unclassified health CLI failure remains a Gateway preflight error, not a model failure', async t => {
  const value = installedClaw(t, { exitCode: 1 });
  await assert.rejects(run(value.connection, { sessionId: crypto.randomUUID() }), cause => cause.code === 'GATEWAY_CHECK_FAILED' && cause.phase === 'preflight');
  assert.deepEqual(value.calls(), [['health', '--json', '--timeout', '2500']]);
});

test('OpenClaw health preserves profile and dispatches once only after Gateway readiness', async t => {
  const value = installedClaw(t, { ok: true }), events = [];
  value.connection.args.splice(1, 0, '--profile', 'design');
  const result = await run(value.connection, { sessionId: crypto.randomUUID(), onEvent: event => events.push(event) });
  assert.equal(result.text, 'verified task');
  assert.deepEqual(value.calls()[0], ['--profile', 'design', 'health', '--json', '--timeout', '2500']);
  assert.equal(value.calls().length, 2);
  assert.equal(events[0].status, 'checking');
});

test('OpenClaw no-model probe distinguishes starting Gateway and never creates a task', async t => {
  const value = installedClaw(t, { status: 'starting' });
  await assert.rejects(probeAgentConnection(value.connection, { cwd }), cause => cause.code === 'GATEWAY_NOT_READY' && cause.phase === 'preflight');
  assert.equal(value.calls().length, 1);
});

test('an explicitly configured OpenClaw local turn does not require a Gateway', async t => {
  const value = installedClaw(t, { ok: false }); value.connection.args.push('--local');
  assert.equal((await run(value.connection, { sessionId: crypto.randomUUID() })).text, 'verified task');
  assert.equal(value.calls().length, 1); assert.ok(value.calls()[0].includes('agent'));
});
test('CLI enforces timeout and cancellation', async () => {
  await assert.rejects(run(cli('hang', { timeoutMs: 80 })), hasCode('TIMEOUT'));
  const controller = new AbortController();
  const pending = run(cli('hang'), { signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, hasCode('ABORTED'));
});
test('CLI enforces concurrent execution limit and releases slot', async () => {
  const controller = new AbortController();
  const first = run(cli('hang'), { signal: controller.signal });
  const firstRejected = assert.rejects(first, hasCode('ABORTED'));
  await assert.rejects(run(cli('echo')), hasCode('BUSY'));
  controller.abort(); await firstRejected;
  assert.match((await run(cli('echo'))).text, /测试/);
});
test('ACP negotiates v1, receives chunks, ignores other sessions and denies permissions', async () => {
  const events = [];
  const result = await run(cli('acp', { mode: 'acp' }), { onEvent: event => events.push(event) });
  assert.equal(result.text, 'ACP verified'); assert.equal(result.sessionId, 'fake-session');
  assert.equal(events.find(event => event.type === 'permission').decision, 'denied');
});
test('ACP refuses unsupported version and partial stop reasons', async () => {
  await assert.rejects(run(cli('acp-version', { mode: 'acp' })), hasCode('UNSUPPORTED_PROTOCOL'));
  await assert.rejects(run(cli('acp-partial', { mode: 'acp' })), hasCode('INCOMPLETE_RESULT'));
  await assert.rejects(run(cli('acp', { mode: 'acp', mcpServers: [{ type: 'http', name: 'test', url: 'http://localhost', headers: [] }] })), hasCode('UNSUPPORTED_CAPABILITY'));
});
test('ACP timeout and cancel settle and release owned process', async () => {
  await assert.rejects(run(cli('acp-hang', { mode: 'acp', timeoutMs: 100 })), hasCode('TIMEOUT'));
  const controller = new AbortController();
  const pending = run(cli('acp-hang', { mode: 'acp' }), { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, hasCode('ABORTED'));
});

async function withGateway(handler, body) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const envName = 'AIDESIGNHUB_FIXTURE_GATEWAY_TOKEN';
  const previous = process.env[envName]; process.env[envName] = 'fixture-token-not-real';
  try { await body({ mode: 'openclaw-http', endpoint: `http://127.0.0.1:${server.address().port}`, tokenEnv: envName, timeoutMs: 2000 }); }
  finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
test('HTTP no-model check reaches only healthz and does not send credentials or a model request', async () => {
  const observed = [];
  await withGateway((req, res) => {
    observed.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    res.end('{"ok":true}');
  }, async connection => {
    const result = await probeAgentConnection(connection, { cwd });
    assert.equal(result.level, 'gateway'); assert.equal(result.modelCalled, false);
  });
  assert.deepEqual(observed, [{ method: 'GET', path: '/healthz', auth: undefined }]);
});

test('HTTP no-model check does not confuse an unavailable Gateway with configured credentials', async () => {
  await withGateway((_req, res) => { res.writeHead(503); res.end('secret-bearing failure'); }, async connection => {
    await assert.rejects(probeAgentConnection(connection, { cwd }), cause => cause.code === 'GATEWAY_NOT_READY' && !cause.message.includes('secret-bearing'));
  });
});

test('OpenClaw HTTP chat uses bearer env, explicit session and JSON body', async () => {
  let observed;
  await withGateway((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      observed = { url: req.url, headers: req.headers, body: JSON.parse(data) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'chat-1', choices: [{ message: { content: 'HTTP verified' }, finish_reason: 'stop' }] }));
    });
  }, async connection => {
    const result = await run({ ...connection, sessionKey: 'hub:test', agentId: 'main', stream: false });
    assert.equal(result.text, 'HTTP verified'); assert.equal(result.metadata.cancellation, 'request-abort-only');
    assert.equal(observed.url, '/v1/chat/completions'); assert.equal(observed.headers.authorization, 'Bearer fixture-token-not-real');
    assert.equal(observed.headers['x-openclaw-session-key'], 'hub:test'); assert.equal(observed.body.model, 'openclaw');
    assert.equal(observed.body.messages[0].role, 'user');
    assert.equal(result.metadata.sessionKey, 'hub:test'); assert.equal(result.sessionId, undefined);
  });
});
test('OpenClaw HTTP per-run routing is distinct and never becomes a fabricated sessionId', async () => {
  const observed = [];
  await withGateway((req, res) => {
    req.resume(); observed.push(req.headers['x-openclaw-session-key']);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}');
  }, async connection => {
    for (const number of [1, 2]) {
      const sessionKey = `agent:main:aidesignhub:project_${number}:run_${number}`;
      const result = await run(connection, { sessionKey, sessionId: crypto.randomUUID() });
      assert.equal(result.metadata.sessionKey, sessionKey); assert.equal(result.sessionId, undefined);
    }
    assert.equal(new Set(observed).size, 2);
    assert.equal(connection.sessionKey, undefined);
  });
});
test('OpenClaw HTTP rejects cross-run session/resume conflicts before making requests', async () => {
  let requests = 0;
  await withGateway((_req, res) => { requests++; res.end('{}'); }, async connection => {
    await assert.rejects(run({ ...connection, sessionKey: 'hub:old' }, { sessionKey: 'hub:new' }), hasCode('SESSION_CONFLICT'));
    await assert.rejects(run({ ...connection, api: 'responses', previousResponseId: 'response-old' }, { sessionKey: 'hub:new' }), hasCode('SESSION_CONFLICT'));
    await assert.rejects(run(connection, { sessionKey: 'bad\r\nheader' }), hasCode('INVALID_TEMPLATE'));
    assert.equal(requests, 0);
  });
});
test('OpenClaw Responses SSE parses fragmented UTF-8, final output and usage', async () => {
  await withGateway((req, res) => {
    assert.equal(req.url, '/v1/responses');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(': keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"草稿"}\r\n\r\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","output":[{"type":"message","content":[{"type":"output_text","text":"最终答案"}]}],"usage":{"total_tokens":12}}}\n\ndata: [DONE]\n\n');
    res.write(bytes.subarray(0, 120)); res.end(bytes.subarray(120));
  }, async connection => {
    const result = await run({ ...connection, api: 'responses' });
    assert.equal(result.text, '最终答案'); assert.equal(result.metadata.responseId, 'resp-1'); assert.equal(result.metadata.usage.total_tokens, 12);
  });
});
test('OpenClaw chat SSE emits deltas and validates finish', async () => {
  await withGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, async connection => { assert.equal((await run(connection)).text, 'hello'); });
});
test('OpenClaw fails on provider errors and incomplete output, even after deltas', async () => {
  await withGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\ndata: [DONE]\n\n');
  }, async connection => { await assert.rejects(run({ ...connection, api: 'responses' }), hasCode('AGENT_FAILED')); });
  await withGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}');
  }, async connection => { await assert.rejects(run(connection), hasCode('INCOMPLETE_RESULT')); });
});
test('OpenClaw malformed/truncated SSE is not reported successful', async () => {
  await withGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  }, async connection => { await assert.rejects(run(connection), hasCode('INCOMPLETE_RESULT')); });
});
test('OpenClaw nonterminal JSON with output must not become a completed result', async () => {
  await withGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"in_progress","output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}');
  }, async connection => { await assert.rejects(run({ ...connection, api: 'responses' }), hasCode('INCOMPLETE_RESULT')); });
});
test('HTTP cancellation is local abort and redirect never forwards credentials', async () => {
  await withGateway((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); }, async connection => {
    const controller = new AbortController();
    const pending = run(connection, { signal: controller.signal }); setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, cause => cause.code === 'ABORTED' && cause.message.includes('not confirmed'));
  });
  await withGateway((_req, res) => { res.writeHead(302, { Location: 'https://example.invalid' }); res.end(); }, async connection => {
    await assert.rejects(run(connection), hasCode('HTTP_CONNECTION_FAILED'));
  });
});
test('HTTP errors never include remote secret-bearing error body', async () => {
  await withGateway((_req, res) => { res.writeHead(401); res.end('fixture-token-not-real'); }, async connection => {
    await assert.rejects(run(connection), cause => cause.code === 'HTTP_ERROR' && !cause.message.includes('fixture-token'));
  });
});
test('Safety validation rejects arbitrary shell paths, bad cwd and credentials in URLs', async () => {
  await assert.rejects(run({ mode: 'cli', command: 'node', args: [] }), hasCode('INVALID_EXECUTABLE'));
  await assert.rejects(run(cli('echo'), { cwd: 'relative' }), hasCode('INVALID_CWD'));
  await assert.rejects(run({ mode: 'openclaw-http', endpoint: 'http://example.com', tokenEnv: 'X' }), hasCode('INSECURE_ENDPOINT'));
  await assert.rejects(run({ mode: 'openclaw-http', endpoint: 'https://user:secret@example.com', tokenEnv: 'X' }), hasCode('INVALID_ENDPOINT'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(run(cli('echo'), { signal: aborted.signal }), hasCode('ABORTED'));
});
