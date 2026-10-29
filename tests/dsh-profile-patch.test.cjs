'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPatch, mergeDshProfilePatch } = require('../backend/dsh-profile-patch.cjs');
const { buildLlmPatch } = require('../backend/dsh-llm-bridge.cjs');

test('upgrade preserves personal model, reasoning, custom provider, MCP, skills and unknown settings', () => {
  const before = `
- id: agent-default-model
  config: { provider: custom, model: personal, reasoning: high }
- id: llm-pi-ai
  config:
    providers:
      custom: { baseURL: 'http://localhost:1234/v1', apiKeyEnv: PRIVATE_KEY }
- id: skill-filesystem
  config: { directories: ['D:/my-skills'] }
- id: ui-theme
  config: { preference: dark, font: personal }
- insert:
  - id: personal-mcp
    name: custom-mcp
    config: { command: custom.exe }
- id: unknown-extension
  config: { keep: true }
`;
  const generated = `
- id: agent-default-model
  config: { provider: adh, model: host }
- id: llm-pi-ai
  config: { providers: { adh: { model: host } } }
- id: ui-theme
  config: { preference: light }
- id: skill-filesystem
  disabled: false
`;
  const extra = [{ insert: [{ id: 'adh-mcp-rhino', name: 'mcp', config: { command: 'python.exe' } }] }];
  const text = mergeDshProfilePatch(before, generated, extra);
  const entries = readPatch(text);
  const config = id => entries.find(entry => entry.id === id).config;
  assert.deepEqual(config('agent-default-model'), { provider: 'custom', model: 'personal', reasoning: 'high' });
  assert.equal(config('llm-pi-ai').providers.custom.apiKeyEnv, 'PRIVATE_KEY');
  assert.equal(config('llm-pi-ai').providers.adh.model, 'host');
  assert.deepEqual(config('skill-filesystem').directories, ['D:/my-skills']);
  assert.deepEqual(config('ui-theme'), { preference: 'light', font: 'personal' });
  assert.equal(config('unknown-extension').keep, true);
  assert.equal(entries.find(entry => entry.insert).insert.length, 2);
  assert.equal(mergeDshProfilePatch(text, generated, extra), text);
});

test('malformed or incompatible patches fail instead of replacing user configuration', () => {
  for (const text of ['- config: [', 'config: {}', '- null', '- [x]']) {
    assert.throws(() => mergeDshProfilePatch(text, '[]'));
  }
});

test('fresh profiles accept the host model and quoted Windows paths', () => {
  const text = mergeDshProfilePatch('', '- id: agent-default-model\n  config: { provider: adh, model: host }', [
    { insert: [{ id: 'mcp', config: { command: 'C:\\设计工作台\\python.exe', args: ['D:\\MCP tools\\server.py'] } }] },
  ]);
  const parsed = readPatch(text);
  assert.equal(parsed[0].config.model, 'host');
  assert.equal(parsed[1].insert[0].config.command, 'C:\\设计工作台\\python.exe');
});

test('an obsolete Hub model is migrated to the shared catalog while keeping reasoning preferences', () => {
  const before = '- id: agent-default-model\n  config: { provider: adh, model: deepseek-chat, reasoning: high }';
  const generated = '- id: llm-pi-ai\n  config: { providers: { adh: { models: [{ id: text-flash }, { id: text-sol }] } } }\n- id: agent-default-model\n  config: { provider: adh, model: text-flash }';
  const patch = readPatch(mergeDshProfilePatch(before, generated));
  assert.deepEqual(patch.find(p => p.id === 'agent-default-model').config, { provider: 'adh', model: 'text-flash', reasoning: 'high' });
});

test('shared Harness catalog uses Responses for GPT 6 and Chat Completions for DeepSeek', () => {
  const entries = readPatch(buildLlmPatch({ configured: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'gpt-6-astra', defaultProfileId: 'text-astra', profiles: [
    { id: 'text-flash', model: 'deepseek-flash', name: 'DeepSeek', configured: true },
    { id: 'text-sol', model: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', configured: true },
    { id: 'text-astra', model: 'gpt-6-astra', name: 'GPT 6 Astra', configured: true },
  ] }));
  const providers = entries.find(p => p.id === 'llm-pi-ai').config.providers;
  assert.equal(providers.adh.api, 'openai-completions'); assert.equal(providers.adh.models.length, 1);
  assert.equal(providers['adh-responses'].api, 'openai-responses'); assert.equal(providers['adh-responses'].models.length, 2);
  assert.deepEqual(providers['adh-responses'].models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.equal(entries.find(p => p.id === 'agent-default-model').config.provider, 'adh-responses');
  assert.ok(!JSON.stringify(entries).includes('sk-'));
});
