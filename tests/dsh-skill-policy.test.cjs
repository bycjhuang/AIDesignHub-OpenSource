'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DEFAULT_EXCLUDED_SKILL_IDS, buildHubSkillPolicyEntries, patchFilesystemSkillSource, ensureHubSkillPolicyRuntime } = require('../backend/dsh-skill-policy.cjs');
const { mergeDshProfilePatch, readPatch } = require('../backend/dsh-profile-patch.cjs');

test('skill policy preserves custom roots and settings, is idempotent and can restore native discovery', () => {
  const runtimeRoot = path.resolve('fixture-runtime');
  const before = [{ id: 'skill-filesystem', disabled: false, config: {
    customSkillDirs: ['D:/my skills'], includeDefaultRoots: true, watch: false, providerName: 'personal-config-name',
  } }];
  const original = structuredClone(before);
  const entries = buildHubSkillPolicyEntries({ existingEntries: before, runtimeRoot });
  assert.equal(entries[0].disabled, true);
  assert.deepEqual(entries[1].config.filesystem, before[0].config);
  assert.deepEqual(entries[1].config.excludedSkillIds, DEFAULT_EXCLUDED_SKILL_IDS);
  assert.deepEqual(before, original);
  const merged = readPatch(mergeDshProfilePatch(JSON.stringify(before), '[]', entries));
  const again = buildHubSkillPolicyEntries({ existingEntries: merged, runtimeRoot });
  assert.deepEqual(again, entries);
  const restore = buildHubSkillPolicyEntries({ existingEntries: merged, runtimeRoot, enabled: false });
  assert.equal(restore[0].disabled, false);
  assert.equal(restore[1].disabled, true);
  assert.deepEqual(restore[1].config.filesystem.customSkillDirs, ['D:/my skills']);
});

test('policy preserves an intentional native provider opt-out and rejects pattern exclusions', () => {
  const entries = buildHubSkillPolicyEntries({ runtimeRoot: path.resolve('fixture-runtime'), existingEntries: [{ id: 'skill-filesystem', disabled: true }] });
  assert.equal(entries[1].disabled, true);
  assert.throws(() => buildHubSkillPolicyEntries({ runtimeRoot: 'x', excludedSkillIds: ['*video*'] }), /exact kebab-case/);
});

test('provider adapter removes private IDs before ranking and direct loading, retaining incomplete observations', async () => {
  const { filterSkillProvider } = await import('../backend/dsh-plugins/adh-skill-policy/index.js');
  let calls = 0;
  const provider = { name: 'fixture', list: async () => ({ complete: false, candidates: [{ name: 'cad' }, { name: 'ai-workshop-video-cover' }] }),
    get: async candidate => { calls += 1; return candidate; } };
  const filtered = filterSkillProvider(provider, DEFAULT_EXCLUDED_SKILL_IDS);
  assert.deepEqual(await filtered.list({ cwd: 'unchanged' }), { complete: false, candidates: [{ name: 'cad' }] });
  assert.equal(await filtered.get({ name: 'ai-workshop-video-cover' }, {}), undefined);
  assert.equal(calls, 0);
  assert.deepEqual(await filtered.get({ name: 'cad' }, {}), { name: 'cad' });
  assert.equal(calls, 1);
});

test('runtime filesystem policy has exact backup, is idempotent, restores original bytes and rejects unknown drift', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-skill-runtime-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'package/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js');
  const source = 'class Fixture {\n\tasync list() { const candidates = []; const complete = true;\n\t\treturn complete ? candidates : {\n\t\t\tcandidates,\n\t\t\tcomplete\n\t\t};\n}\n\tasync get(candidate, options) {\n\t\tconst locator = candidate.locator; return locator; }\n}';
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source);
  const first = ensureHubSkillPolicyRuntime({ runtimeRoot: root });
  assert.equal(await readFile(first.backup, 'utf8'), source);
  assert.equal(await readFile(file, 'utf8'), patchFilesystemSkillSource(source, DEFAULT_EXCLUDED_SKILL_IDS));
  assert.equal(ensureHubSkillPolicyRuntime({ runtimeRoot: root }).patchedSha256, first.patchedSha256);
  ensureHubSkillPolicyRuntime({ runtimeRoot: root, enabled: false });
  assert.equal(await readFile(file, 'utf8'), source);
  ensureHubSkillPolicyRuntime({ runtimeRoot: root });
  await writeFile(file, 'unknown upstream or user modification');
  assert.throws(() => ensureHubSkillPolicyRuntime({ runtimeRoot: root }), /RUNTIME_CHANGED/);
  assert.equal(await readFile(file, 'utf8'), 'unknown upstream or user modification');
});

const runtimeRoot = process.env.ADH_TEST_DSH_PACKAGE || path.join(process.env.APPDATA || '', 'bycj-design-workbench-prototype', 'cache', 'dsh-runtime', '0.2.1-rc.2', 'package');
const sdkAvailable = existsSync(path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-skill/lib/index.js'));
test('actual rc2 provider filters default/custom/project roots while following workspace changes', { skip: !sdkAvailable }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-skill-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = path.join(root, 'dsh');
  const agentsHome = path.join(root, 'agents');
  const custom = path.join(root, 'custom');
  const bundled = path.join(root, 'bundled');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  async function skill(base, name) {
    const folder = path.join(base, name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} instructions\n---\nBody for ${name}.\n`);
  }
  await Promise.all([mkdir(path.join(first, '.git'), { recursive: true }), mkdir(path.join(second, '.git'), { recursive: true }), mkdir(bundled, { recursive: true })]);
  await skill(path.join(agentsHome, 'skills'), 'architecture-model');
  await skill(path.join(agentsHome, 'skills'), 'ai-workshop-video-cover');
  await skill(path.join(agentsHome, 'skills'), 'animate');
  await skill(path.join(agentsHome, 'skills'), 'carton-bitmap-to-editable-svg');
  await skill(path.join(dshHome, 'skills'), 'expedition-frog-digital-human');
  await skill(custom, 'office-documents');
  await skill(custom, 'ai-workshop-video-editing');
  await skill(path.join(first, '.agents/skills'), 'first-project-design');
  await skill(path.join(second, '.dsh/skills'), 'second-project-model');
  await skill(path.join(second, '.dsh/skills'), 'ai-workshop-video-cover');
  const runtime = name => import(pathToFileURL(path.join(runtimeRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { SkillRegistry }, policy] = await Promise.all([runtime('cordis'), runtime('dsh-skill'), import('../backend/dsh-plugins/adh-skill-policy/index.js')]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SkillRegistry).await();
  await ctx.plugin(policy, { filesystemModule: path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js'),
    excludedSkillIds: DEFAULT_EXCLUDED_SKILL_IDS,
    filesystem: { dshHome, agentsHome, bundledSkillDir: bundled, customSkillDirs: [custom], watch: false } }).await();
  const names = async cwd => (await ctx.skills.list({ cwd })).map(item => item.name);
  assert.deepEqual(await names(first), ['architecture-model', 'first-project-design', 'office-documents']);
  assert.deepEqual(await names(second), ['architecture-model', 'office-documents', 'second-project-model']);
  for (const name of ['animate', 'carton-bitmap-to-editable-svg', 'ai-workshop-video-cover', 'ai-workshop-video-editing', 'expedition-frog-digital-human']) {
    assert.equal(await ctx.skills.get(name, { cwd: second }), undefined);
  }
  const loaded = await ctx.skills.get('office-documents', { cwd: second });
  assert.equal(loaded.content, 'Body for office-documents.');
  assert.equal(loaded.resourceBase.path, path.join(custom, 'office-documents'));
  assert.equal((await ctx.skills.snapshot({ cwd: second })).complete, true);
});

test('full official web Host filters real standard, ptc and cordis preset skill scopes', { skip: !sdkAvailable, timeout: 120000 }, async () => {
  const result = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../scripts/smoke-skill-policy-host.cjs')], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.ok, true);
  assert.deepEqual(report.presets.map(item => item.composedPreset), ['standard', 'ptc', 'cordis']);
  assert.ok(report.presets.every(item => item.directGetDenied && item.ok));
  assert.equal(report.presets[0].skillToolDenied, true);
  assert.equal(report.realProfileTouched, false);
});
