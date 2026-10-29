'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// The runtime bundles ui-slots into the web bootstrap instead of installing a
// standalone Node package. Evaluate that exact, pure SDK module in isolation.
function installedSlotCore(t) {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const runtime = process.env.ADH_TEST_DSH_RUNTIME_ROOT || path.join(roaming, 'bycj-design-workbench-prototype', 'cache', 'dsh-runtime', '0.2.1-rc.2', 'package');
  const assets = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
  if (!fs.existsSync(assets)) { t.skip('Installed DSH SDK is unavailable.'); return null; }
  const bundle = fs.readdirSync(assets).filter(name => /^index.*\.js$/.test(name)).map(name => fs.readFileSync(path.join(assets, name), 'utf8')).find(source => /SlotCore:[\w$]+/.test(source));
  assert(bundle, 'The installed SDK must expose its ui-slots module.');
  const coreName = bundle.match(/SlotCore:([\w$]+)/)[1], hookName = bundle.match(/standardHookPropName:([\w$]+)/)[1];
  const exportAt = bundle.indexOf(`SlotCore:${coreName}`), end = bundle.lastIndexOf('const ', exportAt);
  const begin = bundle.lastIndexOf(`function ${hookName}(`, end);
  assert(begin >= 0 && end > begin, 'The installed pure ui-slots module boundaries must be intact.');
  const sandbox = { queueMicrotask };
  vm.runInNewContext(`${bundle.slice(begin, end)};globalThis.InstalledSlotCore=${coreName};`, sandbox);
  return sandbox.InstalledSlotCore;
}

test('installed SDK single-slot priority replaces and restores the real native model provider', async t => {
  const SlotCore = installedSlotCore(t); if (!SlotCore) return;
  const core = new SlotCore(), modelSlot = 'conversation.input.model';
  core.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
    [modelSlot]: { kind: 'single', scope: 'session' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } }, () => null);
  const NativeModel = () => ({ native: true });
  const NativeTrigger = () => ({ nativeTrigger: true });
  core.register({ name: modelSlot, priority: 0 }, NativeModel);
  core.register({ name: 'conversation.chat.node', key: 'turn-trigger', priority: 0, locale: 'chat' }, NativeTrigger);
  assert.throws(() => core.register({ name: modelSlot }, () => null), /priority 0/);

  let definition, executorId = 'adh', draft = '';
  const cleanups = [], commands = [], scope = { id: 's1' };
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {}, useRef: value => ({ current: value }), useState: value => [typeof value === 'function' ? value() : value, () => {}] };
  const input = { state: { getSnapshot: () => ({ draft, phase: 'plain' }), subscribe: () => () => {} }, notify() {}, setDraft: value => { draft = value; }, focus() {} };
  const ctx = {
    slots: { register: (options, component) => core.register(options, component), entries: key => core.entries(key), subscribe: (key, fn) => core.subscribe(key, fn), inject: (_name, callback) => { const dispose = callback(); if (dispose) cleanups.push(dispose); } },
    sessions: { scope: () => scope, scopeOf: () => 's1', list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    conversation: { input: { for: () => input } },
    inputTriggers: { registerSource: source => { commands.push(source); return () => {}; } },
    effect: callback => { const dispose = callback(); if (dispose) cleanups.push(dispose); }, get: () => undefined,
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { definition = value; } }, addEventListener() {}, removeEventListener() {} },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, project: { id: 'p1', name: '江湾文化商业中心' }, executorId, executorIds: executorId === 'adh' ? [] : ['external'], executors: [{ id: 'adh', internal: true }, { id: 'external', label: 'OpenClaw' }] }) }),
    setInterval, clearInterval, setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/dsh-plugins/adh-project-workbench/client.js'), 'utf8'), sandbox);
  definition.factory(name => { assert.equal(name, 'react'); return React; }).apply(ctx);
  const disposeClient = () => { for (const dispose of cleanups.splice(0).reverse()) dispose(); };
  t.after(disposeClient);
  const refresh = async () => {
    const picked = await commands[0].matchEnter({ sessionId: 's1' }, '/Hub', undefined, { attachments: 0 });
    assert.equal((await picked.claim.submit('', scope, [])).kind, 'success');
  };
  assert.equal(core.entriesOfSlot(modelSlot)[0].component, NativeModel);
  executorId = 'external'; await refresh();
  let winner = core.entriesOfSlot(modelSlot)[0];
  assert.equal(winner.options.priority, -100); assert.equal(winner.component.name, 'ExternalModel');
  assert.equal(winner.component({ sessionId: 's1' }).props.disabled, true);
  assert.equal(core.entries(modelSlot).length, 2, 'The native provider remains registered for restoration.');
  executorId = 'adh'; await refresh();
  assert.equal(core.entriesOfSlot(modelSlot)[0].component, NativeModel); assert.equal(core.entries(modelSlot).length, 1);
  executorId = 'collaboration'; await refresh();
  winner = core.entriesOfSlot(modelSlot)[0]; assert.equal(winner.options.priority, -100); assert.equal(winner.component({ sessionId: 's1' }).props.disabled, true);
  const trigger = core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'turn-trigger');
  assert.equal(trigger.options.priority, -100); assert.equal(trigger.component.name, 'CollaborationTrigger');
  const nativeFallback = trigger.component({ node: { data: { source: { kind: 'schedule' } } } }); assert.equal(nativeFallback.type, NativeTrigger);
  const result = trigger.component({ node: { data: { source: { kind: 'adh-collaboration', form: 'relay', senderLabel: 'Hermes' }, content: [{ type: 'text', text: '真实持久回传结果' }] } } }); assert.equal(result.type.name, 'CollaborationMessage'); assert.equal(result.type(result.props).type, 'article');
  disposeClient(); assert.equal(core.entriesOfSlot(modelSlot)[0].component, NativeModel); assert.equal(core.entriesOfSlot('conversation.chat.node')[0].component, NativeTrigger);
});

test('installed Chat visibility preserves claimed collaboration triggers and hides ordinary injected context', t => {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const runtime = process.env.ADH_TEST_DSH_RUNTIME_ROOT || path.join(roaming, 'bycj-design-workbench-prototype', 'cache', 'dsh-runtime', '0.2.1-rc.2', 'package');
  const file = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js');
  if (!fs.existsSync(file)) { t.skip('Installed DSH Chat SDK is unavailable.'); return; }
  const source = fs.readFileSync(file, 'utf8'), match = source.match(/function isVisibleChatNode\(node\) \{[\s\S]*?\n\s*\}/); assert(match, 'The actual Chat visibility policy must be found.');
  const visible = vm.runInNewContext(`(${match[0]})`), data = { source: { kind: 'adh-collaboration', form: 'relay' }, content: [{ type: 'text', text: '持久回传结果' }] };
  assert.equal(visible({ kind: 'context', visibility: 'visible', data }), false);
  assert.equal(visible({ kind: 'turn-trigger', visibility: 'visible', data }), true);
});
