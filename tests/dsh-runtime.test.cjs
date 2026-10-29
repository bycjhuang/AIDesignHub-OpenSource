'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { DshRuntimeManager } = require('../backend/dsh-runtime.cjs');
const { readPatch } = require('../backend/dsh-profile-patch.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adh-harness-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new DshRuntimeManager({ userDataDir: root, cacheRoot: root,
    professionalMcpCacheRoot: root, pluginsSourceDir: path.resolve(__dirname, '../backend/dsh-plugins'),
    ensureSkillPolicyRuntime: () => ({ fixtureRuntime: true }),
    getModelStatus: () => ({ configured: true, provider: 'deepseek', baseUrl: 'https://example.invalid/v1', model: 'test: model #1' }),
    emit: () => {},
  });
  await fs.mkdir(manager.profileDir(), { recursive: true });
  const pkg = { dependencies: { 'personal-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'personal-plugin'], custom: true } } };
  await fs.writeFile(path.join(manager.profileDir(), 'package.json'), JSON.stringify(pkg));
  return manager;
}

test('profile upgrade retains user config and sessions, installs local bundles, and is idempotent', async t => {
  const manager = await fixture(t);
  const profile = manager.profileDir();
  const sessionFile = path.join(manager.dshHome(), 'sessions', 'personal.jsonl');
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, '{"title":"keep my conversation"}\n');
  const before = '- id: agent-default-model\n  config: { provider: personal, model: chosen, reasoning: high }\n- insert:\n  - id: personal-mcp\n    name: my-mcp\n    config: { command: my.exe }\n';
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), before);
  await manager.ensureProfile({ nodeExe: process.execPath });
  const pkg = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.profile.custom, true);
  assert.equal(pkg.dependencies['personal-plugin'], '1.0.0');
  assert.ok(pkg.dsh.profile.bundles.includes('personal-plugin'));
  assert.ok(pkg.dsh.profile.bundles.includes('@aidesign/dsh-tool-discovery'));
  assert.ok((await fs.stat(path.join(profile, 'node_modules/@aidesign/dsh-tool-discovery/index.js'))).isFile());
  const first = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
  const patch = readPatch(first);
  assert.equal(patch.find(item => item.id === 'agent-default-model').config.model, 'chosen');
  assert.equal(patch.find(item => item.id === 'llm-pi-ai').config.providers.adh.models[0].id, 'test: model #1');
  assert.equal(patch.find(item => item.insert).insert[0].config.command, 'my.exe');
  assert.equal(await fs.readFile(sessionFile, 'utf8'), '{"title":"keep my conversation"}\n');
  await manager.ensureProfile({ nodeExe: process.execPath });
  assert.equal(await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), first);
  const backups = (await fs.readdir(profile)).filter(name => name.startsWith('cordis.patch.yml.before-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(profile, backups[0]), 'utf8'), before);
});

test('invalid user YAML is preserved byte for byte without changing package metadata', async t => {
  const manager = await fixture(t);
  const file = path.join(manager.profileDir(), 'cordis.patch.yml');
  const packageFile = path.join(manager.profileDir(), 'package.json');
  const pkg = await fs.readFile(packageFile, 'utf8');
  await fs.writeFile(file, '- config: [');
  await assert.rejects(manager.ensureProfile({ nodeExe: process.execPath }));
  assert.equal(await fs.readFile(file, 'utf8'), '- config: [');
  assert.equal(await fs.readFile(packageFile, 'utf8'), pkg);
});

test('concurrent theme/model patch requests serialize and retain custom extensions', async t => {
  const manager = await fixture(t);
  const file = path.join(manager.profileDir(), 'cordis.patch.yml');
  await fs.writeFile(file, '- id: custom\n  config: { keep: true }\n');
  const writes = Array.from({ length: 5 }, () => manager.writeLlmPatch());
  manager.theme = 'dark';
  await Promise.all(writes);
  const patch = readPatch(await fs.readFile(file, 'utf8'));
  assert.equal(patch.find(item => item.id === 'custom').config.keep, true);
  assert.equal(patch.find(item => item.id === 'ui-theme').config.preference, 'dark');
});

test('ready probe requires authentication, HTML and the live brand plugin, rejects a 404', async t => {
  let pluginReady = false;
  const server = http.createServer((req, res) => {
    if (req.url.includes('?token=')) { res.writeHead(303, { 'Set-Cookie': 'session=ok; HttpOnly', Location: '/' }); res.end(); return; }
    if (req.headers.cookie !== 'session=ok') { res.writeHead(401); res.end(); return; }
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); return; }
    if (pluginReady) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('png'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const manager = await fixture(t);
  manager.authUrl = `http://127.0.0.1:${server.address().port}/?token=test`;
  await assert.rejects(manager.probeReady(1), /DSH_HOST_PROBE_TIMEOUT/);
  pluginReady = true;
  await manager.probeReady(1);
});
