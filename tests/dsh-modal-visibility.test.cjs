'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('native Agent view yields to shell dialogs and restores after nested dialogs, resize and delayed attach', { timeout: 30000 }, async t => {
  const executable = path.join(__dirname, '../.runtime/electron.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) return t.skip('The isolated Electron UI runtime is unavailable.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-modal-visibility-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(root), /^adh-modal-visibility-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, ADH_MODAL_VISIBILITY_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, 'fixtures/dsh-modal-visibility.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native modal test timed out.')); }, 25000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, (result.stderr || result.stdout).slice(-2500));
  const report = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('ADH_MODAL_RESULT ')).slice('ADH_MODAL_RESULT '.length));
  for (const name of ['modelDialog', 'nestedDialogs', 'resizeWhileHidden', 'sameSession', 'delayedAttach', 'legacyModal', 'removedDialog']) assert.equal(report[name], true, name);
  assert.equal(report.networkRequests, 0);
});
