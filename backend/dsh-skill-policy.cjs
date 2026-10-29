'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

// Exact owner-specific workflows. General design, media, modelling and project
// skills remain available, including skills in the Agent's current workspace.
const DEFAULT_EXCLUDED_SKILL_IDS = Object.freeze([
  'animate',
  'carton-bitmap-to-editable-svg',
  'ai-learning-camp-cover',
  'ai-talking-head-cover',
  'ai-workshop-video-cover',
  'ai-workshop-video-editing',
  'expedition-frog-digital-human',
  'product-tutorial-brand-video',
  'calligraphy-video-editing',
  'digital-human-voiceover-pipeline',
  'bycj-media',
]);

const hash = value => createHash('sha256').update(value).digest('hex');
const POLICY_MARKER = '// AIDesignHub filesystem skill policy v1';
function patchFilesystemSkillSource(source, excludedSkillIds) {
  const listAnchor = '\t\treturn complete ? candidates : {\n\t\t\tcandidates,\n\t\t\tcomplete\n\t\t};';
  const getAnchor = '\tasync get(candidate, options) {\n\t\tconst locator = candidate.locator;';
  for (const anchor of [listAnchor, getAnchor]) if (source.split(anchor).length !== 2) {
    throw new Error('ADH_SKILL_POLICY_RUNTIME_UNSUPPORTED: original filesystem module was preserved');
  }
  return `${POLICY_MARKER}\nconst ADH_EXCLUDED_SKILL_IDS = new Set(${JSON.stringify(excludedSkillIds)});\n`
    + source.replace(listAnchor, '\t\tconst accepted = candidates.filter(candidate => !ADH_EXCLUDED_SKILL_IDS.has(candidate.name));\n\t\treturn complete ? accepted : {\n\t\t\tcandidates: accepted,\n\t\t\tcomplete\n\t\t};')
      .replace(getAnchor, '\tasync get(candidate, options) {\n\t\tif (ADH_EXCLUDED_SKILL_IDS.has(candidate.name)) return undefined;\n\t\tconst locator = candidate.locator;');
}

/** Apply the same native provider policy in host AND all preset-owned scopes. */
function ensureHubSkillPolicyRuntime({ runtimeRoot, excludedSkillIds = DEFAULT_EXCLUDED_SKILL_IDS, enabled = true }) {
  const file = path.join(runtimeRoot, 'package', 'node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js');
  const backup = `${file}.adh-original`;
  const manifestFile = `${file}.adh-policy.json`;
  const current = readFileSync(file);
  let original = current;
  let manifest;
  if (existsSync(backup)) {
    original = readFileSync(backup);
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (hash(original) !== manifest.originalSha256 || ![manifest.originalSha256, manifest.patchedSha256].includes(hash(current))) {
      throw new Error('ADH_SKILL_POLICY_RUNTIME_CHANGED: unknown changes were preserved');
    }
  } else if (current.toString('utf8').startsWith(POLICY_MARKER)) {
    throw new Error('ADH_SKILL_POLICY_BACKUP_MISSING: patched source was preserved');
  }
  const patched = enabled ? Buffer.from(patchFilesystemSkillSource(original.toString('utf8'), excludedSkillIds)) : original;
  if (!existsSync(backup)) {
    // Write original bytes before installing any derived module.
    writeFileSync(backup, original, { flag: 'wx' });
  }
  manifest = { version: 1, enabled, excludedSkillIds: [...excludedSkillIds], originalSha256: hash(original), patchedSha256: hash(patched) };
  const serializedManifest = JSON.stringify(manifest, null, 2);
  if (!existsSync(manifestFile) || readFileSync(manifestFile, 'utf8') !== serializedManifest) writeFileSync(manifestFile, serializedManifest);
  if (hash(current) !== manifest.patchedSha256) writeFileSync(file, patched);
  return { file, backup, ...manifest };
}

/**
 * Replace only the filesystem provider instance, retaining its configuration in
 * place and forwarding it intact to the policy provider. No skill files move.
 * runtimeRoot is the pinned DSH runtime directory containing package/.
 */
function buildHubSkillPolicyEntries({ existingEntries = [], runtimeRoot, excludedSkillIds = DEFAULT_EXCLUDED_SKILL_IDS, enabled = true } = {}) {
  if (!runtimeRoot) throw new TypeError('Hub skill policy requires runtimeRoot');
  if (!Array.isArray(excludedSkillIds) || excludedSkillIds.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    throw new TypeError('Hub excluded skill IDs must be exact kebab-case names');
  }
  const previous = existingEntries.find(entry => entry.id === 'adh-skill-policy');
  const filesystem = existingEntries.find(entry => entry.id === 'skill-filesystem');
  const originalFilesystemDisabled = previous?.config?.originalFilesystemDisabled ?? filesystem?.disabled ?? false;
  const filesystemModule = path.join(runtimeRoot, 'package', 'node_modules', '@deepseek-ai', 'dsh-skill-filesystem', 'lib', 'index.js');
  return [
    { id: 'skill-filesystem', disabled: enabled ? true : originalFilesystemDisabled },
    { id: 'adh-skill-policy', disabled: enabled ? originalFilesystemDisabled : true, config: {
      filesystemModule,
      filesystem: structuredClone(filesystem?.config ?? previous?.config?.filesystem ?? {}),
      excludedSkillIds: [...new Set(excludedSkillIds)], originalFilesystemDisabled,
    } },
  ];
}

module.exports = { DEFAULT_EXCLUDED_SKILL_IDS, buildHubSkillPolicyEntries, patchFilesystemSkillSource, ensureHubSkillPolicyRuntime };
