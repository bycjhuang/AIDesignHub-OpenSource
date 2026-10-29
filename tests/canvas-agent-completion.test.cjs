'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { completeCanvasAgent } = require('../backend/canvas-agent-completion.cjs');
const { ModelService } = require('../backend/model-service.cjs');
const KEY = 'sk-canvas-fixture-only-never-a-real-key';
const CONFIG = { apiKey: KEY, baseUrl: 'https://fixture.example/v1', model: 'canvas-fixture', provider: 'openai-compatible', timeoutMs: 1000 };
const MESSAGES = [{ role: 'system', content: '仅处理当前画布。' }, { role: 'user', content: '添加文字。' }];
const TOOLS = [{ type: 'function', function: { name: 'manipulate_canvas', description: '编辑当前画布', parameters: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object' } } } } } }];
const call = (name = 'manipulate_canvas', args = { operations: [{ action: 'add_text', text: '你好' }] }, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (message = { content: '已完成。' }, finish_reason = 'stop', rest = {}) => new Response(JSON.stringify({ choices: [{ message, finish_reason }], ...rest }), { headers: { 'content-type': 'application/json' } });
const code = expected => error => { assert.equal(error.code, expected); assert.ok(!error.message.includes(KEY)); return true; };
const run = (fetchImpl, overrides = {}) => completeCanvasAgent({ config: CONFIG, messages: MESSAGES, fetchImpl, ...overrides });

test('DeepSeek indexed tool calls are normalized while unrelated extra fields remain rejected', async () => {
  const tool = { ...call(), index: 0 };
  const answer = await run(async () => response({ content: null, tool_calls: [tool] }, 'tool_calls'), { tools: TOOLS });
  assert.equal(answer.toolCalls[0].name, 'manipulate_canvas');
  await assert.rejects(run(async () => response({ content: null, tool_calls: [{ ...tool, extra: 'unsafe' }] }, 'tool_calls'), { tools: TOOLS }), code('MODEL_INVALID_RESPONSE'));
});

test('GPT 6 uses Responses and carries reasoning plus the exact tool outputs through a stateless loop', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-fixture-reasoning' };
  const tool = { type: 'function_call', id: 'fc_fixture', call_id: 'call_1', name: 'manipulate_canvas', arguments: call().function.arguments };
  const config = { ...CONFIG, model: 'gpt-6-astra' };
  const first = await run(async (url, options) => {
    assert.equal(url, `${CONFIG.baseUrl}/responses`);
    const body = JSON.parse(options.body);
    assert.equal(body.store, false); assert.deepEqual(body.input, MESSAGES);
    assert.equal(body.tools[0].name, 'manipulate_canvas'); assert.equal(body.tools[0].function, undefined);
    return new Response(JSON.stringify({ status: 'completed', output: [reasoning, tool] }));
  }, { config, tools: TOOLS });
  const messages = [...MESSAGES, { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_1', content: '{"elementIds":["t1"]}' }];
  const final = await run(async (_, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.input, [...MESSAGES, reasoning, tool, { type: 'function_call_output', call_id: 'call_1', output: '{"elementIds":["t1"]}' }]);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '实际完成' }] }], usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } }));
  }, { config, tools: TOOLS, messages, responseContext: first.responseContext });
  assert.equal(final.reply, '实际完成'); assert.deepEqual(final.usage, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
  assert.equal(final.responseContext, undefined);
});

test('canvas completion posts once with bounded text/tool protocol and returns parsed calls plus safe usage', async () => {
  let requests = 0;
  const result = await run(async (url, options) => {
    requests++; assert.equal(url, `${CONFIG.baseUrl}/chat/completions`); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, CONFIG.model); assert.equal(body.stream, false); assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.messages, MESSAGES); assert.deepEqual(body.tools, TOOLS); assert.ok(!options.body.includes(KEY));
    return response({ content: null, tool_calls: [call()] }, 'tool_calls', { usage: { total_tokens: 42, prompt_tokens: -1, secret: KEY.slice(0, 4) } });
  }, { tools: TOOLS });
  assert.equal(requests, 1); assert.deepEqual(result, { reply: '', toolCalls: [{ id: 'call_1', name: 'manipulate_canvas', arguments: { operations: [{ action: 'add_text', text: '你好' }] } }], model: CONFIG.model, usage: { total_tokens: 42 } });
  const messages = [...MESSAGES, { role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_1', content: '{"elementIds":["t1"]}' }];
  await run(async (_, options) => { assert.deepEqual(JSON.parse(options.body).messages, messages); return response(); }, { messages, tools: TOOLS });
  await run(async (_, options) => { assert.equal(JSON.parse(options.body).tools, undefined); return response(); });
});

test('canvas completion rejects unknown tools, malformed JSON arguments and oversized contexts before network', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return response(); };
  const badTool = { type: 'function', function: { name: 'exec', parameters: { type: 'object' } } };
  for (const overrides of [
    { tools: [badTool] }, { tools: Array(9).fill(TOOLS[0]) }, { tools: [...TOOLS, ...TOOLS] },
    { messages: [{ role: 'developer', content: 'x' }] }, { messages: [{ role: 'user', content: '中'.repeat(50000) }] },
    { messages: [{ role: 'user', content: 'x', image_url: 'https://outside.example' }] },
    { messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }], tools: TOOLS },
    { messages: [...MESSAGES, { role: 'assistant', content: null, tool_calls: [call()] }], tools: TOOLS },
    { messages: [...MESSAGES, { role: 'assistant', content: null, tool_calls: [call('manipulate_canvas', [])] }, { role: 'tool', tool_call_id: 'call_1', content: '{}' }], tools: TOOLS },
  ]) await assert.rejects(run(fetchImpl, overrides));
  assert.equal(requests, 0);
});

test('canvas completion rejects unsafe or incomplete responses without replaying or leaking credentials', async () => {
  const examples = [
    [() => new Response('', { status: 302, headers: { location: 'https://outside.example' } }), 'MODEL_REDIRECT_BLOCKED'],
    [() => new Response(KEY, { status: 401 }), 'MODEL_AUTH_FAILED'],
    [() => new Response(KEY, { status: 429 }), 'MODEL_RATE_LIMITED'],
    [() => new Response(KEY, { status: 500 }), 'MODEL_HTTP_ERROR'],
    [() => { throw new Error('private ' + KEY); }, 'MODEL_NETWORK_ERROR'],
    [() => response({ content: KEY }), 'MODEL_SECRET_IN_RESPONSE'],
    [() => response({ content: null, tool_calls: [call('manipulate_canvas', { secret: KEY })] }, 'tool_calls'), 'MODEL_SECRET_IN_RESPONSE'],
    [() => response({ content: 'x' }, 'length'), 'MODEL_INCOMPLETE_RESPONSE'],
    [() => response({ content: 'x', function_call: {} }), 'MODEL_INVALID_RESPONSE'],
    [() => response({ content: null, tool_calls: [call('exec')] }, 'tool_calls'), 'MODEL_INVALID_RESPONSE'],
    [() => response({ content: null, tool_calls: [call('manipulate_canvas', [])] }, 'tool_calls'), 'MODEL_INVALID_RESPONSE'],
    [() => response({ content: null, tool_calls: [call(), call()] }, 'tool_calls'), 'MODEL_INVALID_RESPONSE'],
    [() => response({ content: null, tool_calls: [{ ...call(), function: { name: 'manipulate_canvas', arguments: '{"x":' } }] }, 'tool_calls'), 'MODEL_INVALID_RESPONSE'],
    [() => response({ content: null, tool_calls: [call('manipulate_canvas', { text: 'x'.repeat(33000) })] }, 'tool_calls'), 'MODEL_INVALID_RESPONSE'],
    [() => new Response('x'.repeat(270000)), 'MODEL_RESPONSE_LIMIT'],
  ];
  for (const [make, expected] of examples) {
    let requests = 0;
    await assert.rejects(run(async () => { requests++; return make(); }, { tools: TOOLS }), code(expected));
    assert.equal(requests, 1);
  }
});

test('canvas cancellation and timeout stop a provider that ignores AbortSignal without retries', async () => {
  const controller = new AbortController(); let requests = 0, observed;
  const fetchImpl = async (_, options) => { requests++; observed = options.signal; return new Promise(() => {}); };
  const pending = run(fetchImpl, { signal: controller.signal }); controller.abort(new Error(KEY));
  await assert.rejects(pending, code('MODEL_CANCELLED')); assert.equal(observed.aborted, true); assert.equal(requests, 1);
  await assert.rejects(run(fetchImpl, { signal: controller.signal }), code('MODEL_CANCELLED')); assert.equal(requests, 1);
  await assert.rejects(run(fetchImpl, { config: { ...CONFIG, timeoutMs: 15 } }), code('MODEL_TIMEOUT')); assert.equal(requests, 2);
});

test('ModelService canvas wrapper uses only its private config and leaves knowledge completions tool-free', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-canvas-model-'));
  t.after(() => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert.match(path.basename(dataDir), /^adh-canvas-model-/); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const secretStore = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(byte => byte ^ 75), decryptString: value => Buffer.from(value).map(byte => byte ^ 75).toString() };
  let requests = 0;
  const service = new ModelService({ dataDir, secretStore, fetchImpl: async (url, options) => {
    requests++; assert.equal(url, `${CONFIG.baseUrl}/chat/completions`); assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    return response({ content: null, tool_calls: [call()] }, 'tool_calls');
  } });
  service.save({ ...CONFIG, provider: 'openai-compatible' });
  const before = fs.readFileSync(path.join(dataDir, 'model-private', 'model-config.enc'));
  await service.completeCanvasAgent({ messages: MESSAGES, tools: TOOLS, config: { apiKey: 'do-not-use', baseUrl: 'https://outside.example' }, fetchImpl: () => { throw new Error('do-not-use'); } });
  await assert.rejects(service.completeKnowledge({ messages: MESSAGES }), code('MODEL_TOOLS_NOT_ALLOWED'));
  assert.equal(requests, 2); assert.deepEqual(fs.readFileSync(path.join(dataDir, 'model-private', 'model-config.enc')), before);
});
