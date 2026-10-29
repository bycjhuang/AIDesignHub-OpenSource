'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { auditDirectory, isPrivatePath, listFiles } = require('./release-security.cjs');
const run = promisify(execFile);

const root = path.resolve(__dirname, '..');
const stageRoot = path.join(root, '.runtime', 'installer-resources', 'public');
const harnessVersion = '0.2.1-rc.2';

async function required(file) { if (!(await fs.stat(file).catch(() => null))) throw new Error(`Missing installer prerequisite: ${path.relative(root, file)}`); }
async function main() {
  // Only copy explicit runtime roots. Never copy a user's whole cache or profile.
  const cachedHarness = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'bycj-design-workbench-prototype', 'cache', 'dsh-runtime', harnessVersion);
  const stagedHarness = path.join(root, '.runtime', 'installer-resources', 'dsh-runtime', harnessVersion);
  const harness = (await fs.stat(path.join(cachedHarness, 'package')).catch(() => null)) ? cachedHarness : stagedHarness;
  const sources = [
    [path.join(harness, 'node'), `dsh-runtime/${harnessVersion}/node`],
    [path.join(harness, 'package'), `dsh-runtime/${harnessVersion}/package`],
    [path.join(harness, 'runtime-manifest.json'), `dsh-runtime/${harnessVersion}/runtime-manifest.json`],
    [path.join(root, '.runtime', 'professional-mcp'), 'professional-mcp'],
    [path.join(root, '.runtime', 'knowledge'), 'knowledge'],
  ];
  await required(path.join(root, 'Loomic-main/Loomic-main/apps/web/out/index.html'));
  for (const [source] of sources) await required(source);
  await required(path.join(root, '.runtime/knowledge/node/node.exe'));
  await required(path.join(root, '.runtime/knowledge/worker.cjs'));
  // Fixed target below the installer staging directory; never remove source runtimes.
  if (path.resolve(stageRoot) !== path.resolve(root, '.runtime/installer-resources/public')) throw new Error('Invalid staging destination');
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true });
  for (const [source, destination] of sources) {
    const target = path.join(stageRoot, destination);
    if (process.platform === 'win32' && (await fs.stat(source)).isDirectory()) {
      // Native parallel copying avoids a serial filesystem round-trip per npm file.
      try {
        await run('robocopy.exe', [source, target, '/E', '/MT:16', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', 'npm-cache', '__pycache__', '.cache', '.git', '.dsh', '.codex', '.claude', '.agents', '/XF', '.env', '.env.*', '.npmrc'], { windowsHide: true, maxBuffer: 1024 * 1024 });
      } catch (error) { if (!(Number.isInteger(error.code) && error.code < 8)) throw new Error(`Runtime copy failed: ${destination}`); }
    } else await fs.cp(source, target, { recursive: true });
    console.info(`[installer-stage] copied ${destination}`);
  }
  for (const file of await listFiles(stageRoot)) {
    if (isPrivatePath(path.relative(stageRoot, file))) await fs.rm(file);
  }
  // Provenance stays useful without disclosing the developer's filesystem.
  for (const name of ['knowledge', 'professional-mcp']) {
    const file = path.join(stageRoot, name, 'payload-manifest.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.sourceRoot) data.sourceRoot = 'build-input/knowledge';
    if (data.source) data.source = 'build-input/professional-mcp';
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  }
  const result = await auditDirectory(stageRoot);
  const auditRoot = path.join(root, '.runtime/release-audit');
  await fs.mkdir(auditRoot, { recursive: true });
  await fs.writeFile(path.join(auditRoot, 'runtime-audit.json'), JSON.stringify(result, null, 2));
  console.info(`[installer-stage] checked ${result.files} files; findings: ${result.findings.length}`);
  if (result.findings.length) {
    for (const item of result.findings.slice(0, 25)) console.error(JSON.stringify(item));
    throw new Error('Runtime privacy audit failed. No user data has been modified.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
