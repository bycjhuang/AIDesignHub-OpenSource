'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sourceGroups, coverageText } = require('../knowledge-workbench-ui.js');

test('knowledge source folders preserve original paths and source records', () => {
  const one = { id: 'one', name: '消防规范.pdf', path: 'D:\\项目资料\\规范\\消防规范.pdf' };
  const two = { id: 'two', name: '任务书.docx', path: 'D:\\项目资料\\任务书.docx' };
  const three = { id: 'three', name: '会议纪要.txt' };
  const groups = sourceGroups([one, three, two]);
  assert.equal(groups.length, 3);
  assert.ok(groups.some(group => group.folder === 'D:/项目资料/规范' && group.items[0] === one));
  assert.ok(groups.some(group => group.folder === '资料文件' && group.items[0] === three));
  assert.equal(one.path, 'D:\\项目资料\\规范\\消防规范.pdf');
  const copied = { id: 'copy', name: '原文件.docx', filePath: 'D:/Hub/knowledge-workbench-v1/projects/abc/files/4cd7ddaa-ef41-4184-bc88-4aa77b0b6ee9/原文件.docx' };
  assert.equal(sourceGroups([copied])[0].folder, '资料文件');
});

test('knowledge coverage reports partial totals honestly, including zero processed records', () => {
  assert.equal(coverageText({ processedSources: 0, totalSources: 8, processedChunks: 2, totalChunks: 200 }), '已处理 0/8 份资料，2/200 个片段');
  assert.equal(coverageText('只检索相关片段，未逐份整理。'), '只检索相关片段，未逐份整理。');
  assert.equal(coverageText(null), '');
  assert.equal(coverageText({ scope: 'search', processedSources: 2, totalSources: null }), '根据 2 份相关资料回答，未逐份整理整库');
});

test('knowledge workbench browser verifies native actions, privacy, cancellation and project isolation', { timeout: 60000 }, async t => {
  const executable = path.join(__dirname, '..', '.runtime', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(executable)) { t.skip('Local Electron runtime is unavailable'); return; }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(__dirname, 'fixtures', 'knowledge-workbench-ui-smoke.cjs')], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = chunk => { output = (output + chunk.toString('utf8')).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Knowledge UI browser failed (${code}): ${output.slice(-3500)}`)));
  });
  assert.match(result, /KNOWLEDGE_UI_PASS/);
});
