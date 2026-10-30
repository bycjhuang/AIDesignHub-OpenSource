'use strict';

// Builds the original Harness browser plugin roster from public installer
// artifacts. It never starts Harness or reads its profile, user data, or keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_CLIENT_PACKAGES = Object.freeze([
  'dsh-client-modules',
  'dsh-client-ui-chat',
  'dsh-client-ui-sidebar',
  'dsh-client-ui-skill',
  'dsh-client-ui-model-selection',
  'dsh-client-ui-settings-general',
  'dsh-client-ui-settings-models',
  'dsh-client-ui-shortcuts',
  'dsh-client-ui-agent-preset',
  'dsh-client-ui-permission-presets',
  'dsh-client-ui-trajectory',
  'dsh-client-ui-attachment',
]);
const STATIC_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]);
const DEFAULT_RUNTIME_PACKAGE_ROOT = path.resolve(__dirname,
  '../.runtime/installer-resources/public/dsh-runtime/0.2.1-rc.2/package');
const SCOPE = '@deepseek-ai/';
const MODULES_ID = `${SCOPE}dsh-client-modules`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const normalizeId = value => value.replace(/\/client$/, '');

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Agent demo artifact escaped its expected directory: ${target}`);
  }
}

function queueSource() {
  return `(() => {
  const pendingQueue = [];
  window.__ModuleLoader__ = {
    mode: 'queue', pendingQueue,
    load(registration) { pendingQueue.push(registration); },
    create(options) {
      if (this.mode !== 'queue') throw new Error('Module system already started');
      const index = pendingQueue.findIndex(row => row.id === ${JSON.stringify(MODULES_ID)});
      if (index < 0) throw new Error('Browser module bootstrap was not loaded');
      const registration = pendingQueue.splice(index, 1)[0];
      const face = registration.factory(specifier => {
        throw new Error('Unexpected bootstrap external: ' + specifier);
      });
      if (typeof face.createClientModuleSystem !== 'function' || typeof face.apply !== 'function') {
        throw new Error('Invalid browser module bootstrap');
      }
      return face.createClientModuleSystem(this, { id: registration.id, exports: face }, options);
    }
  };
})();\n`;
}

function inspectAgentBoot(options = {}) {
  const runtimePackageRoot = path.resolve(options.runtimePackageRoot || DEFAULT_RUNTIME_PACKAGE_ROOT);
  const scopeDir = path.join(runtimePackageRoot, 'node_modules', '@deepseek-ai');
  const records = new Map();
  const visiting = new Set();

  function select(specifier) {
    const id = normalizeId(specifier);
    if (STATIC_MODULES.has(specifier) || STATIC_MODULES.has(id) || records.has(id)) return;
    if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(id)) {
      throw new Error(`Unexpected browser dependency: ${specifier}`);
    }
    const packageDir = path.join(scopeDir, id.slice(SCOPE.length));
    const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const declaration = metadata.dsh?.client;
    if (metadata.name !== id || declaration?.platform !== 'web') {
      throw new Error(`Package is not a declared browser plugin: ${id}`);
    }
    const clientExport = metadata.exports?.['./client'];
    const relativeBundle = typeof clientExport === 'string' ? clientExport : clientExport?.default;
    // Explicit browser/default exports only: never copy client.node.js or a
    // package directory, server entry point, dependencies, or source maps.
    if (!/^\.\/lib\/client(?:\.browser)?\.js$/.test(relativeBundle || '')) {
      throw new Error(`Unapproved browser entry for ${id}: ${relativeBundle}`);
    }
    const sourcePath = path.resolve(packageDir, relativeBundle);
    assertWithin(packageDir, sourcePath);
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^\s*\/\/[#@] source(?:Mapping)?URL=.*$/gm, '');
    if (!source.includes(`id: ${JSON.stringify(id)}`) || !source.includes('window.__ModuleLoader__.load(')) {
      throw new Error(`Browser factory registration does not match ${id}`);
    }
    const rev = hash(source);
    const relativeOutput = `plugins/${id.slice(SCOPE.length)}/client.js`;
    const record = {
      id, sourcePath, source, relativeOutput,
      attribution: { name: id, version: metadata.version, license: metadata.license,
        repository: metadata.repository?.url || 'https://github.com/deepseek-ai/deepseek-harness' },
      entry: {
        id, url: `./${relativeOutput}?rev=${rev}`, rev,
        inject: declaration.inject || [],
        external: declaration.external || [],
        ...(declaration.immediately === true ? { immediately: true } : {}),
      },
    };
    records.set(id, record);
    for (const dependency of [...record.entry.inject, ...record.entry.external]) select(dependency);
  }

  for (const root of ROOT_CLIENT_PACKAGES) select(`${SCOPE}${root}`);

  // Reuse the desktop adaptation too: upstream plugins alone retain the
  // Harness wordmark, hero, badge and default blue controls.
  const brandRoot = path.resolve(__dirname, '../backend/dsh-plugins/adh-brand');
  const brandPackage = JSON.parse(fs.readFileSync(path.join(brandRoot, 'package.json'), 'utf8'));
  const brandId = '@aidesign/dsh-client-ui-brand';
  if (brandPackage.name !== brandId || brandPackage.dsh?.client?.platform !== 'web') {
    throw new Error('The desktop Agent brand plugin requires review');
  }
  const brandSource = fs.readFileSync(path.join(brandRoot, 'client.js'), 'utf8');
  const brandRev = hash(brandSource);
  const brandOutput = 'plugins/adh-brand/client.js';
  const brandEntry = { id: brandId, url: `./${brandOutput}?rev=${brandRev}`, rev: brandRev,
    inject: brandPackage.dsh.client.inject, external: [], immediately: true };
  for (const dependency of brandEntry.inject) select(dependency);
  records.set(brandId, { id: brandId, source: brandSource, relativeOutput: brandOutput,
    attribution: { name: brandId, version: brandPackage.version, license: 'AGPL-3.0-only',
      repository: 'https://github.com/bycjhuang/AIDesignHub-OpenSource' }, entry: brandEntry });
  // This is the same declarative style block the desktop host taps into its
  // index. Extract it without importing or starting that loopback-only host.
  const shellStyles = fs.readFileSync(path.join(brandRoot, 'index.js'), 'utf8')
    .match(/<style id="adh-shell-cosmetics">[\s\S]*?<\/style>/g);
  if (shellStyles?.length !== 1) throw new Error('The desktop Agent shell stylesheet requires review');
  const ordered = [];
  const placed = new Set();
  function visit(record) {
    if (placed.has(record.id)) return;
    if (visiting.has(record.id)) throw new Error(`Cyclic browser external: ${record.id}`);
    visiting.add(record.id);
    for (const specifier of record.entry.external) {
      const dependency = records.get(normalizeId(specifier));
      if (dependency) visit(dependency);
    }
    visiting.delete(record.id);
    placed.add(record.id);
    ordered.push(record);
  }
  for (const record of records.values()) visit(record);

  for (const record of ordered) {
    for (const match of record.source.matchAll(/\brequire\("([@a-zA-Z0-9][^"\n]*)"\)/g)) {
      if (!STATIC_MODULES.has(match[1]) && !records.has(normalizeId(match[1]))) {
        throw new Error(`Unresolved browser external in ${record.id}: ${match[1]}`);
      }
    }
    // This bounded roster currently ships as one client artifact per package.
    // Fail on future chunk usage until its delivery contract is reviewed.
    if (record.id !== MODULES_ID && /\.importChunk\s*\(/.test(record.source)) {
      throw new Error(`Browser chunk delivery needs review: ${record.id}`);
    }
  }
  const entries = ordered.map(record => record.entry);
  const batches = entries.map(entry => ({
    phase: entry.id === MODULES_ID ? 'bootstrap' : 'application',
    url: entry.url, rev: entry.rev, entries: [entry.id],
  }));
  const version = JSON.parse(fs.readFileSync(path.join(scopeDir, 'dsh-client-modules', 'package.json'), 'utf8')).version;
  const manifest = { rev: hash(JSON.stringify({ entries, batches })), release: { version }, entries, batches };
  const licensePath = path.join(scopeDir, 'dsh', 'LICENSE');
  const licenseText = fs.readFileSync(licensePath, 'utf8');
  if (!licenseText.includes('MIT License') || !licenseText.includes('Copyright (c) 2026 DeepSeek')) {
    throw new Error('The upstream Harness license requires review');
  }
  return { manifest, bundles: ordered, queueSource: queueSource(), licenseText, shellCss: shellStyles[0] };
}

function buildAgentBoot(options = {}) {
  if (!options.outputDir) throw new Error('An explicit agent outputDir is required');
  const outputDir = path.resolve(options.outputDir);
  const assembled = inspectAgentBoot(options);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const bundle of assembled.bundles) {
    const destination = path.resolve(outputDir, bundle.relativeOutput);
    assertWithin(outputDir, destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bundle.source, 'utf8');
  }
  fs.writeFileSync(path.join(outputDir, 'boot-queue.js'), assembled.queueSource, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'boot-manifest.js'),
    `window.__DSH_BOOT__ = ${JSON.stringify(assembled.manifest).replace(/</g, '\\u003c')};\n`, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'HARNESS-LICENSE.txt'), assembled.licenseText, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'browser-plugin-notice.json'), JSON.stringify({
    source: 'https://github.com/deepseek-ai/deepseek-harness',
    note: 'Original Harness browser UI artifacts and the desktop ADH brand plugin; the public demo transport and synthetic data are separate adapters.',
    packages: assembled.bundles.map(bundle => bundle.attribution),
  }, null, 2), 'utf8');
  const bootstrap = assembled.manifest.entries.find(entry => entry.id === MODULES_ID);
  return {
    manifest: assembled.manifest,
    bundleCount: assembled.bundles.length,
    bundleBytes: assembled.bundles.reduce((sum, bundle) => sum + Buffer.byteLength(bundle.source), 0),
    // Insert before the original Vite module script. The caller owns
    // agent-mock.js and must install its browser-only transport first.
    headHtml: [
      assembled.shellCss,
      '<script src="./agent-mock.js"></script>',
      '<script src="./boot-queue.js"></script>',
      `<script src="${bootstrap.url}"></script>`,
      '<script src="./boot-manifest.js"></script>',
    ].join('\n'),
  };
}

module.exports = { ROOT_CLIENT_PACKAGES, inspectAgentBoot, buildAgentBoot };
