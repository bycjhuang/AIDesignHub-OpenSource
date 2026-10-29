'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = readFileSync(path.join(__dirname, '..', 'backend/dsh-plugins/adh-skill-library/client.js'), 'utf8');
const local = { id: 'image-design', displayName: '图像设计', description: '设计演示', sourceLabel: '用户技能', layer: 'design', modelInvocable: true, userInvocable: true };
const shared = { id: 'shared-1', skillId: 'image-design', displayName: '团队图像设计', description: '团队演示', layer: 'design', author: { id: 'designer-1', name: '陈设计', role: '设计师' }, origin: 'local', canUnshare: true, sharedAt: '2026-10-27T01:00:00Z' };
function fixture(overrides = {}) {
  let definition, hookIndex = 0;
  let hooks = ['', 0, '', null, { skills: [local], teamSkills: [shared], context: { label: '当前对话可用技能' }, sharing: { identity: { id: 'designer-1', name: '陈设计' }, server: { running: false, urls: [] }, remote: { connected: false } } }, 'local', '', null, '', ''];
  const effects = [], requests = [], intervals = [], cleared = [];
  const components = new Map();
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) { const index = hookIndex++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }]; },
    useEffect(effect) { effects.push(effect); }, useMemo(fn) { return fn(); }, useRef() { return { current: null }; },
  };
  const sandbox = { window: { __ModuleLoader__: { load(value) { definition = value; } } }, URLSearchParams, AbortController,
    setInterval(callback, duration) { intervals.push({ callback, duration }); return intervals.length; }, clearInterval(id) { cleared.push(id); },
    async fetch(url, options = {}) { requests.push({ url, options }); return { ok: true, async json() { return overrides.response || { ok: true }; } }; },
  };
  vm.runInNewContext(source, sandbox);
  definition.factory(() => React).apply({ sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } }, get() {},
    slots: { inject(_name, register) { register(); }, register(entry, component) { components.set(entry.name, component); } },
  });
  function render(component = components.get('main'), props) { hookIndex = 0; effects.length = 0; return component(props); }
  return { render, effects, requests, intervals, cleared, get hooks() { return hooks; }, set hooks(value) { hooks = value; } };
}
function flatten(node) { if (Array.isArray(node)) return node.flatMap(flatten); if (!node || typeof node !== 'object') return []; return [node, ...node.children.flatMap(flatten)]; }
function textOf(node) { if (Array.isArray(node)) return node.map(textOf).join(''); if (node == null || node === false) return ''; if (typeof node !== 'object') return String(node); return node.children.map(textOf).join(''); }
function find(root, predicate) { return flatten(root).find(predicate); }
function button(root, label) { return find(root, node => node.type === 'button' && textOf(node) === label); }

test('local skills share only registry selectors and expose update state', async () => {
  const f = fixture();
  f.hooks[0] = 'session-1';
  let root = f.render();
  assert.ok(find(root, node => node.props.role === 'tab' && node.props['aria-selected'] === true && textOf(node).startsWith('本机技能')));
  assert.match(textOf(root), /当前对话可用技能/);
  await button(root, '分享到团队').props.onClick();
  assert.equal(f.requests[0].url, '/api/adh-skill-library/share');
  assert.equal(f.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { name: 'image-design', sessionId: 'session-1' });
  assert.equal(f.hooks[7].message, '已分享到团队共享。');
  f.hooks[4].skills = [{ ...local, sharedId: 'shared-1' }];
  root = f.render();
  assert.ok(button(root, '更新分享'));
});

test('team view shows author identity and permits unshare only for owned local snapshots', async () => {
  const f = fixture();
  f.hooks[5] = 'team';
  let root = f.render();
  assert.match(textOf(root), /分享者：陈设计 · 设计师/);
  await button(root, '取消分享').props.onClick();
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { id: 'shared-1' });
  assert.equal(f.requests[0].url, '/api/adh-skill-library/unshare');
  f.hooks[4].teamSkills = [{ ...shared, origin: 'remote', canUnshare: false }];
  f.hooks[2] = '陈设计';
  root = f.render();
  assert.equal(button(root, '取消分享'), undefined);
  assert.match(textOf(root), /团队图像设计/);
  assert.match(textOf(root), /不会自动安装或执行/);
});

test('team connection uses the explicit host form and clears the invitation draft after success', async () => {
  const f = fixture();
  f.hooks[5] = 'team'; f.hooks[8] = ' http://192.168.1.8:43920 '; f.hooks[9] = ' invitation-code ';
  const root = f.render();
  await find(root, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests[0].url, '/api/adh-skill-library/connect');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { url: 'http://192.168.1.8:43920', token: 'invitation-code' });
  assert.equal(f.hooks[9], '');
  assert.ok(button(root, '开启本机共享'));
  f.hooks[4].sharing.server = { running: true, urls: ['http://192.168.1.8:43920'], token: 'sample-code' };
  const running = f.render();
  assert.match(textOf(running), /http:\/\/192\.168\.1\.8:43920/);
  assert.ok(button(running, '关闭本机共享'));
});

test('team detail reuses origin-qualified ID and renders shared instructions only as text', async () => {
  const f = fixture({ response: { ok: true, skill: { ...shared, origin: 'remote', content: '<script>alert(1)</script>' } } });
  f.hooks[3] = { ...shared, origin: 'remote' }; f.hooks[5] = 'team';
  const detail = find(f.render(), node => typeof node.type === 'function');
  assert.ok(detail);
  f.hooks = [{ loading: true }];
  f.render(detail.type, detail.props);
  const dispose = f.effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.requests[0].url, /team-body\?id=shared-1&origin=remote/);
  assert.doesNotMatch(f.requests[0].url, /sessionId/);
  const loaded = f.render(detail.type, detail.props);
  assert.equal(textOf(find(loaded, node => node.type === 'pre')), '<script>alert(1)</script>');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML\s*=/);
  dispose();
});

test('team catalog refreshes periodically and clears its interval when leaving', () => {
  const f = fixture();
  f.hooks[5] = 'team'; f.render();
  const dispose = f.effects[3]();
  assert.equal(f.intervals[0].duration, 15000);
  f.intervals[0].callback();
  assert.equal(f.hooks[1], 1);
  dispose();
  assert.deepEqual(f.cleared, [1]);
});
test('team roles use readable labels while custom role names remain intact', () => {
  const f = fixture(); f.hooks[5] = 'team';
  f.hooks[4].teamSkills = [{ ...shared, author: { ...shared.author, role: 'designer' } }, { ...shared, id: 'custom-role', author: { name: '张设计', role: '景观负责人' } }];
  f.hooks[4].sharing.identity.role = 'pm';
  const root = f.render();
  assert.match(textOf(root), /陈设计 · 项目设计师/);
  assert.match(textOf(root), /张设计 · 景观负责人/);
  assert.match(textOf(root), /当前分享身份：陈设计 · 项目经理/);
});

test('team settings show bridge and server restore failures with duplicate errors removed', () => {
  const f = fixture(); f.hooks[5] = 'team';
  f.hooks[4].sharing.error = '技能共享连接暂不可用';
  f.hooks[4].sharing.server.lastError = '端口被占用，请重新开启共享';
  f.hooks[4].sharing.remoteError = '技能共享连接暂不可用';
  const alerts = flatten(f.render()).filter(node => node.props.role === 'alert').map(textOf);
  assert.deepEqual(alerts, ['技能共享连接暂不可用', '端口被占用，请重新开启共享']);
});