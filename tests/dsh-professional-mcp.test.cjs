'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { mkdtemp, mkdir, writeFile, readFile, stat, rm } = require('node:fs/promises');
const { SOFTWARE, PROFESSIONAL_MCP_IDS, ensureProfessionalMcp, buildProfessionalMcpEntries, patchLightroomStartup } = require('../backend/dsh-professional-mcp.cjs');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-professional-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'offline source');
  const cacheRoot = path.join(root, 'cache');
  const appData = path.join(root, 'appdata');
  async function put(relative, text = 'offline fixture') {
    const file = path.join(sourceDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  await put('python/python.exe');
  for (const item of SOFTWARE) await put(path.join('servers', item.entry), item.key === 'lightroom'
    ? 'if (cli.command === "install-plugin") runInstallPlugin();\n  ensurePluginInstalled(here, (m) => console.error(m));\nstartStdio();\n' : item.key);
  await put('servers/rhino/NOTICE.txt', 'preserved third-party notice');
  const nodeExe = path.join(root, 'node.exe');
  await writeFile(nodeExe, 'fixture');
  return { root, sourceDir, cacheRoot, appData, nodeExe, put };
}

test('offline payload stages all 14 native interfaces and retains notices with verified inventory', async t => {
  const f = await fixture(t);
  await f.put('.env', 'must not copy');
  await f.put('servers/logs/private.log', 'must not copy');
  await f.put('servers/rhino/__pycache__/private.pyc', 'must not copy');
  const result = await ensureProfessionalMcp(f);
  assert.equal(result.ready, true);
  assert.equal(result.manifest.files, 17);
  assert.match(result.manifest.sha256, /^[a-f0-9]{64}$/);
  const files = JSON.parse(await readFile(path.join(result.payloadRoot, 'payload-files.json'), 'utf8'));
  assert.equal(files.length, 17);
  assert.ok(files.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(await readFile(path.join(result.payloadRoot, 'servers/rhino/NOTICE.txt'), 'utf8'), 'preserved third-party notice');
  assert.equal(existsSync(path.join(result.payloadRoot, '.env')), false);
  assert.equal(existsSync(path.join(result.payloadRoot, 'servers/logs')), false);
  assert.equal(existsSync(path.join(result.payloadRoot, 'servers/rhino/__pycache__')), false);
  const entries = buildProfessionalMcpEntries({ ...f, payloadRoot: result.payloadRoot });
  assert.equal(entries.length, 14);
  assert.equal(new Set(entries.map(item => item.config.serverName)).size, 14);
  assert.ok(entries.every(item => PROFESSIONAL_MCP_IDS.includes(item.id) && item.config.failOnStartupError === false));
  assert.ok(entries.every(item => item.config.args[0].startsWith(result.payloadRoot)));
  assert.equal(entries.find(item => item.config.serverName === 'sketchup').config.env.SKETCHUP_MCP_PORT, '9877');
  assert.equal(entries.find(item => item.config.serverName === 'indesign').config.env.COM_BRIDGE_ENABLED, 'true');
  assert.equal(entries.find(item => item.config.serverName === 'blender').config.env.BLENDER_MCP_DISABLE_TELEMETRY, '1');
  assert.ok(entries.find(item => item.config.serverName === 'lightroom').config.args[0].endsWith('adh-stdio.mjs'));
  assert.equal(result.manifest.patches[0].id, 'lightroom-explicit-install-v1');
});

test('normal startup uses the self-contained installed copy without re-reading or copying its original source', async t => {
  const f = await fixture(t);
  const staged = await ensureProfessionalMcp(f);
  const marker = path.join(staged.payloadRoot, 'servers/rhino/NOTICE.txt');
  const before = (await stat(marker)).mtimeMs;
  await rm(f.sourceDir, { recursive: true, force: true });
  const resumed = await ensureProfessionalMcp({ cacheRoot: f.cacheRoot });
  assert.equal(resumed.ready, true);
  assert.equal((await stat(marker)).mtimeMs, before);
  assert.equal(buildProfessionalMcpEntries({ ...f, payloadRoot: resumed.payloadRoot }).length, 14);
});

test('incomplete source fails before replacing an existing installation; explicit refresh keeps the former payload', async t => {
  const f = await fixture(t);
  const staged = await ensureProfessionalMcp(f);
  await rm(path.join(f.sourceDir, 'servers/blender/launcher.py'));
  await assert.rejects(ensureProfessionalMcp(f), /SOURCE_INCOMPLETE/);
  assert.equal((await ensureProfessionalMcp({ cacheRoot: f.cacheRoot })).manifest.sha256, staged.manifest.sha256);
  await f.put('servers/blender/launcher.py', 'updated blender');
  const refreshed = await ensureProfessionalMcp(f);
  assert.equal(refreshed.ready, true);
  assert.notEqual(refreshed.manifest.sha256, staged.manifest.sha256);
  assert.ok(existsSync(refreshed.previousPayloadRoot));
  assert.equal(await readFile(path.join(refreshed.previousPayloadRoot, 'servers/blender/launcher.py'), 'utf8'), 'blender');
});

test('missing resources are omitted per software while an installed Rhino official router works independently', async t => {
  const f = await fixture(t);
  const staged = await ensureProfessionalMcp(f);
  await rm(path.join(staged.payloadRoot, 'servers/illustrator/dist/index.js'));
  const partial = buildProfessionalMcpEntries({ ...f, payloadRoot: staged.payloadRoot });
  assert.equal(partial.length, 13);
  assert.ok(!partial.some(item => item.config.serverName === 'illustrator'));
  const router = path.join(f.appData, 'McNeel/Rhinoceros/packages/8.0/fixture/1.0/rhino-mcp-router.exe');
  await mkdir(path.dirname(router), { recursive: true });
  await writeFile(router, 'fixture');
  const independent = buildProfessionalMcpEntries({ appData: f.appData });
  assert.deepEqual(independent.map(item => item.config.serverName), ['rhino-official']);
  assert.deepEqual(independent[0].config.args, ['--default-version', '8']);
});

test('staging rejects a nested source/destination rather than recursively copying the destination', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureProfessionalMcp({ cacheRoot: path.join(f.sourceDir, 'nested'), sourceDir: f.sourceDir }), /INVALID_SOURCE/);
});

test('Lightroom startup patch preserves explicit installation and rejects changed upstream bundles', () => {
  const source = '#!/usr/bin/env node\nif (cli.command === "install-plugin") runInstallPlugin();\n  ensurePluginInstalled(here, (m) => console.error(m));\nstartStdio();';
  const patched = patchLightroomStartup(source);
  assert.ok(patched.includes('if (cli.command === "install-plugin") runInstallPlugin();'));
  assert.ok(patched.includes('startStdio();'));
  assert.ok(patched.startsWith('#!/usr/bin/env node\n'));
  assert.ok(!patched.includes('ensurePluginInstalled(here'));
  assert.throws(() => patchLightroomStartup('unexpected updated upstream'), /PATCH_UNSUPPORTED/);
  assert.throws(() => patchLightroomStartup(source + source), /PATCH_UNSUPPORTED/);
});
