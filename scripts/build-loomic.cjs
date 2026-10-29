'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..', 'Loomic-main', 'Loomic-main');
const fonts = path.join(root, 'apps', 'web', 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
if (!fs.existsSync(fonts)) throw new Error('请先在 Loomic-main/Loomic-main 执行 pnpm install --frozen-lockfile。');
fs.cpSync(fonts, path.join(root, 'apps', 'web', 'public', 'excalidraw-assets', 'fonts'), { recursive: true });
const publicFonts = path.join(root, 'apps', 'web', 'public', 'excalidraw-assets', 'fonts');
const thirdParty = path.resolve(__dirname, '../third_party');
fs.copyFileSync(path.join(thirdParty, 'fonts/liberation-sans/LiberationSans-Regular.woff2'), path.join(publicFonts, 'Liberation/LiberationSans-Regular.woff2'));
for (const name of ['FONT-NOTICES.md', 'font-license-manifest.json']) fs.copyFileSync(path.join(thirdParty, 'excalidraw', name), path.join(publicFonts, name));
fs.copyFileSync(path.join(thirdParty, 'licenses/OFL-1.1.txt'), path.join(publicFonts, 'OFL-1.1.txt'));
const env = { ...process.env, NEXT_PUBLIC_HUB_LOCAL_RUNTIME: '1', NEXT_TELEMETRY_DISABLED: '1' };
for (const args of [['--filter', '@loomic/shared', 'build'], ['--filter', '@loomic/web', 'build']]) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const cleared = require('./sanitize-loomic-export.cjs').sanitizeLoomicExport(path.join(root, 'apps', 'web', 'out'));
console.log(`Loomic 本机画布已构建：apps/web/out；已清空 ${cleared} 处上游示例云配置。`);
