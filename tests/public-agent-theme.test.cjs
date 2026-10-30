'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web-public/agent-mock.js'), 'utf8');
function boot(theme, { embedded = true, storageBlocked = false } = {}) {
  const listeners = new Map();
  const location = { href: 'https://aidesignhub.work/agent/', origin: 'https://aidesignhub.work', search: '' };
  const window = { location,
    localStorage: { getItem() { if (storageBlocked) throw new Error('storage blocked'); return theme; } },
    addEventListener: (name, callback) => listeners.set(name, callback) };
  window.parent = embedded ? { location, document: { documentElement: { dataset: { theme } } } } : window;
  const document = { readyState: 'loading', addEventListener() {} };
  vm.runInNewContext(source, { window, document, location, navigator: {}, URL, URLSearchParams, console });
  const rpc = window.__DSH_TRANSPORT__.rpc;
  return { window, rpc, send: event => listeners.get('message')(event),
    theme: async () => (await rpc.call('/api', 'settings/describe')).value.namespaces.find(item => item.ns === 'ui-theme') };
}

test('public Agent inherits the workspace palette, including direct entry and unavailable storage', async () => {
  for (const [theme, expected] of [['light', 'light'], ['dark', 'dark'], ['minimal', 'light']]) {
    assert.equal((await boot(theme).theme()).value.preference, expected);
    assert.equal((await boot(theme, { embedded: false }).theme()).value.preference, expected);
  }
  assert.equal((await boot('dark', { embedded: false, storageBlocked: true }).theme()).value.preference, 'light');
});

test('workspace theme changes invalidate the live settings stream and reject unrelated messages', async () => {
  const agent = boot('light');
  const abort = new AbortController();
  const events = agent.rpc.open('/api', '$events', {}, abort.signal);
  await events.next();
  const change = { source: agent.window.parent, origin: agent.window.location.origin,
    data: { type: 'adh-public-theme', theme: 'dark' } };
  for (const invalid of [{ ...change, source: {} }, { ...change, origin: 'https://example.test' },
    { ...change, data: { ...change.data, theme: 'system' } }]) agent.send(invalid);
  assert.equal((await agent.theme()).revision, 0);
  agent.send(change);
  assert.equal((await agent.theme()).value.preference, 'dark');
  assert.deepEqual(JSON.parse(JSON.stringify((await events.next()).value)), {
    type: 'emit', event: 'settings/document-updated', args: ['ui-theme', 1],
  });
  agent.send({ ...change, data: { ...change.data, theme: 'minimal' } });
  assert.equal((await agent.theme()).value.preference, 'light');
  assert.equal((await agent.theme()).revision, 2);
  assert.equal((await agent.rpc.call('/api', 'settings/mutate', { args: {
    ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: 'dark' }],
  } })).ok, false);
  abort.abort();
  await events.return();
});
