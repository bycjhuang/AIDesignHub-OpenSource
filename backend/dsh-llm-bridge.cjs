'use strict';
const { usesResponsesApi } = require('./text-model-protocol.cjs');

function themePreference(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function buildLlmPatch(modelStatus, apiKey, theme = 'light') {
  if (!modelStatus?.configured || !modelStatus.baseUrl || !modelStatus.model) {
    return null;
  }

  const profiles = Array.isArray(modelStatus.profiles) ? modelStatus.profiles.filter(p => p.configured) : [];
  const groups = profiles.length ? [
    { id: 'adh', api: 'openai-completions', models: profiles.filter(p => !usesResponsesApi(p.model)) },
    { id: 'adh-responses', api: 'openai-responses', models: profiles.filter(p => usesResponsesApi(p.model)) },
  ] : [{ id: 'adh', api: 'openai-completions', models: [{ id: modelStatus.model, name: modelStatus.model }] }];
  const defaultModel = profiles.length ? modelStatus.defaultProfileId || profiles[0].id : modelStatus.model;
  const providerId = groups.find(group => group.models.some(p => p.id === defaultModel))?.id || 'adh';
  const displayName = {
    deepseek: 'DeepSeek API (via AIDesignHub)',
    bailian: '阿里云百炼 (via AIDesignHub)',
    'openai-compatible': '自定义模型 (via AIDesignHub)',
  }[modelStatus.provider] || 'AIDesignHub 模型';

  const patchLines = [
    '# AIDesignHub desktop profile patch: reuse host model configuration.',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    ...groups.flatMap(group => [
      `      ${group.id}:`, `        displayName: ${group.id === 'adh-responses' ? 'GPT · APIMart (via AIDesignHub)' : displayName}`,
      `        api: ${group.api}`, `        baseURL: ${JSON.stringify(modelStatus.baseUrl.replace(/\/+$/, ''))}`,
      '        apiKeyEnv: ADH_DESKTOP_LLM_KEY', '        supportsMaxOutputTokens: true',
      group.models.length ? '        models:' : '        models: []',
      ...group.models.flatMap(model => [`          - id: ${JSON.stringify(model.id)}`, `            name: ${JSON.stringify(model.name || model.model)}`, '            contextWindow: 128000', ...(usesResponsesApi(model.model) ? ['            reasoningEfforts: { low: low, medium: medium, high: high }'] : [])]),
    ]),
    '- id: ui-theme',
    '  config:',
    `    preference: ${themePreference(theme)}`,
    '- id: ui-settings-general',
    '  config:',
    "    welcomeNoticeVersion: '2026-09-28.1'",
    '- id: skill-filesystem',
    '  disabled: false',
    '- id: llm-deepseek-account',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${providerId}`,
    `    model: ${JSON.stringify(defaultModel)}`,
    '',
  ];

  return patchLines.join('\n');
}

module.exports = { buildLlmPatch, themePreference };
