'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { checkSource, checkPackaged, generateLegalAsset } = require('../scripts/open-source-license.cjs');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-oss-license-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(base)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(base), /^adh-oss-license-/);
    fs.rmSync(base, { recursive: true, force: true });
  });
  for (const file of ['LICENSE', 'NOTICE', 'COPYRIGHT.md', 'THIRD-PARTY-NOTICES.md', 'package.json', 'third_party', 'Loomic-main/Loomic-main/LICENSE', 'Loomic-main/Loomic-main/package.json', 'Loomic-main/Loomic-main/pnpm-lock.yaml', 'Loomic-main/Loomic-main/skills']) {
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    fs.cpSync(path.join(root, file), path.join(base, file), { recursive: true });
  }
  fs.mkdirSync(path.join(base, 'assets'));
  return base;
}

test('source release rejects lost upstream copyright and incomplete font notices', t => {
  const base = fixture(t);
  assert.equal(checkSource(base).ok, true);
  const license = path.join(base, 'third_party/loomic/LICENSE');
  fs.writeFileSync(license, fs.readFileSync(license, 'utf8').replace('Xinmin Zeng', 'incorrect author'));
  assert.equal(checkSource(base).ok, false);
  assert.ok(checkSource(base).findings.some(x => x.rule === 'upstream-license-changed'));
  fs.copyFileSync(path.join(root, 'third_party/loomic/LICENSE'), license);
  fs.rmSync(path.join(base, 'Loomic-main/Loomic-main/skills/canvas-design/canvas-fonts/OFL.txt'));
  assert.ok(checkSource(base).findings.some(x => x.file.endsWith('/OFL.txt')));
});

test('source release detects changed font bytes and rollback to EPL-only layout library', t => {
  const base = fixture(t);
  fs.appendFileSync(path.join(base, 'Loomic-main/Loomic-main/skills/canvas-design/canvas-fonts/ArsenalSC-Regular.ttf'), 'tamper');
  assert.ok(checkSource(base).findings.some(x => x.rule === 'font-changed-without-notice-review'));
  const file = path.join(base, 'Loomic-main/Loomic-main/package.json');
  const pkg = JSON.parse(fs.readFileSync(file)); pkg.pnpm.overrides.elkjs = '0.9.3'; fs.writeFileSync(file, JSON.stringify(pkg));
  assert.ok(checkSource(base).findings.some(x => x.rule === 'elk-gpl-compatible-override-missing'));
});

test('offline legal information includes exact version, source download and original licenses', t => {
  const base = fixture(t);
  const result = generateLegalAsset(base);
  const vm = require('node:vm'), context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'assets/open-source-info.js'), 'utf8'), context);
  const info = context.globalThis.AIDesignHubOpenSource;
  assert.equal(info.version, result.version);
  assert.ok(info.sourceUrl.endsWith(`/AIDesignHub-${result.version}-source.zip`));
  assert.ok(info.texts.some(x => x.text.includes('Copyright (c) 2026 DeepSeek')));
  assert.ok(info.texts.some(x => x.text.includes('Copyright (c) 2026 Xinmin Zeng')));
});

test('packaged release rejects missing or altered Harness license', t => {
  const source = fixture(t), appOut = path.join(source, 'packaged'), app = path.join(appOut, 'resources/app');
  fs.mkdirSync(app, { recursive: true });
  for (const file of ['LICENSE', 'NOTICE', 'COPYRIGHT.md', 'THIRD-PARTY-NOTICES.md', 'third_party']) fs.cpSync(path.join(source, file), path.join(app, file), { recursive: true });
  fs.mkdirSync(path.join(app, 'assets')); fs.writeFileSync(path.join(app, 'assets/open-source-info.js'), 'fixture');
  const fonts = 'Loomic-main/Loomic-main/apps/web/out/excalidraw-assets/fonts';
  fs.mkdirSync(path.join(app, fonts, 'Liberation'), { recursive: true });
  fs.copyFileSync(path.join(root, 'third_party/fonts/liberation-sans/LiberationSans-Regular.woff2'), path.join(app, fonts, 'Liberation/LiberationSans-Regular.woff2'));
  const fontInventory = JSON.parse(fs.readFileSync(path.join(root, 'third_party/excalidraw/font-license-manifest.json'), 'utf8'));
  fontInventory.fonts = fontInventory.fonts.filter(x => x.family === 'Liberation');
  fs.writeFileSync(path.join(app, 'third_party/excalidraw/font-license-manifest.json'), JSON.stringify(fontInventory));
  fs.writeFileSync(path.join(app, fonts, 'font-license-manifest.json'), JSON.stringify(fontInventory));
  fs.copyFileSync(path.join(root, 'third_party/excalidraw/FONT-NOTICES.md'), path.join(app, fonts, 'FONT-NOTICES.md'));
  fs.copyFileSync(path.join(root, 'third_party/licenses/OFL-1.1.txt'), path.join(app, fonts, 'OFL-1.1.txt'));
  assert.ok(checkPackaged(appOut).findings.some(x => x.rule === 'bundled-harness-license-invalid'));
  const target = path.join(appOut, 'resources/dsh-runtime/0.2.1-rc.2/package/node_modules/@deepseek-ai/dsh/LICENSE');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, 'third_party/deepseek-harness/LICENSE'), target);
  fs.writeFileSync(path.join(path.dirname(target), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
  assert.equal(checkPackaged(appOut).ok, true);
  const font = path.join(app, fonts, 'Liberation/LiberationSans-Regular.woff2');
  fs.appendFileSync(font, 'tamper');
  assert.ok(checkPackaged(appOut).findings.some(x => x.rule === 'packaged-font-missing-or-changed'));
  fs.copyFileSync(path.join(root, 'third_party/fonts/liberation-sans/LiberationSans-Regular.woff2'), font);
  fs.appendFileSync(target, 'changed grant');
  assert.equal(checkPackaged(appOut).ok, false);
});

test('GPL-compatible elkjs completes a real graph layout after license migration', async t => {
  const file = path.join(root, 'Loomic-main/Loomic-main/node_modules/.pnpm/elkjs@0.12.1/node_modules/elkjs/lib/elk.bundled.js');
  if (!fs.existsSync(file)) return t.skip('Canvas workspace dependencies are not installed');
  const ELK = require(file), elk = new ELK();
  const graph = await elk.layout({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered' }, children: [{ id: 'a', width: 80, height: 40 }, { id: 'b', width: 80, height: 40 }], edges: [{ id: 'a-to-b', sources: ['a'], targets: ['b'] }] });
  assert.equal(graph.children.length, 2);
  assert.ok(graph.children.every(x => Number.isFinite(x.x) && Number.isFinite(x.y)));
  assert.ok(graph.edges[0].sections.length > 0);
});
