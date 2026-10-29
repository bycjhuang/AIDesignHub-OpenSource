'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DSH_RUNTIME_PINS: pins, dshRuntimePaths, readDshRuntimeManifest, isDshRuntimeReady, ensureDshRuntime } = require('../backend/dsh-provisioner.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-runtime-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^adh-runtime-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const paths = dshRuntimePaths(root);
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const pkg = (name, data) => put(path.join(paths.root, 'package', 'node_modules', name, 'package.json'), JSON.stringify(data));
  const manifest = { schema: 1, ...pins, nodeArchiveSha256: 'a'.repeat(64), installedAt: '2026-10-26T00:00:00.000Z' };
  put(paths.manifest, JSON.stringify(manifest));
  for (const file of [paths.nodeExe, paths.npmCli, paths.dshCli, paths.pnpmCli]) put(file, 'fixture');
  const core = ['dsh-base', 'dsh-agent-loop', 'dsh-llm-pi-ai', 'dsh-web-app'];
  pkg('@deepseek-ai/dsh', { version: pins.dshVersion,
    dependencies: Object.fromEntries(core.map(name => [`@deepseek-ai/${name}`, pins.dshVersion])) });
  for (const name of core) pkg(`@deepseek-ai/${name}`, { version: pins.dshVersion });
  pkg('@earendil-works/pi-ai', { version: pins.piAiVersion });
  pkg('pnpm', { version: pins.pnpmVersion });
  return { root, paths, put, pkg, manifest };
}

test('a complete matching runtime is reused without network or touching its files', async t => {
  const f = fixture(t);
  assert.equal(isDshRuntimeReady(f.paths), true);
  const before = fs.readFileSync(f.paths.manifest, 'utf8');
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('must not use network'); };
  try {
    const result = await ensureDshRuntime({ cacheRoot: f.root });
    assert.deepEqual(result.paths, f.paths);
    assert.equal(result.manifest.dshVersion, pins.dshVersion);
    assert.equal(fs.readFileSync(f.paths.manifest, 'utf8'), before);
  } finally { global.fetch = originalFetch; }
});

test('readiness rejects missing, mixed-version or floating adapter package trees', t => {
  const f = fixture(t);
  f.pkg('@earendil-works/pi-ai', { version: '1.2.0' });
  assert.equal(isDshRuntimeReady(f.paths), false);
  f.pkg('@earendil-works/pi-ai', { version: pins.piAiVersion });
  f.pkg('@deepseek-ai/dsh-agent-loop', { version: '0.2.0-rc.2' });
  assert.equal(isDshRuntimeReady(f.paths), false);
  f.pkg('@deepseek-ai/dsh-agent-loop', { version: pins.dshVersion });
  fs.unlinkSync(path.join(f.paths.root, 'package/node_modules/@deepseek-ai/dsh-web-app/package.json'));
  assert.equal(isDshRuntimeReady(f.paths), false);
});

test('a legacy or corrupt manifest cannot make a runtime ready', t => {
  const f = fixture(t);
  const legacy = { ...f.manifest }; delete legacy.piAiVersion;
  f.put(f.paths.manifest, JSON.stringify(legacy));
  assert.equal(readDshRuntimeManifest(f.paths), null);
  f.put(f.paths.manifest, 'not json');
  assert.equal(isDshRuntimeReady(f.paths), false);
});

test('failed installation keeps the existing runtime and removes only its new staging directory', async t => {
  const f = fixture(t);
  f.put(f.paths.manifest, JSON.stringify({ ...f.manifest, nodeVersion: '22.0.0' }));
  const oldManifest = fs.readFileSync(f.paths.manifest, 'utf8');
  const previous = dshRuntimePaths(f.root, { ...pins, dshVersion: '0.2.0-rc.2' });
  f.put(path.join(previous.root, 'keep.txt'), 'previous version');
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline fixture'); };
  try {
    await assert.rejects(ensureDshRuntime({ cacheRoot: f.root }), /offline fixture/);
  } finally { global.fetch = originalFetch; }
  assert.equal(fs.readFileSync(f.paths.manifest, 'utf8'), oldManifest);
  assert.equal(fs.readFileSync(previous.root + '/keep.txt', 'utf8'), 'previous version');
  assert.deepEqual(fs.readdirSync(path.dirname(f.paths.root)).sort(), ['0.2.0-rc.2', pins.dshVersion].sort());
});
