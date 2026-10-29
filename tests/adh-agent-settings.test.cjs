'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./fixtures/native-adh-backend-fixture.cjs');
const { AgentPairingService } = require('../backend/agent-pairing.cjs');
function fixture(t) {
  const f = setup(t), copies = [], toggles = []; let remote = false, gateway = { running: false, url: '' };
  f.service.assertLocalAgentSettings = () => { if (remote) throw Object.assign(new Error('远端客户端不能更改本机接入设置。'), { code: 'LOCAL_ONLY' }); };
  f.service.clipboard = { writeText: value => { copies.push(value); } }; f.service.gatewayStatus = () => gateway;
  f.service.setGatewayEnabled = async enabled => {
    toggles.push(enabled); gateway = { running: enabled, url: enabled ? 'http://127.0.0.1:12345' : '' };
    f.hub.setGateway(enabled ? { url: gateway.url, command: process.execPath, mcpScript: path.resolve('scripts/hub-mcp.cjs'), cliScript: path.resolve('scripts/hub-cli.cjs') } : null);
  };
  const request = (action, args = {}, extra = {}) => f.request(action, args, { caller: 'client', projectId: f.currentProjectId, ...extra });
  return { ...f, request, copies, toggles, remote: value => { remote = value; } };
}
test('native settings reads and discovery do not save, pair, launch a model or reveal protected arguments', async t => {
  const f = fixture(t), secret = 'private-fixture-credential';
  const saved = f.hub.saveConnection({ id: 'protected-args', provider: 'custom', label: '既有设置', mode: 'cli', command: process.execPath, args: ['--token', secret] });
  let probes = 0; f.hub.probe = async () => { probes++; return { level: 'protocol', code: 'ACP_READY' }; };
  f.hub.discover = () => ({ candidates: [{ id: 'detected', provider: 'hermes', label: 'Hermes', installed: true, config: { provider: 'hermes', mode: 'acp', command: process.execPath, args: ['--token', secret] } }] });
  const before = f.hub.state.connections.length, settings = await f.request('collaboration_settings', {}, { sessionId: undefined });
  assert.equal(settings.capabilities.canConfigure, true); assert.equal(settings.connections.find(item => item.id === saved.id).args[1], '[已保护]'); assert(!JSON.stringify(settings).includes(secret));
  const discovery = await f.request('runtime_discover'); assert.equal(discovery.candidates[0].config.args[1], '[已保护]'); assert(!JSON.stringify(discovery).includes(secret)); assert.equal(f.hub.state.connections.length, before); assert.equal(probes, 0); assert.equal(f.counts().executionCalls, 0); assert.equal(f.hub.state.jobs.length, 0);
  const protectedConfig = settings.connections.find(item => item.id === saved.id);
  await f.request('connection_save', { confirmed: true, connection: { ...protectedConfig, label: '修改显示名' } });
  assert.equal(f.hub.connection(saved.id).args[1], secret); assert.equal(f.hub.connection(saved.id).label, '修改显示名');
  const backups = fs.readdirSync(path.join(f.directory, 'adh-connection-backups')); assert.equal(backups.length, 1); const backup = JSON.parse(fs.readFileSync(path.join(f.directory, 'adh-connection-backups', backups[0]), 'utf8')); assert.equal(backup.connection.label, '既有设置');
  await assert.rejects(f.request('connection_save', { confirmed: true, connection: { ...protectedConfig, label: '陈旧配置' } }), error => error.code === 'CONNECTION_CHANGED');
  await assert.rejects(f.request('connection_save', { confirmed: true, connection: { provider: 'custom', mode: 'cli', label: '禁止新密钥', command: process.execPath, args: ['--token', secret] } }), error => error.code === 'SECRET_INPUT');
});

test('native settings preserve local permissions and require explicit confirmation for writes, pairing and model tests', async t => {
  const f = fixture(t); let modelTests = 0;
  await assert.rejects(f.request('collaboration_settings', {}, { caller: 'tool' }), error => error.code === 'USER_ACTION_REQUIRED');
  for (const action of ['connection_save', 'runtime_pair', 'runtime_auto_pair', 'connection_probe', 'connection_test', 'gateway_toggle', 'grant_create_copy', 'grant_revoke']) await assert.rejects(f.request(action), error => error.code === 'USER_ACTION_REQUIRED');
  f.hub.testConnection = async () => { modelTests++; return { ok: true, modelCalled: true, level: 'task', message: '固定测试完成' }; };
  await assert.rejects(f.request('connection_test', { confirmed: true, connectionId: 'external' }), error => error.code === 'MODEL_CONFIRMATION_REQUIRED'); assert.equal(modelTests, 0);
  assert.equal((await f.request('connection_test', { confirmed: true, allowModel: true, connectionId: 'external' })).validation.modelCalled, true); assert.equal(modelTests, 1);
  f.remote(true); assert.equal((await f.request('collaboration_settings')).capabilities.canConfigure, false);
  for (const action of ['runtime_discover', 'connection_save', 'runtime_pair', 'runtime_auto_pair', 'connection_probe', 'gateway_toggle', 'grant_create_copy']) await assert.rejects(f.request(action, { confirmed: true }), error => error.code === 'LOCAL_ONLY');
  assert.equal(f.copies.length, 0); assert.equal(f.toggles.length, 0); assert.equal(f.counts().executionCalls, 0);
});

test('real AgentPairing service is reused by native settings and automatic pairing always disables model planning', async t => {
  const f = fixture(t); let planning = 0, probes = 0;
  f.hub.discover = () => ({ candidates: [{ id: 'hermes-entry', provider: 'hermes', label: 'Hermes Agent', installed: true, pairable: true, config: { provider: 'hermes', mode: 'acp', command: process.execPath, args: ['--acp'], label: 'Hermes Agent' } }] });
  f.hub.probe = async () => { probes++; return { level: 'protocol', code: 'ACP_READY', message: 'ACP 握手完成，无模型调用。' }; };
  f.service.agentPairing = new AgentPairingService({ hub: f.hub, dataDir: path.join(f.directory, 'device-pairing'), planner: async () => { planning++; return { candidateIds: [] }; } }); t.after(() => f.service.agentPairing.dispose());
  const paired = await f.request('runtime_pair', { candidateId: 'hermes-entry', confirmLaunch: true }); assert(paired.ok); assert(paired.remembered); assert.equal(probes, 1);
  const automatic = await f.request('runtime_auto_pair', { confirmed: true, useModel: true }); assert.equal(automatic.modelAssisted, false); assert.equal(planning, 0); assert.equal(probes, 2); assert(automatic.results.some(item => item.provider === 'hermes' && item.ok));
  assert(fs.existsSync(path.join(f.directory, 'device-pairing/agent-pairings.json'))); assert.equal(f.counts().executionCalls, 0); assert.equal(f.hub.state.jobs.length, 0); assert.equal(f.hub.state.runs.length, 0);
  const connection = await f.service.start();
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'runtime_auto_pair', caller: 'client', arguments: { confirmed: true } }) });
  const envelope = await response.json(); assert.equal(response.status, 200); assert.equal(envelope.ok, true); assert.equal(envelope.result.ok, false); assert(envelope.result.results.some(item => item.provider === 'hermes' && item.ok));
});

test('MCP grant creation copies secrets only through native clipboard and snapshots/templates contain no raw token', async t => {
  const f = fixture(t), member = f.backend.store.members.find(item => item.projectId === f.currentProjectId && item.active !== false);
  await f.request('gateway_toggle', { enabled: true, confirmed: true }); assert.equal(f.toggles.length, 1);
  const template = await f.request('client_config', { transport: 'stdio' }); assert.equal(template.containsToken, false); assert(JSON.stringify(template.config).includes('<AIDESIGNHUB_TOKEN>'));
  const result = await f.request('grant_create_copy', { label: '原生客户端', memberId: member.id, scopes: ['project:read'], copy: 'config', transport: 'stdio', confirmed: true }); assert(result.copied);
  const copied = JSON.parse(f.copies[0]), token = copied.mcpServers.AIDesignHub.env.AIDESIGNHUB_TOKEN; assert(f.hub.authorize(token));
  assert(!JSON.stringify(result).includes(token)); assert(!Object.hasOwn(result.grant, 'tokenHash')); assert(!JSON.stringify(await f.request('collaboration_settings')).includes(token)); assert(!JSON.stringify(template).includes(token));
  const onlyToken = await f.request('grant_create_copy', { label: '仅复制授权', memberId: member.id, scopes: ['tasks:read'], copy: 'token', confirmed: true }); assert(onlyToken.copied); assert(f.hub.authorize(f.copies[1])); assert(!JSON.stringify(onlyToken).includes(f.copies[1]));
  await assert.rejects(f.request('grant_revoke', { grantId: result.grant.id, confirmed: true }, { projectId: f.foreignId }), error => error.code === 'PROJECT_CHANGED');
  await f.request('grant_revoke', { grantId: result.grant.id, confirmed: true }); assert.equal(f.hub.authorize(token), null);
  assert.equal(f.counts().executionCalls, 0); assert.equal(f.hub.state.jobs.length, 0);
});

test('unavailable clipboard creates no grant, failed copy revokes its grant, and project switches cannot leave a usable copied grant', async t => {
  const f = fixture(t), member = f.backend.store.members.find(item => item.projectId === f.currentProjectId && item.active !== false), args = { label: '复制边界', memberId: member.id, scopes: ['project:read'], copy: 'token', confirmed: true };
  f.service.clipboard = null; await assert.rejects(f.request('grant_create_copy', args), error => error.code === 'CLIPBOARD_UNAVAILABLE'); assert.equal(f.hub.access.grants.length, 0);
  f.service.clipboard = { writeText: () => { throw new Error('do not expose credentials'); } }; await assert.rejects(f.request('grant_create_copy', args), error => error.code === 'CLIPBOARD_FAILED'); assert(f.hub.access.grants.every(item => item.revokedAt));
  let release, copied; f.service.clipboard = { writeText: value => { copied = value; return new Promise(resolve => { release = resolve; }); } };
  const pending = f.request('grant_create_copy', args); await new Promise(resolve => setImmediate(resolve)); f.switchProject(); release(); await assert.rejects(pending, error => error.code === 'PROJECT_CHANGED'); assert.equal(f.hub.authorize(copied), null);
});

test('legacy collaboration detail keeps history accessible in the native center without exposing private fixed input or expanding model scope', async t => {
  const f = fixture(t), secret = 'some-private-auth';
  f.backend.mutate(store => { store.agentHub.jobs.push({ id: 'legacy-job', projectId: f.currentProjectId, title: '旧协作任务' }); store.agentHub.runs.push({ id: 'legacy-run', jobId: 'legacy-job', projectId: f.currentProjectId, connectionId: 'openclaw', status: 'awaiting_review', input: { title: '旧协作任务', privateContext: '不能返回的固定私密上下文' }, output: `保留完整的历史成果。\nAuthorization: Bearer ${secret}` }); store.agentHub.events.push({ id: 'legacy-json', projectId: f.currentProjectId, runId: 'legacy-run', type: 'progress', message: 'Hermes {"type":"status","internal":"private"}' }, { id: 'legacy-dot', projectId: f.currentProjectId, runId: 'legacy-run', type: 'progress', message: '。' }); return true; });
  const detail = await f.request('collaboration_run', { runId: 'legacy-run' }); assert.match(detail.run.output, /完整的历史成果/); assert.equal(detail.run.sessionId, null); assert(!JSON.stringify(detail).includes(secret)); assert(!JSON.stringify(detail).includes('固定私密上下文')); assert(!JSON.stringify(detail).includes('"internal"')); assert.equal(detail.events.length, 1);
  const catalog = await f.request('collaboration_catalog'); assert(catalog.agents.some(agent => agent.projects.some(project => project.tasks.some(task => task.runId === 'legacy-run'))));
  await assert.rejects(f.request('collaboration_run', { runId: 'legacy-run' }, { caller: 'tool' }), error => error.code === 'USER_ACTION_REQUIRED');
  await assert.rejects(f.request('external_status', { runId: 'legacy-run' }, { caller: 'tool' }), error => error.code === 'RUN_SCOPE');
  f.switchProject(); await assert.rejects(f.request('collaboration_run', { runId: 'legacy-run' }, { projectId: f.foreignId }), error => error.code === 'RUN_SCOPE');
});
