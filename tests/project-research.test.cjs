'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AgentHub } = require('../backend/agent-hub.cjs');
const { CaseResearchService } = require('../backend/case-research.cjs');
const { ProjectResearchService } = require('../backend/project-research.cjs');

const a = 'https://architecture.example.org/case', b = 'https://design.example.org/case';
const data = () => ({ summary: '已阅读两站原文。', sources: [{ url: a, title: '来源一', read: true }, { url: b, title: '来源二', read: true }], cases: [{ name: '水岸艺术馆', primarySourceUrl: a, sourceUrls: [a, b], area: '8000平方米', openingDate: null, summary: '滨水公共空间', evidence: [{ field: 'name', value: '水岸艺术馆', sourceUrl: a, quote: '项目名称：水岸艺术馆' }, { field: 'area', value: '8000平方米', sourceUrl: b, quote: '建筑面积8000平方米' }], sources: [{ url: a, imageUrls: ['https://images.example.org/a.jpg'] }, { url: b, imageUrls: ['https://images.example.org/b.jpg'] }], references: [{ point: '保留滨水步行界面', application: '当前项目滨水路径连通', limitation: '需核对防洪标高', sourceUrls: [a] }] }], references: [{ point: '连续公共岸线', application: '结合当前文化商业街区', limitation: '需核对项目边界', sourceUrls: [a, b] }] });
function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-project-research-'));
  const backend = new LocalBackend({ dataDir });
  const hub = new AgentHub({ backend, execute: async () => ({ text: JSON.stringify(options.output || data()) }) });
  const cases = new CaseResearchService({ backend, hub });
  const connection = hub.saveConnection({ provider: 'hermes', mode: 'cli', command: process.execPath, args: [] });
  const calls = [];
  const imageResearch = options.imageResearch || { archiveSources: async payload => { calls.push(payload); return { status: 'complete', images: payload.sources.map((source, i) => ({ assetId: `image_${i}`, caseId: source.caseId, sourcePageUrl: source.url, width: 2000, height: 1500 })), assetIds: payload.sources.map((_, i) => `image_${i}`), errors: [] }; } };
  const service = new ProjectResearchService({ backend, hub, cases, fetchPage: options.fetchPage || (async url => ({ url, finalUrl: url, title: '水岸艺术馆', text: '项目名称：水岸艺术馆。建筑面积8000平方米。滨水公共空间。', images: [], retrievedAt: 123 })), imageResearch, projectContext: options.projectContext });
  const start = extra => service.start({ projectId: 'project_jiangwan', brief: '调研滨水文化商业案例', connectionId: connection.id, ...extra });
  const done = async id => { for (let i = 0; i < 200 && !['complete', 'partial', 'failed', 'interrupted', 'cancelled'].includes(service.get(id).status); i++) { await new Promise(resolve => setTimeout(resolve, 2)); await service.idle(); } return service.get(id); };
  const cleanup = async () => { service.dispose(); await service.idle(); cases.dispose(); hub.dispose?.(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { backend, hub, cases, service, start, done, calls, cleanup };
}

test('project research dispatches a real Hub task, verifies two sources, archives selected images and persists reviewable cases', async () => {
  const f = fixture();
  try {
    const initial = f.start({ seedUrls: [a] }), result = await f.done(initial.id);
    assert.equal(result.status, 'complete'); assert.equal(f.hub.state.jobs.length, 1); assert.equal(f.hub.state.runs[0].status, 'awaiting_review');
    assert.equal(result.sources.length, 2); assert(result.sources.every(item => item.status === 'read'));
    assert.equal(result.cases[0].fields.area.status, 'source-quoted'); assert(result.cases[0].caseId); assert.equal(result.images.length, 2);
    assert.equal(f.cases.find(result.cases[0].caseId).research.status, 'awaiting_review'); assert.equal(f.calls.length, 1); assert(f.calls[0].sources.every(source => source.page.text));
    const reopened = new LocalBackend({ dataDir: f.backend.dataDir }); assert.equal(reopened.store.projectResearch[0].id, result.id); assert.equal(reopened.store.projectResearch[0].status, 'complete');
    const sources = JSON.parse(fs.readFileSync(path.join(f.backend.dataDir, 'project-research', result.sourceSnapshot.file), 'utf8')); assert.equal(sources.pages.length, 2); assert(sources.pages.every(item => item.text.includes('水岸艺术馆')));
    assert.match(f.hub.state.jobs[0].instruction, /实际调用联网搜索/); assert.equal(f.hub.state.jobs[0].allowProjectTools, false);
  } finally { await f.cleanup(); }
});

test('unreadable pages and fabricated quotes cannot create a verified case or download images', async () => {
  const output = data(); output.cases[0].evidence[0].quote = '没有在来源出现的项目名称：水岸艺术馆';
  const f = fixture({ output, fetchPage: async url => { if (url === b) throw new Error('HTTP 403：需要验证'); return { url, text: '真实正文：水岸艺术馆，滨水景观。', title: '水岸艺术馆' }; } });
  try {
    const result = await f.done(f.start().id);
    assert.equal(result.status, 'partial'); assert.equal(result.cases[0].status, 'needs_verification'); assert.equal(result.cases[0].caseId, undefined); assert.equal(f.calls.length, 0);
    assert.equal(result.sources.find(item => item.url === b).status, 'unavailable'); assert.match(result.sources.find(item => item.url === b).error, /403/);
    assert.match(result.errors.join('\n'), /身份核验/); assert.doesNotMatch(result.errors.join('\n'), /服务尚未就绪/);
    assert.equal(f.backend.store.cases.filter(item => item.sourceUrl === a).length, 0);
  } finally { await f.cleanup(); }
});

test('selected project context is frozen at dispatch, private provider fields are excluded and sharing can be disabled', async () => {
  let reads = 0;
  const f = fixture({ projectContext: () => { reads++; return { project: { focus: '文化街区' }, tasks: [{ title: '滨水调研' }], decisions: [], risks: [], secretToken: 'do-not-share', members: [{ name: '私人成员' }] }; } });
  try {
    f.backend.mutate(store => { store.projects.find(item => item.id === 'project_jiangwan').researchProfile = { isSynthetic: true, positioning: '演示假设文化商业街区', siteAreaM2: 42000, unrelatedSecret: 'never' }; return true; });
    const first = await f.done(f.start().id); assert.equal(reads, 1); assert.equal(first.projectSnapshot.tasks[0].title, '滨水调研'); assert.equal(first.projectSnapshot.secretToken, undefined); assert.equal(first.projectSnapshot.members, undefined);
    assert.equal(first.projectSnapshot.researchProfile.siteAreaM2, 42000); assert.equal(first.projectSnapshot.researchProfile.unrelatedSecret, undefined);
    const second = await f.done(f.start({ includeProjectContext: false }).id); assert.equal(reads, 1); assert.equal(second.projectSnapshot.researchProfile, undefined); assert.equal(second.projectSnapshot.tasks, undefined);
  } finally { await f.cleanup(); }
});

test('invalid input never dispatches and malformed Agent output remains a failed run result', async () => {
  const f = fixture({ output: { summary: '没有结构化案例。' } });
  try {
    assert.throws(() => f.start({ seedUrls: ['http://127.0.0.1/internal'] }), /公开/); assert.throws(() => f.start({ maxCases: 9 }), /1至6/); assert.equal(f.hub.state.jobs.length, 0);
    const result = await f.done(f.start().id); assert.equal(result.status, 'failed'); assert.match(result.error, /cases/); assert.equal(f.hub.state.runs[0].status, 'awaiting_review');
  } finally { await f.cleanup(); }
});

test('one available picture source remains partial and retry preserves history', async () => {
  const f = fixture({ imageResearch: { archiveSources: async payload => ({ status: 'partial', images: [{ assetId: 'one', caseId: payload.sources[0].caseId, sourcePageUrl: a, width: 2000, height: 1500 }], errors: ['第二来源原图不可读取。'] }) } });
  try {
    const first = await f.done(f.start().id); assert.equal(first.status, 'partial'); assert.equal(first.images.length, 1); assert.match(first.warnings.join('\n'), /两个详情页/);
    const retried = f.service.retry(first.id); assert.equal(retried.revision, 2); const second = await f.done(first.id); assert.equal(second.status, 'partial'); assert.equal(second.history[0].images.length, 1); assert.equal(second.history[0].status, 'partial');
  } finally { await f.cleanup(); }
});

test('same-site gallery links do not count as two independent websites', async () => {
  const output = data(), gallery = 'https://architecture.example.org/case/gallery';
  output.sources[1].url = gallery; output.cases[0].sourceUrls[1] = gallery; output.cases[0].sources[1].url = gallery; output.cases[0].evidence[1].sourceUrl = gallery;
  const f = fixture({ output });
  try { const result = await f.done(f.start().id); assert.equal(result.status, 'partial'); assert.equal(result.sources.length, 2); assert.match(result.warnings.join('\n'), /跨站对比/); } finally { await f.cleanup(); }
});

test('interrupted Agent runs recover to a terminal state on reopening and can be retried', async () => {
  const f = fixture();
  try {
    const first = await f.done(f.start().id);
    f.backend.mutate(store => { const task = store.projectResearch.find(item => item.id === first.id); task.status = 'researching'; const run = store.agentHub.runs.find(item => item.id === task.runId); run.status = 'interrupted'; run.error = '关窗中断，请核对外部任务。'; return true; });
    f.service.dispose();
    const restored = new ProjectResearchService({ backend: f.backend, hub: f.hub, cases: f.cases });
    assert.equal(restored.get(first.id).status, 'interrupted'); assert.match(restored.get(first.id).error, /关窗/); assert.equal(restored.retry(first.id).revision, 2); restored.dispose();
  } finally { await f.cleanup(); }
});

test('rejecting a run during source validation aborts work and late pages cannot create cases', async () => {
  let entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const f = fixture({ fetchPage: (url, { signal }) => new Promise((resolve, reject) => { entered(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) });
  try {
    const started = f.start(); await gate;
    const active = f.service.get(started.id); assert.equal(active.status, 'validating');
    f.hub.reviewRun(active.runId, false); await f.service.idle();
    const result = f.service.get(started.id); assert.equal(result.status, 'failed'); assert.equal(result.cases.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.backend.store.cases.filter(item => item.sourceUrl === a).length, 0);
  } finally { await f.cleanup(); }
});

test('Markdown emphasis added by a reader does not invalidate unchanged source wording and original quotes are retained', async () => {
  const output = data(); output.cases[0].evidence[0].quote = '**项目信息**项目名称：水岸艺术馆';
  const f = fixture({ output, fetchPage: async url => ({ url, finalUrl: url, title: '水岸艺术馆', text: '项目信息 项目名称：水岸艺术馆。建筑面积8000平方米。', images: [] }) });
  try {
    const result = await f.done(f.start().id); assert.equal(result.status, 'complete'); assert(result.cases[0].caseId);
    assert.equal(result.cases[0].evidence[0].quote, '**项目信息**项目名称：水岸艺术馆'); assert.equal(result.cases[0].evidence[0].quoteNormalization, 'markdown-emphasis-and-whitespace');
    assert.equal(result.cases[0].fields.name.status, 'source-quoted');
  } finally { await f.cleanup(); }
});

test('an exact original-language name proof can become the identity source while preserving the original primary URL', async () => {
  const output = data(); output.cases[0].evidence[0].sourceUrl = b;
  const f = fixture({ output, fetchPage: async url => ({ url, finalUrl: url, title: url === a ? 'Waterfront Art Museum' : '水岸艺术馆', text: url === a ? 'The Waterfront Art Museum creates a public waterfront.' : '项目名称：水岸艺术馆。建筑面积8000平方米。', images: [] }) });
  try {
    const result = await f.done(f.start().id), record = result.cases[0]; assert.equal(result.status, 'complete'); assert.equal(record.primarySourceUrl, b); assert.equal(record.originalPrimarySourceUrl, a);
    assert.deepEqual(new Set(record.sourceUrls), new Set([a, b])); assert.match(result.warnings.join('\n'), /未经翻译或推断/); assert.equal(f.cases.find(record.caseId).sourceUrl, b); assert.equal(f.cases.find(record.caseId).research.originalPrimarySourceUrl, a); assert.equal(f.calls[0].sources.length, 2);
  } finally { await f.cleanup(); }
});

test('revalidate reuses existing Agent output, retains history and never invokes the model or creates another run', async () => {
  const f = fixture();
  try {
    const first = await f.done(f.start().id), count = f.hub.state.runs.length;
    f.hub.execute = async () => { throw new Error('must not invoke an executor'); };
    const retry = f.service.revalidate(first.id); assert.equal(retry.revision, first.revision + 1); const result = await f.done(first.id);
    assert.equal(result.status, 'complete'); assert.equal(f.hub.state.runs.length, count); assert.equal(f.hub.state.jobs.length, count); assert.equal(result.runId, first.runId); assert.equal(result.validationAttempt, 1); assert.equal(result.history.at(-1).action, 'revalidate'); assert.equal(result.history.at(-1).revision, first.revision); assert.notEqual(result.sourceSnapshot.file, first.sourceSnapshot.file);
  } finally { await f.cleanup(); }
});
