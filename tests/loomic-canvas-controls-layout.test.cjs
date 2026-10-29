'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('original canvas model settings and chat controls do not overlap at desktop, tablet and mobile widths', { timeout: 70000 }, async t => {
  const repo = path.resolve(__dirname, '..');
  const executable = path.join(repo, '.runtime', 'electron.exe');
  const staticRoot = path.join(repo, 'Loomic-main', 'Loomic-main', 'apps', 'web', 'out');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) { t.skip('The isolated Electron UI runtime is unavailable.'); return; }
  if (!fs.existsSync(path.join(staticRoot, 'home.html'))) { t.skip('Build the original Loomic web UI first.'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-loomic-controls-ui-'));
  const artifactDir = path.join(repo, '.runtime', 'test-artifacts', 'loomic-canvas-controls-layout');
  t.after(() => {
    const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(resolved), /^adh-loomic-controls-ui-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const env = { ...process.env, ADH_LOOMIC_CONTROLS_TEST_ROOT: temporary, ADH_LOOMIC_CONTROLS_ARTIFACTS: artifactDir, ADH_LOOMIC_CONTROLS_STATIC_ROOT: staticRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, 'fixtures', 'loomic-canvas-controls-layout.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`The isolated controls test timed out. ${(stdout + stderr).slice(-3000)}`)); }, 60000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, (result.stderr || result.stdout).slice(-5000));
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('ADH_LOOMIC_CONTROLS_RESULT '));
  assert(line, 'The real original canvas DOM must report its measurements.');
  const checks = JSON.parse(line.slice('ADH_LOOMIC_CONTROLS_RESULT '.length));
  assert.equal(checks.measurements.length, 6);
  for (const width of [1600, 1024, 760]) {
    for (const chatOpen of [true, false]) {
      const measurement = checks.measurements.find(row => row.width === width && row.chatOpen === chatOpen);
      assert(measurement, `${width}px/${chatOpen}`);
      assert.equal(measurement.innerWidth, width);
      assert.equal(measurement.intersects, false, JSON.stringify(measurement));
      assert.equal(measurement.controlOnScreen, true, JSON.stringify(measurement));
      if (!chatOpen) { assert.equal(measurement.apiHit, true); assert.equal(measurement.chatHit, true); }
    }
  }
  assert.equal(checks.chatCalls, 0); assert.equal(checks.imageCalls, 0); assert.equal(checks.completedExternalRequests, 0);
  for (const screenshot of checks.screenshots) assert(fs.statSync(screenshot).size > 1000);
  t.diagnostic(`Original canvas control measurements and screenshots: ${artifactDir}`);
});
