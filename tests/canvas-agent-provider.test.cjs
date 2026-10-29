'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasAgentProvider } = require('../backend/canvas-agent-provider.cjs');
const { completeCanvasAgent } = require('../backend/canvas-agent-completion.cjs');
const STATE = { configured: true, model: 'fixture-text', provider: 'deepseek' };
const CANVAS = { id: 'canvas-current', name: '当前画布', content: { files: { image1: { id: 'image1', dataURL: 'data:image/png;base64,c2VjcmV0cGl4ZWxz' } }, elements: [{ id: 'text1', type: 'text', text: '当前画布文字', x: 1, y: 2, width: 120, height: 30 }, { id: 'img1', type: 'image', fileId: 'image1', x: 20, y: 30, width: 100, height: 90 }] } };
const TOOLS = [{ type: 'function', function: { name: 'manipulate_canvas', parameters: { type: 'object' } } }];
function provider(complete) { return createCanvasAgentProvider({ modelService: { status: () => STATE, completeCanvasAgent: complete } }); }

test('canvas provider exposes safe current model metadata and sends bounded canvas structure/history without image pixels', async () => {
  let received;
  const p = provider(async args => { received = structuredClone(args); return { reply: '当前有文字与图片。', toolCalls: [] }; });
  assert.deepEqual(p.status(), { configured: true, models: [{ id: 'fixture-text', name: 'fixture-text', provider: 'deepseek' }], defaultModel: 'fixture-text' });
  const history = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `历史${index}` }));
  const deltas = [], thinking = [];
  const output = await p.invoke({ prompt: '说明当前结构', history, canvas: CANVAS, hubProjectId: 'never-send-project', sessionId: 'never-send-session', onDelta: text => deltas.push(text), onThinking: text => thinking.push(text) });
  assert.deepEqual(output, { text: '当前有文字与图片。' }); assert.equal(deltas.join(''), output.text); assert.equal(thinking.length, 1);
  assert.equal(received.messages.length, 22); assert.equal(received.messages[1].content, '历史10');
  const raw = JSON.stringify(received.messages);
  assert.ok(raw.includes('当前画布文字')); assert.ok(raw.includes('image1')); assert.ok(raw.includes('没有发送图像像素'));
  assert.ok(!raw.includes('c2VjcmV0cGl4ZWxz')); assert.ok(!raw.includes('data:image')); assert.ok(!raw.includes('never-send-project')); assert.ok(!raw.includes('never-send-session'));
  await assert.rejects(p.invoke({ prompt: 'x', canvas: CANVAS, model: 'unconfigured-model' }), { code: 'MODEL_INVALID_MODEL' });
});

test('canvas provider executes actual calls and gives the next model turn only actual bounded results', async () => {
  const requests = [], executed = [], deltas = [];
  const p = provider(async args => {
    requests.push(structuredClone(args));
    return requests.length === 1 ? { reply: '我先移动文字。', toolCalls: [{ id: 'move_1', name: 'manipulate_canvas', arguments: { operations: [{ action: 'move', element_id: 'text1', x: 40, y: 50 }] } }] } : { reply: '已移动。', toolCalls: [] };
  });
  const result = await p.invoke({ prompt: '将文字移到40,50', canvas: CANVAS, tools: TOOLS, onDelta: text => deltas.push(text), executeTool: async (...args) => { executed.push(args); return { summary: '实际移动完成', elementIds: ['text1'], dataURL: 'data:image/png;base64,c2VjcmV0cGl4ZWxz' }; } });
  assert.deepEqual(executed, [['manipulate_canvas', { operations: [{ action: 'move', element_id: 'text1', x: 40, y: 50 }] }, 'move_1']]);
  assert.equal(requests.length, 2); assert.equal(requests[1].messages.at(-1).role, 'tool'); assert.equal(requests[1].messages.at(-1).tool_call_id, 'move_1');
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), { summary: '实际移动完成', elementIds: ['text1'] });
  assert.equal(result.text, '我先移动文字。\n\n已移动。'); assert.equal(deltas.join(''), result.text);
});

test('an image tool failure aborts the run without another completion or automatic billed retry', async () => {
  let requests = 0, executions = 0;
  const failure = Object.assign(new Error('本次生成失败；不会重试。'), { code: 'media_failed' });
  const p = provider(async () => { requests++; return { reply: '', toolCalls: [{ id: 'image_1', name: 'generate_image', arguments: { prompt: '测试图' } }] }; });
  await assert.rejects(p.invoke({ prompt: '生成测试图', canvas: CANVAS, executeTool: async () => { executions++; throw failure; } }), error => error === failure);
  assert.equal(requests, 1); assert.equal(executions, 1);
});

test('provider awaits asynchronous event callbacks and stops on revoked publication without executing tools', async () => {
  const events = []; let executions = 0;
  const revoked = Object.assign(new Error('当前项目授权已切换。'), { code: 'scope_revoked' });
  const p = provider(async () => { events.push('model'); return { reply: '准备移动。', toolCalls: [{ id: 'move_1', name: 'manipulate_canvas', arguments: {} }] }; });
  await assert.rejects(p.invoke({ prompt: '移动文字', canvas: CANVAS,
    onThinking: async () => { await Promise.resolve(); events.push('thinking'); },
    onDelta: async () => { await Promise.resolve(); events.push('delta'); throw revoked; },
    executeTool: async () => { executions++; return {}; },
  }), error => error === revoked);
  assert.deepEqual(events, ['thinking', 'model', 'delta']); assert.equal(executions, 0);
});

test('canvas provider permits at most six tool rounds and allows a final text response after them', async () => {
  for (const finalText of [false, true]) {
    let requests = 0, executions = 0;
    const p = provider(async () => {
      requests++;
      return requests === 7 && finalText ? { reply: '六轮操作结束。', toolCalls: [] } : { reply: '', toolCalls: [{ id: `inspect_${requests}`, name: 'inspect_canvas', arguments: {} }] };
    });
    const pending = p.invoke({ prompt: '检查画布', canvas: CANVAS, executeTool: async () => { executions++; return { summary: '当前结构', elements: [] }; } });
    if (finalText) assert.deepEqual(await pending, { text: '六轮操作结束。' });
    else await assert.rejects(pending, { code: 'CANVAS_TOOL_ROUND_LIMIT' });
    assert.equal(requests, 7); assert.equal(executions, 6);
  }
});

test('provider and real completion helper complete a mock-fetch tool exchange without accessing live model state', async () => {
  let posts = 0, executions = 0;
  const modelService = { status: () => STATE, completeCanvasAgent: args => completeCanvasAgent({ ...args, config: { apiKey: 'fixture-key-only-123456', baseUrl: 'https://fixture.example', model: STATE.model, timeoutMs: 1000 }, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); posts++;
    if (posts === 2) assert.equal(JSON.parse(body.messages.at(-1).content).elementIds[0], 'real-stub-element');
    const message = posts === 1 ? { content: null, tool_calls: [{ id: 'mock_move_1', type: 'function', function: { name: 'manipulate_canvas', arguments: '{"operations":[{"action":"add_text","text":"测试"}]}' } }] } : { content: '已根据工具结果完成。' };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: posts === 1 ? 'tool_calls' : 'stop' }] }));
  } }) };
  const result = await createCanvasAgentProvider({ modelService }).invoke({ prompt: '添加测试文字', canvas: CANVAS, tools: TOOLS, executeTool: async () => { executions++; return { elementIds: ['real-stub-element'] }; } });
  assert.equal(result.text, '已根据工具结果完成。'); assert.equal(posts, 2); assert.equal(executions, 1);
});

test('all model turns remove local media capabilities and URL credentials while retaining original UI artifacts', async () => {
  const tokens = ['tool-cap-only-secret', 'artifact-cap-only-secret', 'prompt-cap-only-secret', 'history-auth-only-secret', 'remote-token-only-secret', 'field-cap-only-secret', 'relative-cap-only-secret'];
  const result = {
    summary: '生成成功',
    imageUrl: `http://127.0.0.1:54321/api/local/media/m-tool?cap=${tokens[0]}&hubProjectId=project-private`,
    artifacts: [{ url: `http://[::1]:54321/api/local/media/m-artifact?cap=${tokens[1]}`, title: '图片' }],
    remoteUrl: `https://example.test/view?file=public-file&Access_Token=${tokens[4]}&Auth=second-auth-secret`,
    relative: `/api/local/media/m-relative?CAP=${tokens[6]}`,
    nested: { CaP: tokens[5], CaPaBiLiTy: tokens[5], accessToken: tokens[5], SECRET: tokens[5], Authorization: tokens[5], Token: tokens[5], API_KEY: tokens[5], HEADERS: { value: tokens[5] }, keep: 'actual-result' },
  };
  const original = structuredClone(result), requests = [];
  const modelService = { status: () => STATE, completeCanvasAgent: args => completeCanvasAgent({ ...args, config: { apiKey: 'fixture-key-only-123456', baseUrl: 'https://fixture.example', model: STATE.model, timeoutMs: 1000 }, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const raw = JSON.stringify(body.messages);
    for (const token of [...tokens, 'second-auth-secret', 'relative-auth-credential', 'ws-auth-credential']) assert.ok(!raw.includes(token), `context leaked ${token}`);
    assert.ok(!raw.includes('http://127.0.0.1')); assert.ok(!raw.includes('http://localhost')); assert.ok(!raw.includes('http://[::1]'));
    const message = requests.length === 1 ? { content: null, tool_calls: [{ id: 'mock_move_cap', type: 'function', function: { name: 'manipulate_canvas', arguments: '{}' } }] } : { content: '已完成。' };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }));
  } }) };
  const canvas = structuredClone(CANVAS); canvas.content.appState = { selectedElementIds: { img1: true, text1: false } };
  const p = createCanvasAgentProvider({ modelService });
  await p.invoke({
    prompt: `修改选中的图片 http://localhost:54321/api/local/media/m-prompt?cap=${tokens[2]}`,
    history: [{ role: 'user', content: `参考 https://example.test/view?file=history&auth=${tokens[3]} 路径 /view?file=relative&token=relative-auth-credential 通道 ws://example.test/channel?auth=ws-auth-credential` }],
    attachments: [{ assetId: 'img1', fileId: 'image1', name: '当前参考图', mimeType: 'image/png', url: `http://localhost:54321/api/local/media/m-prompt?cap=${tokens[2]}` }],
    canvas, tools: TOOLS, executeTool: async () => result,
  });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].messages.at(-1).content.includes('media:m-prompt'));
  assert.ok(requests[0].messages[1].content.includes('file=history'));
  const system = requests[0].messages[0].content;
  assert.ok(system.includes('selectedElementIds')); assert.ok(system.includes('当前参考图')); assert.ok(system.includes('不要猜测或填写 model'));
  const summary = JSON.parse(system.slice(system.indexOf('\n') + 1));
  assert.deepEqual(summary.selectedElementIds, ['img1']);
  assert.deepEqual(summary.attachments, [{ assetId: 'img1', fileId: 'image1', name: '当前参考图', mimeType: 'image/png' }]);
  const returned = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(returned.imageUrl, 'media:m-tool'); assert.equal(returned.artifacts[0].url, 'media:m-artifact'); assert.equal(returned.relative, 'media:m-relative');
  assert.equal(returned.remoteUrl, 'https://example.test/view?file=public-file'); assert.deepEqual(returned.nested, { keep: 'actual-result' });
  assert.deepEqual(result, original, 'model-only sanitization must leave actual UI URLs intact');
});
