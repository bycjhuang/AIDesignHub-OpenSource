'use strict';

const fs = require('node:fs/promises');
const { createReadStream, existsSync } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const ROOT_DEPENDENCIES = ['@huggingface/transformers', '@lancedb/lancedb', '@langchain/textsplitters', '@napi-rs/canvas', 'apache-arrow', 'pdf-parse', 'tesseract.js', 'word-extractor'];
const within = (root, child) => { const rel = path.relative(root, child); return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function platformMatches(values, actual) {
  return !Array.isArray(values) || !values.length || !values.includes(`!${actual}`)
    && (!values.some(value => !value.startsWith('!')) || values.includes(actual) || values.includes('any'));
}

async function dependencyClosure(sourceRoot, roots = ROOT_DEPENDENCIES) {
  const modulesRoot = await fs.realpath(path.join(sourceRoot, 'node_modules'));
  const boundary = path.dirname(modulesRoot);
  const packages = new Map();
  async function resolvePackage(name, from) {
    let current = from;
    while (within(boundary, current)) {
      const candidate = path.join(current, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) {
        const real = await fs.realpath(candidate);
        if (!within(modulesRoot, real)) throw new Error(`Knowledge dependency escapes node_modules: ${name}`);
        return real;
      }
      if (current === boundary) break;
      current = path.dirname(current);
    }
    return null;
  }
  async function visit(name, from, optional = false) {
    const directory = await resolvePackage(name, from);
    if (!directory) { if (optional) return null; throw new Error(`Missing knowledge dependency ${name}`); }
    const manifest = await json(path.join(directory, 'package.json'));
    if (!platformMatches(manifest.os, process.platform) || !platformMatches(manifest.cpu, process.arch)) {
      if (optional) return null;
      throw new Error(`Unsupported knowledge dependency ${name}`);
    }
    const relative = path.relative(modulesRoot, directory);
    if (packages.has(relative)) return relative;
    const item = { name: manifest.name, version: manifest.version, path: relative.split(path.sep).join('/'), dependencies: [] };
    packages.set(relative, item);
    const dependencies = new Map();
    for (const dep of Object.keys(manifest.dependencies || {})) dependencies.set(dep, false);
    for (const dep of Object.keys(manifest.optionalDependencies || {})) dependencies.set(dep, true);
    for (const dep of Object.keys(manifest.peerDependencies || {})) if (!dependencies.has(dep)) dependencies.set(dep, Boolean(manifest.peerDependenciesMeta?.[dep]?.optional));
    for (const [dep, isOptional] of dependencies) {
      const resolved = await visit(dep, directory, isOptional);
      if (resolved) item.dependencies.push({ name: dep, path: resolved.split(path.sep).join('/') });
    }
    return relative;
  }
  for (const name of roots) await visit(name, boundary);
  return { modulesRoot, packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

async function filesUnder(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(root, rel));
    else if (entry.isFile()) result.push(rel);
    else throw new Error(`Unexpected link in portable knowledge runtime: ${rel}`);
  }
  return result;
}

async function buildWorker(sourceRoot, payloadRoot) {
  const sourceCode = path.resolve(__dirname, '../backend/knowledge-engine');
  const esbuild = require(path.join(sourceRoot, 'node_modules', 'esbuild'));
  await esbuild.build({ entryPoints: [path.join(sourceCode, 'worker.ts')], bundle: true,
    platform: 'node', target: 'node22', format: 'cjs', outfile: path.join(payloadRoot, 'worker.cjs'),
    external: ROOT_DEPENDENCIES, logLevel: 'silent' });
}

async function refreshKnowledgeWorker({ sourceRoot, payloadRoot }) {
  sourceRoot = path.resolve(sourceRoot); payloadRoot = path.resolve(payloadRoot);
  const manifestPath = path.join(payloadRoot, 'payload-manifest.json');
  const manifest = await json(manifestPath);
  if (manifest.schema !== 1 || manifest.importedUserData !== false) throw new Error('Knowledge payload manifest is invalid');
  await buildWorker(sourceRoot, payloadRoot);
  const records = await json(path.join(payloadRoot, 'payload-files.json'));
  const worker = records.find(item => item.path === 'worker.cjs');
  if (!worker) throw new Error('Knowledge payload has no worker inventory');
  worker.bytes = (await fs.stat(path.join(payloadRoot, 'worker.cjs'))).size;
  worker.sha256 = await digest(path.join(payloadRoot, 'worker.cjs'));
  const sourceCode = path.resolve(__dirname, '../backend/knowledge-engine');
  manifest.sourceFiles = [];
  for (const rel of await filesUnder(sourceCode)) manifest.sourceFiles.push({ path: rel.split(path.sep).join('/'), sha256: await digest(path.join(sourceCode, rel)) });
  const tree = createHash('sha256');
  for (const item of records) tree.update(`${item.path}\0${item.bytes}\0${item.sha256}\n`);
  manifest.bytes = records.reduce((sum, item) => sum + item.bytes, 0);
  manifest.sha256 = tree.digest('hex'); manifest.compiledAt = new Date().toISOString();
  await fs.writeFile(path.join(payloadRoot, 'payload-files.json'), JSON.stringify(records));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { payloadRoot, ...manifest };
}

async function stageKnowledgeEngine({ sourceRoot, payloadRoot, nodeExe, onProgress = () => {} }) {
  sourceRoot = path.resolve(sourceRoot);
  payloadRoot = path.resolve(payloadRoot);
  if (within(sourceRoot, payloadRoot)) throw new Error('Knowledge runtime must be outside the reference project');
  const stage = `${payloadRoot}.next-${randomUUID()}`;
  const sourceCode = path.resolve(__dirname, '../backend/knowledge-engine');
  await fs.mkdir(stage, { recursive: true });
  try {
    const closure = await dependencyClosure(sourceRoot);
    onProgress(`copying ${closure.packages.length} public production dependencies`);
    for (const item of closure.packages) {
      const from = path.join(closure.modulesRoot, item.path);
      const to = path.join(stage, 'node_modules', item.path);
      await fs.cp(from, to, { recursive: true, dereference: true, filter: async file => {
        const rel = path.relative(from, file);
        const segments = rel.split(path.sep);
        if (segments.includes('node_modules') || segments.includes('.git') || segments.some(name => /^\.env(?:\.|$)/i.test(name)) || /\.(?:log|map)$/i.test(rel)) return false;
        const real = await fs.realpath(file);
        if (!within(closure.modulesRoot, real)) throw new Error(`Public dependency file escaped: ${item.name}`);
        if (item.name === 'onnxruntime-node') {
          const native = /^bin\/napi-v\d+\/(win32|linux|darwin)(?:\/([^/]+))?/.exec(rel.split(path.sep).join('/'));
          if (native && (native[1] !== process.platform || native[2] && native[2] !== process.arch)) return false;
        }
        return true;
      } });
    }
    const assetsFrom = path.join(sourceRoot, 'desktop-assets', 'knowledge');
    await fs.cp(assetsFrom, path.join(stage, 'assets'), { recursive: true });
    const assetManifest = await json(path.join(stage, 'assets', 'manifest.json'));
    const model = path.join(stage, 'assets', 'models', assetManifest.modelId, 'onnx', assetManifest.model.fileName);
    if (await digest(model) !== assetManifest.model.sha256) throw new Error('Knowledge model asset hash mismatch');
    for (const item of assetManifest.ocr) if (await digest(path.join(stage, 'assets', 'ocr', item.fileName)) !== item.sha256) throw new Error(`OCR asset hash mismatch: ${item.language}`);
    if (!nodeExe || !existsSync(nodeExe) || /electron(?:\.exe)?$/i.test(path.basename(nodeExe))) throw new Error('Knowledge staging requires a standalone Node executable');
    await fs.mkdir(path.join(stage, 'node'), { recursive: true });
    await fs.copyFile(nodeExe, path.join(stage, 'node', 'node.exe'));
    const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE');
    if (existsSync(nodeLicense)) await fs.copyFile(nodeLicense, path.join(stage, 'node', 'LICENSE'));
    await fs.cp(path.join(sourceCode, 'vendor'), path.join(stage, 'licenses'), { recursive: true });
    await buildWorker(sourceRoot, stage);
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'aidesignhub-offline-knowledge-runtime', private: true, type: 'commonjs', dependencies: Object.fromEntries(closure.packages.filter(item => ROOT_DEPENDENCIES.includes(item.name)).map(item => [item.name, item.version])) }, null, 2));
    await fs.writeFile(path.join(stage, 'production-dependencies.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, roots: ROOT_DEPENDENCIES, packages: closure.packages }, null, 2));
    const sourceRecords = [];
    for (const rel of await filesUnder(sourceCode)) sourceRecords.push({ path: rel.split(path.sep).join('/'), sha256: await digest(path.join(sourceCode, rel)) });
    const list = (await filesUnder(stage)).sort();
    const records = new Array(list.length);
    let next = 0;
    let complete = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < list.length) {
        const index = next++;
        const file = path.join(stage, list[index]);
        records[index] = { path: list[index].split(path.sep).join('/'), bytes: (await fs.stat(file)).size, sha256: await digest(file) };
        complete += 1;
        if (complete % 2000 === 0) onProgress(`verified ${complete}/${list.length} runtime files`);
      }
    }));
    const tree = createHash('sha256');
    for (const item of records) tree.update(`${item.path}\0${item.bytes}\0${item.sha256}\n`);
    const manifest = { schema: 1, stagedAt: new Date().toISOString(), sourceRoot, publicAssetsOnly: true, importedUserData: false, offlineOnly: true,
      packages: closure.packages.length, files: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0), sha256: tree.digest('hex'), sourceFiles: sourceRecords,
      adaptations: ['Standalone Node IPC worker', 'E5 and OCR forced to bundled offline assets', 'Full search chunk text retained', 'Original AnythingLLM upstream source and licenses retained'] };
    await fs.writeFile(path.join(stage, 'payload-files.json'), JSON.stringify(records));
    await fs.writeFile(path.join(stage, 'payload-manifest.json'), JSON.stringify(manifest, null, 2));
    let previousPayloadRoot;
    if (existsSync(payloadRoot)) { previousPayloadRoot = `${payloadRoot}.previous-${randomUUID()}`; await fs.rename(payloadRoot, previousPayloadRoot); }
    try { await fs.rename(stage, payloadRoot); } catch (error) { if (previousPayloadRoot) await fs.rename(previousPayloadRoot, payloadRoot); throw error; }
    return { payloadRoot, previousPayloadRoot, ...manifest };
  } catch (error) {
    // stage is the exact UUID-named temporary sibling of the explicit payloadRoot.
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = { ROOT_DEPENDENCIES, dependencyClosure, stageKnowledgeEngine, refreshKnowledgeWorker };
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const sourceRoot = value('--source-root');
  const nodeExe = value('--node');
  const payloadRoot = value('--payload-root') || path.resolve(__dirname, '../.runtime/knowledge');
  if (!sourceRoot || !nodeExe && !args.includes('--compile-only')) { console.error('Usage: node scripts/stage-knowledge-engine.cjs --source-root <reference repo> --node <standalone node.exe> [--payload-root <directory>] [--compile-only]'); process.exitCode = 1; }
  else (args.includes('--compile-only') ? refreshKnowledgeWorker({ sourceRoot, payloadRoot })
    : stageKnowledgeEngine({ sourceRoot, nodeExe, payloadRoot, onProgress: message => console.info(`[knowledge-stage] ${message}`) }))
    .then(result => console.log(JSON.stringify({ payloadRoot: result.payloadRoot, packages: result.packages, files: result.files, bytes: result.bytes, sha256: result.sha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
