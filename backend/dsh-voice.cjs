'use strict';

const { createReadStream, readFileSync } = require('node:fs');
const { copyFile, mkdir, rename, rm, stat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');

const DSH_VOICE_INPUT_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle';

function applyVoiceInputDefault(packageJson, { force = false } = {}) {
  const profile = (packageJson.dsh ??= {}).profile ??= {};
  const bundles = profile.bundles ??= [];
  if (!Array.isArray(bundles)) throw new Error('DSH_PROFILE_BUNDLES_INVALID');
  const defaults = packageJson.adhDesktopDefaults ??= {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('DSH_PROFILE_DEFAULTS_INVALID');
  // The official plugin manager removes a bundle to disable it. Apply this
  // installation default once so a later deliberate removal remains respected.
  if (!force && (defaults.voiceInput ?? 0) >= 1) return false;
  if (!bundles.includes(DSH_VOICE_INPUT_BUNDLE)) bundles.push(DSH_VOICE_INPUT_BUNDLE);
  defaults.voiceInput = 1;
  return true;
}

function voiceAssets(runtimeRoot, dshHome) {
  const manifest = path.join(runtimeRoot, 'package', 'node_modules', '@deepseek-ai',
    'dsh-experimental-speech-to-text-sensevoice', 'runtime', 'assets.json');
  const lock = JSON.parse(readFileSync(manifest, 'utf8'));
  const dataRoot = path.join(dshHome, 'speech-to-text', 'sensevoice');
  return [
    [lock.models?.int8, 'sensevoice-onnx'], [lock.tokens, 'sensevoice-onnx'], [lock.vad, 'silero'],
  ].map(([asset, folder]) => {
    if (!asset || typeof asset.name !== 'string' || path.basename(asset.name) !== asset.name
      || /[\\/]/.test(asset.name) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('DSH_VOICE_ASSET_MANIFEST_INVALID');
    const relative = path.join('models', folder, asset.name);
    return { name: asset.name, bytes: asset.bytes, sha256: asset.sha256, relative, file: path.join(dataRoot, relative) };
  });
}

async function matchesAsset(file, asset) {
  try {
    if ((await stat(file)).size !== asset.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === asset.sha256;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Copy only verified public model assets. Account/configuration files are never read. */
async function prepareVoiceAssets({ runtimeRoot, dshHome, sourceDataRoots = [] }) {
  const assets = voiceAssets(runtimeRoot, dshHome);
  const files = [];
  for (const asset of assets) {
    let ready = await matchesAsset(asset.file, asset);
    let copied = false;
    if (!ready) {
      for (const sourceRoot of sourceDataRoots) {
        const source = path.join(sourceRoot, asset.relative);
        if (!await matchesAsset(source, asset)) continue;
        await mkdir(path.dirname(asset.file), { recursive: true });
        const staged = `${asset.file}.adh-next-${process.pid}`;
        try {
          await copyFile(source, staged);
          if (!await matchesAsset(staged, asset)) throw new Error('DSH_VOICE_ASSET_COPY_MISMATCH');
          await rename(staged, asset.file);
        } finally { await rm(staged, { force: true }); }
        ready = true;
        copied = true;
        break;
      }
    }
    files.push({ file: asset.file, bytes: asset.bytes, sha256: asset.sha256, ready, copied });
  }
  return { ready: files.every(file => file.ready), files };
}

function loopbackOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function allowVoicePermission({ contents, trustedContents, authUrl, permission, details = {}, request = false }) {
  if (!contents || contents !== trustedContents || contents.isDestroyed() || permission !== 'media') return false;
  const origin = loopbackOrigin(authUrl);
  if (!origin || loopbackOrigin(contents.getURL()) !== origin || details.isMainFrame === false) return false;
  for (const value of [details.requestingUrl, details.securityOrigin, details.embeddingOrigin]) {
    if (value && loopbackOrigin(value) !== origin) return false;
  }
  // Electron distinguishes microphone and camera within the shared media permission.
  return request
    ? Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio')
    : details.mediaType === 'audio';
}

function configureVoicePermissions(session, trustedContents, resolveUrl) {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowVoicePermission({ contents, trustedContents, authUrl: resolveUrl(), permission, details, request: true }));
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return allowVoicePermission({ contents, trustedContents, authUrl: resolveUrl(), permission,
      details: { ...details, securityOrigin: requestingOrigin } });
  });
}

module.exports = { DSH_VOICE_INPUT_BUNDLE, applyVoiceInputDefault, voiceAssets, matchesAsset,
  prepareVoiceAssets, allowVoicePermission, configureVoicePermissions };
