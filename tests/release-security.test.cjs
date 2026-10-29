'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { inspectText, isPrivatePath } = require('../scripts/release-security.cjs');

test('release audit blocks a credential without including its value in diagnostics', () => {
  const key = `sk-${randomBytes(24).toString('hex')}`;
  const findings = inspectText(`const options = { apiKey: '${key}' };`, 'application.cjs');
  assert(findings.some(item => item.rule === 'api-key'));
  assert(!JSON.stringify(findings).includes(key));
  assert.equal(inspectText("const key = 'sk-canvas-fixture-only-never-a-real-key';", 'fixture.cjs').length, 0);
});

test('release audit rejects user data and allows distributable metadata and CA trust', () => {
  for (const file of ['profile/store.json', 'device-settings-v1/models.json', 'model-private/key.json', 'server/.env.local', 'npm-cache/file', 'server/private.pem']) assert.equal(isPrivatePath(file), true, file);
  for (const file of ['package/package.json', 'server/.env.example', 'server/.env.local.example', 'certifi/cacert.pem', 'LICENSE']) assert.equal(isPrivatePath(file), false, file);
  const profile = 'C:\\Users\\' + 'private-person' + '\\AppData\\config.json';
  assert(inspectText(profile, 'metadata.json').some(item => item.rule === 'personal-profile-path'));
  assert.equal(inspectText('C:\\Users\\user\\AppData', 'sample.md').length, 0);
});
