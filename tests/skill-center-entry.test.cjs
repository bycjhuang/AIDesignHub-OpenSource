'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

test('legacy skills navigation opens the native center without selecting the retired page', () => {
  const source = fs.readFileSync(path.join(root, 'app-v2.js'), 'utf8');
  const start = source.indexOf('  function setView(view) {');
  const end = source.indexOf('  function renderDshState(', start);
  assert.ok(start >= 0 && end > start);
  let opened = 0;
  const context = { window: { aidesignAIHub: { openSkills() { opened++; } } } };
  vm.runInNewContext(`${source.slice(start, end)}\nsetView('skills');`, context);
  assert.equal(opened, 1);
});

test('shell exposes one native skills route and keeps retired controls inaccessible', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /class="nav-item[^"\n]*"\s+data-view="skills"/);
  assert.match(html, /id="view-skills"\s+hidden\s+inert\s+aria-hidden="true"/);
  assert.match(html, /data-view-target="skills"/);
  assert.match(html, /class="nav-item" data-view="adh-agent"/);
});