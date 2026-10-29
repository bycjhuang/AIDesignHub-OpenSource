'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = (base, file) => fs.readFileSync(path.join(base, file), 'utf8');
const normalized = text => text.replace(/\r\n/g, '\n').trimEnd() + '\n';
const gitBlob = text => { const data = Buffer.from(normalized(text)); return crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'); };

function checkSource(base = root) {
  const findings = [];
  const requireFile = file => {
    if (!fs.existsSync(path.join(base, file))) { findings.push({ file, rule: 'missing-license-material' }); return false; }
    return true;
  };
  for (const file of ['LICENSE', 'NOTICE', 'COPYRIGHT.md', 'THIRD-PARTY-NOTICES.md', 'third_party/UPSTREAMS.json']) requireFile(file);
  if (findings.length) return { ok: false, findings };
  if (!read(base, 'LICENSE').includes('GNU AFFERO GENERAL PUBLIC LICENSE') || !read(base, 'LICENSE').includes('19 November 2007')) findings.push({ file: 'LICENSE', rule: 'wrong-main-license' });
  if (JSON.parse(read(base, 'package.json')).license !== 'AGPL-3.0-only') findings.push({ file: 'package.json', rule: 'wrong-main-license-metadata' });
  for (const item of JSON.parse(read(base, 'third_party/UPSTREAMS.json')).components) {
    for (const file of [item.licenseFile, item.preservedLicenseFile].filter(Boolean)) {
      if (requireFile(file) && gitBlob(read(base, file)) !== item.licenseGitBlob) findings.push({ file, rule: 'upstream-license-changed', component: item.id });
    }
  }
  for (const file of ['Loomic-main/Loomic-main/skills/canvas-design/LICENSE.txt', 'Loomic-main/Loomic-main/skills/json-image-prompt/LICENSE.txt']) {
    if (requireFile(file) && !read(base, file).includes('Apache License')) findings.push({ file, rule: 'missing-skill-license' });
  }
  const fontRoot = 'Loomic-main/Loomic-main/skills/canvas-design/canvas-fonts';
  for (const file of [`${fontRoot}/OFL.txt`, `${fontRoot}/FONT-NOTICES.md`, `${fontRoot}/font-license-manifest.json`, 'third_party/excalidraw/FONT-NOTICES.md', 'third_party/excalidraw/font-license-manifest.json']) requireFile(file);
  if (fs.existsSync(path.join(base, fontRoot, 'font-license-manifest.json'))) {
    const manifest = JSON.parse(read(base, `${fontRoot}/font-license-manifest.json`));
    for (const font of manifest.fonts) {
      const file = `${fontRoot}/${font.file}`;
      if (requireFile(file) && crypto.createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex') !== font.sha256) findings.push({ file, rule: 'font-changed-without-notice-review' });
    }
    if (manifest.fonts.length !== 54) findings.push({ file: `${fontRoot}/font-license-manifest.json`, rule: 'font-inventory-incomplete' });
  }
  const elkSources = 'third_party/elkjs/UPSTREAM.json';
  if (requireFile(elkSources)) {
    for (const archive of JSON.parse(read(base, elkSources)).sourceArchives) {
      const file = `third_party/elkjs/sources/${archive.file}`;
      if (requireFile(file) && crypto.createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex') !== archive.sha256) findings.push({ file, rule: 'mirrored-elk-source-changed' });
    }
  }
  const canvasPackage = JSON.parse(read(base, 'Loomic-main/Loomic-main/package.json'));
  if (canvasPackage.pnpm?.overrides?.elkjs !== '0.12.1') findings.push({ file: 'Loomic-main/Loomic-main/package.json', rule: 'elk-gpl-compatible-override-missing' });
  if (!read(base, 'Loomic-main/Loomic-main/pnpm-lock.yaml').includes('elkjs@0.12.1:')) findings.push({ file: 'Loomic-main/Loomic-main/pnpm-lock.yaml', rule: 'elk-license-upgrade-not-locked' });
  const replacement = 'third_party/fonts/liberation-sans';
  if (requireFile(`${replacement}/UPSTREAM.json`)) {
    const manifest = JSON.parse(read(base, `${replacement}/UPSTREAM.json`));
    for (const [name, hash] of Object.entries(manifest.files)) {
      const file = `${replacement}/${name}`;
      if (requireFile(file) && crypto.createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex') !== hash) findings.push({ file, rule: 'audited-font-replacement-changed' });
    }
  }
  return { ok: findings.length === 0, findings };
}

function legalInformation(base = root) {
  const version = JSON.parse(read(base, 'package.json')).version;
  const repository = 'https://github.com/bycjhuang/AIDesignHub-OpenSource';
  return {
    version, license: 'AGPL-3.0-only', copyright: 'Copyright (c) 2026 AIDesignHub authors and contributors',
    maintainer: 'bycjhuang', repository,
    sourceUrl: `${repository}/releases/download/v${version}/AIDesignHub-${version}-source.zip`,
    sourceArchive: `AIDesignHub-${version}-source.zip`,
    notice: read(base, 'THIRD-PARTY-NOTICES.md').replace(/\r\n/g, '\n'),
    texts: [
      ['GNU AGPL version 3', 'LICENSE'],
      ['DeepSeek Harness · MIT · Copyright (c) 2026 DeepSeek', 'third_party/deepseek-harness/LICENSE'],
      ['Loomic · MIT · Copyright (c) 2026 Xinmin Zeng', 'third_party/loomic/LICENSE'],
      ['Excalidraw · MIT · Copyright (c) 2020 Excalidraw', 'third_party/excalidraw/LICENSE'],
      ['Apache License 2.0 · skills', 'third_party/licenses/Apache-2.0.txt'],
      ['SIL Open Font License 1.1 · fonts', 'third_party/licenses/OFL-1.1.txt'],
      ['elkjs · EPL / GPL 原始许可', 'third_party/licenses/elkjs-LICENSE.md'],
      ['Excalidraw 字体原作者与许可', 'third_party/excalidraw/FONT-NOTICES.md'],
      ['Loomic 技能字体原作者与许可', 'Loomic-main/Loomic-main/skills/canvas-design/canvas-fonts/FONT-NOTICES.md'],
    ].map(([title, file]) => ({ title, file, text: read(base, file).replace(/\r\n/g, '\n') })),
  };
}

function generateLegalAsset(base = root) {
  const result = checkSource(base);
  if (!result.ok) throw new Error(`Open-source license check failed: ${JSON.stringify(result.findings)}`);
  const info = legalInformation(base);
  const output = `'use strict';\n// Generated from the licenses shipped with this source; contains no user data.\n(function(root) { root.AIDesignHubOpenSource = Object.freeze(${JSON.stringify(info, null, 2)}); })(globalThis);\n`;
  fs.writeFileSync(path.join(base, 'assets/open-source-info.js'), output);
  return { license: info.license, version: info.version, primaryComponents: 3 };
}

function checkPackaged(appOutDir) {
  const base = path.join(appOutDir, 'resources/app');
  const findings = [];
  for (const file of ['LICENSE', 'NOTICE', 'COPYRIGHT.md', 'THIRD-PARTY-NOTICES.md', 'third_party/UPSTREAMS.json', 'assets/open-source-info.js']) {
    if (!fs.existsSync(path.join(base, file))) findings.push({ file, rule: 'packaged-license-missing' });
  }
  if (findings.length) return { ok: false, findings };
  for (const component of JSON.parse(read(base, 'third_party/UPSTREAMS.json')).components) {
    if (!fs.existsSync(path.join(base, component.licenseFile)) || gitBlob(read(base, component.licenseFile)) !== component.licenseGitBlob) findings.push({ file: component.licenseFile, rule: 'packaged-upstream-license-invalid' });
  }
  const harness = path.join(appOutDir, 'resources/dsh-runtime/0.2.1-rc.2/package/node_modules/@deepseek-ai/dsh');
  if (!fs.existsSync(path.join(harness, 'LICENSE')) || gitBlob(fs.readFileSync(path.join(harness, 'LICENSE'), 'utf8')) !== JSON.parse(read(base, 'third_party/UPSTREAMS.json')).components.find(x => x.id === 'deepseek-harness').licenseGitBlob) findings.push({ file: 'resources/dsh-runtime/.../@deepseek-ai/dsh/LICENSE', rule: 'bundled-harness-license-invalid' });
  if (!fs.existsSync(path.join(harness, 'package.json')) || JSON.parse(fs.readFileSync(path.join(harness, 'package.json'), 'utf8')).version !== '0.2.1-rc.2') findings.push({ file: 'resources/dsh-runtime/.../@deepseek-ai/dsh/package.json', rule: 'bundled-harness-version-not-audited' });
  const fonts = path.join(base, 'Loomic-main/Loomic-main/apps/web/out/excalidraw-assets/fonts');
  const fontManifest = JSON.parse(read(base, 'third_party/excalidraw/font-license-manifest.json'));
  for (const font of fontManifest.fonts) {
    const file = path.join(fonts, font.file);
    if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== font.sha256) findings.push({ file: `canvas-fonts/${font.file}`, rule: 'packaged-font-missing-or-changed' });
  }
  for (const name of ['FONT-NOTICES.md', 'font-license-manifest.json', 'OFL-1.1.txt']) if (!fs.existsSync(path.join(fonts, name))) findings.push({ file: `canvas-fonts/${name}`, rule: 'packaged-font-notices-missing' });
  return { ok: findings.length === 0, findings };
}

module.exports = { checkSource, checkPackaged, generateLegalAsset, legalInformation, gitBlob };
if (require.main === module) {
  try {
    const result = process.argv.includes('--generate') ? generateLegalAsset() : checkSource();
    console.info(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
