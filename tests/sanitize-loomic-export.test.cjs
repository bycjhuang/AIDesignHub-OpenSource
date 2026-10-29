'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const { sanitizeBundle } = require('../scripts/sanitize-loomic-export.cjs');
const { inspectText } = require('../scripts/release-security.cjs');

test('local canvas build clears only the named upstream Firebase demonstration config', () => {
  const demo = 'AIza' + randomBytes(24).toString('base64url');
  const source = `globalThis.settings={VITE_APP_FIREBASE_CONFIG:'${JSON.stringify({ apiKey: demo, projectId: 'upstream-demo' })}',unchanged:42};`;
  const sanitized = sanitizeBundle(source), context = {};
  vm.runInNewContext(sanitized, context);
  assert.equal(context.settings.VITE_APP_FIREBASE_CONFIG, '{}'); assert.equal(context.settings.unchanged, 42);
  assert(!sanitized.includes(demo)); assert.equal(sanitizeBundle(sanitized), sanitized);
});

test('storage field names are permitted while unrelated credential values still block release', () => {
  assert.equal(inspectText('const fields={API_KEY:"excalidraw-oai-api-key"};', 'canvas.js').length, 0);
  const privateValue = 'sk-' + randomBytes(24).toString('hex');
  const source = `const configured={apiKey:'${privateValue}'};`;
  assert.equal(sanitizeBundle(source), source);
  assert(inspectText(source, 'canvas.js').some(item => item.rule === 'api-key'));
});
