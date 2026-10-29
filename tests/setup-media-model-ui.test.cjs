'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('unified model dialog keeps text behavior and manages image/video profiles through mock IPC', { timeout: 30000 }, async t => {
  const executable = path.join(__dirname, '..', '.runtime', 'electron.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) { t.skip('The isolated Electron UI runtime is unavailable.'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-media-model-ui-'));
  t.after(() => {
    const real = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(real).toLowerCase(), parent.toLowerCase());
    assert.match(path.basename(real), /^adh-media-model-ui-/);
    fs.rmSync(real, { recursive: true, force: true });
  });
  const env = { ...process.env, ADH_MEDIA_UI_TEST_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, 'fixtures', 'setup-media-model-ui-smoke.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('ADH_MEDIA_UI_RESULT '));
  assert.equal(result.code, 0, (result.stderr || result.stdout).slice(-3000));
  assert(line, 'The isolated UI must report its assertions.');
  const checks = JSON.parse(line.slice('ADH_MEDIA_UI_RESULT '.length));
  assert.equal(checks.textProviderBehavior, true); assert.equal(checks.textSavePreserved, true);
  assert.equal(checks.blankKeyPreserved, true); assert.equal(checks.multipleImages, true); assert.equal(checks.defaultChanged, true);
  assert.equal(checks.videoMetadataOnly, true); assert.equal(checks.deleted, true); assert.equal(checks.changedEvents, true);
  assert.equal(checks.videoPlaceholder, true); assert.equal(checks.compactMedia, true);
  assert.equal(checks.localizedError, true); assert.equal(checks.smallWidth, true); assert.equal(checks.secretHidden, true); assert.equal(checks.paidNetworkCalls, 0);
  for (const name of ['singleModelDialog', 'savedModelsAreStatus', 'compactApimart', 'sharedKeyUpdated']) assert.equal(checks[name], true, name);
  for (const name of ['sharedTextLayout', 'sharedFooter', 'checkboxAligned', 'textSwitchPreserved', 'textSaveHidden', 'footerLabelUpdated', 'smallTextWidth']) assert.equal(checks[name], true, name);
});
