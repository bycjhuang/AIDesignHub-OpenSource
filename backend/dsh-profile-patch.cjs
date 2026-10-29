'use strict';

const yaml = require('js-yaml');

function readPatch(text) {
  const value = yaml.load(text);
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('DSH_PROFILE_PATCH_INVALID: expected a YAML patch sequence');
  }
  return value;
}

function mergeConfig(existing, generated) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
      || !generated || typeof generated !== 'object' || Array.isArray(generated)) return structuredClone(generated);
  const result = structuredClone(existing);
  for (const [key, value] of Object.entries(generated)) {
    // YAML mappings are data; defining properties also avoids __proto__ setters.
    Object.defineProperty(result, key, {
      value: mergeConfig(existing[key], value), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function mergeEntries(existing, generated) {
  const result = structuredClone(existing);
  for (const entry of generated) {
    if (Array.isArray(entry.insert)) {
      const insertion = result.find(item => Array.isArray(item.insert));
      if (insertion) insertion.insert = mergeEntries(insertion.insert, entry.insert);
      else result.push(structuredClone(entry));
      continue;
    }
    const current = entry.id && result.find(item => item.id === entry.id);
    if (!current) {
      result.push(structuredClone(entry));
      continue;
    }
    // The user may choose a default inside Harness independently of the Hub model.
    if (entry.id === 'agent-default-model' && current.config?.provider && current.config?.model) {
      const available = generated.find(item => item.id === 'llm-pi-ai')?.config?.providers?.[current.config.provider]?.models;
      if (!['adh', 'adh-responses'].includes(current.config.provider) || !available || available.some(model => model.id === current.config.model)) continue;
    }
    Object.assign(current, mergeConfig(current, entry));
  }
  return result;
}

function mergeDshProfilePatch(existingText, generatedText, extraEntries = []) {
  const merged = mergeEntries(mergeEntries(readPatch(existingText), readPatch(generatedText)), extraEntries);
  return yaml.dump(merged, { noRefs: true, lineWidth: 140, quotingType: "'" });
}

module.exports = { readPatch, mergeDshProfilePatch };
