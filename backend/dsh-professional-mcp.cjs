'use strict';

// Native-software bridges adapted from BYCJ Design's desktop integration.
// Only redistributable server/runtime assets enter this payload; no BYCJ
// account, model route, cloud service, or application profile is imported.
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, existsSync, readFileSync, readdirSync } = require('node:fs');
const { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');

const SOFTWARE = Object.freeze([
  { key: 'blender', title: 'Blender', runtime: 'python', entry: 'blender/launcher.py', env: { DISABLE_TELEMETRY: '1', BLENDER_MCP_DISABLE_TELEMETRY: '1', MCP_DISABLE_TELEMETRY: '1' } },
  { key: '3dsmax', title: '3ds Max', runtime: 'python', entry: '3dsmax/launcher.py' },
  { key: 'photoshop', title: 'Photoshop', runtime: 'node', entry: 'photoshop/dist/index.js', env: { POSTHOG_DISABLED: '1' } },
  { key: 'illustrator', title: 'Illustrator', runtime: 'node', entry: 'illustrator/dist/index.js' },
  { key: 'revit', title: 'Revit', runtime: 'node', entry: 'revit/build/index.js' },
  { key: 'rhino', title: 'Rhino', runtime: 'python', entry: 'rhino/launcher.py' },
  { key: 'sketchup', title: 'SketchUp', runtime: 'python', entry: 'sketchup/launcher.py', env: { SKETCHUP_MCP_PORT: '9877' } },
  { key: 'indesign', title: 'InDesign', runtime: 'node', entry: 'indesign/vendor/dist/bridge/index.mjs', env: { COM_BRIDGE_ENABLED: 'true' } },
  { key: 'premiere', title: 'Premiere Pro', runtime: 'node', entry: 'premiere/vendor/dist/bridge/index.mjs', env: { PREMIERE_TEMP_DIR: path.join(tmpdir(), 'premiere-mcp-bridge'), PREMIERE_MCP_TELEMETRY: '0', PREMIERE_MCP_UPDATE_CHECK: '0' } },
  { key: 'aftereffects', title: 'After Effects', runtime: 'node', entry: 'ae/vendor/dist/bridge/index.mjs' },
  { key: 'lightroom', title: 'Lightroom Classic', runtime: 'node', entry: 'lightroom/vendor/dist/index.mjs', launchEntry: 'lightroom/vendor/dist/adh-stdio.mjs' },
  { key: 'c4d', title: 'Cinema 4D', runtime: 'python', entry: 'c4d/launcher.py' },
  { key: 'archicad', title: 'ArchiCAD', runtime: 'python', entry: 'archicad/launcher.py' },
  { key: 'autocad', title: 'AutoCAD', runtime: 'python', entry: 'autocad/launcher.py' },
].map(item => Object.freeze(item)));
const PROFESSIONAL_MCP_IDS = Object.freeze([...SOFTWARE.map(item => `adh-mcp-${item.key}`), 'adh-mcp-rhino-official']);

function professionalMcpRoot(cacheRoot) { return path.join(cacheRoot, 'professional-mcp'); }
function payloadStatus(payloadRoot) {
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(payloadRoot, 'payload-manifest.json'), 'utf8')); } catch { /* not staged */ }
  const entries = SOFTWARE.map(item => ({ ...item, path: path.join(payloadRoot, 'servers', item.launchEntry || item.entry) }));
  const missing = entries.filter(item => !existsSync(item.path)).map(item => item.key);
  const pythonReady = existsSync(path.join(payloadRoot, 'python', 'python.exe'));
  return { payloadRoot, ready: manifest?.schema === 1 && pythonReady && missing.length === 0, manifest, missing, pythonReady };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

// Runtime caches, logs and local .env files are never part of the bridge copy.
function skipAsset(name) {
  return ['.git', '__pycache__', 'logs', '.cache'].includes(name)
    || /^\.env(?:\.|$)/i.test(name) || /\.(?:pyc|pyo|log)$/i.test(name);
}

async function assetFiles(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (skipAsset(entry.name)) continue;
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await assetFiles(root, rel));
    else if (entry.isFile()) result.push(rel);
    else throw new Error(`PROFESSIONAL_MCP_UNSUPPORTED_LINK: ${rel}`);
  }
  return result;
}

const LIGHTROOM_AUTO_INSTALL = '  ensurePluginInstalled(here, (m) => console.error(m));';
function patchLightroomStartup(source) {
  if (source.split(LIGHTROOM_AUTO_INSTALL).length !== 2) throw new Error('PROFESSIONAL_MCP_LIGHTROOM_PATCH_UNSUPPORTED: original bundle was preserved');
  // Preserve the original first-line shebang so the generated ESM stays valid.
  return source.replace(LIGHTROOM_AUTO_INSTALL, '  // Plugin installation is an explicit install-plugin command in AIDesignHub.');
}

async function materializeLightroomEntry(payloadRoot) {
  const item = SOFTWARE.find(software => software.key === 'lightroom');
  const original = path.join(payloadRoot, 'servers', item.entry);
  if (!existsSync(original)) return null;
  const target = path.join(payloadRoot, 'servers', item.launchEntry);
  const source = await readFile(original, 'utf8');
  const patched = patchLightroomStartup(source);
  let current;
  try { current = await readFile(target, 'utf8'); } catch { /* first migration */ }
  if (current !== patched) await writeFile(target, patched);
  return { id: 'lightroom-explicit-install-v1', source: `servers/${item.entry}`,
    path: `servers/${item.launchEntry}`, bytes: Buffer.byteLength(patched),
    originalSha256: createHash('sha256').update(source).digest('hex'),
    sha256: createHash('sha256').update(patched).digest('hex') };
}

async function migrateInstalledPayload(payloadRoot) {
  const before = payloadStatus(payloadRoot);
  if (before.manifest?.schema !== 1) return before;
  const patch = await materializeLightroomEntry(payloadRoot);
  if (!patch || before.manifest.patches?.some(item => item.id === patch.id && item.sha256 === patch.sha256)) return payloadStatus(payloadRoot);
  const files = JSON.parse(await readFile(path.join(payloadRoot, 'payload-files.json'), 'utf8'))
    .filter(item => item.path !== patch.path);
  files.push({ path: patch.path, bytes: patch.bytes, sha256: patch.sha256 });
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const digest = createHash('sha256');
  for (const file of files) digest.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  const manifest = { ...before.manifest, files: files.length,
    bytes: files.reduce((sum, item) => sum + item.bytes, 0), sha256: digest.digest('hex'), patches: [patch] };
  await writeFile(path.join(payloadRoot, 'payload-files.json'), JSON.stringify(files));
  await writeFile(path.join(payloadRoot, 'payload-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return payloadStatus(payloadRoot);
}

/**
 * Stage once from an explicit offline mcp-bridges directory. Subsequent starts
 * inspect the installed payload and never copy or download its dependencies.
 * Returns { payloadRoot, ready, manifest, missing, pythonReady }.
 */
async function ensureProfessionalMcp({ cacheRoot, sourceDir, onProgress } = {}) {
  if (!cacheRoot) throw new TypeError('Professional MCP cacheRoot is required');
  const payloadRoot = professionalMcpRoot(path.resolve(cacheRoot));
  if (!sourceDir) return migrateInstalledPayload(payloadRoot);
  const source = path.resolve(sourceDir);
  if (source === payloadRoot || source.startsWith(`${payloadRoot}${path.sep}`)
    || payloadRoot.startsWith(`${source}${path.sep}`)) throw new Error('PROFESSIONAL_MCP_INVALID_SOURCE');
  if (!existsSync(path.join(source, 'python', 'python.exe')) || SOFTWARE.some(item => !existsSync(path.join(source, 'servers', item.entry)))) {
    throw new Error('PROFESSIONAL_MCP_SOURCE_INCOMPLETE: Python and all 14 software servers are required');
  }
  const staged = `${payloadRoot}.next-${randomUUID()}`;
  const backup = `${payloadRoot}.previous-${randomUUID()}`;
  await mkdir(staged, { recursive: true });
  let backedUp = false;
  try {
    const files = (await assetFiles(source)).sort();
    const records = new Array(files.length);
    let next = 0;
    let complete = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(12, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        const rel = files[index];
        const from = path.join(source, rel);
        const to = path.join(staged, rel);
        await mkdir(path.dirname(to), { recursive: true });
        const expected = await sha256File(from);
        await copyFile(from, to);
        const actual = await sha256File(to);
        if (actual !== expected) throw new Error(`PROFESSIONAL_MCP_COPY_MISMATCH: ${rel}`);
        records[index] = { path: rel.split(path.sep).join('/'), bytes: (await stat(to)).size, sha256: actual };
        complete += 1;
        if (complete % 1000 === 0 || complete === files.length) onProgress?.({ complete, total: files.length });
      }
    }));
    const failed = workers.find(worker => worker.status === 'rejected');
    if (failed) throw failed.reason;
    const lightroomPatch = await materializeLightroomEntry(staged);
    if (lightroomPatch) {
      const previousGenerated = records.findIndex(record => record.path === lightroomPatch.path);
      if (previousGenerated >= 0) records.splice(previousGenerated, 1);
      records.push({ path: lightroomPatch.path, bytes: lightroomPatch.bytes, sha256: lightroomPatch.sha256 });
    }
    records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const digest = createHash('sha256');
    for (const file of records) digest.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
    const manifest = { schema: 1, stagedAt: new Date().toISOString(), source,
      origin: 'BYCJ Design desktop professional software MCP bridges',
      software: SOFTWARE.map(item => ({ key: item.key, title: item.title, entry: item.entry })),
      files: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0), sha256: digest.digest('hex'),
      patches: lightroomPatch ? [lightroomPatch] : [] };
    await writeFile(path.join(staged, 'payload-files.json'), JSON.stringify(records));
    await writeFile(path.join(staged, 'payload-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(payloadRoot)) { await rename(payloadRoot, backup); backedUp = true; }
    try { await rename(staged, payloadRoot); }
    catch (error) { if (backedUp) await rename(backup, payloadRoot); throw error; }
    // Retain the previous payload for recovery. Staging never deletes it.
    return { ...payloadStatus(payloadRoot), ...(backedUp ? { previousPayloadRoot: backup } : {}) };
  } catch (error) {
    // staged is a UUID-named child of the explicitly supplied cacheRoot.
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function findRhinoRouter(appData = process.env.APPDATA) {
  if (!appData) return null;
  function find(root, depth) {
    if (depth < 0) return null;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const file = path.join(root, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'rhino-mcp-router.exe') return file;
      if (entry.isDirectory()) { const hit = find(file, depth - 1); if (hit) return hit; }
    }
    return null;
  }
  for (const [version, major] of [['8.0', 8], ['9.0', 9]]) {
    const command = find(path.join(appData, 'McNeel', 'Rhinoceros', 'packages', version), 6);
    if (command) return { command, major };
  }
  return null;
}

/** Return Cordis insert entries; user-defined MCP entries are merged by caller. */
function buildProfessionalMcpEntries({ payloadRoot, nodeExe, appData } = {}) {
  const entries = [];
  const python = payloadRoot && path.join(payloadRoot, 'python', 'python.exe');
  if (payloadRoot) for (const item of SOFTWARE) {
    const entry = path.join(payloadRoot, 'servers', item.launchEntry || item.entry);
    const command = item.runtime === 'python' ? python : nodeExe;
    if (!command || !existsSync(command) || !existsSync(entry)) continue;
    entries.push({ id: `adh-mcp-${item.key}`, name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: item.key, transport: 'stdio', command, args: [entry],
      failOnStartupError: false,
      env: { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', ...item.env },
    } });
  }
  const router = findRhinoRouter(appData);
  if (router) entries.push({ id: 'adh-mcp-rhino-official', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'rhino-official', transport: 'stdio', command: router.command,
    args: ['--default-version', String(router.major)], failOnStartupError: false,
  } });
  return entries;
}

module.exports = { SOFTWARE, PROFESSIONAL_MCP_IDS, professionalMcpRoot, payloadStatus, patchLightroomStartup,
  ensureProfessionalMcp, buildProfessionalMcpEntries, findRhinoRouter };
