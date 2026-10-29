'use strict';

// Local text catalog only. Publishing never evaluates code, installs a plugin,
// reads an upload path, fetches a URL, or grants an Agent additional permissions.
const crypto = require('node:crypto');
const copy = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const TERMINAL = new Set(['succeeded', 'rejected', 'failed']);
const SAVE_FIELDS = new Set(['projectId', 'id', 'name', 'description', 'category', 'version', 'instructions', 'input', 'output', 'dependencies']);
const RATE_FIELDS = new Set(['projectId', 'runId', 'score', 'comment']);
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请提供技能记录对象。');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`不接受字段 ${key}；技能中心只接收受限文本，不接受执行配置、文件路径或权限。`);
}
function text(value, label, max, required = false) {
  if (value === undefined || value === null) { if (required) throw new Error(`${label}不能为空。`);return ''; }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label}必须是最多 ${max} 字符的文本。`);
  const result = value.trim();if (required && !result) throw new Error(`${label}不能为空。`);return result;
}
function contentHash(skill) {
  const content = Object.fromEntries(['id', 'familyId', 'projectId', 'authorId', 'name', 'description', 'category', 'version', 'instructions', 'input', 'output', 'dependencies'].map(key => [key, skill[key]]));
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

class SkillCenter {
  constructor({ backend, builtins = [] }) {
    if (!backend?.store || typeof backend.mutate !== 'function') throw new Error('技能中心需要本地项目数据库。');
    this.backend = backend;
    this.builtins = copy(builtins).map(skill => ({ ...skill, familyId: skill.id, origin: 'builtin', status: 'published', authorId: null, category: skill.category || '企业内置', dependencies: skill.dependencies || [], input: skill.input || '', output: skill.output || '' }));
    if (new Set(this.builtins.map(skill => skill.id)).size !== this.builtins.length) throw new Error('内置技能 ID 重复。');
    if (!backend.store.skillCenter) backend.mutate(store => { store.skillCenter = { skills: [], reviews: [] };return true; });
    if (!Array.isArray(this.state.skills) || !Array.isArray(this.state.reviews)) throw new Error('技能中心数据格式错误，不能覆盖原记录。');
  }
  get state() { return this.backend.store.skillCenter; }
  project(projectId) {
    const id = projectId || this.backend.store.settings.currentProjectId;
    if (!this.backend.store.projects.some(project => project.id === id)) throw new Error('项目不存在。');
    return id;
  }
  member(projectId) {
    const id = this.backend.store.settings.currentMemberId;
    const member = this.backend.store.members.find(item => item.id === id && item.projectId === projectId && item.active !== false);
    if (!member) throw new Error('当前成员不是此项目的有效成员。');return member;
  }
  record(id, projectId, version) {
    const skill = this.builtins.find(item => item.id === id && (!version || item.version === version))
      || this.state.skills.find(item => item.id === id && item.projectId === projectId && item.status === 'published' && (!version || item.version === version));
    if (!skill || (skill.origin !== 'builtin' && skill.contentHash !== contentHash(skill))) return null;
    return skill;
  }
  get(id, projectId, version) {
    const pid = this.project(projectId);const skill = this.record(id, pid, version);
    if (!skill) throw new Error('技能版本不存在、尚未发布、不属于此项目或内容已损坏。');return copy(skill);
  }
  save(payload) {
    object(payload, SAVE_FIELDS);const projectId = this.project(payload.projectId), member = this.member(projectId);
    const previous = payload.id ? this.state.skills.find(skill => skill.id === payload.id && skill.projectId === projectId) : null;
    if (payload.id && !previous) throw new Error('不能修改内置技能或其他项目的技能。');
    if (previous && previous.authorId !== member.id) throw new Error('只能编辑自己贡献的技能。');
    const merged = { ...previous, ...payload };
    const version = text(merged.version || '1.0.0', '版本', 40, true);
    if (!/^[a-z0-9][a-z0-9.+_-]{0,39}$/i.test(version)) throw new Error('版本须使用字母、数字、点、横线或下划线。');
    if (previous?.status === 'published' && version === previous.version) throw new Error('已发布版本不可修改，请填写新版本。');
    const dependencies = merged.dependencies === undefined ? [] : merged.dependencies;
    if (!Array.isArray(dependencies) || dependencies.length > 20) throw new Error('依赖只能是最多 20 个说明名称。');
    const dependencyNames = dependencies.map(value => {
      const name = text(value, '依赖名称', 200, true);
      if (/[\\/]/.test(name) || /^[a-z][a-z0-9+.-]*:/i.test(name)) throw new Error('依赖填写工具名称，不接受文件路径或下载 URL。');return name;
    });
    const draftId = !previous || previous.status === 'published' ? uid('skill') : previous.id;
    const familyId = previous?.familyId || draftId;
    if (this.state.skills.some(skill => skill.projectId === projectId && skill.familyId === familyId && skill.version === version && skill.id !== draftId)) throw new Error('同一技能家族已有此版本。');
    const draft = {
      id: draftId, familyId, projectId, authorId: member.id, origin: 'employee', status: 'draft',
      name: text(merged.name, '技能名称', 120, true), description: text(merged.description, '技能说明', 2000),
      category: text(merged.category || '通用', '技能分类', 80), version,
      instructions: text(merged.instructions, '技能方法', 40000, true), input: text(merged.input, '输入说明', 4000), output: text(merged.output, '输出说明', 4000),
      dependencies: [...new Set(dependencyNames)], createdAt: previous?.status === 'draft' ? previous.createdAt : Date.now(), updatedAt: Date.now(),
    };
    return this.backend.mutate(store => { const index = store.skillCenter.skills.findIndex(skill => skill.id === draftId);if (index < 0) store.skillCenter.skills.push(draft);else store.skillCenter.skills[index] = draft;return draft; });
  }
  publish(id) {
    const skill = this.state.skills.find(item => item.id === id);
    if (!skill) throw new Error('待发布技能不存在。');
    const projectId = this.project(skill.projectId), member = this.member(projectId);
    if (skill.authorId !== member.id) throw new Error('只能确认发布自己贡献的技能。');
    if (skill.status === 'published') return this.get(skill.id, projectId, skill.version);
    if (skill.status !== 'draft') throw new Error('当前技能不是可发布草稿。');
    return this.backend.mutate(store => { const current = store.skillCenter.skills.find(item => item.id === id);current.status = 'published';current.publishedAt = Date.now();current.publishedBy = member.id;current.updatedAt = Date.now();current.contentHash = contentHash(current);return current; });
  }
  runContext(run, projectId) {
    if (!run || run.projectId !== projectId || !TERMINAL.has(run.status)) return null;
    const job = this.backend.store.agentHub?.jobs?.find(item => item.id === run.jobId && item.projectId === projectId);
    const task = this.backend.store.tasks.find(item => item.id === job?.taskId && item.projectId === projectId && item.agentJobId === job?.id);
    const snapshot = run.input?.skill;
    if (!job || !task || !snapshot || job.skillId !== snapshot.id || job.skillVersion !== snapshot.version || !run.memberId) return null;
    const skill = this.record(snapshot.id, projectId, snapshot.version);
    if (!skill || snapshot.instructions !== skill.instructions || snapshot.name !== skill.name) return null;
    if (skill.origin === 'employee' && (snapshot.contentHash !== skill.contentHash || contentHash(snapshot) !== skill.contentHash)) return null;
    return { run, job, task, skill };
  }
  validReviews(projectId, contexts) {
    const accepted = new Map();
    for (const review of this.state.reviews) {
      if (review.projectId !== projectId) continue;const context = contexts.get(review.runId);
      if (!context || review.skillId !== context.skill.id || review.skillVersion !== context.skill.version || review.reviewerId !== context.run.memberId || review.reviewerId === context.skill.authorId || !Number.isInteger(review.score) || review.score < 1 || review.score > 5) continue;
      // A run contributes at most one current rating, even if old data was duplicated.
      if (!accepted.has(review.runId) || (review.updatedAt || 0) > (accepted.get(review.runId).updatedAt || 0)) accepted.set(review.runId, review);
    }
    return [...accepted.values()];
  }
  contexts(projectId) {
    return new Map((this.backend.store.agentHub?.runs || []).map(run => this.runContext(run, projectId)).filter(Boolean).map(context => [context.run.id, context]));
  }
  list(projectId) {
    const pid = this.project(projectId), contexts = this.contexts(pid), reviews = this.validReviews(pid, contexts);
    const items = [...this.builtins, ...this.state.skills.filter(skill => skill.projectId === pid && skill.status === 'published' && this.record(skill.id, pid, skill.version))];
    return items.map(skill => {
      const runs = [...contexts.values()].filter(context => context.skill.id === skill.id && context.skill.version === skill.version).map(context => context.run);
      const ratings = reviews.filter(review => review.skillId === skill.id && review.skillVersion === skill.version);
      const scoreSum = ratings.reduce((sum, review) => sum + review.score, 0), averageScore = ratings.length ? Math.round(scoreSum / ratings.length * 100) / 100 : null;
      // A visible sample-adjusted catalog ranking, never a personnel/performance score.
      const rankingScore = ratings.length ? Math.round((scoreSum + 3 * 3) / (ratings.length + 3) * 1000) / 1000 : 0;
      return { ...copy(skill), authorName: skill.authorId ? this.backend.store.members.find(member => member.id === skill.authorId && member.projectId === pid)?.name || '原贡献者' : '企业内置', stats: { usageCount: runs.length, completedCount: runs.filter(run => run.status === 'succeeded').length, reuseCount: runs.filter(run => run.memberId !== skill.authorId).length, reviewCount: ratings.length, averageScore, rankingScore } };
    }).sort((left, right) => right.stats.rankingScore - left.stats.rankingScore || right.stats.reviewCount - left.stats.reviewCount || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
  }
  rate(payload) {
    object(payload, RATE_FIELDS);const projectId = this.project(payload.projectId), member = this.member(projectId);
    if (!Number.isInteger(payload.score) || payload.score < 1 || payload.score > 5) throw new Error('评分必须是 1–5 的整数。');
    const runId = text(payload.runId, '运行 ID', 160, true), comment = text(payload.comment, '评价', 2000);
    const run = this.backend.store.agentHub?.runs?.find(item => item.id === runId), context = this.runContext(run, projectId);
    if (!context) throw new Error('只能评价此项目中已终止、使用可核实技能版本的真实任务运行。');
    if (context.task.ownerId !== member.id || run.memberId !== member.id) throw new Error('只有本次运行的任务负责人可以评价。');
    if (context.skill.authorId === member.id) throw new Error('不能给自己贡献的技能评分。');
    const existing = this.state.reviews.find(review => review.runId === runId);
    if (existing && existing.reviewerId !== member.id) throw new Error('该运行已有其他成员的评价，不能覆盖。');
    const review = { id: existing?.id || uid('skill_review'), projectId, runId, jobId: context.job.id, skillId: context.skill.id, skillVersion: context.skill.version, reviewerId: member.id, score: payload.score, comment, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
    return this.backend.mutate(store => { const index = store.skillCenter.reviews.findIndex(item => item.runId === runId);if (index < 0) store.skillCenter.reviews.push(review);else store.skillCenter.reviews[index] = review;return review; });
  }
  snapshot(projectId) {
    const pid = this.project(projectId), member = this.member(pid), skills = this.list(pid), contexts = this.contexts(pid), reviews = this.validReviews(pid, contexts);
    const contributions = [...new Set(skills.filter(skill => skill.origin === 'employee').map(skill => skill.authorId))].map(authorId => {
      const authored = skills.filter(skill => skill.authorId === authorId);return { memberId: authorId, name: authored[0].authorName, publishedVersions: authored.length, skillFamilies: new Set(authored.map(skill => skill.familyId)).size, reuseCount: authored.reduce((sum, skill) => sum + skill.stats.reuseCount, 0), reviewCount: authored.reduce((sum, skill) => sum + skill.stats.reviewCount, 0), basis: '真实终态运行与有效使用评价；不是人员绩效、奖金或考核分。' };
    }).sort((a, b) => b.reuseCount - a.reuseCount || b.reviewCount - a.reviewCount || a.name.localeCompare(b.name, 'zh-CN'));
    const eligibleRuns = [...contexts.values()].filter(context => context.task.ownerId === member.id && context.run.memberId === member.id && context.skill.authorId !== member.id).map(({ run, job, skill }) => ({ runId: run.id, title: job.title, status: run.status, skillId: skill.id, skillName: skill.name, skillVersion: skill.version, review: copy(reviews.find(review => review.runId === run.id) || null) }));
    return { projectId: pid, skills, drafts: copy(this.state.skills.filter(skill => skill.projectId === pid && skill.authorId === member.id && skill.status === 'draft')), contributions, eligibleRuns, rankingPolicy: '展示版本评分、样本量及适度平滑后的目录排序；没有员工绩效分。' };
  }
}

module.exports = { SkillCenter };
