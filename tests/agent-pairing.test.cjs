'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentPairingService, fingerprint } = require('../backend/agent-pairing.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const good = () => ({ ok: true, verified: false, level: 'protocol', message: '协议握手通过，未调用模型。', checkedAt: 123 });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-pairing-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^aidesignhub-pairing-test-/); fs.rmSync(root, { recursive: true, force: true }); });
  const candidate = {
    id: 'discovered-deepseek', provider: 'deepseek', installed: true, pairable: true,
    config: { provider: 'deepseek', label: 'DeepSeek Harness', mode: 'acp', command: path.join(root, 'node.exe'), args: [path.join(root, 'dsh', 'bin.js'), '--profile', 'acp'] },
  };
  const calls = { discover: 0, save: [], probe: [] };
  const hub = {
    candidates: [candidate], state: { connections: [{ id: 'deepseek', provider: 'deepseek', mode: 'inbound', verifiedAt: null }] },
    discoverRuntimes() { calls.discover++; return { candidates: copy(this.candidates) }; },
    saveConnection(input) {
      calls.save.push(copy(input)); const saved = { ...copy(input), id: input.id || `connection-${calls.save.length}`, verifiedAt: null, revision: `rev-${calls.save.length}` };
      const i = this.state.connections.findIndex(c => c.id === saved.id); if (i === -1) this.state.connections.push(saved); else this.state.connections[i] = saved;
      return copy(saved);
    },
    async probeConnection(id) { calls.probe.push(id); return this.probeResult ? await this.probeResult(id) : good(); },
    connection(id) { const connection = this.state.connections.find(c => c.id === id); if (!connection) throw new Error('Connection missing'); return copy(connection); },
  };
  const dataDir = path.join(root, 'device-settings-v1');
  const service = new AgentPairingService({ hub, dataDir, clock: () => 123 });
  return { root, dataDir, candidate, hub, calls, service };
}

test('pairing requires explicit launch confirmation before detection, save or launch', async t => {
  const f = fixture(t);
  for (const confirmLaunch of [undefined, false, 'true', 1]) await assert.rejects(f.service.pair({ candidateId: f.candidate.id, confirmLaunch }));
  assert.deepEqual(f.calls, { discover: 0, save: [], probe: [] }); assert.equal(fs.existsSync(f.dataDir), false);
});

test('pairing resolves the selected ID from fresh discovery and ignores supplied config', async t => {
  const f = fixture(t); const result = await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true, config: { command: 'evil-command', args: ['synthetic-secret'], cwd: 'private-folder' } });
  assert.equal(f.calls.discover, 1); assert.equal(result.ok, true); assert.equal(result.remembered, true);
  assert.equal(f.calls.save[0].command, f.candidate.config.command); assert.deepEqual(f.calls.save[0].args, f.candidate.config.args);
  assert.ok(!JSON.stringify(f.calls).includes('evil-command')); assert.ok(!JSON.stringify(f.calls).includes('synthetic-secret'));
  assert.equal(result.connection.verifiedAt, null); assert.equal(result.validation.verified, false);
});

test('a vanished candidate cannot be launched using stale renderer metadata', async t => {
  const f = fixture(t); f.hub.candidates = [];
  await assert.rejects(f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true, config: f.candidate.config }));
  assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
});

test('desktop apps, missing runtimes and unsafe templates are never launched', async t => {
  const f = fixture(t);
  const base = f.candidate;
  const candidates = [
    { ...base, provider: 'chatgpt', config: { ...base.config, provider: 'chatgpt', mode: 'inbound' } },
    { ...base, provider: 'zcode', config: { ...base.config, provider: 'zcode', mode: 'cli' } },
    { ...base, installed: false }, { ...base, pairable: false },
    { ...base, config: { ...base.config, cwd: path.join(f.root, 'private-project') } },
    { ...base, config: { ...base.config, endpoint: 'https://gateway.example' } },
    { ...base, config: { ...base.config, tokenEnv: 'PRIVATE_AGENT_TOKEN' } },
    { ...base, config: { ...base.config, command: 'relative.exe' } },
    { ...base, config: { ...base.config, provider: 'openclaw' } },
  ];
  for (const candidate of candidates) { f.hub.candidates = [candidate]; await assert.rejects(f.service.pair({ candidateId: base.id, confirmLaunch: true })); }
  assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
});

test('pairing adds a safe connection without overwriting a custom connection', async t => {
  const f = fixture(t); const custom = { id: 'deepseek', provider: 'deepseek', mode: 'acp', command: path.join(f.root, 'custom.exe'), args: ['custom'], cwd: path.join(f.root, 'private'), verifiedAt: 111 };
  f.hub.state.connections = [copy(custom)];
  const result = await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  assert.notEqual(result.connection.id, custom.id); assert.deepEqual(f.hub.state.connections.find(c => c.id === custom.id), custom);
});

test('same launch recipe with a private working directory is not silently reused for pairing', async t => {
  const f = fixture(t); const custom = { ...f.candidate.config, id: 'private-project-runner', cwd: path.join(f.root, 'private-project'), verifiedAt: 111 };
  f.hub.state.connections = [copy(custom)];
  const result = await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  assert.notEqual(result.connection.id, custom.id); assert.ok(!result.connection.cwd);
  assert.deepEqual(f.hub.state.connections.find(c => c.id === custom.id), custom);
  assert.ok(!f.calls.probe.includes(custom.id));
});

test('persisted pairing contains only provider, fingerprint and timestamp; no launch arguments or secrets', async t => {
  const f = fixture(t); await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  const raw = fs.readFileSync(path.join(f.dataDir, 'agent-pairings.json'), 'utf8'); const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['pairings', 'version']); assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.pairings[0]).sort(), ['fingerprint', 'pairedAt', 'provider']);
  assert.equal(parsed.pairings[0].fingerprint, fingerprint(f.candidate.config));
  for (const value of [f.candidate.config.command, ...f.candidate.config.args, 'verifiedAt', 'grants', 'token', 'cwd']) assert.ok(!raw.includes(value));
});

test('re-saving pairing metadata does not retain unknown legacy secret or argv fields', async t => {
  const f = fixture(t); fs.mkdirSync(f.dataDir, { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'agent-pairings.json'), JSON.stringify({ version: 1, pairings: [{ provider: 'hermes', fingerprint: 'f'.repeat(64), pairedAt: 1, args: ['private-argv'], token: 'synthetic-legacy-secret' }] }));
  await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  const raw = fs.readFileSync(path.join(f.dataDir, 'agent-pairings.json'), 'utf8');
  assert.ok(!raw.includes('private-argv')); assert.ok(!raw.includes('synthetic-legacy-secret'));
  for (const item of JSON.parse(raw).pairings) assert.deepEqual(Object.keys(item).sort(), ['fingerprint', 'pairedAt', 'provider']);
});

test('failed or stale validation is not remembered as paired or ready', async t => {
  for (const validation of [{ ok: false, verified: false, level: 'protocol', message: 'Failed' }, { ...good(), stale: true }]) {
    const f = fixture(t); f.hub.probeResult = () => validation;
    const result = await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
    assert.equal(result.ok, false); assert.equal(result.remembered, false); assert.equal(fs.existsSync(path.join(f.dataDir, 'agent-pairings.json')), false);
  }
});

test('configuration-only success cannot mark a CLI or ACP runtime remembered', async t => {
  const f = fixture(t); f.hub.probeResult = () => ({ ...good(), level: 'configuration' });
  const result = await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  assert.equal(result.remembered, false); assert.equal(fs.existsSync(path.join(f.dataDir, 'agent-pairings.json')), false);
});

test('overlapping same-candidate pairing is blocked and completion releases the lock', async t => {
  const f = fixture(t); let release;
  f.hub.probeResult = () => new Promise(resolve => { release = resolve; });
  const first = f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  await assert.rejects(f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true }), /正在配对/);
  assert.equal(f.calls.probe.length, 1); release(good()); await first;
  f.hub.probeResult = () => good(); assert.equal((await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true })).ok, true);
});

test('probe exceptions release the busy lock and do not persist pairing', async t => {
  const f = fixture(t); f.hub.probeResult = () => { throw new Error('Synthetic probe failure'); };
  await assert.rejects(f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true }), /Synthetic/);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'agent-pairings.json')), false);
  f.hub.probeResult = () => good(); assert.equal((await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true })).remembered, true);
});

test('legacy restore uses the fresh safe template and drops grants, validation and task verification', t => {
  const f = fixture(t); const old = { ...f.candidate.config, id: 'old-database-id', verifiedAt: 999, validation: { ok: true }, modelValidation: { verified: true }, runtimeVerification: { runId: 'private-run' }, grants: ['private-grant'], token: 'synthetic-token' };
  const before = copy(old); const result = f.service.restore([old]);
  assert.equal(result.restored.length, 1); assert.equal(f.calls.probe.length, 0); assert.deepEqual(old, before);
  const saved = f.hub.connection(result.restored[0].connectionId); assert.equal(saved.verifiedAt, null);
  for (const key of ['grants', 'token', 'validation', 'modelValidation', 'runtimeVerification']) assert.equal(saved[key], undefined);
  assert.deepEqual(f.calls.save[0], { ...f.candidate.config, id: 'deepseek' });
});

test('legacy restore rejects mismatched recipes and project-specific working directories', t => {
  const f = fixture(t); const base = f.candidate.config;
  for (const old of [{ ...base, args: ['unrelated'] }, { ...base, cwd: path.join(f.root, 'private') }, { ...base, tokenEnv: 'PRIVATE_TOKEN' }, { ...base, endpoint: 'https://gateway.example' }]) assert.equal(f.service.restore([old]).restored.length, 0);
  assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
});

test('remembered hash restores only a matching runtime currently discovered, without launching it', async t => {
  const f = fixture(t); await f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true });
  f.calls.save = []; f.calls.probe = []; f.hub.state.connections = [{ id: 'deepseek', provider: 'deepseek', mode: 'inbound' }];
  const result = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir }).restore();
  assert.equal(result.restored.length, 1); assert.equal(f.calls.probe.length, 0); assert.equal(f.hub.connection(result.restored[0].connectionId).verifiedAt, null);
  f.hub.state.connections = [{ id: 'deepseek', provider: 'deepseek', mode: 'inbound' }]; f.hub.candidates[0].config.args.push('--new-version');
  assert.equal(f.service.restore().restored.length, 0);
});

test('restore never replaces any non-placeholder provider connection', t => {
  const f = fixture(t); const existing = { id: 'deepseek', provider: 'deepseek', mode: 'acp', command: path.join(f.root, 'custom.exe'), args: ['custom'], verifiedAt: 10 };
  f.hub.state.connections = [copy(existing)]; const result = f.service.restore([copy(f.candidate.config)]);
  assert.equal(result.restored.length, 0); assert.deepEqual(result.skipped, ['deepseek']); assert.equal(f.calls.save.length, 0); assert.deepEqual(f.hub.state.connections[0], existing);
});

test('invalid persisted pairing data produces a warning, no launch and no copied authorization', t => {
  const f = fixture(t); fs.mkdirSync(f.dataDir, { recursive: true }); fs.writeFileSync(path.join(f.dataDir, 'agent-pairings.json'), '{ invalid fixture');
  const result = f.service.restore(); assert.match(result.warning, /未自动恢复/); assert.equal(result.restored.length, 0);
  assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
});

test('automatic pairing also requires confirmation before discovery or model planning', async t => {
  const f = fixture(t); let plannerCalls = 0;
  const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: async () => { plannerCalls++; return {}; } });
  for (const confirmed of [false, undefined, 1, 'true']) await assert.rejects(service.autoPair({ confirmed, useModel: true }));
  assert.equal(plannerCalls, 0); assert.equal(f.calls.discover, 0); assert.equal(f.calls.probe.length, 0);
});

test('automatic planning receives only software metadata and can only rank detector-approved IDs', async t => {
  const f = fixture(t); let plannerInput;
  const second = { ...copy(f.candidate), id: 'preferred-deepseek', label: 'Preferred ACP', config: { ...copy(f.candidate.config), args: ['preferred-local-entry.js', '--profile', 'acp'] }, version: '1.0' };
  f.hub.candidates.push(second);
  const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: async input => { plannerInput = input; return { candidateIds: [second.id], command: 'MODEL-CANNOT-RUN-THIS', config: { args: ['PRIVATE-TOKEN'] } }; } });
  const result = await service.autoPair({ confirmed: true, useModel: true });
  assert.equal(result.modelAssisted, true); assert.deepEqual(f.calls.save[0].args, second.config.args);
  assert.deepEqual(Object.keys(plannerInput), ['candidates']);
  for (const candidate of plannerInput.candidates) assert.deepEqual(Object.keys(candidate).sort(), ['id', 'installed', 'mode', 'pairable', 'provider', 'version']);
  for (const value of [f.candidate.config.command, f.candidate.config.args[0], 'apiKey', 'projectContext']) assert.ok(!JSON.stringify(plannerInput).includes(value));
  assert.ok(!JSON.stringify(f.calls).includes('MODEL-CANNOT-RUN-THIS')); assert.ok(!JSON.stringify(f.calls).includes('PRIVATE-TOKEN'));
  assert.equal(result.results.find(r => r.provider === 'deepseek').ok, true);
});

test('automatic pairing works without model use and reports GUI authorization as a separate state', async t => {
  const f = fixture(t); let plannerCalls = 0;
  f.hub.candidates.push({ id: 'chatgpt-desktop', provider: 'chatgpt', installed: true, pairable: false }, { id: 'zcode-desktop', provider: 'zcode', installed: true, pairable: false });
  const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: async () => { plannerCalls++; return {}; } });
  const result = await service.autoPair({ confirmed: true, useModel: false });
  assert.equal(plannerCalls, 0); assert.equal(result.modelAssisted, false); assert.equal(f.calls.probe.length, 1);
  for (const provider of ['chatgpt', 'zcode']) assert.equal(result.needsUserAction.find(r => r.provider === provider).code, 'CLIENT_AUTHORIZATION_REQUIRED');
  assert.equal(result.needsUserAction.find(r => r.provider === 'hermes').code, 'INSTALLATION_NOT_FOUND');
  assert.match(result.summary, /配对不等于模型任务验证/);
});

test('model error or invented candidate IDs fall back to fixed safe discovery recipes', async t => {
  for (const plan of [async () => { throw new Error('PRIVATE PROVIDER ERROR'); }, async () => ({ candidateIds: ['invented-agent'], command: 'unsafe' })]) {
    const f = fixture(t); const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: plan });
    const result = await service.autoPair({ confirmed: true, useModel: true });
    assert.equal(result.modelAssisted, false); assert.match(result.summary, /受控配对规则/);
    assert.equal(result.results.find(r => r.provider === 'deepseek').ok, true); assert.deepEqual(f.calls.save[0].args, f.candidate.config.args);
    assert.ok(!JSON.stringify(result).includes('PRIVATE PROVIDER ERROR')); assert.ok(!JSON.stringify(f.calls).includes('unsafe'));
  }
});

test('duplicate planner IDs cannot consume retry slots or prevent the real fallback recipe', async t => {
  const f = fixture(t); const second = { ...copy(f.candidate), id: 'fallback-deepseek', config: { ...copy(f.candidate.config), args: ['fallback.js', '--profile', 'acp'] } };
  f.hub.candidates.push(second); f.hub.probeResult = id => f.hub.connection(id).args[0] === second.config.args[0] ? good() : { ...good(), ok: false, code: 'ACP_ERROR' };
  const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: async () => ({ candidateIds: [f.candidate.id, f.candidate.id, f.candidate.id] }) });
  const result = await service.autoPair({ confirmed: true, useModel: true }); const item = result.results.find(r => r.provider === 'deepseek');
  assert.equal(result.modelAssisted, false); assert.equal(item.ok, true); assert.equal(f.calls.probe.length, 2);
  assert.deepEqual(item.attempts.map(a => a.candidateId), [f.candidate.id, second.id]);
});

test('automatic pairing tries another known candidate after failure and only remembers the successful recipe', async t => {
  const f = fixture(t); const second = { ...copy(f.candidate), id: 'deepseek-fallback', label: 'Known fallback', config: { ...copy(f.candidate.config), args: ['fallback.js', '--profile', 'acp'] } };
  f.hub.candidates.push(second); f.hub.probeResult = id => f.hub.connection(id).args[0] === second.config.args[0] ? good() : { ...good(), ok: false, code: 'ACP_ERROR' };
  const progress = []; f.service.on('progress', event => progress.push(event.stage));
  const result = await f.service.autoPair({ confirmed: true, useModel: false }); const item = result.results.find(r => r.provider === 'deepseek');
  assert.equal(item.ok, true); assert.deepEqual(item.attempts.map(a => a.candidateId), [f.candidate.id, second.id]); assert.deepEqual(item.attempts.map(a => a.ok), [false, true]);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'agent-pairings.json'), 'utf8'));
  assert.equal(saved.pairings.length, 1); assert.equal(saved.pairings[0].fingerprint, fingerprint(second.config));
  assert.ok(progress.includes('repairing')); assert.equal(progress.at(-1), 'complete');
});

test('automatic retry is bounded to three known candidates per product with no failed fingerprint persistence', async t => {
  const f = fixture(t); f.hub.candidates = Array.from({ length: 6 }, (_, i) => ({ ...copy(f.candidate), id: `deepseek-${i}`, label: `Candidate ${i}`, config: { ...copy(f.candidate.config), args: [`candidate-${i}.js`, '--profile', 'acp'] } }));
  f.hub.probeResult = () => ({ ...good(), ok: false, code: 'ACP_ERROR' });
  const result = await f.service.autoPair({ confirmed: true, useModel: false }); const item = result.results.find(r => r.provider === 'deepseek');
  assert.equal(item.code, 'PAIRING_NEEDS_ATTENTION'); assert.equal(item.attempts.length, 3); assert.equal(f.calls.probe.length, 3);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'agent-pairings.json')), false);
});

test('automatic configuration blocks concurrent runs and releases the lock after completion', async t => {
  const f = fixture(t); let release;
  const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: () => new Promise(resolve => { release = resolve; }) });
  const pending = service.autoPair({ confirmed: true, useModel: true });
  await assert.rejects(service.autoPair({ confirmed: true, useModel: false }), /正在进行/); assert.equal(f.calls.probe.length, 0);
  release({ candidateIds: [f.candidate.id] }); await pending; assert.equal(service.running, false);
  await service.autoPair({ confirmed: true, useModel: false }); assert.equal(service.running, false);
});

test('automatic discovery failure preserves existing connections and releases the global running lock', async t => {
  const f = fixture(t); const before = copy(f.hub.state.connections); const discover = f.hub.discoverRuntimes;
  f.hub.discoverRuntimes = () => { throw new Error('PRIVATE ERROR'); };
  await assert.rejects(f.service.autoPair({ confirmed: true, useModel: false }), error => !error.message.includes('PRIVATE ERROR'));
  assert.equal(f.service.running, false); assert.deepEqual(f.hub.state.connections, before); assert.equal(f.calls.save.length, 0);
  f.hub.discoverRuntimes = discover; assert.equal((await f.service.autoPair({ confirmed: true, useModel: false })).results.find(r => r.provider === 'deepseek').ok, true);
});

test('a candidate removed while the model plans is never executed from its old discovery snapshot', async t => {
  const f = fixture(t); const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: async () => { f.hub.candidates = []; return { candidateIds: [f.candidate.id] }; } });
  const result = await service.autoPair({ confirmed: true, useModel: true });
  assert.equal(result.results.find(r => r.provider === 'deepseek').code, 'PAIRING_NEEDS_ATTENTION'); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'agent-pairings.json')), false);
});

test('shutdown while model planning is pending prevents every later save and probe', async t => {
  for (const stopHub of [false, true]) {
    const f = fixture(t); let release;
    const service = new AgentPairingService({ hub: f.hub, dataDir: f.dataDir, planner: () => new Promise(resolve => { release = resolve; }) });
    const pending = service.autoPair({ confirmed: true, useModel: true });
    if (stopHub) f.hub.disposed = true; else service.dispose();
    release({ candidateIds: [f.candidate.id] });
    await assert.rejects(pending); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
    assert.equal(service.running, false); assert.equal(fs.existsSync(f.dataDir), false);
  }
});

test('shutdown during an active probe cannot remember late success or attempt another discovered entry', async t => {
  const f = fixture(t); let release;
  f.hub.candidates.push({ ...copy(f.candidate), id: 'fallback-entry', config: { ...copy(f.candidate.config), args: ['fallback.js'] } });
  f.hub.probeResult = () => new Promise(resolve => { release = resolve; });
  const pending = f.service.autoPair({ confirmed: true, useModel: false });
  assert.equal(f.calls.probe.length, 1); f.service.dispose(); release(good());
  await assert.rejects(pending); assert.equal(f.calls.probe.length, 1); assert.equal(f.calls.save.length, 1);
  assert.equal(f.service.running, false); assert.equal(f.service.busy.size, 0); assert.equal(fs.existsSync(f.dataDir), false);
});

test('disposed pairing rejects new automatic or single-candidate starts before any side effects', async t => {
  const f = fixture(t); f.service.dispose();
  await assert.rejects(f.service.autoPair({ confirmed: true, useModel: false }), error => error.code === 'SETUP_STOPPED');
  await assert.rejects(f.service.pair({ candidateId: f.candidate.id, confirmLaunch: true }), error => error.code === 'SETUP_STOPPED');
  assert.equal(f.calls.discover, 0); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.probe.length, 0);
});
