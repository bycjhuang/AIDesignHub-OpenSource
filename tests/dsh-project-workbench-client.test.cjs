'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const slots = new Map(), registrations = [], commands = [], events = new Map(), actions = [], prompts = [], echoes = [], effects = [], notifications = [], listListeners = new Set(), opened = [], started = [], panels = [], pendingEffects = [];
  const stateOverrides = {}, actionFailures = new Map(), actionResults = new Map(), nativeRefreshes = [], nativeTimers = new Map(); let timerId = 0, nativeBlank = true, nativeReady = true;
  const hookSets = new Map(); let hooks = [], hookIndex = 0, definition, projectId = 'p1', draft = '', inputRevision = 0, selectedSession = 's1', rendering;
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: initial => { const stateHooks = hooks, index = hookIndex++; if (!(index in stateHooks)) stateHooks[index] = typeof initial === 'function' ? initial() : initial; return [stateHooks[index], value => { stateHooks[index] = typeof value === 'function' ? value(stateHooks[index]) : value; }]; },
    useEffect(fn, deps) { const effectHooks = hooks, index = hookIndex++, previous = effectHooks[index]; if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) { const state = { deps, cleanup: null }; effectHooks[index] = state; pendingEffects.push(() => { previous?.cleanup?.(); state.cleanup = fn(); }); effects.push(() => state.cleanup?.()); } },
    useRef: initial => { const index = hookIndex++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
  };
  const input = { state: { getSnapshot: () => ({ draft, draftRev: inputRevision, phase: 'plain', attachmentIds: [] }), subscribe: () => () => {} }, setDraft: text => { draft = text; inputRevision++; }, notify: (level, text) => notifications.push({ level, text }), focus() {} };
  const session = { getSnapshot: () => ({ blank: nativeBlank }), beginSubmission: value => { echoes.push(value); return { requestId: 'echo-1', abandon() {} }; }, prompt: async (...args) => { prompts.push(args); return { ok: true, value: { accepted: true } }; } };
  const scoped = { tag: 's1' };
  const state = () => ({ project: { id: projectId, name: projectId === 'p1' ? '江湾文化商业中心' : '另一个项目' }, executorId: 'adh', executorIds: [], selectedCaseIds: ['c1'], cases: [{ id: 'c1', name: '滨水案例' }], executors: [{ id: 'adh', label: 'ADH Agent', internal: true }, { id: 'external', label: '外部执行器' }, { id: 'hermes', label: 'Hermes' }], artifacts: [], research: [], ...stateOverrides });
  const settings = () => ({ project: state().project, catalog: [{ id: 'openclaw', name: 'OpenClaw', modes: ['cli', 'acp', 'openclaw-http'] }], connections: [{ id: 'external', provider: 'openclaw', label: '外部执行器', mode: 'cli', command: 'C:\\Agent\\run.exe', args: ['--auth', '[已保护]'], revision: 'saved-revision' }], gateway: { running: false, url: '' }, members: [{ id: 'member1', name: '项目成员' }], grants: [], capabilities: { canConfigure: true, pairingAvailable: true }, ...(stateOverrides.settings || {}) });
  const context = {
    slots: { inject: (_name, factory) => { const cleanup = factory(); if (cleanup) effects.push(cleanup); }, entries: name => [...slots.values()].filter(entry => entry.options.name === name), subscribe: () => () => {}, register: (options, component) => { const key = options.id || options.key || options.name, previous = slots.get(key), entry = { options, component }; registrations.push(entry); slots.set(key, entry); return () => { if (slots.get(key) !== entry) return; if (previous) slots.set(key, previous); else slots.delete(key); }; } },
    sessions: { scope: id => id === 's1' ? scoped : undefined, scopeOf: scope => scope?.tag, binding: id => id === 's1' ? { session } : null, refreshProjections: async id => { nativeRefreshes.push({ method: 'refreshProjections', sessionId: id }); if (nativeReady) nativeBlank = false; }, refresh: async () => { nativeRefreshes.push({ method: 'refresh' }); }, list: { getSnapshot: () => ({ byId: { [selectedSession]: { id: selectedSession, retainedBy: { mainView: 1 } } } }), subscribe: fn => { listListeners.add(fn); return () => listListeners.delete(fn); } } },
    conversation: { input: { for: scope => { assert.equal(scope, scoped); return input; } } },
    inputTriggers: { registerSource: source => { commands.push(source); return () => {}; } },
    effect: factory => { const cleanup = factory(); if (cleanup) effects.push(cleanup); }, get: name => name === 'uiWorkspace' ? { openSession: id => opened.push(id), startSession: (...args) => started.push(args) } : name === 'layout' ? { selectPanel: id => panels.push(id) } : undefined,
  };
  const sandbox = { window: { __ModuleLoader__: { load: value => { definition = value; } }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
    document: { head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }), hidden: false, addEventListener() {}, removeEventListener() {} },
    fetch: async (url, options) => {
      if (url.includes('/state?')) return { ok: true, json: async () => ({ ok: true, ...state() }) };
      const body = JSON.parse(options.body); actions.push(body);
      if (actionFailures.has(body.action)) throw actionFailures.get(body.action);
      if (actionResults.has(body.action)) return { ok: true, json: async () => ({ ok: true, ...actionResults.get(body.action) }) };
      if (body.action === 'collaboration_catalog') return { ok: true, json: async () => ({ ok: true, projectId, agents: stateOverrides.agents || [] }) };
      if (body.action === 'collaboration_settings') return { ok: true, json: async () => ({ ok: true, ...settings() }) };
      if (body.projectId !== projectId) return { ok: false, json: async () => ({ ok: false, error: '项目已切换' }) };
      if (body.action === 'select_executor') { stateOverrides.executorId = body.arguments.executorId; stateOverrides.executorIds = body.arguments.executorIds || (body.arguments.executorId === 'adh' ? [] : [body.arguments.executorId]); }
      if (body.action === 'select_presentation_template') stateOverrides.presentationTemplate = body.arguments.template;
      return { ok: true, json: async () => ({ ok: true, ...(body.action === 'external_dispatch_many' ? { batchId: 'batch1', tasks: body.arguments.tasks.map((task, index) => ({ ...task, runId: `run${index + 1}`, status: 'queued' })) } : {}) }) };
    }, setInterval, clearInterval, setTimeout: callback => { const id = ++timerId; nativeTimers.set(id, callback); return id; }, clearTimeout: id => nativeTimers.delete(id), console, URLSearchParams, crypto: require('node:crypto').webcrypto };
  const NativeTrigger = props => ({ type: 'native-trigger', props, children: [] });
  context.slots.register({ name: 'conversation.chat.node', key: 'turn-trigger', locale: 'chat' }, NativeTrigger);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/dsh-plugins/adh-project-workbench/client.js'), 'utf8'), sandbox);
  assert.equal(definition.id, '@aidesign/dsh-project-workbench');
  definition.factory(name => { assert.equal(name, 'react'); return React; }).apply(context);
  const source = commands[0];
  function renderComponent(component, props = {}) { rendering = component.name; hooks = hookSets.get(rendering) || []; hookSets.set(rendering, hooks); hookIndex = 0; const result = component(props); rendering = null; for (const effect of pendingEffects.splice(0)) effect(); return result; }
  function findComponent(tree, name) { if (!tree || typeof tree !== 'object') return null; return tree.type?.name === name ? tree : tree.children.map(child => findComponent(child, name)).find(Boolean); }
  return { source, mentions: commands[1], slots, registrations, actions, prompts, echoes, notifications, events, sandbox, input, opened, started, panels, NativeTrigger, nativeRefreshes, nativeTimers, nativeReady: value => { nativeReady = value; }, nativeBlank: () => nativeBlank, async flushNativeTimers() { const pending = [...nativeTimers.entries()]; nativeTimers.clear(); await Promise.all(pending.map(([, callback]) => callback())); }, project: id => { projectId = id; }, draft: () => draft,
    setState: value => Object.assign(stateOverrides, value), failAction: (action, error) => error ? actionFailures.set(action, error) : actionFailures.delete(action),
    respondAction: (action, result) => actionResults.set(action, result),
    setSession(id) { selectedSession = id; for (const listener of listListeners) listener(); },
    render(id) { return renderComponent(slots.get(id).component, { sessionId: 's1' }); }, clearHooks() { hookSets.clear(); }, dispose() { for (const effect of effects.reverse()) effect(); },
    renderChild(tree, name) { const node = findComponent(tree, name); assert(node, `${name} should be present`); return renderComponent(node.type, node.props); },
    renderDialog(name) { hookSets.delete('ExecutorMenu'); const tree = renderComponent(slots.get('adh-workbench-executor').component, { sessionId: 's1' }), node = findComponent(tree, name); assert(node, `${name} should be open`); return renderComponent(node.type, node.props); },
    renderResults() { const tree = this.renderDialog('HubTasks'), node = findComponent(tree, 'ResultsDock'); return renderComponent(node.type, node.props); },
    async submit(line) { const outcome = await source.matchEnter({ sessionId: 's1' }, line, undefined, { attachments: 0 }); const token = outcome.claim.token.trim(); return outcome.claim.submit(line.slice(token.length).trim(), scoped, []); },
  };
}
function buttons(tree) { if (!tree || typeof tree !== 'object') return []; return [...(tree.type === 'button' ? [tree] : []), ...tree.children.flatMap(buttons)]; }
function text(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!node || typeof node !== 'object') return ''; return node.children.map(text).join(''); }
function elements(node, type) { if (!node || typeof node !== 'object') return []; return [...(node.type === type ? [node] : []), ...node.children.flatMap(child => elements(child, type))]; }
function componentNodes(node, name) { if (!node || typeof node !== 'object') return []; return [...(node.type?.name === name ? [node] : []), ...node.children.flatMap(child => componentNodes(child, name))]; }
const settle = () => new Promise(resolve => setImmediate(resolve));
async function settingsPanel(f, detail = {}) { f.events.get('adh-workbench-request')({ detail: { panel: 'collaboration', tab: 'settings', projectId: 'p1', ...detail } }); let panel = f.render('adh-agents'); f.renderChild(panel, 'CollaborationSettings'); await settle(); panel = f.render('adh-agents'); return f.renderChild(panel, 'CollaborationSettings'); }

test('legacy skills navigation opens the native skill panel without creating a session or preparing a case task', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.events.get('adh-workbench-request')({ detail: { panel: 'skills' } });
  await settle();
  assert.equal(f.panels.at(-1), 'adh-skills');
  assert.equal(f.started.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.actions.length, 0);
});

test('ADH project commands use native Session prompt and never dispatch to an external executor', async t => {
  const f = fixture(); t.after(() => f.dispose());
  assert.equal(f.slots.get('adh-workbench-executor').options.name, 'conversation.input.right');
  assert(!f.registrations.some(slot => ['conversation.input.dock', 'conversation.composer.dock', 'conversation.input.left'].includes(slot.options.name)));
  const result = await f.submit('/案例调研 滨水文化商业'); assert.equal(result.kind, 'success');
  assert.equal(f.prompts.length, 1); assert.equal(f.echoes.length, 1); assert.equal(f.prompts[0][3], 'echo-1');
  assert.match(f.prompts[0][0][0].text, /滨水文化商业/); assert.match(f.prompts[0][0][0].text, /下载到本地/);
  assert(f.actions.some(action => action.action === 'prepare_context' && action.arguments.executorId === 'adh'));
  assert(!f.actions.some(action => action.action.startsWith('external_dispatch')));
});

test('PPT command lets ADH inspect selected local cases before generating deliverables', async t => {
  const f = fixture(); t.after(() => f.dispose());
  await f.submit('/案例PPT'); assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0][0][0].text, /已选择 1 个案例/); assert.match(f.prompts[0][0][0].text, /筛选|匹配程度/);
  assert.equal(f.actions.find(action => action.action === 'prepare_context').arguments.action, 'presentation');
});

test('composer style selector applies to research and PPT, survives Hub reopening and does not send a task', async t => {
  const f = fixture(); t.after(() => f.dispose());
  await f.submit('/Hub');
  let selector = elements(f.render('adh-workbench-executor'), 'select').find(node => node.props['aria-label'] === '案例 PPT 风格');
  assert(selector); assert.equal(selector.props.value, 'brief');
  selector.props.onChange({ target: { value: 'editorial' } }); await settle();
  assert(f.actions.some(action => action.action === 'select_presentation_template' && action.arguments.template === 'editorial'));
  assert.equal(f.prompts.length, 0);
  selector = elements(f.render('adh-workbench-executor'), 'select')[0]; assert.equal(selector.props.value, 'editorial');
  let dialog = f.renderDialog('HubTasks'); assert.equal(buttons(dialog).find(button => text(button) === '杂志版').props['aria-pressed'], true);
  await f.submit('/案例调研 滨水案例');
  assert.match(f.prompts.at(-1)[0][0].text, /杂志版/); assert.match(f.prompts.at(-1)[0][0].text, /每个案例 1–3 页/);
  await f.submit('/案例PPT');
  assert.match(f.prompts.at(-1)[0][0].text, /template: 'editorial'/); assert.match(f.prompts.at(-1)[0][0].text, /caseId/);
  await f.submit('/Hub'); dialog = f.renderDialog('HubTasks');
  assert.equal(buttons(dialog).find(button => text(button) === '杂志版').props['aria-pressed'], true);
  await f.submit('/案例PPT 简报版'); assert.match(f.prompts.at(-1)[0][0].text, /template: 'brief'/);
});

test('failed style changes retain the previous style and surface an error', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.submit('/Hub');
  f.failAction('select_presentation_template', new Error('保存失败'));
  const selector = elements(f.render('adh-workbench-executor'), 'select')[0];
  selector.props.onChange({ target: { value: 'editorial' } }); await settle();
  assert.equal(elements(f.render('adh-workbench-executor'), 'select')[0].props.value, 'brief');
  assert(f.notifications.some(item => item.level === 'error' && /保存失败/.test(item.text)));
});

test('external executor choice is explicit, sends through collaboration action, and preserves the native draft', async t => {
  const f = fixture(); t.after(() => f.dispose());
  await f.submit('/案例PPT'); f.prompts.length = 0; f.input.setDraft('请核对文化节点');
  let tree = f.render('adh-workbench-executor'); buttons(tree)[0].props.onClick();
  tree = f.render('adh-workbench-executor'); const external = buttons(tree).find(button => text(button).includes('外部执行器'));
  await external.props.onClick(); assert.equal(f.draft(), '/协作 @external 请核对文化节点');
  assert(f.actions.some(action => action.action === 'select_executor' && action.arguments.executorId === 'external'));
  assert.equal(f.slots.get('conversation.input.model').component({ sessionId: 's1' }).props.disabled, true);
  const result = await f.submit(f.draft()); assert.equal(result.kind, 'success'); assert.equal(f.prompts.length, 0);
  const dispatch = f.actions.find(action => action.action === 'external_dispatch_many'); assert.equal(dispatch.arguments.tasks[0].connectionId, 'external'); assert.equal(dispatch.arguments.tasks[0].instruction, '请核对文化节点');
  f.clearHooks(); tree = f.render('adh-workbench-executor'); buttons(tree)[0].props.onClick(); tree = f.render('adh-workbench-executor');
  await buttons(tree).find(button => text(button).includes('当前项目中的研究与制作')).props.onClick();
  assert.equal(f.draft(), '请核对文化节点'); assert(!f.slots.has('conversation.input.model'));
});

test('unsupported attachments and missing external executor never silently become ADH messages', async t => {
  const f = fixture(); t.after(() => f.dispose());
  await assert.rejects(f.source.matchEnter({ sessionId: 's1' }, '/案例调研', undefined, { attachments: 1 }), /移除附件/);
  const result = await f.submit('/协作 请求外部处理'); assert.equal(result.kind, 'error'); assert.equal(f.prompts.length, 0); assert.equal(f.actions.length, 0);
});

test('native Hub tool rows show Chinese work summaries without raw argument IDs and retain the trajectory inspector', t => {
  const f = fixture(); t.after(() => f.dispose()); let inspected = 0;
  const view = f.slots.get('hub_case_details'); assert.equal(view.options.name, 'tool.call.toolview');
  const tree = view.component({ toolName: 'hub_case_details', phase: 'result', inspect: () => { inspected++; }, block: {
    kind: 'tool-result', call: { name: 'hub_case_details', argsRaw: '{"caseIds":["case_private_uuid_123"]}' },
    content: [{ type: 'text', text: JSON.stringify({ cases: [{ id: 'case_private_uuid_123', name: '上海蟠龙天地', originalUrl: 'https://architecture.example/source' }] }) }], isError: false,
  } });
  assert.match(text(tree), /阅读案例资料/); assert.match(text(tree), /上海蟠龙天地/); assert(!text(tree).includes('hub_case_details')); assert(!text(tree).includes('case_private_uuid_123')); assert(!text(tree).includes('caseIds'));
  buttons(tree).find(button => text(button) === '详情').props.onClick(); assert.equal(inspected, 1);
});

test('preparing and failed Hub tool rows do not expose partial JSON or raw failures in the conversation', t => {
  const f = fixture(); t.after(() => f.dispose()); const view = f.slots.get('hub_research_archive');
  const preparing = view.component({ toolName: 'hub_research_archive', phase: 'preparing', block: { argsRaw: '{"result":{"internalId":"unfinished' } });
  assert.match(text(preparing), /归档案例与高清图片/); assert.match(text(preparing), /准备中/); assert(!text(preparing).includes('internalId'));
  const failed = view.component({ toolName: 'hub_research_archive', phase: 'result', block: { content: [{ type: 'text', text: '{"ok":false,"error":{"stack":"private-stack","internalId":"private-id"}}' }], isError: true } });
  assert.match(text(failed), /未完成，可查看详情/); assert(!text(failed).includes('private-stack')); assert(!text(failed).includes('private-id'));
});

test('Hub command collects latest PPT and analysis links without mounting permanent composer content', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.setState({ artifacts: [
    { id: 'old-ppt', type: 'pptx', title: '旧版项目对标案例研究与完整来源说明_详细文件名.pptx' },
    { id: 'old-html', type: 'html', title: '旧版项目分析页_详细文件名.html' },
    { id: 'new-ppt', type: 'pptx', title: '江湾文化商业中心最新案例研究与项目策略_非常冗长文件名.pptx' },
    { id: 'new-html', type: 'html', title: '江湾文化商业中心最新案例分析_非常冗长文件名.html' },
  ] });
  await f.submit('/Hub'); assert.equal(f.prompts.length, 0); const tree = f.renderResults(), resultButtons = buttons(tree);
  assert.deepEqual(resultButtons.map(text), ['打开 PPT', '查看分析页', '历史成果']);
  assert(!text(tree).includes('非常冗长文件名')); assert(!text(tree).includes('旧版项目'));
  await resultButtons[0].props.onClick(); assert.equal(f.actions.filter(action => action.action === 'artifact_open').at(-1).arguments.artifactId, 'new-ppt');
  await resultButtons[1].props.onClick(); assert.equal(f.actions.filter(action => action.action === 'artifact_open').at(-1).arguments.artifactId, 'new-html');
  assert(![...f.slots.values()].some(slot => slot.options.name === 'conversation.composer.dock'));
});

test('artifact open network timeout is shown as concise Chinese without raw English errors', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.setState({ artifacts: [{ id: 'ppt', type: 'pptx', title: '案例 PPT' }] });
  f.failAction('artifact_open', new Error('The operation was aborted due to timeout'));
  await f.submit('/Hub'); await buttons(f.renderResults())[0].props.onClick();
  assert.equal(f.notifications.at(-1).text, '连接超时，请稍后重试。'); assert(!f.notifications.some(item => /timeout|aborted/.test(item.text)));
});

test('one collaboration command assigns distinct tasks to multiple Agents and never invokes ADH', async t => {
  const f = fixture(); t.after(() => f.dispose());
  const result = await f.submit('/协作 @external 调研两个滨水案例\n@Hermes 核对案例规模与来源');
  assert.equal(result.kind, 'success'); assert.equal(f.prompts.length, 0);
  const batch = f.actions.filter(action => action.action === 'external_dispatch_many'); assert.equal(batch.length, 1);
  assert.deepEqual(batch[0].arguments.tasks.map(task => [task.connectionId, task.instruction]), [['external', '调研两个滨水案例'], ['hermes', '核对案例规模与来源']]);
  assert.equal(batch[0].arguments.commandText, '/协作 @external 调研两个滨水案例\n@Hermes 核对案例规模与来源');
  assert.match(batch[0].arguments.requestId, /^[0-9a-f-]{36}$/); assert.equal(batch[0].sessionId, 's1'); assert.equal(batch[0].projectId, 'p1');
  const permission = f.actions.find(action => action.action === 'select_executor'); assert.equal(permission.arguments.executorId, 'collaboration'); assert.deepEqual(permission.arguments.executorIds, ['external', 'hermes']);
});

test('external-only collaboration follows its native conversation and waits for durable metadata without prompting a model', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.nativeReady(false);
  assert.equal((await f.submit('/协作 @external 调研案例')).kind, 'success');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.opened, ['s1']); assert.equal(f.nativeBlank(), true); assert.equal(f.prompts.length, 0); assert.equal(f.echoes.length, 0);
  assert(f.nativeRefreshes.some(call => call.method === 'refreshProjections' && call.sessionId === 's1'));
  assert(f.nativeRefreshes.some(call => call.method === 'refresh')); assert.equal(f.nativeTimers.size, 1);
  f.nativeReady(true); await f.flushNativeTimers(); assert.equal(f.nativeBlank(), false); assert.equal(f.nativeTimers.size, 0);
  assert.equal(f.actions.filter(action => action.action === 'external_dispatch_many').length, 1);
});

test('opening an existing collaboration refreshes its native transcript metadata without replaying the batch', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.setState({ collaborationBatches: [{ id: 'existing-batch' }] });
  await f.submit('/Hub'); assert.equal(f.nativeBlank(), false);
  assert(f.nativeRefreshes.some(call => call.method === 'refreshProjections' && call.sessionId === 's1'));
  assert(!f.actions.some(action => action.action.startsWith('external_dispatch'))); assert.equal(f.prompts.length, 0);
});

test('an uncertain batch submission reuses its request ID on retry and leaves the native draft intact', async t => {
  const f = fixture(); t.after(() => f.dispose()); const instruction = '/协作 @external 调研案例\n@hermes 阅读来源'; f.input.setDraft(instruction);
  f.failAction('external_dispatch_many', new Error('network timeout'));
  assert.equal((await f.submit(instruction)).kind, 'error'); f.failAction('external_dispatch_many', null);
  assert.equal((await f.submit(instruction)).kind, 'success');
  const attempts = f.actions.filter(action => action.action === 'external_dispatch_many'); assert.equal(attempts.length, 2); assert.equal(attempts[0].arguments.requestId, attempts[1].arguments.requestId); assert.equal(f.draft(), instruction); assert.equal(f.prompts.length, 0);
});

test('changing selected cases after an uncertain submission creates a new collaboration intent', async t => {
  const f = fixture(); t.after(() => f.dispose()); const instruction = '/协作 @external 调研案例';
  f.failAction('external_dispatch_many', new Error('network timeout')); await f.submit(instruction);
  f.setState({ selectedCaseIds: ['c2'] }); f.failAction('external_dispatch_many', null); await f.submit(instruction);
  const attempts = f.actions.filter(action => action.action === 'external_dispatch_many'); assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].arguments.requestId, attempts[1].arguments.requestId); assert.deepEqual(attempts[1].arguments.caseIds, ['c2']);
});

test('executor mentions use native references only in collaboration drafts', async t => {
  const f = fixture(); t.after(() => f.dispose());
  assert.equal((await f.mentions.candidates({ sessionId: 's1' }, { query: '', position: 'inline' })).length, 0);
  f.input.setDraft('/协作 @'); const candidates = await f.mentions.candidates({ sessionId: 's1' }, { query: 'Hermes', position: 'inline' }); assert.equal(candidates.length, 1);
  const picked = f.mentions.onPick({ candidate: candidates[0] }); assert.equal(picked.insert.ref, 'hermes'); assert.equal(picked.insert.source, '协作执行器'); assert.equal(await f.mentions.codec.serialize(picked.insert.ref), '@hermes');
});

test('collaboration editor stages multiple tasks in the native composer and waits for the user to send', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.submit('/协作');
  let editor = f.renderDialog('CollaborationEditor');
  function nodes(tree, type) { if (!tree || typeof tree !== 'object') return []; return [...(tree.type === type ? [tree] : []), ...tree.children.flatMap(child => nodes(child, type))]; }
  nodes(editor, 'textarea')[0].props.onChange({ target: { value: '调研滨水案例' } });
  buttons(editor).find(button => text(button) === '+ 添加任务').props.onClick();
  editor = f.renderDialog('CollaborationEditor'); nodes(editor, 'select')[1].props.onChange({ target: { value: 'hermes' } }); nodes(editor, 'textarea')[1].props.onChange({ target: { value: '核对高清图片来源' } });
  editor = f.renderDialog('CollaborationEditor'); await buttons(editor.props.footer).find(button => text(button) === '加入输入框').props.onClick();
  assert.equal(f.draft(), '/协作 @external 调研滨水案例\n@hermes 核对高清图片来源');
  assert(!f.actions.some(action => action.action.startsWith('external_dispatch'))); assert.equal(f.prompts.length, 0);
  await f.submit(f.draft()); assert.equal(f.actions.filter(action => action.action === 'external_dispatch_many').length, 1);
});

test('switching to another ADH session releases the external model override', async t => {
  const f = fixture(); t.after(() => f.dispose()); await f.submit('/Hub');
  let tree = f.render('adh-workbench-executor'); buttons(tree)[0].props.onClick(); tree = f.render('adh-workbench-executor'); await buttons(tree).find(button => text(button).includes('外部执行器')).props.onClick();
  assert(f.slots.has('conversation.input.model')); f.setSession('s2'); assert(!f.slots.has('conversation.input.model'));
});

test('Agents directory groups all projects and allows only current-project tasks to open native sessions', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.setState({ agents: [{ id: 'external', label: '外部执行器', projects: [
    { id: 'other-project', name: '另一个项目', tasks: [{ runId: 'private', sessionId: 'other-session', title: '其他项目任务', status: 'running' }] },
    { id: 'p1', name: '江湾文化商业中心', tasks: [{ runId: 'older', sessionId: 'older-session', title: '旧任务', status: 'completed', updatedAt: 100 }, { runId: 'run1', sessionId: 'origin-session', title: '滨水文化案例调研', status: 'completed', updatedAt: 200 }] },
  ] }] });
  assert(f.registrations.some(entry => entry.options.name === 'sidebar.panellist' && entry.options.id === 'adh-agents'));
  f.render('adh-agents'); await new Promise(resolve => setImmediate(resolve)); let tree = f.render('adh-agents');
  function folders(node) { if (!node || typeof node !== 'object') return []; return [...(node.type === 'details' ? [node] : []), ...node.children.flatMap(folders)]; }
  const directories = folders(tree); assert.equal(directories.length, 2); assert.equal(directories[0].props.open, true); assert.match(text(directories[0].children[0]), /江湾文化商业中心/); assert.equal(directories[1].props.open, false);
  assert.deepEqual(buttons(directories[0]).map(button => text(button).replace('已完成', '')), ['滨水文化案例调研', '旧任务']);
  assert.equal(text(buttons(tree).find(button => button.props.className === 'adh-wb-agent-item')), '外部执行器3');
  const other = buttons(tree).find(button => text(button).includes('其他项目任务')); assert.equal(other.props.disabled, true); assert.match(other.props.title, /先在 Hub 切换到「另一个项目」/); other.props.onClick(); assert.equal(f.opened.length, 0);
  directories[1].props.onToggle({ currentTarget: { open: true } }); tree = f.render('adh-agents'); assert.equal(folders(tree)[1].props.open, true);
  buttons(tree).find(button => text(button).includes('滨水文化案例调研')).props.onClick(); assert.deepEqual(f.opened, ['origin-session']); assert.equal(f.prompts.length, 0);
});

test('collaboration settings open without creating a chat or performing setup actions', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.setSession('');
  const tree = await settingsPanel(f);
  assert.match(text(tree), /本机 Agent/); assert.match(text(tree), /执行器连接/);
  assert.equal(f.registrations.find(entry => entry.options.name === 'sidebar.panellist' && entry.options.id === 'adh-agents').options.label(), 'Agent 协作中心');
  assert(f.panels.includes('adh-agents')); assert.equal(f.started.length, 0); assert.equal(f.prompts.length, 0);
  assert(f.actions.every(action => ['collaboration_catalog', 'collaboration_settings'].includes(action.action)));
});

test('native detection and pairing require explicit actions and pairing keeps model use off', async t => {
  const f = fixture(); t.after(() => f.dispose());
  f.respondAction('runtime_discover', { candidates: [{ id: 'local-entry', provider: 'openclaw', label: 'OpenClaw CLI', installed: true, pairable: true, config: { command: 'C:\\Agent\\run.exe' } }] });
  f.respondAction('runtime_auto_pair', { result: { ok: false, summary: '一项配对完成，另有客户端需要授权。', results: [{ provider: 'chatgpt', ok: false, message: '请在客户端完成接入。' }] } });
  let tree = await settingsPanel(f); await buttons(tree).find(button => text(button) === '仅检测').props.onClick();
  tree = f.renderChild(f.render('adh-agents'), 'CollaborationSettings'); assert.match(text(tree), /OpenClaw CLI/);
  await buttons(tree).find(button => text(button) === '配对').props.onClick();
  const pair = f.actions.find(action => action.action === 'runtime_pair'); assert.deepEqual(pair.arguments, { candidateId: 'local-entry', confirmLaunch: true });
  tree = f.renderChild(f.render('adh-agents'), 'CollaborationSettings'); await buttons(tree).find(button => text(button) === '自动检测并配对').props.onClick();
  const automatic = f.actions.find(action => action.action === 'runtime_auto_pair'); assert.equal(automatic.arguments.confirmed, true); assert.equal(automatic.arguments.useModel, false);
  tree = f.renderChild(f.render('adh-agents'), 'CollaborationSettings'); assert.match(text(tree), /配对结果/); assert.match(text(tree), /请在客户端完成接入/);
  assert(!f.actions.some(action => /external_dispatch|connection_test/.test(action.action))); assert.equal(f.prompts.length, 0);
});

test('connection editor preserves protected argument placeholders and revision on an explicit save', async t => {
  const f = fixture(); t.after(() => f.dispose()); let tree = await settingsPanel(f);
  buttons(tree).find(button => text(button) === '设置').props.onClick(); tree = f.renderChild(f.render('adh-agents'), 'CollaborationSettings');
  let editor = f.renderChild(tree, 'ConnectionEditor'); elements(editor, 'input').find(input => input.props.value === '外部执行器').props.onChange({ target: { value: '我的 OpenClaw' } });
  editor = f.renderChild(tree, 'ConnectionEditor'); assert.equal(buttons(editor).find(button => text(button) === '运行最小测试').props.disabled, true);
  await editor.props.onSubmit({ preventDefault() {} });
  const saved = f.actions.find(action => action.action === 'connection_save'); assert.equal(saved.arguments.confirmed, true); assert.equal(saved.arguments.connection.revision, 'saved-revision'); assert.deepEqual(saved.arguments.connection.args, ['--auth', '[已保护]']); assert.equal(saved.arguments.connection.label, '我的 OpenClaw');
  assert(!f.actions.some(action => /connection_test|connection_probe|external_dispatch/.test(action.action)));
});

test('model test needs its own confirmation and explicitly allows the external model', async t => {
  const f = fixture(); t.after(() => f.dispose()); let tree = await settingsPanel(f);
  buttons(tree).find(button => text(button) === '设置').props.onClick(); tree = f.renderChild(f.render('adh-agents'), 'CollaborationSettings');
  const editor = f.renderChild(tree, 'ConnectionEditor'); buttons(editor).find(button => text(button) === '运行最小测试').props.onClick();
  assert(!f.actions.some(action => action.action === 'connection_test'));
  tree = f.renderChild(f.render('adh-agents'), 'CollaborationSettings'); const confirmation = componentNodes(tree, 'Dialog').find(node => node.props.title.startsWith('测试 '));
  assert.match(confirmation.props.description, /模型额度/); await buttons(confirmation.props.footer).find(button => text(button) === '运行最小测试').props.onClick();
  const tested = f.actions.find(action => action.action === 'connection_test'); assert.deepEqual(tested.arguments, { connectionId: 'external', confirmed: true, allowModel: true }); assert.equal(f.prompts.length, 0);
});

test('MCP authorization copies secrets on the backend and displays only a token-free template', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.respondAction('grant_create_copy', { copied: true, grant: { id: 'grant1' }, message: '授权配置已复制。' }); f.respondAction('client_config', { config: { mcpServers: { hub: { token: '<AIDESIGNHUB_TOKEN>' } } }, containsToken: false });
  const tree = await settingsPanel(f); let mcp = f.renderChild(tree, 'McpSettings'); mcp.props.onToggle({ currentTarget: { open: true } }); mcp = f.renderChild(tree, 'McpSettings'); let access = f.renderChild(mcp, 'McpAccess');
  const form = elements(access, 'form')[0]; elements(form, 'input').find(input => input.props.maxLength === 100).props.onChange({ target: { value: '本机客户端' } }); access = f.renderChild(mcp, 'McpAccess'); await elements(access, 'form')[0].props.onSubmit({ preventDefault() {} });
  const created = f.actions.find(action => action.action === 'grant_create_copy'); assert.equal(created.projectId, 'p1'); assert.equal(created.arguments.copy, 'config'); assert.equal(created.arguments.confirmed, true); assert.equal(created.arguments.memberId, 'member1'); assert(!('token' in created.arguments));
  await buttons(access).find(button => text(button) === '生成不含密钥的配置模板').props.onClick(); access = f.renderChild(mcp, 'McpAccess'); assert.match(elements(access, 'textarea')[0].props.value, /<AIDESIGNHUB_TOKEN>/);
  f.respondAction('client_config', { config: 'must-never-render-secret', containsToken: true }); await buttons(access).find(button => text(button) === '生成不含密钥的配置模板').props.onClick(); access = f.renderChild(mcp, 'McpAccess'); assert.equal(elements(access, 'textarea').length, 0); assert(!text(access).includes('must-never-render-secret'));
});

test('explicit auto-pair handoff is consumed once and a plain settings handoff does not pair', async t => {
  const f = fixture(); t.after(() => f.dispose()); await settingsPanel(f, { autoPair: true }); await settle();
  f.renderChild(f.render('adh-agents'), 'CollaborationSettings'); await settle(); f.renderChild(f.render('adh-agents'), 'CollaborationSettings');
  const calls = f.actions.filter(action => action.action === 'runtime_auto_pair'); assert.equal(calls.length, 1); assert.equal(calls[0].arguments.useModel, false); assert.equal(f.started.length, 0);
});

test('legacy tasks display their persisted result in the native center without a separate composer or replay', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.setState({ agents: [{ id: 'external', label: '执行器', projects: [{ id: 'p1', name: '江湾文化商业中心', tasks: [{ runId: 'legacy-run', title: '旧调研', status: 'awaiting_review' }] }] }] });
  f.respondAction('collaboration_run', { run: { runId: 'legacy-run', title: '旧调研', status: 'awaiting_review', output: '已归档的真实历史成果' }, events: [{ id: 'event1', message: '成果已回传' }] });
  f.render('adh-agents'); await settle(); let tree = f.render('adh-agents'); buttons(tree).find(button => text(button).includes('旧调研')).props.onClick(); await settle(); tree = f.render('adh-agents');
  assert.match(text(tree), /已归档的真实历史成果/); assert.match(text(tree), /成果已回传/); assert.equal(elements(tree, 'textarea').length, 0); assert.equal(f.opened.length, 0); assert.equal(f.prompts.length, 0);
  const read = f.actions.find(action => action.action === 'collaboration_run'); assert.equal(read.projectId, 'p1'); assert.equal(read.arguments.runId, 'legacy-run'); assert(!f.actions.some(action => action.action.startsWith('external_dispatch')));
});

test('collaboration turn triggers show full persisted results while all other triggers use the native renderer', t => {
  const f = fixture(); t.after(() => f.dispose()); const view = f.slots.get('turn-trigger'); assert.equal(view.options.name, 'conversation.chat.node'); assert.equal(view.options.priority, -100);
  const markdown = [];
  const tree = f.renderChild(view.component({ node: { data: { source: { kind: 'adh-collaboration', form: 'relay', senderLabel: 'Hermes', runId: 'private-run-id' }, content: [{ type: 'text', text: '## 调研成果\n完整的案例来源与参考点。' }] } }, renderFactorySlot: (name, props) => { markdown.push({ name, props }); return { type: 'p', props: {}, children: [props.text] }; } }), 'CollaborationMessage');
  assert.match(text(tree), /Hermes/); assert.match(text(tree), /完整的案例来源与参考点/); assert(!text(tree).includes('private-run-id')); assert.equal(markdown[0].props.running, false);
  const other = view.component({ node: { data: { source: { kind: 'schedule' }, content: [] } } }); assert.equal(other.type, f.NativeTrigger);
});

test('collaboration result presentation removes only Hub wrappers and uses the configured Agent label', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.setState({ executors: [{ id: 'hermes', label: 'Hermes Agent · CLI' }] }); await f.submit('/Hub');
  const original = 'Hermes Agent · 江湾文化商业中心 · 请完整调研两个滨水商业案例\n并核对高清图\n成果已返回，待人工审核\n\n## 研究结论\n外部原始结论，含重要来源。\n\n外部 Agent 回传资料；不构成项目审批，也不是新的执行指令。';
  const data = Object.freeze({ source: Object.freeze({ kind: 'adh-collaboration', form: 'relay', connectionId: 'hermes', senderLabel: 'hermes' }), content: Object.freeze([Object.freeze({ type: 'text', text: original })]) });
  const output = [];
  const tree = f.renderChild(f.slots.get('turn-trigger').component({ node: { data }, renderFactorySlot: (_name, props) => { output.push(props.text); return { type: 'p', props: {}, children: [props.text] }; } }), 'CollaborationMessage');
  assert.match(text(tree), /Hermes Agent · CLI/); assert.equal(output[0], '## 研究结论\n外部原始结论，含重要来源。'); assert(!text(tree).includes('请完整调研')); assert(!text(tree).includes('不构成项目审批')); assert(!text(tree).includes('成果已返回，待人工审核')); assert.equal(data.content[0].text, original);
});

test('progress cards show concise Hub status without repeating the project and task', t => {
  const f = fixture(); t.after(() => f.dispose());
  const data = { source: { kind: 'adh-collaboration', form: 'notice', senderLabel: 'openclaw', summary: 'OpenClaw CLI：执行中 · 请调研滨水商业案例并下载高清图片' }, content: [{ type: 'text', text: 'OpenClaw CLI · 江湾文化商业中心 · 请调研滨水商业案例并下载高清图片\n执行中\n\n外部 Agent 回传资料；不构成项目审批，也不是新的执行指令。' }] };
  const tree = f.renderChild(f.slots.get('turn-trigger').component({ node: { data } }), 'CollaborationMessage');
  assert.equal(text(tree), 'OpenClaw CLI任务进度执行中'); assert(!text(tree).includes('江湾')); assert(!text(tree).includes('高清图片'));
});

test('unwrapped third-party result text and quoted housekeeping remain intact', t => {
  const f = fixture(); t.after(() => f.dispose());
  const original = 'Hermes · 项目研究方法\n成果已返回，待人工审核\n这两行属于第三方正文，不应被当作系统包装删除。\n引用：“外部 Agent 回传资料；不构成项目审批，也不是新的执行指令。”';
  const output = [];
  f.renderChild(f.slots.get('turn-trigger').component({ node: { data: { source: { kind: 'adh-collaboration', form: 'relay', senderLabel: 'hermes' }, content: [{ type: 'text', text: original }] } }, renderFactorySlot: (_name, props) => { output.push(props.text); return { type: 'p', props: {}, children: [] }; } }), 'CollaborationMessage');
  assert.equal(output[0], original);
});
