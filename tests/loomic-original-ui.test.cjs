'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('original Loomic Home, Excalidraw and Agent UI generate, reference-edit and restore local images', { timeout: 100000 }, async t => {
  const repo = path.resolve(__dirname, '..');
  const executable = path.join(repo, '.runtime', 'electron.exe');
  const staticRoot = path.join(repo, 'Loomic-main', 'Loomic-main', 'apps', 'web', 'out');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) { t.skip('The isolated Electron UI runtime is unavailable.'); return; }
  if (!fs.existsSync(path.join(staticRoot, 'home.html'))) { t.skip('Build the original Loomic web UI with node scripts/build-loomic.cjs first.'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-loomic-original-ui-'));
  const artifactDir = path.join(repo, '.runtime', 'test-artifacts', 'loomic-original-ui');
  t.after(() => {
    const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^adh-loomic-original-ui-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const env = { ...process.env, ADH_LOOMIC_UI_TEST_ROOT: temporary, ADH_LOOMIC_UI_ARTIFACTS: artifactDir, ADH_LOOMIC_UI_STATIC_ROOT: staticRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, 'fixtures', 'loomic-original-ui-smoke.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`The isolated original UI smoke timed out. ${(stdout + stderr).slice(-3000)}`)); }, 90000);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, (result.stderr || result.stdout).slice(-5500));
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('ADH_LOOMIC_ORIGINAL_UI_RESULT '));
  assert(line, 'The original UI fixture must report its results.');
  const checks = JSON.parse(line.slice('ADH_LOOMIC_ORIGINAL_UI_RESULT '.length));
  for (const name of ['originalHome', 'homeBrand', 'newProject', 'originalExcalidraw', 'originalAgentSidebar', 'imageCard', 'localCanvasSaved', 'referencePicker', 'referenceImages', 'refreshRestored', 'noRepeatedProviderCalls', 'webSocketFlow']) assert.equal(checks[name], true, name);
  assert.equal(checks.chatCalls, 2); assert.equal(checks.imageCalls, 2); assert.equal(checks.realNetworkRequests, 0);
  for (const screenshot of checks.screenshots) assert(fs.statSync(screenshot).size > 1000, screenshot);
  t.diagnostic(`Original UI screenshots: ${artifactDir}`);
});
