'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { TeamSkillLibrary, DEFAULT_PORT, MAX_CONTENT_BYTES, connectionUrl } = require('../backend/team-skill-library.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-team-skills-'));
  let identity = { id: 'designer-chen', name: '陈设计', role: 'designer' };
  const libraries = [];
  const factory = extra => { const instance = new TeamSkillLibrary({ dataDir: directory, getIdentity: () => identity, ...options, ...extra }); libraries.push(instance); return instance; };
  const library = factory();
  t.after(async () => { for (const instance of libraries) await instance.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { library, factory, directory, setIdentity: value => { identity = value; } };
}
const skill = extra => ({ id: 'rhino-method', displayName: 'Rhino 建模方法', description: '场地地形建模复核方法',
  layer: 'modeling', content: '# 场地地形\n先复核设计基准高程，再核对闭合曲线。', ...extra });

test('shares persist as metadata and instruction snapshots; repeated own shares update with stable identity', t => {
  const f = fixture(t), shared = f.library.share({ skill: skill({ path: 'C:/private/secrets', privateKey: 'never-copy' }), author: { id: 'imposter' } });
  assert.equal(shared.skillId, 'rhino-method'); assert.equal(shared.author.name, '陈设计'); assert.equal(shared.canUnshare, true);
  assert.equal(shared.content, undefined); assert.equal(shared.path, undefined); assert.equal(shared.privateKey, undefined);
  assert.equal(f.library.status().server.running, false); assert.equal(f.library.status().server.port, DEFAULT_PORT);
  const content = '# 更新方法\n核对高程并记录复核人。';
  const updated = f.library.share({ skill: skill({ content }) });
  assert.equal(updated.id, shared.id); assert.equal(updated.sharedAt, shared.sharedAt); assert.equal(f.library.list().length, 1);
  const reopened = f.factory(); assert.equal(reopened.get(shared.id).content, content);
  assert.equal(reopened.get(shared.id).author.id, 'designer-chen');
  assert(!fs.readFileSync(reopened.libraryFile, 'utf8').includes('C:/private/secrets'));
});

test('each designer owns their own share and cannot remove another designer share', t => {
  const f = fixture(t), chen = f.library.share({ skill: skill() });
  f.setIdentity({ id: 'designer-lin', name: '林设计', role: 'architect' });
  assert.equal(f.library.list()[0].canUnshare, false);
  assert.throws(() => f.library.unshare(chen.id), /只有分享者/);
  const lin = f.library.share({ skill: skill({ content: '林设计的方法。' }) });
  assert.notEqual(lin.id, chen.id); assert.equal(lin.author.name, '林设计');
  f.library.unshare(lin.id); assert.equal(f.library.list().length, 1);
  f.setIdentity({ id: 'designer-chen', name: '陈设计', role: 'designer' });
  f.library.unshare(chen.id); assert.deepEqual(f.library.list(), []);
  assert.throws(() => f.library.get(chen.id), /已取消分享/);
});

test('skill IDs, size and recognizable secrets are checked; caller paths and author fields are never used', t => {
  const f = fixture(t);
  assert.throws(() => f.library.share({ skill: skill({ id: '../private' }) }), /名称无效/);
  assert.throws(() => f.library.share({ skill: skill({ content: '' }) }), /为空/);
  assert.throws(() => f.library.share({ skill: skill({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }) }), /512 KB/);
  assert.throws(() => f.library.share({ skill: skill({ content: '-----BEGIN PRIVATE KEY-----\nprivate material' }) }), /疑似密钥/);
  assert.throws(() => f.library.share({ skill: skill({ content: 'api_key = abcdefghijklmnopqrstuvwxyz1234' }) }), /疑似密钥/);
  assert.throws(() => f.library.get('../connection-private.json'), /标识无效/);
  assert.equal(f.library.list().length, 0);
});

test('separate native clients read shared snapshots over HTTP and see updates and cancellations without local data', async t => {
  const host = fixture(t), client = fixture(t);
  const own = host.library.share({ skill: skill() });
  const status = await host.library.start({ host: '127.0.0.1', port: 0 });
  await client.library.connect({ url: status.server.urls[0], token: status.server.token });
  assert.equal(client.library.status().remote.connected, true);
  let remote = await client.library.listRemote();
  assert.equal(remote.length, 1); assert.equal(remote[0].id, own.id); assert.equal(remote[0].canUnshare, false);
  assert.equal(remote[0].author.name, '陈设计'); assert.equal(remote[0].content, undefined);
  assert.equal((await client.library.getRemote(own.id)).content, skill().content);
  assert.deepEqual(client.library.list(), []);
  host.library.share({ skill: skill({ content: '新版已核验说明。' }) });
  assert.equal((await client.library.getRemote(own.id)).content, '新版已核验说明。');
  host.library.unshare(own.id); remote = await client.library.listRemote(); assert.deepEqual(remote, []);
  await assert.rejects(client.library.getRemote(own.id), /暂不可读取/);
});

test('LAN server exposes no project, mutation, browser-origin, path or secret access', async t => {
  const f = fixture(t), shared = f.library.share({ skill: skill() });
  const status = await f.library.start({ host: '127.0.0.1', port: 0 }), url = status.server.urls[0];
  const headers = { authorization: 'Bearer ' + status.server.token };
  assert.equal((await fetch(url + '/api/team-skills')).status, 401);
  assert.equal((await fetch(url + '/api/team-skills', { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  assert.equal((await fetch(url + '/api/team-skills', { headers: { ...headers, origin: 'http://malicious.example' } })).status, 403);
  assert.equal((await fetch(url + '/api/team-skills', { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await fetch(url + '/api/bootstrap', { headers })).status, 404);
  assert.equal((await fetch(url + '/api/team-skills?path=connection-private.json', { headers })).status, 400);
  assert.equal((await fetch(url + '/api/team-skills/connection-private.json', { headers })).status, 404);
  const list = await (await fetch(url + '/api/team-skills', { headers })).text();
  assert(!list.includes(status.server.token)); assert(!list.includes(f.directory)); assert(!list.includes('connection-private'));
  const body = await (await fetch(url + '/api/team-skills/' + shared.id, { headers })).json();
  assert.equal(body.data.content, skill().content); assert.equal(body.data.canUnshare, false);
});

test('connections reject public addresses, redirects, wrong tokens and unsupported services; failures preserve prior connection', async t => {
  const f = fixture(t), host = fixture(t), status = await host.library.start({ host: '127.0.0.1', port: 0 });
  for (const url of ['https://192.168.1.8:47831', 'http://8.8.8.8:80', 'http://example.org', 'http://192.168.1.8/private', 'http://user:pass@192.168.1.8']) {
    assert.throws(() => connectionUrl(url), /仅支持/);
  }
  assert.equal(connectionUrl('http://192.168.1.8:47831'), 'http://192.168.1.8:47831');
  await f.library.connect({ url: status.server.urls[0], token: status.server.token });
  await assert.rejects(f.library.connect({ url: status.server.urls[0], token: 'invalid-invalid-token' }), /连接码无效/);
  assert.equal(f.library.status().remote.url, status.server.urls[0]);
  const redirect = http.createServer((request, response) => { response.writeHead(302, { location: 'http://8.8.8.8/' }); response.end(); });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => redirect.close(resolve)));
  await assert.rejects(f.library.connect({ url: 'http://127.0.0.1:' + redirect.address().port, token: status.server.token }), /无法连接/);
});

test('encrypted connection state survives restart, shutdown preserves opt-in, explicit stop disables restore', async t => {
  const protectSecret = value => Buffer.from('protected:' + value).toString('base64');
  const unprotectSecret = value => Buffer.from(value, 'base64').toString().slice(10);
  const f = fixture(t, { protectSecret, unprotectSecret }), host = fixture(t);
  const status = await f.library.start({ host: '127.0.0.1', port: 0 }), remoteStatus = await host.library.start({ host: '127.0.0.1', port: 0 });
  await f.library.connect({ url: remoteStatus.server.urls[0], token: remoteStatus.server.token });
  const state = fs.readFileSync(f.library.configFile, 'utf8');
  assert(!state.includes(status.server.token)); assert(!state.includes(remoteStatus.server.token));
  await f.library.stop({ preserveEnabled: true });
  const reopened = f.factory();
  await reopened.restore();
  assert.equal(reopened.status().server.running, true); assert.equal(reopened.status().server.port, status.server.port);
  assert.equal(reopened.status().server.token, status.server.token); assert.equal(reopened.status().remote.connected, true);
  assert.deepEqual(await reopened.listRemote(), []);
  reopened.disconnect(); assert.equal(reopened.status().remote.connected, false);
  await reopened.stop();
  const disabled = f.factory(); await disabled.restore(); assert.equal(disabled.status().server.running, false);
});

test('offline remote is reported and occupied restore port keeps project startup recoverable', async t => {
  const client = fixture(t), host = fixture(t);
  const status = await host.library.start({ host: '127.0.0.1', port: 0 });
  await client.library.connect({ url: status.server.urls[0], token: status.server.token });
  await host.library.stop({ preserveEnabled: true });
  await assert.rejects(client.library.listRemote(), /无法连接/);
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(status.server.port, '0.0.0.0', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const reopened = host.factory();
  await assert.rejects(reopened.restore(), /端口.*已被占用/);
  assert.equal(reopened.status().server.running, false); assert.match(reopened.status().server.lastError, /已被占用/);
  assert.deepEqual(reopened.list(), []);
});



test('remote reading counts decoded instruction limit separately from JSON escaping', async t => {
  const host = fixture(t), client = fixture(t);
  const escaped = '\n"\\\u0000'.repeat(120000);
  assert(Buffer.byteLength(escaped) < MAX_CONTENT_BYTES);
  const shared = host.library.share({ skill: skill({ content: escaped }) });
  const status = await host.library.start({ host: '127.0.0.1', port: 0 });
  await client.library.connect({ url: status.server.urls[0], token: status.server.token });
  assert.equal((await client.library.getRemote(shared.id)).content, escaped);
});

test('concurrent start shares a single listener and shutdown waits for startup', async t => {
  const f = fixture(t);
  const statuses = await Promise.all([f.library.start({ host: '127.0.0.1', port: 0 }), f.library.start({ host: '127.0.0.1', port: 0 })]);
  assert.equal(statuses[0].server.port, statuses[1].server.port); assert.equal(f.library.status().server.running, true);
  await f.library.stop();
  await Promise.all([f.library.start({ host: '127.0.0.1', port: 0 }), f.library.stop()]);
  assert.equal(f.library.status().server.running, false);
});

