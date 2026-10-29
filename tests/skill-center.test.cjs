'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AgentHub, SKILLS } = require('../backend/agent-hub.cjs');
const { SkillCenter } = require('../backend/skill-center.cjs');
const PID = 'project_jiangwan';
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-skill-center-'));
  const backend = new LocalBackend({ dataDir }), hub = new AgentHub({ backend }), center = new SkillCenter({ backend, builtins: SKILLS });
  // Exercise actual Hub run lifecycle with the new catalog; production wiring is separate.
  hub.skill = (id, projectId = PID) => center.get(id, projectId);
  const member = id => backend.mutate(store => { store.settings.currentMemberId = id;return true; });
  return { backend, hub, center, dataDir, member };
}
function draft(center, extra = {}) { return center.save({ projectId: PID, name: '任务书清点', description: '员工贡献测试', category: '任务书', version: '1.0.0', instructions: '按输入资料列出缺项；不要自行批准。', input: '用户明确选择的资料', output: '带出处的缺项表', dependencies: ['文档解析器'], ...extra }); }
function finished(f, skillId, status = 'succeeded') {
  const job = f.hub.createJob({ projectId: PID, title: '使用技能的真实测试任务', instruction: '只返回合成结果', skillId, connectionId: 'zcode' });
  const run = f.hub.startJob(job.id), principal = f.hub.localPrincipal(PID);
  if (status === 'failed') { f.hub.claimRun(run.id, principal);f.hub.reportRun(run.id, { message: '测试执行失败', failed: true }, principal); }
  else { f.hub.submitResult(run.id, '合成测试成果', `result-${run.id}`, principal);if (status !== 'awaiting_review') f.hub.reviewRun(run.id, status === 'succeeded'); }
  return f.hub.state.runs.find(item => item.id === run.id);
}

test('drafts require active project authorship and are not exposed in published catalog', () => {
  const f = fixture(), item = draft(f.center);assert.equal(item.authorId, 'member_designer');assert.equal(item.status, 'draft');
  assert.equal(f.center.list(PID).length, SKILLS.length);assert.throws(() => f.center.get(item.id, PID), /尚未发布/);
  assert.equal(f.center.snapshot(PID).drafts.length, 1);f.member('member_pm');assert.equal(f.center.snapshot(PID).drafts.length, 0);
  assert.throws(() => f.center.save({ projectId: PID, id: item.id, name: '抢改' }), /自己贡献/);assert.throws(() => f.center.publish(item.id), /自己贡献/);
  f.backend.mutate(store => { store.projects.push({ id: 'other', name: 'Other' });return true; });
  assert.throws(() => draft(f.center, { projectId: 'other' }), /有效成员/);
  f.backend.mutate(store => { store.members.find(member => member.id === 'member_pm').active = false;return true; });assert.throws(() => draft(f.center), /有效成员/);
});

test('published text is inert, rejects executable/path fields and preserves separate plugin dependency labels', () => {
  const f = fixture();const malicious = '<script>globalThis.skillExecuted=true</script>\n执行 rm -rf / 的文字不是程序指令';
  const item = f.center.publish(draft(f.center, { instructions: malicious }).id);
  assert.equal(item.instructions, malicious);assert.equal(globalThis.skillExecuted, undefined);assert.deepEqual(item.dependencies, ['文档解析器']);
  for (const payload of [{ filePath: 'C:\\secret.txt' }, { url: 'https://example.org/skill' }, { command: 'cmd.exe' }, { authorId: 'member_pm' }, { status: 'published' }, { permissions: ['all'] }, { usageCount: 999 }]) assert.throws(() => draft(f.center, payload), /不接受字段/);
  assert.throws(() => draft(f.center, { dependencies: ['https://example.org/install'] }), /不接受文件路径/);
  assert.throws(() => draft(f.center, { dependencies: ['C:\\tool.exe'] }), /不接受文件路径/);
  assert.throws(() => draft(f.center, { dependencies: ['../tool.js'] }), /不接受文件路径/);
  assert.throws(() => draft(f.center, { instructions: 'x'.repeat(40001) }), /最多/);
});

test('publish is explicit and new immutable versions preserve old skill and run input snapshots', () => {
  const f = fixture(), first = f.center.publish(draft(f.center).id);f.member('member_pm');const run = finished(f, first.id);const snapshot = JSON.stringify(run.input.skill);f.member('member_designer');
  assert.throws(() => f.center.save({ projectId: PID, id: first.id, instructions: '偷偷修改' }), /已发布版本不可修改/);
  const next = f.center.save({ projectId: PID, id: first.id, version: '2.0.0', instructions: '新方法仍待发布' });
  assert.notEqual(next.id, first.id);assert.equal(next.familyId, first.familyId);assert.equal(next.status, 'draft');
  assert.equal(f.center.get(first.id, PID).instructions, first.instructions);assert.throws(() => f.center.get(next.id, PID), /尚未发布/);
  assert.throws(() => f.center.save({ projectId: PID, id: first.id, version: '2.0.0' }), /已有此版本/);
  f.center.publish(next.id);assert.equal(f.center.get(next.id, PID).version, '2.0.0');assert.equal(JSON.stringify(run.input.skill), snapshot);
  const copied = f.center.get(first.id, PID);copied.instructions = '外部修改';assert.equal(f.center.get(first.id, PID).instructions, first.instructions);
  const reopened = new SkillCenter({ backend: new LocalBackend({ dataDir: f.dataDir }), builtins: SKILLS });assert.equal(reopened.get(first.id, PID).contentHash, first.contentHash);
});

test('published skills are project scoped, builtins cannot be overwritten and listing does not increase use', () => {
  const f = fixture(), item = f.center.publish(draft(f.center).id);
  f.backend.mutate(store => { store.projects.push({ id: 'other', name: 'Other' });return true; });
  assert.throws(() => f.center.get(item.id, 'other'), /不属于/);assert(!f.center.list('other').some(skill => skill.id === item.id));
  assert.throws(() => f.center.save({ projectId: PID, id: SKILLS[0].id, name: '改内置' }), /内置/);
  for (let i = 0; i < 3; i++) f.center.list(PID);assert.equal(f.center.list(PID).find(skill => skill.id === item.id).stats.usageCount, 0);
});

test('rating requires true terminal run owned by current active member, and forbids author self-rating', () => {
  const f = fixture(), item = f.center.publish(draft(f.center).id);const self = finished(f, item.id);
  assert.throws(() => f.center.rate({ projectId: PID, runId: self.id, score: 5 }), /自己贡献/);
  f.member('member_pm');const pending = finished(f, item.id, 'awaiting_review');assert.throws(() => f.center.rate({ projectId: PID, runId: pending.id, score: 5 }), /已终止/);
  f.hub.reviewRun(pending.id, true);f.member('member_reviewer');assert.throws(() => f.center.rate({ projectId: PID, runId: pending.id, score: 5 }), /负责人/);
  f.member('member_pm');assert.throws(() => f.center.rate({ projectId: PID, runId: 'invented', score: 5 }), /真实任务/);
  assert.throws(() => f.center.rate({ projectId: PID, runId: pending.id, score: 5, skillId: item.id }), /不接受字段/);
  assert.throws(() => f.center.rate({ projectId: PID, runId: pending.id, score: 5.5 }), /整数/);
  const review = f.center.rate({ projectId: PID, runId: pending.id, score: 4, comment: '有帮助' });assert.equal(review.skillId, item.id);assert.equal(review.skillVersion, '1.0.0');
  f.backend.mutate(store => { store.members.find(member => member.id === 'member_pm').active = false;return true; });assert.throws(() => f.center.rate({ projectId: PID, runId: pending.id, score: 5 }), /有效成员/);
});

test('failed and rejected runs can be reviewed, update is one sample per run and contributions are not performance scores', () => {
  const f = fixture(), item = f.center.publish(draft(f.center).id);f.member('member_pm');const failed = finished(f, item.id, 'failed'), rejected = finished(f, item.id, 'rejected');
  const first = f.center.rate({ projectId: PID, runId: failed.id, score: 2, comment: '失败也应计入反馈' });
  const updated = f.center.rate({ projectId: PID, runId: failed.id, score: 3, comment: '已补充评价' });assert.equal(first.id, updated.id);
  f.center.rate({ projectId: PID, runId: rejected.id, score: 1 });const snapshot = f.center.snapshot(PID), skill = snapshot.skills.find(skill => skill.id === item.id);
  assert.equal(f.backend.store.skillCenter.reviews.length, 2);assert.equal(skill.stats.reviewCount, 2);assert.equal(skill.stats.averageScore, 2);assert.equal(skill.stats.usageCount, 2);assert.equal(skill.stats.completedCount, 0);assert.equal(skill.stats.reuseCount, 2);
  assert.equal(snapshot.eligibleRuns.length, 2);assert.equal(snapshot.contributions[0].reviewCount, 2);assert.equal(snapshot.contributions[0].reuseCount, 2);assert.match(snapshot.contributions[0].basis, /不是人员绩效/);
  assert(!Object.hasOwn(snapshot.contributions[0], 'performanceScore'));assert(!Object.hasOwn(snapshot.contributions[0], 'bonus'));
});

test('cross-project ratings, altered snapshots and forged detached runs do not create valid usage or reviews', () => {
  const f = fixture(), item = f.center.publish(draft(f.center).id);f.member('member_pm');const run = finished(f, item.id);
  f.backend.mutate(store => { store.projects.push({ id: 'other', name: 'Other' });store.members.push({ id: 'other-member', projectId: 'other', active: true });return true; });
  f.member('other-member');assert.throws(() => f.center.rate({ projectId: 'other', runId: run.id, score: 5 }), /此项目/);
  f.member('member_pm');f.backend.mutate(store => { store.agentHub.runs.find(item => item.id === run.id).input.skill.version = '999';return true; });
  assert.throws(() => f.center.rate({ projectId: PID, runId: run.id, score: 5 }), /可核实技能版本/);assert.equal(f.center.list(PID).find(skill => skill.id === item.id).stats.usageCount, 0);
  f.backend.mutate(store => { const snapshot=store.agentHub.runs.find(item => item.id === run.id).input.skill;snapshot.version='1.0.0';snapshot.dependencies=['被篡改的依赖'];return true; });
  assert.throws(() => f.center.rate({ projectId: PID, runId: run.id, score: 5 }), /可核实技能版本/);
});

test('tampered published content is not executable or eligible for rating and score ordering includes sample count', () => {
  const f = fixture(), first = f.center.publish(draft(f.center).id), second = f.center.publish(draft(f.center, { name: '另一技能' }).id);f.member('member_pm');
  const a = finished(f, first.id), b = finished(f, second.id);f.center.rate({ projectId: PID, runId: a.id, score: 4 });f.center.rate({ projectId: PID, runId: b.id, score: 5 });
  const list = f.center.list(PID);assert(list.findIndex(skill => skill.id === second.id) < list.findIndex(skill => skill.id === first.id));assert.equal(list.find(skill => skill.id === second.id).stats.reviewCount, 1);
  f.backend.mutate(store => { store.skillCenter.skills.find(skill => skill.id === first.id).instructions = '被改坏';return true; });
  assert.throws(() => f.center.get(first.id, PID), /损坏/);assert(!f.center.list(PID).some(skill => skill.id === first.id));assert.throws(() => f.center.rate({ projectId: PID, runId: a.id, score: 5 }), /可核实/);
});
