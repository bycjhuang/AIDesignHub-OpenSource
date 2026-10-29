'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ModelService } = require('./model-service.cjs');

const DEVICE_DIRECTORY = 'device-settings-v1';
const MODEL_PARTS = ['model-private', 'model-config.enc'];
const MAX_CONFIG_BYTES = 65536;

function settingsError(code, message) {
  const error = new Error(message); error.code = code; return error;
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw settingsError('DEVICE_DATA_DIR_REQUIRED', '本机设置需要明确的绝对数据目录。');
  return path.resolve(value);
}
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function assertSafePath(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw settingsError('DEVICE_STORAGE_UNSAFE', '本机设置路径超出允许的数据目录。');
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let entry;
    try { entry = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entry.isSymbolicLink()) throw settingsError('DEVICE_STORAGE_UNSAFE', '本机设置及旧配置不能通过符号链接访问。');
  }
}
function noNetwork() { throw settingsError('DEVICE_NETWORK_FORBIDDEN', '设置迁移不允许调用模型。'); }
function inspectConfig(root, candidate, secretStore) {
  const file = path.join(candidate.dataDir, ...MODEL_PARTS);
  try {
    assertSafePath(root, file);
    if (!fs.existsSync(file)) return { ...candidate, state: 'absent' };
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) return { ...candidate, state: 'invalid', errorCode: 'MODEL_CONFIG_UNREADABLE' };
    const bytes = fs.readFileSync(file);
    const status = new ModelService({ dataDir: candidate.dataDir, secretStore, fetchImpl: noNetwork }).status();
    assertSafePath(root, file);
    if (!bytes.equals(fs.readFileSync(file))) return { ...candidate, state: 'invalid', errorCode: 'MODEL_CONFIG_CHANGED' };
    if (status.errorCode) return { ...candidate, state: 'invalid', errorCode: status.errorCode };
    if (!status.configured) return { ...candidate, state: 'unconfigured' };
    return { ...candidate, state: 'valid', bytes };
  } catch (error) {
    return { ...candidate, state: 'invalid', errorCode: error.code === 'DEVICE_STORAGE_UNSAFE' ? error.code : 'MODEL_CONFIG_UNREADABLE' };
  }
}

/** Resolve machine-owned settings independently from project/demo databases.
 * Only copies an already encrypted, locally readable model configuration. Does
 * not migrate project records, grants, runtime credentials or verification state.
 * Explicit data roots and smoke/custom roots never inspect the real user profile.
 */
function resolveDeviceSettings({ userDataDir, backendDataDir, env = process.env, smoke = false, secretStore } = {}) {
  const backendRoot = absolute(backendDataDir);
  const override = typeof env?.AIDESIGNHUB_DATA_DIR === 'string' && env.AIDESIGNHUB_DATA_DIR.trim() ? absolute(env.AIDESIGNHUB_DATA_DIR) : null;
  const smokeMode = smoke === true || env?.BYCJ_WORKBENCH_SMOKE === '1';
  let root, isolated;
  if (override) { root = override; isolated = true; }
  else if (smokeMode) { root = backendRoot; isolated = true; }
  else {
    const userRoot = absolute(userDataDir);
    const knownBackend = ['design-workbench-v1', 'demo-company-v1'].some(name => samePath(backendRoot, path.join(userRoot, name)));
    root = knownBackend ? userRoot : backendRoot;
    isolated = !knownBackend;
  }
  const dataDir = path.join(root, DEVICE_DIRECTORY);
  assertSafePath(root, path.join(dataDir, ...MODEL_PARTS));
  const result = (status, extra = {}) => ({
    dataDir, scope: 'device', isolated,
    migration: { status, needsSelection: false, sourceCount: 0, sourceLabels: [], ...extra },
  });
  const current = inspectConfig(root, { label: '本机共享设置', dataDir }, secretStore);
  if (current.state !== 'absent') {
    // Even a deliberately cleared or corrupt destination wins over legacy data:
    // a restart must not silently restore a key that the user already removed.
    if (current.state === 'valid') return result('existing');
    if (current.state === 'unconfigured') return result('existing_unconfigured');
    return result('invalid_target', { errorCode: current.errorCode });
  }
  const legacy = [
    ...(isolated ? [{ label: '隔离数据旧设置', dataDir: root }] : []),
    { label: '原项目工作区', dataDir: path.join(root, 'design-workbench-v1') },
    { label: '演示公司工作区', dataDir: path.join(root, 'demo-company-v1') },
  ];
  const sources = legacy.map(candidate => inspectConfig(root, candidate, secretStore));
  const present = sources.filter(source => source.state !== 'absent');
  const valid = sources.filter(source => source.state === 'valid');
  const invalid = sources.filter(source => source.state === 'invalid');
  const metadata = { sourceCount: present.length, sourceLabels: present.map(source => source.label), invalidSourceCount: invalid.length };
  if (!valid.length) {
    if (invalid.length) return result(invalid.some(source => source.errorCode === 'MODEL_ENCRYPTION_UNAVAILABLE') ? 'unavailable' : 'invalid_source', { ...metadata, errorCode: invalid[0].errorCode });
    return result('not_configured', metadata);
  }
  if (valid.some(source => !source.bytes.equals(valid[0].bytes))) return result('needs_selection', { ...metadata, needsSelection: true });

  // Exclusive creation protects a concurrent save/migration. The old encrypted
  // source remains untouched, and no plaintext or credential enters the result.
  const target = path.join(dataDir, ...MODEL_PARTS);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    assertSafePath(root, target);
    fs.writeFileSync(target, valid[0].bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const concurrent = inspectConfig(root, { label: '本机共享设置', dataDir }, secretStore);
      if (concurrent.state === 'valid') return result('existing', metadata);
      return result('invalid_target', { ...metadata, errorCode: concurrent.errorCode || 'MODEL_NOT_CONFIGURED' });
    }
    return result('unavailable', { ...metadata, errorCode: error.code === 'DEVICE_STORAGE_UNSAFE' ? error.code : 'MODEL_STORAGE_FAILED' });
  }
  const migrated = inspectConfig(root, { label: '本机共享设置', dataDir }, secretStore);
  if (migrated.state !== 'valid') return result('invalid_target', { ...metadata, errorCode: migrated.errorCode || 'MODEL_NOT_CONFIGURED' });
  return result('migrated', { ...metadata, migratedFrom: valid.map(source => source.label) });
}

module.exports = { resolveDeviceSettings, DEVICE_DIRECTORY };
