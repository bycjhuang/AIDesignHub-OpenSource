'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DSH_VOICE_INPUT_BUNDLE, applyVoiceInputDefault, prepareVoiceAssets, allowVoicePermission,
  configureVoicePermissions } = require('../backend/dsh-voice.cjs');

test('voice default covers fresh and upgraded profiles while retaining settings and deliberate later opt-out', () => {
  const profile = { name: 'custom', dsh: { profile: { bundles: ['custom-plugin'], custom: true } },
    adhDesktopDefaults: { custom: 'preserved' } };
  assert.equal(applyVoiceInputDefault(profile), true);
  assert.deepEqual(profile.dsh.profile.bundles, ['custom-plugin', DSH_VOICE_INPUT_BUNDLE]);
  assert.equal(profile.adhDesktopDefaults.custom, 'preserved');
  assert.equal(profile.dsh.profile.custom, true);
  profile.dsh.profile.bundles.pop();
  assert.equal(applyVoiceInputDefault(profile), false);
  assert.deepEqual(profile.dsh.profile.bundles, ['custom-plugin']);
  assert.equal(applyVoiceInputDefault(profile, { force: true }), true);
  assert.equal(profile.name, 'custom');
  const fresh = {};
  applyVoiceInputDefault(fresh);
  assert.deepEqual(fresh.dsh.profile.bundles, [DSH_VOICE_INPUT_BUNDLE]);
});

test('audio permission is scoped to the current trusted main-frame Hub host and excludes camera', () => {
  const authUrl = 'http://127.0.0.1:45678/?token=test';
  const contents = { isDestroyed: () => false, getURL: () => authUrl };
  const options = { contents, trustedContents: contents, authUrl, permission: 'media', request: true,
    details: { requestingUrl: authUrl, isMainFrame: true, mediaTypes: ['audio'] } };
  assert.equal(allowVoicePermission(options), true);
  for (const change of [
    { permission: 'display-capture' },
    { authUrl: 'http://127.0.0.1:45679/' },
    { authUrl: 'https://example.com/' },
    { contents: { ...contents } },
    { details: { ...options.details, isMainFrame: false } },
    { details: { ...options.details, requestingUrl: 'http://127.0.0.1:1111/' } },
    { details: { ...options.details, mediaTypes: ['audio', 'video'] } },
    { details: { ...options.details, mediaTypes: [] } },
  ]) assert.equal(allowVoicePermission({ ...options, ...change }), false);
  assert.equal(allowVoicePermission({ ...options, request: false, details: { mediaType: 'audio' } }), true);
  assert.equal(allowVoicePermission({ ...options, request: false, details: { mediaType: 'video' } }), false);
});

test('permission handlers follow a host port change and refuse stale views/origins', () => {
  let request, check, port = 45678;
  const session = { setPermissionRequestHandler: fn => { request = fn; }, setPermissionCheckHandler: fn => { check = fn; } };
  const contents = { isDestroyed: () => false, getURL: () => `http://127.0.0.1:${port}/` };
  configureVoicePermissions(session, contents, () => `http://127.0.0.1:${port}/?token=test`);
  let granted;
  request(contents, 'media', value => { granted = value; }, { mediaTypes: ['audio'], isMainFrame: true });
  assert.equal(granted, true);
  assert.equal(check(contents, 'media', 'http://127.0.0.1:45678', { mediaType: 'audio' }), true);
  port++;
  assert.equal(check(contents, 'media', 'http://127.0.0.1:45678', { mediaType: 'audio' }), false);
  assert.equal(check(contents, 'media', 'http://127.0.0.1:45679', { mediaType: 'audio' }), true);
});

function assetFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-voice-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^adh-voice-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(root, 'runtime');
  const dshHome = path.join(root, 'hub-home');
  const source = path.join(root, 'existing-models');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const descriptor = name => ({ name, bytes: 4, sha256: createHash('sha256').update('test').digest('hex') });
  const lock = { models: { int8: descriptor('model.int8.onnx') }, tokens: descriptor('tokens.txt'), vad: descriptor('silero_vad.onnx') };
  const lockFile = path.join(runtimeRoot, 'package/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json');
  put(lockFile, JSON.stringify(lock));
  return { root, runtimeRoot, dshHome, source, put, lock, lockFile };
}

test('model preparation copies only verified public assets into the independent Hub home and reuses valid targets', async t => {
  const f = assetFixture(t);
  for (const file of ['models/sensevoice-onnx/model.int8.onnx', 'models/sensevoice-onnx/tokens.txt', 'models/silero/silero_vad.onnx']) f.put(path.join(f.source, file), 'test');
  f.put(path.join(f.source, 'account.json'), 'private-data-must-not-be-copied');
  const options = { runtimeRoot: f.runtimeRoot, dshHome: f.dshHome, sourceDataRoots: [f.source] };
  const result = await prepareVoiceAssets(options);
  assert.equal(result.ready, true);
  assert.ok(result.files.every(file => file.ready && file.copied));
  assert.equal(fs.existsSync(path.join(f.dshHome, 'account.json')), false);
  assert.equal(fs.existsSync(path.join(f.dshHome, 'speech-to-text/sensevoice/account.json')), false);
  assert.ok((await prepareVoiceAssets(options)).files.every(file => !file.copied));
});

test('corrupt source models stay unready and unsafe model manifests cannot escape the target home', async t => {
  const f = assetFixture(t);
  f.put(path.join(f.source, 'models/sensevoice-onnx/model.int8.onnx'), 'evil');
  const options = { runtimeRoot: f.runtimeRoot, dshHome: f.dshHome, sourceDataRoots: [f.source] };
  assert.equal((await prepareVoiceAssets(options)).ready, false);
  assert.equal(fs.existsSync(path.join(f.dshHome, 'speech-to-text/sensevoice/models/sensevoice-onnx/model.int8.onnx')), false);
  f.lock.tokens.name = '../account.json';
  f.put(f.lockFile, JSON.stringify(f.lock));
  await assert.rejects(prepareVoiceAssets(options), /DSH_VOICE_ASSET_MANIFEST_INVALID/);
});
