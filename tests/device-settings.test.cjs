'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModelService } = require('../backend/model-service.cjs');
const { resolveDeviceSettings } = require('../backend/device-settings.cjs');

const FIXTURE_KEY = 'sk-device-settings-synthetic-test-key';
const CONFIG = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: FIXTURE_KEY };
const modelFile = directory => path.join(directory, 'model-private', 'model-config.enc');
function vault() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]), cipher.getAuthTag()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), { authTagLength: 16 }); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-device-fixture-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('aidesignhub-device-fixture-')); fs.rmSync(root, { recursive: true, force: true }); });
  const secretStore = vault(); const userDataDir = path.join(root, 'real-user-data');
  const normal = path.join(userDataDir, 'design-workbench-v1'); const demo = path.join(userDataDir, 'demo-company-v1');
  const model = dataDir => new ModelService({ dataDir, secretStore, fetchImpl: () => { throw new Error('Network must not run'); } });
  const resolve = (options = {}) => resolveDeviceSettings({ userDataDir, backendDataDir: demo, env: {}, secretStore, ...options });
  return { root, userDataDir, normal, demo, secretStore, model, resolve };
}

test('empty install has one device location for normal and demo without creating credentials or business files', t => {
  const f = fixture(t); const demo = f.resolve(); const normal = f.resolve({ backendDataDir: f.normal });
  assert.equal(demo.dataDir, path.join(f.userDataDir, 'device-settings-v1')); assert.equal(normal.dataDir, demo.dataDir);
  assert.equal(demo.scope, 'device'); assert.equal(demo.isolated, false); assert.equal(demo.migration.status, 'not_configured');
  assert.equal(fs.existsSync(f.userDataDir), false);
});

test('one legacy configuration migrates encrypted bytes and leaves project source untouched', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG); const before = fs.readFileSync(modelFile(f.normal));
  const business = path.join(f.normal, 'store.json'); fs.writeFileSync(business, '{"projects":[{"id":"private-project"}]}');
  const result = f.resolve(); const after = fs.readFileSync(modelFile(result.dataDir));
  assert.equal(result.migration.status, 'migrated'); assert.ok(before.equals(after)); assert.ok(before.equals(fs.readFileSync(modelFile(f.normal))));
  assert.equal(fs.readFileSync(business, 'utf8'), '{"projects":[{"id":"private-project"}]}');
  assert.equal(f.model(result.dataDir).status().configured, true); assert.ok(!JSON.stringify(result).includes(FIXTURE_KEY));
  assert.ok(!after.includes(Buffer.from(FIXTURE_KEY))); assert.equal(fs.existsSync(path.join(result.dataDir, 'store.json')), false);
  assert.equal(f.resolve().migration.status, 'existing');
});

test('identical encrypted legacy blobs can migrate; differing valid configurations require selection', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG); fs.mkdirSync(path.dirname(modelFile(f.demo)), { recursive: true });
  fs.copyFileSync(modelFile(f.normal), modelFile(f.demo));
  assert.equal(f.resolve().migration.status, 'migrated');
  const g = fixture(t); g.model(g.normal).save(CONFIG); g.model(g.demo).save({ ...CONFIG, model: 'another-model' });
  const result = g.resolve(); assert.equal(result.migration.status, 'needs_selection'); assert.equal(result.migration.needsSelection, true);
  assert.equal(result.migration.sourceCount, 2); assert.equal(fs.existsSync(modelFile(result.dataDir)), false);
});

test('existing device configuration wins and is never replaced by legacy settings', t => {
  const f = fixture(t); const device = f.resolve().dataDir; f.model(device).save({ ...CONFIG, model: 'device-model' });
  f.model(f.normal).save(CONFIG); const before = fs.readFileSync(modelFile(device));
  assert.equal(f.resolve().migration.status, 'existing'); assert.ok(before.equals(fs.readFileSync(modelFile(device))));
  assert.equal(f.model(device).status().model, 'device-model');
});

test('explicitly cleared device key is not resurrected from a configured legacy store', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG); const device = f.resolve().dataDir;
  f.model(device).save({ ...CONFIG, apiKey: '', clearApiKey: true }); const before = fs.readFileSync(modelFile(device));
  assert.equal(f.resolve().migration.status, 'existing_unconfigured'); assert.equal(f.model(device).status().configured, false);
  assert.ok(before.equals(fs.readFileSync(modelFile(device))));
});

test('corrupt source and destination are reported, never treated as migrated or overwritten', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(modelFile(f.normal)), { recursive: true }); fs.writeFileSync(modelFile(f.normal), 'corrupt-fixture');
  const result = f.resolve(); assert.equal(result.migration.status, 'invalid_source'); assert.equal(fs.existsSync(modelFile(result.dataDir)), false);
  f.model(f.demo).save(CONFIG); fs.mkdirSync(path.dirname(modelFile(result.dataDir)), { recursive: true }); fs.writeFileSync(modelFile(result.dataDir), 'corrupt-destination');
  assert.equal(f.resolve().migration.status, 'invalid_target'); assert.equal(fs.readFileSync(modelFile(result.dataDir), 'utf8'), 'corrupt-destination');
});

test('one valid source can migrate when a second legacy source is corrupt, with the skipped source disclosed', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG); fs.mkdirSync(path.dirname(modelFile(f.demo)), { recursive: true }); fs.writeFileSync(modelFile(f.demo), 'corrupt-fixture');
  const result = f.resolve(); assert.equal(result.migration.status, 'migrated'); assert.equal(result.migration.invalidSourceCount, 1);
  assert.deepEqual(result.migration.migratedFrom, ['原项目工作区']); assert.equal(fs.readFileSync(modelFile(f.demo), 'utf8'), 'corrupt-fixture');
  assert.ok(fs.readFileSync(modelFile(result.dataDir)).equals(fs.readFileSync(modelFile(f.normal))));
});

test('a legacy blob from another encryption identity is not accepted as usable configuration', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG); const result = f.resolve({ secretStore: vault() });
  assert.equal(result.migration.status, 'invalid_source'); assert.equal(result.migration.errorCode, 'MODEL_CONFIG_UNREADABLE');
  assert.equal(fs.existsSync(modelFile(result.dataDir)), false);
});

test('unavailable operating-system encryption is not a successful migration', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG);
  const result = f.resolve({ secretStore: { isEncryptionAvailable: () => false } });
  assert.equal(result.migration.status, 'unavailable'); assert.equal(result.migration.errorCode, 'MODEL_ENCRYPTION_UNAVAILABLE');
  assert.equal(fs.existsSync(modelFile(result.dataDir)), false);
});

test('explicit data-root override never reads or copies real-user settings', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG); const isolated = path.join(f.root, 'isolated-run');
  const result = f.resolve({ backendDataDir: path.join(isolated, 'demo-company-v1'), env: { AIDESIGNHUB_DATA_DIR: isolated } });
  assert.equal(result.isolated, true); assert.equal(result.dataDir, path.join(isolated, 'device-settings-v1')); assert.equal(result.migration.status, 'not_configured');
  f.model(isolated).save({ ...CONFIG, model: 'isolated-model' });
  const migrated = f.resolve({ backendDataDir: isolated, env: { AIDESIGNHUB_DATA_DIR: isolated } });
  assert.equal(migrated.migration.status, 'migrated'); assert.equal(f.model(migrated.dataDir).status().model, 'isolated-model');
  assert.equal(fs.existsSync(path.join(f.userDataDir, 'device-settings-v1')), false);
});

test('smoke and injected backend-only test roots do not inspect real-user settings', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG);
  for (const options of [{ smoke: true }, { env: { BYCJ_WORKBENCH_SMOKE: '1' } }, {}]) {
    const isolated = path.join(f.root, `test-${crypto.randomUUID()}`);
    const result = f.resolve({ backendDataDir: isolated, ...options });
    assert.equal(result.isolated, true); assert.equal(result.dataDir, path.join(isolated, 'device-settings-v1')); assert.equal(result.migration.status, 'not_configured');
  }
});

test('legacy grants and verified runtime configurations are not migrated with the model', t => {
  const f = fixture(t); f.model(f.normal).save(CONFIG);
  fs.writeFileSync(path.join(f.normal, 'agent-access.json'), '{"grants":["synthetic"]}');
  fs.writeFileSync(path.join(f.normal, 'store.json'), '{"agentHub":{"connections":[{"verifiedAt":123}]}}');
  const result = f.resolve(); assert.deepEqual(fs.readdirSync(result.dataDir), ['model-private']);
  assert.ok(!JSON.stringify(result).includes('verifiedAt')); assert.ok(!JSON.stringify(result).includes('grants'));
});

test('oversize legacy configuration is rejected without attempting to decode', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(modelFile(f.normal)), { recursive: true }); fs.writeFileSync(modelFile(f.normal), Buffer.alloc(65537));
  let calls = 0; const result = f.resolve({ secretStore: { isEncryptionAvailable: () => true, decryptString: () => { calls++; }, encryptString: () => {} } });
  assert.equal(result.migration.status, 'invalid_source'); assert.equal(calls, 0);
});

test('symbolic-link legacy source cannot import credentials from outside the data root', t => {
  const f = fixture(t); const external = path.join(f.root, 'outside'); f.model(external).save(CONFIG); fs.mkdirSync(f.userDataDir, { recursive: true });
  try { fs.symlinkSync(external, f.normal, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symbolic links are unavailable on this test host'); throw error; }
  const result = f.resolve(); assert.equal(result.migration.status, 'invalid_source'); assert.equal(result.migration.errorCode, 'DEVICE_STORAGE_UNSAFE');
  assert.equal(fs.existsSync(modelFile(result.dataDir)), false);
});

test('symbolic-link destination is rejected before writing outside the data root', t => {
  const f = fixture(t); const external = path.join(f.root, 'outside'); fs.mkdirSync(external, { recursive: true }); fs.mkdirSync(f.userDataDir, { recursive: true });
  try { fs.symlinkSync(external, path.join(f.userDataDir, 'device-settings-v1'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symbolic links are unavailable on this test host'); throw error; }
  assert.throws(() => f.resolve(), error => error.code === 'DEVICE_STORAGE_UNSAFE'); assert.deepEqual(fs.readdirSync(external), []);
});
