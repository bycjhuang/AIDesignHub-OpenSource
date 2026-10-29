'use strict';

const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { createReadStream, existsSync, readFileSync } = require('node:fs');
const { cp, mkdir, readdir, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DSH_RUNTIME_PINS = Object.freeze({
  nodeVersion: '24.18.1',
  dshVersion: '0.2.1-rc.2',
  pnpmVersion: '11.7.0',
  // Match the upstream rc.2 lockfile, rather than the adapter's floating ^1.1.0 range.
  piAiVersion: '1.1.0',
});

function dshRuntimePaths(cacheRoot, pins = DSH_RUNTIME_PINS) {
  const root = path.join(cacheRoot, 'dsh-runtime', pins.dshVersion);
  return runtimePaths(root);
}

function runtimePaths(root) {
  const nodeDir = path.join(root, 'node');
  const packageDir = path.join(root, 'package');
  return {
    root,
    nodeExe: path.join(nodeDir, 'node.exe'),
    npmCli: path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    dshCli: path.join(packageDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    pnpmCli: path.join(packageDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    manifest: path.join(root, 'runtime-manifest.json'),
  };
}

function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) sums.set(match[2].trim(), match[1]);
  }
  return sums;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('end', () => resolve(hash.digest('hex')));
    stream.once('error', reject);
  });
}

async function download(url, destination, onProgress) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下载失败：${url} (${response.status})`);
  const total = Number(response.headers.get('content-length')) || null;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
  }
  await writeFile(destination, Buffer.concat(chunks));
}

async function downloadWithFallback(url, destination, onProgress) {
  try {
    await download(url, destination, onProgress);
  } catch {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ProgressPreference='SilentlyContinue';Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${destination.replace(/'/g, "''")}' -UseBasicParsing`],
      { windowsHide: true, timeout: 600_000 });
  }
}

async function rmRetry(target, attempts = 8) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function extractZip(archive, destination) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await mkdir(destination, { recursive: true });
  await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`],
    { windowsHide: true, timeout: 600_000 });
}

function readDshRuntimeManifest(paths) {
  try {
    const manifest = JSON.parse(existsSync(paths.manifest) ? readFileSync(paths.manifest, 'utf8') : '');
    if (manifest.schema !== 1 || manifest.nodeVersion !== DSH_RUNTIME_PINS.nodeVersion
      || manifest.dshVersion !== DSH_RUNTIME_PINS.dshVersion || manifest.pnpmVersion !== DSH_RUNTIME_PINS.pnpmVersion
      || manifest.piAiVersion !== DSH_RUNTIME_PINS.piAiVersion) return null;
    return manifest;
  } catch {
    return null;
  }
}

function isDshRuntimeReady(paths) {
  if (readDshRuntimeManifest(paths) === null
    || !existsSync(paths.nodeExe) || !existsSync(paths.npmCli) || !existsSync(paths.dshCli) || !existsSync(paths.pnpmCli)) return false;
  try {
    const modules = path.join(paths.root, 'package', 'node_modules');
    const installedPackage = name => JSON.parse(readFileSync(path.join(modules, name, 'package.json'), 'utf8'));
    const cli = installedPackage('@deepseek-ai/dsh');
    if (cli.version !== DSH_RUNTIME_PINS.dshVersion
      || installedPackage('@earendil-works/pi-ai').version !== DSH_RUNTIME_PINS.piAiVersion
      || installedPackage('pnpm').version !== DSH_RUNTIME_PINS.pnpmVersion) return false;
    // A stale/partial npm tree must not be accepted merely because the CLI exists.
    const names = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm-pi-ai',
      ...Object.keys(cli.dependencies || {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))]);
    return [...names].every(name => installedPackage(name).version === DSH_RUNTIME_PINS.dshVersion);
  } catch {
    return false;
  }
}

async function ensureDshRuntime(options) {
  const pins = DSH_RUNTIME_PINS;
  const targetPaths = dshRuntimePaths(options.cacheRoot, pins);
  if (isDshRuntimeReady(targetPaths)) {
    return { paths: targetPaths, manifest: readDshRuntimeManifest(targetPaths) };
  }
  // Install separately and switch only after validation. Existing versions and
  // incomplete installations remain recoverable; profile/session data is elsewhere.
  const paths = runtimePaths(`${targetPaths.root}.install-${process.pid}-${Date.now()}`);
  await mkdir(paths.root, { recursive: true });

  try {
    const actual = await installNode(paths, targetPaths, options);

    options.onProgress?.('packages', 0, null);
    const packageRoot = path.join(paths.root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ private: true,
      dependencies: { '@deepseek-ai/dsh': pins.dshVersion, pnpm: pins.pnpmVersion, '@earendil-works/pi-ai': pins.piAiVersion },
      overrides: { '@earendil-works/pi-ai': pins.piAiVersion },
    }, null, 2));
    try {
      await execFileAsync(paths.nodeExe, [paths.npmCli, 'install', '--prefix', packageRoot,
        '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
        { windowsHide: true, timeout: 900_000, maxBuffer: 2 * 1024 * 1024, env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          // Native dependency install scripts invoke a bare node on clean machines.
          PATH: [path.dirname(paths.nodeExe), process.env.PATH || ''].join(path.delimiter),
          npm_config_cache: path.join(paths.root, 'npm-cache'),
          npm_config_store_dir: path.join(paths.root, 'pnpm-store'),
        } });
    } catch (error) {
      const detail = error?.stderr || error?.stdout || String(error);
      throw new Error(`DSH_NPM_INSTALL_FAILED: ${detail.slice(-2000)}`);
    }

    const manifest = {
      schema: 1,
      nodeVersion: pins.nodeVersion,
      dshVersion: pins.dshVersion,
      pnpmVersion: pins.pnpmVersion,
      piAiVersion: pins.piAiVersion,
      nodeArchiveSha256: actual,
      installedAt: new Date().toISOString(),
    };
    const staged = `${paths.manifest}.next`;
    await writeFile(staged, JSON.stringify(manifest, null, 2));
    await rename(staged, paths.manifest);
    if (!isDshRuntimeReady(paths)) throw new Error('DSH_RUNTIME_INCOMPLETE');
    let previousRoot = null;
    if (existsSync(targetPaths.root)) {
      previousRoot = `${targetPaths.root}.previous-${Date.now()}`;
      await rename(targetPaths.root, previousRoot);
    }
    try {
      await rename(paths.root, targetPaths.root);
    } catch (error) {
      if (previousRoot) await rename(previousRoot, targetPaths.root);
      throw error;
    }
    options.onProgress?.('verify', 1, 1);
    return { paths: targetPaths, manifest };
  } catch (error) {
    // This is the fresh staging tree only; never recurse into a user-chosen path.
    const parent = path.resolve(path.dirname(targetPaths.root));
    if (path.dirname(path.resolve(paths.root)) === parent && path.basename(paths.root).startsWith(`${pins.dshVersion}.install-`)) {
      await rmRetry(paths.root).catch(() => undefined);
    }
    throw error;
  }
}

async function installNode(paths, targetPaths, options) {
  const pins = DSH_RUNTIME_PINS;
  // Reuse only a complete, matching embedded Node already installed by this Hub.
  const parent = path.dirname(targetPaths.root);
  const siblings = await readdir(parent, { withFileTypes: true });
  for (const item of siblings) {
    if (!item.isDirectory() || item.name.includes('.install-')) continue;
    const candidate = runtimePaths(path.join(parent, item.name));
    try {
      const previous = JSON.parse(readFileSync(candidate.manifest, 'utf8'));
      if (previous.nodeVersion !== pins.nodeVersion || !/^[a-f0-9]{64}$/.test(previous.nodeArchiveSha256)
        || !existsSync(candidate.npmCli)) continue;
      const { stdout } = await execFileAsync(candidate.nodeExe, ['--version'], { windowsHide: true, timeout: 10_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
      if (stdout.trim() !== `v${pins.nodeVersion}`) continue;
      await cp(path.join(candidate.root, 'node'), path.join(paths.root, 'node'), { recursive: true });
      return previous.nodeArchiveSha256;
    } catch { /* Try another complete runtime, then the verified download. */ }
  }

  const archiveName = `node-v${pins.nodeVersion}-win-x64.zip`;
  const archive = path.join(paths.root, archiveName);
  const sumsUrl = `https://nodejs.org/dist/v${pins.nodeVersion}/SHASUMS256.txt`;
  const response = await fetch(sumsUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`NODE_SHASUM_DOWNLOAD_FAILED(${response.status})`);
  const sums = parseShasums(await response.text());
  const expected = sums.get(archiveName);
  if (!expected) throw new Error('NODE_SHASUM_MISSING');
  options.onProgress?.('node', 0, null);
  await downloadWithFallback(`https://nodejs.org/dist/v${pins.nodeVersion}/${archiveName}`, archive,
    (received, total) => options.onProgress?.('node', received, total));
  const actual = await sha256File(archive);
  if (actual !== expected) {
    await rm(archive, { force: true });
    throw new Error('NODE_SHASUM_MISMATCH');
  }
  const extracted = path.join(paths.root, 'node-extract');
  await extractZip(archive, extracted);
  const inner = path.join(extracted, `node-v${pins.nodeVersion}-win-x64`);
  await rename(inner, path.join(paths.root, 'node'));
  await rm(extracted, { recursive: true, force: true });
  await rm(archive, { force: true });

  return actual;
}

async function linkBundleIntoProfile(profileDir, sourceDir, scope, name) {
  const target = path.join(profileDir, 'node_modules', scope, name);
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(sourceDir, target, { recursive: true });
  return target;
}

module.exports = {
  DSH_RUNTIME_PINS,
  dshRuntimePaths,
  parseShasums,
  sha256File,
  readDshRuntimeManifest,
  isDshRuntimeReady,
  ensureDshRuntime,
  linkBundleIntoProfile,
  rmRetry,
};
