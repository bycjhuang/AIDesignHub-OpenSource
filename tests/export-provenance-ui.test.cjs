'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
test('canvas PNG exports preserve artwork and carry a visible band plus valid version metadata', { timeout: 30000 }, async t => {
  const repo = path.resolve(__dirname, '..'), exe = path.join(repo, '.runtime/electron.exe');
  if (!fs.existsSync(exe) || !fs.existsSync(path.join(repo, 'Loomic-main/Loomic-main/node_modules/typescript'))) return t.skip('Local Electron and canvas build dependencies are required.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-export-proof-'));
  t.after(() => { const real = fs.realpathSync(root); assert.equal(path.dirname(real).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(real), /^adh-export-proof-/); fs.rmSync(real, { recursive: true, force: true }); });
  const env = { ...process.env, ADH_EXPORT_PROOF_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(exe, [path.join(__dirname, 'fixtures/export-provenance.cjs')], { env, windowsHide: true });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Export proof timed out.')); }, 25000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output.slice(-2200)); assert.match(result.output, /EXPORT_PROOF_RESULT/);
});
