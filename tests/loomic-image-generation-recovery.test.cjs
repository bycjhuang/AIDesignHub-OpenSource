'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('canvas images finish after closing their panel and recover after a page refresh', { timeout: 65000 }, async t => {
  const repo = path.resolve(__dirname, '..');
  const executable = path.join(repo, '.runtime', 'electron.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) { t.skip('The isolated Electron UI runtime is unavailable.'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-image-recovery-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^adh-image-recovery-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const env = { ...process.env, ADH_IMAGE_RECOVERY_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, 'fixtures', 'loomic-image-recovery.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Image recovery UI timed out: ' + output.slice(-1800))); }, 55000);
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output.slice(-3000));
  const line = result.output.split(/\r?\n/).find(value => value.startsWith('IMAGE_RECOVERY_RESULT '));
  assert.ok(line, result.output.slice(-1800));
  const checks = JSON.parse(line.slice('IMAGE_RECOVERY_RESULT '.length));
  assert.equal(checks.panelClosed, true); assert.equal(checks.refreshed, true);
  assert.equal(checks.images, 2); assert.equal(checks.submissions, 2); assert.equal(checks.pending, 0); assert.equal(checks.externalRequests, 0);
});
