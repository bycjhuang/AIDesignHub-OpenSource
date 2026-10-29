'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { applyResearchDemoProfiles, safeProfileForContext, makeResearchDemoProfile, SYNTHETIC_LABEL } = require('../backend/project-research-profiles.cjs');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-research-profiles-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, backend: new LocalBackend({ dataDir }) };
}

test('all missing profiles persist atomically with synthetic labels and consistent area metrics', t => {
  const { backend, dataDir } = setup(t);
  backend.mutate(store => {
    store.projects.push({ id: 'garden', name: '云栖庭院住宅社区', type: '改善型住宅' }, { id: 'culture', name: '青岚地方文化中心', type: '公共文化建筑' }, { id: 'office', name: '科创产业园', type: '办公' });
    return true;
  });
  const originalProjects = backend.store.projects.map(({ id, name, type }) => ({ id, name, type }));
  const beforeDecisions = JSON.stringify(backend.store.decisions), beforeTasks = JSON.stringify(backend.store.tasks);
  const mutate = backend.mutate.bind(backend); let calls = 0;
  backend.mutate = callback => { calls++; return mutate(callback); };
  const result = applyResearchDemoProfiles(backend);
  assert.equal(calls, 1); assert.equal(result.updatedCount, 4); assert.equal(result.skippedCount, 0);
  assert.deepEqual(backend.store.projects.map(({ id, name, type }) => ({ id, name, type })), originalProjects);
  for (const project of backend.store.projects) {
    const profile = project.researchProfile;
    assert.equal(profile.isSynthetic, true); assert.equal(profile.label, SYNTHETIC_LABEL);
    assert.equal(profile.grossFloorAreaM2, profile.aboveGroundAreaM2 + profile.belowGroundAreaM2);
    assert.equal(profile.plotRatio, Number((profile.aboveGroundAreaM2 / profile.siteAreaM2).toFixed(4)));
    assert(profile.maxHeight > 0); assert(profile.objectives.length >= 3); assert(profile.focusQuestions.length >= 3);
    assert(profile.assumptions.some(value => value.includes('非实际项目指标')));
  }
  const jiangwan = backend.store.projects[0].researchProfile;
  assert.equal(jiangwan.siteAreaM2, 42000); assert.equal(jiangwan.grossFloorAreaM2, 101600); assert.equal(jiangwan.plotRatio, 1.8); assert.match(jiangwan.positioning, /滨水文化商业/);
  assert.equal(JSON.stringify(backend.store.decisions), beforeDecisions); assert.equal(JSON.stringify(backend.store.tasks), beforeTasks);
  const reopened = new LocalBackend({ dataDir });
  assert.deepEqual(reopened.store.projects.map(project => project.researchProfile), backend.store.projects.map(project => project.researchProfile));
});

test('existing real profiles and previous demo edits are preserved; repeated application performs no write', t => {
  const { backend } = setup(t);
  const actual = { isSynthetic: false, label: '正式任务书', siteAreaM2: 12345, positioning: '已提供的实际定位' };
  const priorDemo = { isSynthetic: true, label: '旧演示', siteAreaM2: 789, positioning: '用户已修改的假设' };
  backend.mutate(store => { store.projects[0].researchProfile = actual; store.projects.push({ id: 'old', name: '已有演示', researchProfile: priorDemo }); return true; });
  let calls = 0; const mutate = backend.mutate.bind(backend); backend.mutate = callback => { calls++; return mutate(callback); };
  const result = applyResearchDemoProfiles(backend);
  assert.equal(result.updatedCount, 0); assert.equal(calls, 0);
  assert.deepEqual(backend.store.projects[0].researchProfile, actual); assert.deepEqual(backend.store.projects[1].researchProfile, priorDemo);
});

test('context projection retains the assumption marker and omits untrusted extra objects, paths and invalid numbers', () => {
  const profile = makeResearchDemoProfile({ name: '江湾文化商业中心' }, 1234567890);
  const safe = safeProfileForContext({ researchProfile: { ...profile, label: '已批准的实际指标', absolutePath: 'C:\\secret', modelKey: 'not-for-context', dangerous: { code: true }, maxHeight: Infinity } });
  assert.equal(safe.label, SYNTHETIC_LABEL); assert.equal(safe.isSynthetic, true); assert.equal(safe.maxHeight, undefined);
  assert.equal(safe.absolutePath, undefined); assert.equal(safe.modelKey, undefined); assert.equal(safe.dangerous, undefined);
  assert.deepEqual(safeProfileForContext(profile), profile);
  assert.equal(safeProfileForContext(null), null); assert.equal(safeProfileForContext({}), null); assert.equal(safeProfileForContext([]), null);
  const actual = safeProfileForContext({ isSynthetic: false, positioning: '实际项目定位', label: '真实任务书', siteAreaM2: 1200 });
  assert.equal(actual.isSynthetic, false); assert.equal(actual.label, '真实任务书'); assert.equal(actual.siteAreaM2, 1200);
});

test('name-based profiles use different relevant objectives without inventing approval decisions', () => {
  const names = ['云栖庭院住宅社区', '青岚地方文化中心', '滨江慢行公园', '实验学校', '科创产业园'];
  const profiles = names.map(name => makeResearchDemoProfile({ name }));
  assert.match(profiles[0].type, /住宅/); assert.match(profiles[1].type, /文化/); assert.match(profiles[2].type, /景观/); assert.match(profiles[3].type, /教育/);
  assert.equal(profiles[2].plotRatio, 0.05); assert.equal(profiles[2].belowGroundAreaM2, 0);
  for (const profile of profiles) { assert.equal(profile.approvedAt, undefined); assert.equal(profile.decisions, undefined); assert(profile.assumptions[0].includes('不代表业主确认')); }
});

test('failed atomic persistence restores all prior project objects', t => {
  const { backend } = setup(t), previous = JSON.stringify(backend.store.projects);
  backend.persist = () => { throw new Error('disk unavailable'); };
  assert.throws(() => applyResearchDemoProfiles(backend), /disk unavailable/);
  assert.equal(JSON.stringify(backend.store.projects), previous);
});
