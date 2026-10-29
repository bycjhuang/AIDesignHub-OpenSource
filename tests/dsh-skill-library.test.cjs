'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

const pluginDir = path.join(__dirname, '..', 'backend', 'dsh-plugins', 'adh-skill-library');
const plugin = import(pathToFileURL(path.join(pluginDir, 'index.js')).href);
const item = (name, overrides = {}) => ({ name, description: `用途 ${name}`, source: 'custom', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, ...overrides });

async function fixture(overrides = {}) {
  const routes = new Map();
  const listed = [], loaded = [];
  const skills = {
    async list(options) { listed.push(options); return overrides.items || [item('blender-modeling'), item('manual-only', { invocation: { modelInvocable: false, userInvocable: true } })]; },
    async get(name, options) { loaded.push({ name, options }); return { ...item(name), content: '# 原始说明\n<script>window.pwned = true</script>', ...overrides.definition }; },
  };
  const services = { ...overrides.services };
  const context = {
    skills,
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    get(name) { return services[name]; },
  };
  const desktopCalls = [];
  const desktop = overrides.desktop || (async (operation, args) => { desktopCalls.push({ operation, args }); return operation === 'catalog' ? { teamSkills: [], sharing: { server: { running: false }, remote: { connected: false }, identity: { id: 'designer', name: '测试设计师' } } } : { skill: args.skill }; });
  (await plugin).registerSkillLibrary(context, desktop);
  async function request(endpoint, query = '', body) {
    const route = routes.get(`/api/adh-skill-library/${endpoint}`);
    const response = await route.fetch(new Request(`http://127.0.0.1:9000${route.path}${query}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, headers: response.headers, payload: await response.json() };
  }
  return { routes, listed, loaded, skills, services, request, desktopCalls };
}

test('authenticated connection routes list real registry summaries without loading bodies', async () => {
  const f = await fixture();
  assert.equal(f.routes.get('/api/adh-skill-library/list').methods[0], 'GET');
  assert.equal(f.routes.get('/api/adh-skill-library/share').methods[0], 'POST');
  const r = await f.request('list');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.payload.context.label, '全局已启用技能');
  assert.equal(r.payload.skills[0].displayName, 'Blender 建模');
  assert.equal(r.payload.skills[1].modelInvocable, false);
  assert.equal(r.payload.skills[1].userInvocable, true);
  assert.equal(r.payload.skills[0].sourceLabel, '自定义目录');
  assert.equal(f.loaded.length, 0);
  assert.equal(f.listed.length, 1);
  assert.equal(f.listed[0].cwd, undefined);
  assert.equal('path' in r.payload.skills[0], false);
});

test('sharing resolves a fresh registered skill and never accepts caller content, paths or author identity', async () => {
  const f = await fixture();
  for (const body of [{ name: '../secrets' }, { name: 'blender-modeling', content: 'forged' }, { name: 'blender-modeling', author: { id: 'other' } }, { name: 'blender-modeling', path: 'C:/secret' }]) assert.equal((await f.request('share', '', body)).status, 400);
  assert.equal((await f.request('share', '', { name: 'missing' })).status, 404);
  const shared = await f.request('share', '', { name: 'blender-modeling' });
  assert.equal(shared.status, 200);
  assert.equal(f.desktopCalls.length, 1);
  assert.equal(f.desktopCalls[0].operation, 'share');
  assert.equal(f.desktopCalls[0].args.skill.content, '# 原始说明\n<script>window.pwned = true</script>');
  assert.equal(f.desktopCalls[0].args.skill.id, 'blender-modeling');
  assert.equal(Object.hasOwn(f.desktopCalls[0].args.skill, 'author'), false);
});

test('shared catalog marks only this designer local shares and leaves local skills available when desktop bridge fails', async () => {
  const f = await fixture({ desktop: async () => ({ teamSkills: [{ id: 'shared-1', skillId: 'blender-modeling', origin: 'local', author: { id: 'designer' } }], sharing: { identity: { id: 'designer' } } }) });
  assert.equal((await f.request('list')).payload.skills[0].sharedId, 'shared-1');
  const down = await fixture({ desktop: async () => { throw new Error('private path'); } });
  const result = await down.request('list');
  assert.equal(result.status, 200);
  assert.equal(result.payload.skills.length, 2);
  assert.ok(result.payload.sharing.error);
  assert.doesNotMatch(JSON.stringify(result.payload), /private path/);
});

test('desktop skill bridge enforces a fixed loopback endpoint and keeps its credential in Host requests', async () => {
  const { createDesktopBridge } = await plugin;
  const calls = [], token = 'a'.repeat(64);
  const bridge = createDesktopBridge({ ADH_WORKBENCH_ENDPOINT: 'http://127.0.0.1:12345/adh-workbench', ADH_WORKBENCH_TOKEN: token }, async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, sharing: {} }); });
  const result = await bridge('catalog');
  assert.equal(result.ok, true);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'skill_library_catalog', caller: 'skill-library-ui', arguments: {} });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  const unsafe = createDesktopBridge({ ADH_WORKBENCH_ENDPOINT: 'http://192.168.1.2:12345/adh-workbench', ADH_WORKBENCH_TOKEN: token }, () => { throw new Error('must not fetch'); });
  await assert.rejects(unsafe('catalog'), /连接无效/);
});

test('disabled invocation policies remain visible without claiming model availability', async () => {
  const f = await fixture({ items: [item('disabled', { invocation: { modelInvocable: false, userInvocable: false } }), item('unclassified', { invocation: undefined })] });
  const r = await f.request('list');
  assert.ok(r.payload.skills.every(skill => skill.status === 'disabled' && !skill.modelInvocable && !skill.userInvocable));
});

test('detail rechecks catalog membership, never accepts filesystem selectors, and returns provider text verbatim', async () => {
  const f = await fixture();
  for (const query of ['?name=../secrets', '?name=blender-modeling&path=C:/secret', '?name=blender-modeling&cwd=C:/secret', '?name=blender-modeling&name=manual-only']) {
    assert.equal((await f.request('body', query)).status, 400);
  }
  assert.equal((await f.request('body', '?name=unregistered')).status, 404);
  assert.equal(f.loaded.length, 0);
  const r = await f.request('body', '?name=blender-modeling');
  assert.equal(r.status, 200);
  assert.equal(r.payload.skill.content, '# 原始说明\n<script>window.pwned = true</script>');
  assert.equal(f.loaded[0].name, 'blender-modeling');
});

test('trusted current Session supplies cwd and exact live Agent scope instead of a request path', async () => {
  let disposed = 0;
  const live = { id: 'session-1' };
  const f = await fixture({ services: {
    sessionQuery: { async observeSession(id) {
      assert.equal(id, 'session-1');
      return { header: { cwd: 'D:/old' }, projections: { values: { workingDirectory: 'D:/actual-project' } }, [Symbol.dispose]() { disposed++; } };
    } },
    agents: { get: id => id === 'session-1' ? live : undefined },
  } });
  const r = await f.request('list', '?sessionId=session-1');
  assert.equal(r.status, 200);
  assert.equal(r.payload.context.label, '当前对话可用技能');
  assert.equal(f.listed[0].cwd, 'D:/actual-project');
  assert.equal(f.listed[0].scope, live);
  assert.equal(disposed, 1);
  assert.equal((await f.request('list', '?sessionId=../secrets')).status, 400);
});

test('cold Session uses its standing preset scope and releases it after listing or failure', async () => {
  let released = 0;
  const scope = {};
  const f = await fixture({ services: {
    sessionQuery: { async observeSession() { return { header: { cwd: 'D:/project', agentPreset: 'designer' }, [Symbol.dispose]() {} }; } },
    agentPresets: { async acquireScope(preset) { assert.equal(preset, 'designer'); return { key: scope, async [Symbol.asyncDispose]() { released++; } }; } },
  } });
  assert.equal((await f.request('list', '?sessionId=cold')).status, 200);
  assert.equal(f.listed[0].scope, scope);
  assert.equal(released, 1);
  f.skills.list = async () => { throw new Error('private path and credentials must not leak'); };
  const failed = await f.request('list', '?sessionId=cold');
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.payload), /private path|credentials/);
  assert.equal(released, 2);
});

test('removed and oversized skill definitions fail safely without returning stale instructions', async () => {
  const f = await fixture({ definition: { content: '文'.repeat(200000) } });
  assert.equal((await f.request('body', '?name=blender-modeling')).status, 413);
  f.skills.get = async () => undefined;
  assert.equal((await f.request('body', '?name=blender-modeling')).status, 404);
  const noSession = await f.request('list', '?sessionId=unknown');
  assert.equal(noSession.status, 503);
});

test('client registers an additive sidebar panel and renders instruction content as text', async () => {
  const source = await readFile(path.join(pluginDir, 'client.js'), 'utf8');
  let definition;
  const factorySandbox = { window: { __ModuleLoader__: { load: value => { definition = value; } } } };
  vm.runInNewContext(source, factorySandbox, { filename: 'adh-skill-library/client.js' });
  let useStateOverride;
  const components = new Map();
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useEffect() {}, useMemo(fn) { return fn(); }, useRef() { return { current: null }; },
    useState(initial) { return [useStateOverride ?? (typeof initial === 'function' ? initial() : initial), () => {}]; },
  };
  const instance = definition.factory(name => { assert.equal(name, 'react'); return React; });
  instance.apply({
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } }, get() {},
    slots: { inject(_slot, register) { register(); }, register(entry, component) { components.set(entry.name, { entry, component }); } },
  });
  assert.equal(components.get('sidebar.panellist').entry.label(), '技能中心');
  assert.equal(components.get('main').entry.key, 'adh-skills');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML\s*=/);
  useStateOverride = { skills: [], context: { label: '<img src=x onerror=alert(1)>' } };
  // Text is carried as React children, never inserted as markup. The actual
  // browser owns escaping even when a provider supplies HTML-looking prose.
  assert.match(source, /h\('pre', null, full\.content\)/);
});
