'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { buildProjectWorkbenchEntries, projectWorkbenchHostEnvironment } = require('../backend/dsh-project-workbench.cjs');
const { DSH_RUNTIME_PINS } = require('../backend/dsh-provisioner.cjs');
const root = process.env.ADH_TEST_DSH_PACKAGE || path.join(process.env.APPDATA || '', 'bycj-design-workbench-prototype', 'cache', 'dsh-runtime', DSH_RUNTIME_PINS.dshVersion, 'package');
const runtime = name => import(pathToFileURL(path.join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const available = fs.existsSync(path.join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'));
const integrationTest = available ? test : (title, fn) => test(title, { skip: 'Pinned local DSH SDK required' }, fn);
const TOKEN = 'a'.repeat(64);

test('host configuration accepts only a local exact bridge and never puts its secret in the profile patch', () => {
  const entries = buildProjectWorkbenchEntries(); assert(!JSON.stringify(entries).includes(TOKEN));
  assert.equal(entries[0].insert[0].config.tokenEnv, 'ADH_WORKBENCH_TOKEN');
  assert.equal(entries[0].insert[0].disabled, false); assert.equal(buildProjectWorkbenchEntries(false)[0].insert[0].disabled, true);
  assert.deepEqual(projectWorkbenchHostEnvironment(), { ADH_WORKBENCH_ENDPOINT: '', ADH_WORKBENCH_TOKEN: '' });
  assert.equal(projectWorkbenchHostEnvironment({ endpoint: 'http://127.0.0.1:4567/adh-workbench', token: TOKEN }).ADH_WORKBENCH_TOKEN, TOKEN);
  for (const endpoint of ['https://example.org/adh-workbench', 'http://localhost:4567/adh-workbench', 'http://127.0.0.1:4567/other', 'http://u:p@127.0.0.1:4567/adh-workbench', 'http://127.0.0.1:4567/adh-workbench?token=x']) assert.throws(() => projectWorkbenchHostEnvironment({ endpoint, token: TOKEN }));
  assert.throws(() => projectWorkbenchHostEnvironment({ endpoint: 'http://127.0.0.1:4567/adh-workbench', token: 'short' }));
});

test('context is a bounded case index, preserves synthetic project conditions and excludes arbitrary snapshot fields', async () => {
  const { contextText } = await import('../backend/dsh-plugins/adh-project-workbench/index.js');
  const value = contextText({ project: { id: 'p1', researchProfile: { isSynthetic: true, siteAreaM2: 42000 } }, secret: TOKEN, context: { secret: TOKEN, tasks: [] }, cases: Array.from({ length: 80 }, (_, index) => ({ id: `c${index}`, name: '候选案例', notes: 'x'.repeat(1000), rawHtml: TOKEN })) });
  assert.match(value, /"isSynthetic":true/); assert.match(value, /42000/); assert.match(value, /候选案例/); assert(!value.includes(TOKEN)); assert(value.length < 20000);
});

async function fixture(t, { workflowAction = null, unsafeTools = false, durable = false, actionResults = {} } = {}) {
  const requests = [], routes = new Map(), unsafeCalls = []; let current = 'p1', workflow = workflowAction;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.setHeader('content-type', 'application/json');
    if (body.projectId && body.projectId !== current) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: { code: 'PROJECT_CHANGED', message: '项目已切换，请从当前项目发起。' } })); return; }
    const snapshot = { project: { id: current, name: current === 'p1' ? '江湾文化商业中心' : '青岚地方文化中心', researchProfile: { isSynthetic: true, siteAreaM2: 42000 } }, context: { tasks: [{ title: '开放滨水步道' }] }, cases: [{ id: 'c1', name: '候选案例' }], selectedCaseIds: ['c1'], workflowAction: workflow };
    const result = actionResults[body.action] || (['snapshot', 'prepare_context'].includes(body.action) ? snapshot : { ok: true, action: body.action, projectId: body.projectId, echo: body.arguments });
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = { endpoint: process.env.ADH_WORKBENCH_ENDPOINT, token: process.env.ADH_WORKBENCH_TOKEN };
  Object.assign(process.env, { ADH_WORKBENCH_ENDPOINT: `http://127.0.0.1:${server.address().port}/adh-workbench`, ADH_WORKBENCH_TOKEN: TOKEN });
  t.after(() => { for (const [key, value] of [['ADH_WORKBENCH_ENDPOINT', previous.endpoint], ['ADH_WORKBENCH_TOKEN', previous.token]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const [{ Context }, { AgentRegistry }, { AgentLoop }, { SessionStore }, { SessionProjectionRegistry }, { SystemPrompt }, tools, llm] = await Promise.all([
    runtime('cordis'), runtime('dsh-agent'), runtime('dsh-agent-loop'), runtime('dsh-session'), runtime('dsh-session-projection'), runtime('dsh-system-prompt'), runtime('dsh-tools'), runtime('dsh-llm'),
  ]);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('connection', { fetch: { register: entry => { routes.set(entry.path, entry); return () => routes.delete(entry.path); } } });
  for (const [service, options] of [[SessionProjectionRegistry], [SessionStore], [AgentRegistry], [SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }], [tools.ToolRuntime], [llm.LlmRuntime]]) await ctx.plugin(service, options).await();
  if (durable) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-native-session-'));
    t.after(async () => { await ctx.fiber.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    await ctx.plugin(await runtime('dsh-session-persistence-jsonl'), { root: directory, compression: 'none' }).await();
  }
  if (unsafeTools) for (const name of ['pwsh', 'bash', 'write_file', 'str_replace_editor', 'read_file', 'web_search', 'read_image', 'todo_write']) ctx.tools.register({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { unsafeCalls.push(name); return { ok: true }; } });
  const plugin = await import('../backend/dsh-plugins/adh-project-workbench/index.js'); await ctx.plugin(plugin).await();
  const scripts = [], calls = [], events = [];
  class OfflineAdapter extends llm.LlmAdapter {
    async listModels() { return [{ provider: 'offline', id: 'test', name: 'Offline', context: { contextWindow: 100000 } }]; }
    async resolveModel() { return (await this.listModels())[0]; }
    async *stream(options) {
      calls.push(structuredClone({ ...options, signal: undefined }));
      const blocks = scripts.shift() || [{ type: 'text', text: '完成' }];
      for (const [index, block] of blocks.entries()) yield { type: 'block-end', index, block };
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' }, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    }
  }
  ctx.llm.registerAdapter(['offline'], new OfflineAdapter()); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  ctx.on('session/event', (_session, event) => events.push(event));
  const handle = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'offline', model: 'test' } }), agent = handle.agent;
  return { ctx, agent, handle, scripts, calls, requests, routes, events, unsafeCalls, tools, switchProject: () => { current = 'p2'; }, setWorkflow: value => { workflow = value; },
    async run(text = '为当前项目制作案例分析PPT') { agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await agent.whenIdle(); },
    async execute(name, args) { return ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal }); },
  };
}

integrationTest('the real native ADH loop sees the selected Hub project before its first model request and runs Hub tools', async t => {
  const f = await fixture(t);
  f.scripts.push([{ type: 'tool-call', id: randomUUID(), name: 'hub_web_read', arguments: JSON.stringify({ url: 'https://architecture.example/project' }) }]);
  await f.run();
  assert(f.calls.length >= 2); assert(JSON.stringify(f.calls[0]).includes('江湾文化商业中心'), JSON.stringify({keys:Object.keys(f.calls[0]),messages:f.calls[0].messages,context:f.calls[0].context})); assert(JSON.stringify(f.calls[0]).includes('"isSynthetic":true') || JSON.stringify(f.calls[0]).includes('isSynthetic'));
  assert(!JSON.stringify(f.calls).includes(TOKEN)); assert(f.calls[0].tools.some(tool => tool.name === 'hub_presentation_create'));
  const action = f.requests.find(item => item.action === 'web_read'); assert.equal(action.caller, 'tool'); assert.equal(action.projectId, 'p1'); assert.equal(action.sessionId, f.agent.id);
  assert(f.events.some(event => event.type === 'tool/result'));
});

integrationTest('native research and presentation calls keep the ADH plan intact and never dispatch an external Agent', async t => {
  const f = await fixture(t);
  const result = { summary: '比较庭院与滨水步行界面。', sources: [{ url: 'https://architecture.example/project' }], cases: [{ name: '公开案例', primarySourceUrl: 'https://architecture.example/project', evidence: [{ field: 'name', value: '公开案例', sourceUrl: 'https://architecture.example/project', quote: '项目名称：公开案例' }] }] };
  const plan = { title: '江湾案例研究', format: 'pptx', caseIds: ['c1'], researchId: 'research-native', slides: [{ title: '滨水公共空间', body: '保持开放界面，商业与公共通行分开。', imageAssetIds: ['asset-1'], sourceUrls: ['https://architecture.example/project'] }] };
  for (const [name, args] of [['hub_research_archive', { result }], ['hub_presentation_create', plan]]) f.scripts.push([{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }]);
  await f.run();
  const archive = f.requests.find(item => item.action === 'research_archive'), presentation = f.requests.find(item => item.action === 'presentation_create');
  assert.deepEqual(archive.arguments.result, result); assert.deepEqual(presentation.arguments, plan); assert.equal(presentation.sessionId, f.agent.id); assert.equal(presentation.caller, 'tool');
  assert(!f.requests.some(item => item.action === 'external_dispatch'));
  const { scrubbedParentEnv } = await runtime('dsh-subprocess'); assert.equal(scrubbedParentEnv().ADH_WORKBENCH_TOKEN, undefined);
});

integrationTest('case workflow removes terminal and file writing from the first model request and restores ordinary modeling next turn', async t => {
  const f = await fixture(t, { workflowAction: 'presentation', unsafeTools: true });
  await f.run();
  const names = f.calls[0].tools.map(tool => tool.name);
  for (const name of ['pwsh', 'bash', 'write_file', 'str_replace_editor', 'read_file']) assert(!names.includes(name), name);
  for (const name of ['hub_case_details', 'hub_research_archive', 'hub_presentation_create', 'web_search', 'read_image', 'todo_write']) assert(names.includes(name), name);
  const system = JSON.stringify(f.calls[0].messages.filter(message => message.role === 'system'));
  assert.match(system, /必须使用 Hub 原生案例工具完成工作流/); assert.match(system, /本轮由 Hub 的案例入口发起/); assert.match(system, /禁止搜索或读取 AppData、store.json/);
  f.setWorkflow(null); await f.run('使用 Rhino 建一个盒子');
  assert(f.calls[1].tools.some(tool => tool.name === 'pwsh')); assert(f.calls[1].tools.some(tool => tool.name === 'write_file'));
  const definition = f.ctx.tools.get('hub_research_archive', f.agent), bad = { result: { sources: [], cases: [{ name: '公开案例', primarySourceUrl: 'https://example.org', sourceUrls: 'https://example.org', evidence: [] }] } };
  assert(f.tools.validateJsonSchemaValue(definition.parameters, bad).some(message => String(message).includes('sourceUrls')));
  assert.equal(definition.presentCall({}).title, '保存案例与高清图');
});

integrationTest('a model-forced hidden shell call cannot execute during a case turn', async t => {
  const f = await fixture(t, { workflowAction: 'research', unsafeTools: true });
  f.scripts.push([{ type: 'tool-call', id: randomUUID(), name: 'pwsh', arguments: '{}' }]);
  await f.run(); assert.deepEqual(f.unsafeCalls, []); assert(f.events.some(event => event.type === 'tool/result' && event.data.message?.isError));
});

integrationTest('a project switch rejects old-turn tool writes, and the next native turn binds the newly selected project', async t => {
  const f = await fixture(t); await f.execute('hub_case_catalog', {}); f.switchProject();
  const rejected = await f.execute('hub_presentation_create', { title: '旧项目', format: 'pptx', slides: [{ title: '案例页' }] }); assert.equal(rejected.isError, true);
  const oldRequest = f.requests.findLast(item => item.action === 'presentation_create'); assert.equal(oldRequest.projectId, 'p1');
  await f.run('为新选中的项目继续研究'); assert(JSON.stringify(f.calls[0]).includes('青岚地方文化中心'));
  assert.equal(f.requests.findLast(item => item.action === 'prepare_context').caller, 'context');
});

integrationTest('authenticated browser proxy fixes client identity and rejects forged caller/path fields', async t => {
  const f = await fixture(t), route = f.routes.get('/api/adh-project-workbench/action');
  const bad = await route.fetch(new Request('http://localhost/api/adh-project-workbench/action', { method: 'POST', body: JSON.stringify({ action: 'prepare_context', sessionId: f.agent.id, caller: 'tool', arguments: {} }) })); assert.equal(bad.status, 400);
  const good = await route.fetch(new Request('http://localhost/api/adh-project-workbench/action', { method: 'POST', body: JSON.stringify({ action: 'select_executor', sessionId: f.agent.id, arguments: { executorId: 'adh' } }) })); assert.equal(good.status, 200);
  assert.equal(f.requests.findLast(item => item.action === 'select_executor').caller, 'client');
  const state = await f.routes.get('/api/adh-project-workbench/state').fetch(new Request(`http://localhost/api/adh-project-workbench/state?sessionId=${f.agent.id}`)); assert.equal((await state.json()).project.id, 'p1');
  const duplicated = await f.routes.get('/api/adh-project-workbench/state').fetch(new Request(`http://localhost/api/adh-project-workbench/state?sessionId=${f.agent.id}&sessionId=another`)); assert.equal(duplicated.status, 400);
  for (const action of ['collaboration_pending', 'collaboration_feed', 'collaboration_ack']) {
    const denied = await route.fetch(new Request('http://localhost/api/adh-project-workbench/action', { method: 'POST', body: JSON.stringify({ action, sessionId: f.agent.id, arguments: {} }) })); assert.equal(denied.status, 400);
  }
});

integrationTest('external notices and final relays append and flush through the real native Session SDK without any model call, and retry does not duplicate them', async t => {
  const f = await fixture(t, { durable: true }), { deliverCollaborationEvents } = await import('../backend/dsh-plugins/adh-project-workbench/index.js');
  const entries = [
    { id: 'delivery-progress', projectId: 'p1', sessionId: f.agent.id, runId: 'run-one', batchId: 'batch-one', connectionId: 'external-one', kind: 'notice', summary: '外部 Agent 处理中', text: '执行器 one · 江湾\n已读固定资料。' },
    { id: 'delivery-result', projectId: 'p1', sessionId: f.agent.id, runId: 'run-one', batchId: 'batch-one', connectionId: 'external-one', kind: 'relay', text: '执行器 one · 江湾\n外部任务的完整最终结果。' },
    { id: 'delivery-other-session', projectId: 'p1', sessionId: 'another-session', runId: 'run-other', kind: 'relay', text: '不能出现在当前对话' },
  ], acknowledgements = [];
  const bridge = async (action, sessionId, projectId, args, signal, caller) => { assert.equal(caller, 'host'); if (action === 'collaboration_pending') return { origins: [{ sessionId: f.agent.id, projectId: 'p1', deliveryCount: 2 }] }; if (action === 'collaboration_feed') return { deliveries: entries }; acknowledgements.push(args); return { acknowledged: 1 }; };
  const activeCtx = { sessions: f.ctx.sessions, get: name => name === 'agents' ? { get: () => ({ status: 'running' }) } : f.ctx.get(name) };
  assert.equal((await deliverCollaborationEvents(activeCtx, bridge)).delivered, 0); assert.equal(acknowledgements.length, 0); assert.equal(f.agent.session.deriveMessages().filter(item => item.source.kind === 'adh-collaboration').length, 0);
  assert.equal((await deliverCollaborationEvents(f.ctx, bridge)).delivered, 2); assert.equal(f.calls.length, 0);
  const messages = f.agent.session.deriveMessages().filter(item => item.source.kind === 'adh-collaboration');
  assert.equal(messages.length, 2); assert.equal(messages[0].source.form, 'notice'); assert.equal(messages[1].source.form, 'relay'); assert.equal(messages[1].role, 'user'); assert.match(messages[1].content[0].text, /完整最终结果/);
  for (const message of messages) {
    const inserted = f.events.find(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn' && event.data.inserted.some(item => item.id === message.id));
    const admitted = f.events.find(event => event.type === 'user/message' && event.data.id === message.id);
    assert(inserted); assert(admitted); assert(f.events.some(event => event.seq > inserted.seq && event.seq < admitted.seq && event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn' && event.data.removedCount === 1 && event.data.outcome !== 'canceled'));
    assert.equal(message.source.senderSessionId, 'run-one');
  }
  assert.equal(f.events.filter(event => event.type === 'turn/start').length, 2); assert.equal(f.events.filter(event => event.type === 'step/start').length, 0);
  assert.equal((await deliverCollaborationEvents(f.ctx, bridge)).delivered, 2); assert.equal(f.agent.session.deriveMessages().filter(item => item.source.kind === 'adh-collaboration').length, 2);
  const handle = await f.ctx.sessionPersistence.open(f.agent.id, 'read');
  try { const persisted = await handle.read(); assert.equal(persisted.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'adh-collaboration').length, 2); }
  finally { await handle.close(); }
  assert.equal(acknowledgements.length, 4); assert(acknowledgements.every(item => item.sessionId === f.agent.id && item.projectId === 'p1')); assert.equal(f.calls.length, 0);
});

integrationTest('pending collaboration restores an unloaded native Session writer from persistence without sending any prompt', async t => {
  const f = await fixture(t, { durable: true }), { deliverCollaborationEvents } = await import('../backend/dsh-plugins/adh-project-workbench/index.js');
  const id = f.agent.id; await f.ctx.sessions.flush(f.agent.session); await f.handle.dispose();
  assert.equal(f.ctx.sessions.get(id), undefined); assert.equal(f.ctx.sessions.list().length, 0);
  const resumes = [], acknowledgements = [], delivery = { id: 'cold-result', projectId: 'p1', sessionId: id, runId: 'cold-run', batchId: 'cold-batch', connectionId: 'external-one', kind: 'relay', text: '冷会话中的外部成果完整返回。' };
  // The Host-controller fixture delegates to the real native AgentRegistry
  // resume/persistence lifecycle; only unrelated HTTP/controller assembly is omitted.
  f.ctx.provide('sessionController', { async resolveAgent(sessionId) { resumes.push(sessionId); return { agent: (await f.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'offline', model: 'test' } })).agent }; } });
  const bridge = async (action, sessionId, projectId, args, signal, caller) => {
    assert.equal(caller, 'host');
    if (action === 'collaboration_pending') { assert.equal(args.limit, 20); return { origins: [{ sessionId: id, projectId: 'p1', deliveryCount: 1 }] }; }
    if (action === 'collaboration_feed') { assert(args.sessionIds.includes(id)); return { deliveries: [delivery] }; }
    acknowledgements.push(args); return { acknowledged: 1 };
  };
  assert.equal((await deliverCollaborationEvents(f.ctx, bridge)).delivered, 1); assert.deepEqual(resumes, [id]); assert.equal(f.calls.length, 0);
  assert.equal(f.ctx.sessions.get(id).deriveMessages().filter(message => message.id === 'cold-result').length, 1);
  assert.equal((await deliverCollaborationEvents(f.ctx, bridge)).delivered, 1); assert.equal(resumes.length, 1);
  const stored = await f.ctx.sessionPersistence.open(id, 'read');
  try { const read = await stored.read(); assert.equal(read.events.filter(event => event.type === 'user/message' && event.data.id === 'cold-result').length, 1); }
  finally { await stored.close(); }
  assert.equal(acknowledgements.length, 2); assert.equal(f.calls.length, 0);
});

integrationTest('an external-only user command opens a real completed native turn with zero model steps and preserves the following normal turn counter', async t => {
  const f = await fixture(t, { durable: true }), { deliverCollaborationEvents } = await import('../backend/dsh-plugins/adh-project-workbench/index.js');
  const command = '/协作 @openclaw 请只回复验收通过。\n@Hermes 请核对固定文本。';
  const delivery = { id: 'external-user-command', projectId: 'p1', sessionId: f.agent.id, runId: 'already-dispatched-run', batchId: 'already-dispatched-batch', connectionId: 'collaboration', kind: 'submission', text: command };
  const bridge = async action => action === 'collaboration_pending' ? { origins: [{ projectId: 'p1', sessionId: f.agent.id, deliveryCount: 1 }] } : action === 'collaboration_feed' ? { deliveries: [delivery] } : { acknowledged: 1 };
  assert.equal((await deliverCollaborationEvents(f.ctx, bridge)).delivered, 1); assert.equal(f.calls.length, 0);
  const human = f.agent.session.deriveMessages().find(message => message.id === delivery.id); assert.equal(human.source.kind, 'user'); assert.equal(human.content[0].text, command);
  assert.deepEqual(f.events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1]);
  assert.equal(f.events.filter(event => event.type === 'step/start').length, 0); assert.equal(f.events.find(event => event.type === 'turn/end').data.reason.kind, 'completed');
  assert.equal(f.ctx.sessionProjections.stateOf(f.agent.session, 'turnBoundary').lastTurn, 1);
  assert.equal((await deliverCollaborationEvents(f.ctx, bridge)).delivered, 1); assert.equal(f.events.filter(event => event.type === 'turn/start').length, 1); assert.equal(f.calls.length, 0);
  const handle = await f.ctx.sessionPersistence.open(f.agent.id, 'read');
  try { const read = await handle.read(); assert(read.events.some(event => event.type === 'turn/start')); assert(read.events.some(event => event.type === 'user/message' && event.data.id === delivery.id)); }
  finally { await handle.close(); }
  await f.run('继续一条普通 ADH 对话。'); assert.equal(f.calls.length, 1); assert.deepEqual(f.events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2]);
  assert(!f.requests.some(request => request.action === 'external_dispatch_many' || request.action === 'external_dispatch'));
});

integrationTest('native settings proxy preserves partial automatic-pairing results separately from transport success', async t => {
  const result = { ok: false, modelAssisted: false, results: [{ provider: 'hermes', ok: true }, { provider: 'openclaw', ok: false }], summary: '一项已配对，一项需处理。' };
  const f = await fixture(t, { actionResults: { runtime_auto_pair: result } }), route = f.routes.get('/api/adh-project-workbench/action');
  const response = await route.fetch(new Request('http://localhost/api/adh-project-workbench/action', { method: 'POST', body: JSON.stringify({ action: 'runtime_auto_pair', arguments: { confirmed: true } }) }));
  const envelope = await response.json(); assert.equal(response.status, 200); assert.equal(envelope.ok, true); assert.deepEqual(envelope.result, result); assert.equal(f.calls.length, 0);
});

integrationTest('a collaboration receipt parked before a crash can be admitted again without discarding other human input or calling a model', async t => {
  const f = await fixture(t), { deliverCollaborationEvents } = await import('../backend/dsh-plugins/adh-project-workbench/index.js');
  const delivery = { id: 'parked-collaboration', projectId: 'p1', sessionId: f.agent.id, runId: 'parked-run', batchId: 'parked-batch', connectionId: 'hermes', kind: 'relay', text: '重启后继续呈现既有回传。' };
  f.agent.inbox.append('next-turn', { id: delivery.id, role: 'user', source: { kind: 'adh-collaboration', form: 'relay', adhCollaborationDeliveryId: delivery.id, projectId: 'p1' }, content: [{ type: 'text', text: delivery.text }] });
  const bridge = async action => action === 'collaboration_pending' ? { origins: [{ projectId: 'p1', sessionId: f.agent.id, deliveryCount: 1 }] } : action === 'collaboration_feed' ? { deliveries: [delivery] } : { acknowledged: 1 };
  await deliverCollaborationEvents(f.ctx, bridge); assert.equal(f.agent.session.deriveMessages().filter(message => message.id === delivery.id).length, 1); assert.equal(f.calls.length, 0); assert.equal(f.agent.inbox.nextTurn.length, 0);
  const { appendCollaborationSubmission } = await import('../backend/dsh-plugins/adh-project-workbench/index.js'), another = { ...delivery, id: 'another-parked-receipt' };
  f.agent.inbox.append('next-turn', { id: another.id, role: 'user', source: { kind: 'adh-collaboration', adhCollaborationDeliveryId: another.id, projectId: 'p1' }, content: [{ type: 'text', text: another.text }] });
  f.agent.inbox.append('next-turn', { id: 'human-work-waiting', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '仍待处理的人类指令。' }] });
  assert.equal(await appendCollaborationSubmission(f.agent, another), false); assert.deepEqual(f.agent.inbox.nextTurn.map(message => message.id), [another.id, 'human-work-waiting']); assert.equal(f.calls.length, 0);
});
