'use strict';

// Fills an isolated data root (AIDESIGNHUB_DATA_DIR) with encrypted media model
// profiles, using the same MediaModelService + Electron safeStorage path as the
// running workbench. The API key is only read from APIMART_API_KEY / --api-key=
// at runtime; never hardcode keys in this file or commit them.
//
// Usage (project root):
//   set AIDESIGNHUB_DATA_DIR=<absolute test data dir>
//   set APIMART_API_KEY=<key>
//   node scripts/seed-media-models.cjs [--base-url=...] [--image-model=...] [--video-model=...]
//       [--image-name=...] [--video-name=...] [--skip-image] [--skip-video] [--no-default]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function flag(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(value => typeof value === 'string' && value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

if (!process.versions.electron) {
  const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
  const executable = fs.existsSync(bundled) ? bundled : require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [__filename, ...process.argv.slice(2)], { env, cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true, timeout: 120000 });
  process.exit(result.status ?? 1);
}

const { app, safeStorage } = require('electron');
const { MediaModelService } = require('../backend/media-model-service.cjs');
const { ModelService } = require('../backend/model-service.cjs');

app.whenReady().then(() => {
  try {
    const root = flag('data-dir') || process.env.AIDESIGNHUB_DATA_DIR || '';
    const apiKey = flag('api-key') || process.env.APIMART_API_KEY || '';
    if (!root || !path.isAbsolute(root)) throw new Error('需要 AIDESIGNHUB_DATA_DIR 或 --data-dir=<绝对路径> 指定隔离测试数据目录。');
    if (path.resolve(root).toLowerCase() === path.join(app.getPath('appData'), 'bycj-design-workbench-prototype').toLowerCase()) throw new Error('正式安装版的密钥必须由安装版本身加密保存。请使用工作台中的模型设置；此开发脚本仅用于隔离测试目录，避免再次造成密钥无法解密。');
    if (!apiKey.trim() && !(process.argv.includes('--skip-image') && process.argv.includes('--skip-video'))) throw new Error('需要 APIMART_API_KEY 或 --api-key=<密钥>。密钥只来自运行参数，不写入脚本。');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，拒绝写入模型密钥。');
    const service = new MediaModelService({
      dataDir: path.join(root, 'device-settings-v1'),
      protectSecret: value => safeStorage.encryptString(value).toString('base64'),
      unprotectSecret: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
    });
    const baseUrl = flag('base-url') || 'https://api.apimart.ai/v1';
    const key = apiKey.trim();
    const imageModel = flag('image-model') || 'gpt-image-2';
    let snapshot = service.snapshot();
    if (!process.argv.includes('--skip-image')) snapshot = service.save({ category: 'image', name: flag('image-name') || `APIMart · ${imageModel}`, apiType: 'apimart', baseUrl, model: imageModel, apiKey: key, enabled: true, isDefault: !process.argv.includes('--no-default') });
    if (!process.argv.includes('--skip-video')) {
      snapshot = service.save({ category: 'video', name: flag('video-name') || 'APIMart · Kling v3 Omni', apiType: 'apimart', baseUrl, model: flag('video-model') || 'kling-v3-omni', apiKey: key, enabled: true, isDefault: !process.argv.includes('--no-default') });
    }
    let text = null, textKeyring = [];
    if (flag('text-model')) {
      const texts = new ModelService({ dataDir: path.join(root, 'device-settings-v1'), secretStore: safeStorage });
      let textKey = flag('text-api-key') || process.env.TEXT_API_KEY || '';
      if (!textKey && flag('text-key-from-media')) {
        const raw = JSON.parse(fs.readFileSync(path.join(root, 'device-settings-v1', 'media-private', 'profiles-v1.json'), 'utf8'));
        const donor = raw.profiles.find(p => p.model === flag('text-key-from-media') && p.encryptedApiKey);
        if (donor) textKey = safeStorage.decryptString(Buffer.from(donor.encryptedApiKey, 'base64'));
      }
      const keyFile = flag('text-key-from-file');
      if (!textKey && keyFile && fs.existsSync(keyFile)) textKey = safeStorage.decryptString(fs.readFileSync(keyFile));
      const payload = { provider: flag('text-provider') || 'openai-compatible', model: flag('text-model'), apiKey: textKey };
      if (flag('text-base-url')) payload.baseUrl = flag('text-base-url');
      texts.save(payload);
      const st = texts.status();
      text = st.configured ? `${st.provider}:${st.model}` : 'text-save-failed';
      textKeyring = st.keyring || [];
      if (flag('text-backup-to') && textKey) fs.writeFileSync(flag('text-backup-to'), safeStorage.encryptString(textKey));
    }
    console.log(JSON.stringify({ ok: true, dataDir: root, defaults: snapshot.defaults, text, textKeyring, profiles: snapshot.profiles.map(profile => `${profile.category}:${profile.name}:${profile.model}:${profile.apiType}`) }));
  } catch (error) {
    console.error(`写入媒体模型配置失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
