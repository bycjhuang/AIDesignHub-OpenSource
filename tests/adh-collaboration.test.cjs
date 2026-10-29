'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./fixtures/native-adh-backend-fixture.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function executors(f) { return ['one', 'two'].map(id => f.hub.saveConnection({ id: `batch_${id}`, provider: 'custom', mode: 'cli', label: `测试 ${id}`, command: process.execPath, args: [] })); }
const tasksFor = connections => connections.map((item, index) => ({ connectionId: item.id, title: `独立任务 ${index + 1}`, instruction: `只处理各自固定内容 ${index + 1}，不访问项目原始文件。` }));
async function select(f, connections) { return f.request('select_executor', { executorId: 'collaboration', executorIds: connections.map(item => item.id) }, { caller: 'client' }); }

test('one explicit multi-Agent submission creates shared AgentHub jobs once, keeps independent task inputs and writes a durable native-session outbox', async t => {
  const f = setup(t), connections = executors(f), tasks = tasksFor(connections);
  await assert.rejects(f.request('external_dispatch_many', { requestId: 'batch-1', tasks }, { caller: 'client' }), error => error.code === 'USER_ACTION_REQUIRED');
  const selected = await select(f, connections); assert.equal(selected.executorId, 'collaboration'); assert.deepEqual(selected.executorIds, connections.map(item => item.id)); assert.equal(selected.externalExecutors.filter(item => item.id === 'adh').length, 0);
  await assert.rejects(f.request('external_dispatch_many', { requestId: 'batch-1', tasks }), error => error.code === 'USER_ACTION_REQUIRED');
  const args = { requestId: 'batch-1', tasks }, [first, duplicate] = await Promise.all([f.request('external_dispatch_many', args, { caller: 'client' }), f.request('external_dispatch_many', args, { caller: 'client' })]);
  assert.equal(first.batchId, duplicate.batchId); assert.equal(first.tasks.length, 2); assert.equal(f.hub.state.jobs.length, 2); assert.equal(f.hub.state.runs.length, 2);
  for (const [index, task] of first.tasks.entries()) {
    const job = f.hub.state.jobs.find(item => item.id === task.jobId), run = f.hub.state.runs.find(item => item.id === task.runId);
    assert.equal(job.instruction, tasks[index].instruction); assert.equal(job.adhSessionId, 'adh_session_a'); assert.equal(run.adhBatchId, first.batchId); assert.equal(run.projectId, f.currentProjectId);
  }
  await tick(); await tick(); assert.equal(f.counts().executionCalls, 2);
  assert.equal((await f.request('external_dispatch_many', args, { caller: 'client' })).batchId, first.batchId); assert.equal(f.counts().executionCalls, 2);
  await assert.rejects(f.request('external_dispatch_many', { ...args, tasks: [{ ...tasks[0], instruction: '不同内容' }] }, { caller: 'client' }), error => error.code === 'REQUEST_CONFLICT');
  const snapshot = await f.request('snapshot'); assert.equal(snapshot.collaborationBatches.length, 1); assert.equal(snapshot.runs.length, 2);
  const outbox = (await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries;
  const pending = await f.request('collaboration_pending', { limit: 20 }, { caller: 'host' }); assert.equal(pending.origins.length, 1); assert.equal(pending.origins[0].sessionId, 'adh_session_a'); assert.equal(pending.origins[0].projectId, f.currentProjectId); assert(pending.origins[0].deliveryCount > 0); assert(!JSON.stringify(pending).includes(tasks[0].instruction)); assert(!JSON.stringify(pending).includes('外部协作测试回传'));
  await assert.rejects(f.request('collaboration_pending', {}, { caller: 'client' }), error => error.code === 'USER_ACTION_REQUIRED');
  assert(outbox.some(item => item.kind === 'relay' && item.text.includes('外部协作测试回传'))); assert(outbox.some(item => item.text.includes(tasks[1].instruction)));
  assert(outbox.every(item => item.sessionId === 'adh_session_a' && item.projectId === f.currentProjectId));
  assert.equal((await f.request('collaboration_feed', { sessionIds: ['adh_session_b'] }, { caller: 'host' })).deliveries.length, 0);
  await assert.rejects(f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'client' }), error => error.code === 'USER_ACTION_REQUIRED');
  await assert.rejects(f.request('collaboration_ack', { sessionId: 'adh_session_b', projectId: f.currentProjectId, deliveryIds: [outbox[0].id] }, { caller: 'host' }), error => error.code === 'DELIVERY_SCOPE');
  await f.request('collaboration_ack', { sessionId: 'adh_session_a', projectId: f.currentProjectId, deliveryIds: outbox.map(item => item.id) }, { caller: 'host' });
  assert.equal((await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries.length, 0);
  assert.equal((await f.request('collaboration_pending', {}, { caller: 'host' })).origins.length, 0);
});

test('Host recovery metadata refuses stale or mismatched outbox origins and caps activation to twenty sessions', async t => {
  const f = setup(t), connection = executors(f)[0];
  f.backend.mutate(store => {
    for (let index = 0; index < 23; index++) {
      store.agentHub.runs.push({ id: `run-recovery-${index}`, projectId: f.currentProjectId, adhSessionId: `recovery-${index}`, connectionId: connection.id, status: 'queued' });
      store.adhCollaborationDeliveries.push({ id: `recovery-delivery-${index}`, projectId: f.currentProjectId, sessionId: `recovery-${index}`, runId: `run-recovery-${index}`, kind: 'notice', text: '恢复测试' });
    }
    store.adhCollaborationDeliveries.unshift({ id: 'forged-session', projectId: f.currentProjectId, sessionId: 'foreign-session', runId: 'run-recovery-0', kind: 'notice', text: '不能激活' }, { id: 'deleted-project', projectId: 'absent-project', sessionId: 'recovery-0', runId: 'run-recovery-0', kind: 'notice', text: '不能激活' }); return true;
  });
  const pending = await f.request('collaboration_pending', { limit: 200 }, { caller: 'host' }); assert.equal(pending.origins.length, 20); assert(!pending.origins.some(item => item.sessionId === 'foreign-session' || item.projectId === 'absent-project'));
  const feed = await f.request('collaboration_feed', { sessionIds: ['foreign-session', 'recovery-0'] }, { caller: 'host' }); assert(feed.deliveries.every(item => item.sessionId === 'recovery-0' && item.projectId === f.currentProjectId)); assert(!feed.deliveries.some(item => item.id === 'deleted-project'));
});

test('legacy acknowledged batches receive their original client command once without creating or replaying any external task', async t => {
  const f = setup(t), connections = executors(f), tasks = tasksFor(connections); await select(f, connections);
  const commandText = '/协作 @batch_one 保留原始任务一。\n@测试two 保留原始任务二。';
  const result = await f.request('external_dispatch_many', { requestId: 'legacy-command', tasks, commandText }, { caller: 'client' }); await tick(); await tick();
  const batch = f.backend.store.adhCollaborationBatches.find(item => item.id === result.batchId); assert.equal(batch.commandText, commandText);
  const first = (await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries; assert.equal(first[0].kind, 'submission'); assert.equal(first[0].text, commandText);
  f.backend.mutate(store => { store.adhCollaborationDeliveries = store.adhCollaborationDeliveries.filter(item => item.kind !== 'submission'); for (const item of store.adhCollaborationDeliveries) item.deliveredAt = Date.now(); const saved = store.adhCollaborationBatches.find(item => item.id === result.batchId); delete saved.commandText; delete saved.userSubmitted; return true; });
  const before = { jobs: f.hub.state.jobs.length, runs: f.hub.state.runs.length, executions: f.counts().executionCalls };
  f.service.collaboration.sync(); f.service.collaboration.sync();
  const recovered = (await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries;
  assert.equal(recovered.length, 1); assert.equal(recovered[0].kind, 'submission'); assert(recovered[0].text.includes(tasks[0].instruction)); assert(recovered[0].text.includes(tasks[1].instruction));
  assert.deepEqual({ jobs: f.hub.state.jobs.length, runs: f.hub.state.runs.length, executions: f.counts().executionCalls }, before);
});

test('progress normalization hides executor JSON/debug frames and isolated punctuation while retaining meaningful human progress', () => {
  const { normalizeProgress } = require('../backend/adh-collaboration.cjs');
  assert.equal(normalizeProgress('。'), ''); assert.equal(normalizeProgress(' \n... '), '');
  assert.equal(normalizeProgress('Hermes {"type":"status","message":"internal","session_id":"private-session"}'), '正在处理任务。');
  assert.equal(normalizeProgress('{"jsonrpc":"2.0","method":"session/update"}'), '正在处理任务。'); assert.equal(normalizeProgress('DEBUG internal transport log'), '正在处理任务。');
  assert.equal(normalizeProgress('已经核对两个公开来源。'), '已经核对两个公开来源。');
});

test('previously acknowledged hidden receipts are re-presented once with unique display IDs without repeating external execution', async t => {
  const f = setup(t), connections = executors(f), tasks = tasksFor(connections); await select(f, connections);
  await f.request('external_dispatch_many', { requestId: 'legacy-display', tasks }, { caller: 'client' }); await tick(); await tick();
  const originals = f.backend.store.adhCollaborationDeliveries.filter(item => item.kind === 'relay').map(item => item.id); assert.equal(originals.length, 2);
  f.backend.mutate(store => { for (const item of store.adhCollaborationDeliveries) { item.deliveredAt = Date.now(); if (item.kind !== 'submission') delete item.renderVersion; } return true; });
  const before = { jobs: f.hub.state.jobs.length, runs: f.hub.state.runs.length, executions: f.counts().executionCalls };
  f.service.collaboration.sync(); f.service.collaboration.sync();
  const pending = (await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries;
  const relays = pending.filter(item => item.kind === 'relay'); assert.equal(relays.length, 2); assert(relays.every(item => item.renderVersion === 2 && originals.includes(item.displayOf) && item.id !== item.displayOf));
  assert(relays.every(item => item.text.includes('外部协作测试回传'))); assert(pending.filter(item => item.kind === 'notice').every(item => !item.text.includes('"type"')));
  for (const id of originals) assert(f.backend.store.adhCollaborationDeliveries.find(item => item.id === id).deliveredAt);
  await f.request('collaboration_ack', { sessionId: 'adh_session_a', projectId: f.currentProjectId, deliveryIds: pending.map(item => item.id) }, { caller: 'host' });
  f.service.collaboration.sync(); assert.equal((await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries.length, 0);
  assert.deepEqual({ jobs: f.hub.state.jobs.length, runs: f.hub.state.runs.length, executions: f.counts().executionCalls }, before);
});

test('every batch item must validate before the first job; executor/project changes during preflight reject the whole batch', async t => {
  const f = setup(t), connections = executors(f), tasks = tasksFor(connections); await select(f, connections);
  for (const args of [{ requestId: 'bad-item', tasks: [tasks[0], { ...tasks[1], instruction: '' }] }, { requestId: 'bad-executor', tasks: [tasks[0], { ...tasks[1], connectionId: 'not_selected' }] }, { tasks }]) {
    await assert.rejects(f.request('external_dispatch_many', args, { caller: 'client' })); assert.equal(f.hub.state.jobs.length, 0);
  }
  let release; f.service.beforeExternalDispatch = () => new Promise(resolve => { release = resolve; });
  const changing = f.request('external_dispatch_many', { requestId: 'changing-executors', tasks }, { caller: 'client' }); await tick();
  await f.request('select_executor', { executorId: 'adh' }, { caller: 'client' }); release(); await assert.rejects(changing, error => error.code === 'EXECUTOR_CHANGED');
  assert.equal(f.hub.state.jobs.length, 0);
  await select(f, connections); const changingProject = f.request('external_dispatch_many', { requestId: 'changing-project', tasks }, { caller: 'client' }); await tick();
  f.switchProject(); await f.request('prepare_context'); release(); await assert.rejects(changingProject, error => error.code === 'PROJECT_CHANGED');
  assert.equal(f.hub.state.jobs.length, 0); assert.equal(f.counts().executionCalls, 0);
});

test('connection reconfiguration during a pending batch invalidates all tasks and request IDs are isolated by origin session', async t => {
  const f = setup(t), connections = executors(f), tasks = tasksFor(connections); await select(f, connections);
  let release; f.service.beforeExternalDispatch = () => new Promise(resolve => { release = resolve; });
  const pending = f.request('external_dispatch_many', { requestId: 'configuration-race', tasks }, { caller: 'client' }); await tick();
  f.hub.saveConnection({ ...connections[1], label: '用户重新配置的执行器' }); release(); await assert.rejects(pending, error => error.code === 'EXECUTOR_CHANGED'); assert.equal(f.hub.state.jobs.length, 0);
  f.service.beforeExternalDispatch = async () => {};
  const first = await f.request('external_dispatch_many', { requestId: 'same-session-key', tasks }, { caller: 'client' });
  await f.request('select_executor', { executorId: 'collaboration', executorIds: connections.map(item => item.id) }, { caller: 'client', sessionId: 'adh_session_b' });
  const second = await f.request('external_dispatch_many', { requestId: 'same-session-key', tasks }, { caller: 'client', sessionId: 'adh_session_b' });
  assert.notEqual(first.batchId, second.batchId); assert.equal(f.hub.state.jobs.length, 4); assert.equal(f.hub.state.runs.length, 4);
  await assert.rejects(f.request('external_status', { runId: first.tasks[0].runId }, { sessionId: 'adh_session_b' }), error => error.code === 'RUN_SCOPE');
  await tick(); await tick();
});

test('a failed Agent keeps its sibling result; progress/result deliveries survive project switches and coordinator recreation without redispatch', async t => {
  const f = setup(t), connections = executors(f), tasks = tasksFor(connections); await select(f, connections);
  f.hub.execute = async (connection, options) => { options.onEvent({ text: `真实测试进度 ${connection.id}` }); if (connection.id === connections[1].id) throw new Error('测试中的外部失败'); return { text: '第一位 Agent 的完整结果' }; };
  const batch = await f.request('external_dispatch_many', { requestId: 'partial-batch', tasks }, { caller: 'client' }); await tick(); await tick();
  assert.deepEqual(f.hub.state.runs.map(item => item.status), ['awaiting_review', 'failed']);
  const { AdhCollaboration } = require('../backend/adh-collaboration.cjs'); f.service.collaboration.dispose(); f.service.collaboration = new AdhCollaboration(f.service);
  assert.equal((await f.request('external_dispatch_many', { requestId: 'partial-batch', tasks }, { caller: 'client' })).batchId, batch.batchId); assert.equal(f.hub.state.runs.length, 2);
  f.switchProject(); await f.request('prepare_context');
  const outbox = [];
  for (let page = 0; page < 5; page++) {
    const entries = (await f.request('collaboration_feed', { sessionIds: ['adh_session_a'] }, { caller: 'host' })).deliveries; if (!entries.length) break;
    outbox.push(...entries); await f.request('collaboration_ack', { sessionId: 'adh_session_a', projectId: f.currentProjectId, deliveryIds: entries.map(item => item.id) }, { caller: 'host' });
  }
  assert(outbox.some(item => item.kind === 'relay' && item.text.includes('第一位 Agent 的完整结果'))); assert(outbox.some(item => item.text.includes('真实测试进度'))); assert(outbox.some(item => item.text.includes('测试中的外部失败')));
  assert(outbox.every(item => item.projectId === f.currentProjectId));
  await assert.rejects(f.request('external_status', { runId: batch.tasks[0].runId }), error => error.code === 'RUN_SCOPE');
  const catalog = await f.request('collaboration_catalog', {}, { caller: 'client', sessionId: undefined }); const directory = catalog.agents.find(item => item.id === connections[0].id).projects.find(item => item.id === f.currentProjectId);
  assert.equal(directory.tasks[0].sessionId, 'adh_session_a'); assert.equal(directory.tasks[0].runId, batch.tasks[0].runId);
  assert(!JSON.stringify(catalog).includes('第一位 Agent 的完整结果')); assert(!JSON.stringify(catalog).includes(tasks[0].instruction)); assert(!JSON.stringify(catalog).includes(f.directory));
  f.switchProject(f.currentProjectId); await f.request('prepare_context'); assert.match((await f.request('external_status', { runId: batch.tasks[0].runId })).output, /第一位 Agent/);
});
