'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SOURCE_URL, PROJECT_ID, MEMBER_ID, SCOPES, TOOLS, timeoutFromArgs, DEFAULT_TIMEOUT_MS } = require('../scripts/zcode-case-test.cjs');
const entry = path.join(__dirname, '..', 'scripts', 'zcode-case-test.cjs');
const finalUrl = 'https://ennead.com/work/shanghai-astronomy-museum/';
const page = {
  url: SOURCE_URL, finalUrl, title: 'Shanghai Astronomy Museum', retrievedAt: 123456,
  text: 'Shanghai Astronomy Museum\nSize: 420,000 GSF\nProgram: Museum\nLocation: Shanghai, China\nDesign Architect: Ennead Architects\nPUBLIC_CASE_BODY_NOT_IN_RECEIPT',
};
const output = {
  name: 'Shanghai Astronomy Museum', area: '420,000 GSF', typeLabel: 'Museum', location: 'Shanghai, China', openingDate: null, designer: 'Ennead Architects',
  summary: 'PUBLIC_CASE_BODY_NOT_IN_RECEIPT',
  evidence: [
    ['name', 'Shanghai Astronomy Museum', 'Shanghai Astronomy Museum'],
    ['area', '420,000 GSF', 'Size: 420,000 GSF'],
    ['typeLabel', 'Museum', 'Program: Museum'],
    ['location', 'Shanghai, China', 'Location: Shanghai, China'],
    ['designer', 'Ennead Architects', 'Design Architect: Ennead Architects'],
  ].map(([field, value, quote]) => ({ field, value, sourceUrl: finalUrl, quote })),
};
const fixtureFetcher = `async url => { if (url !== ${JSON.stringify(SOURCE_URL)}) throw new Error('Unexpected source'); return ${JSON.stringify(page)}; }`;

function bootstrap({ timeoutMs = 10000, fetcher = fixtureFetcher, signal = false } = {}) {
  return `require(${JSON.stringify(entry)}).startCaseTestServer({timeoutMs:${timeoutMs},fetchPage:${fetcher}}).then(async session => { ${signal ? "process.emit('SIGTERM');" : ''} await session.closed; }).catch(() => {process.exitCode=1;});`;
}
function readyFrom(stream) {
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Case harness startup timed out')), 10000);
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let parsed; try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.event === 'aidesignhub-zcode-case-test-ready') { clearTimeout(timer); resolve(parsed); }
      }
    });
  });
}
const receipt = ready => JSON.parse(fs.readFileSync(ready.receiptPath, 'utf8'));
const store = ready => JSON.parse(fs.readFileSync(path.join(ready.dataDir, 'store.json'), 'utf8'));
async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 15)); } while (Date.now() < deadline);
  throw new Error('Test state did not settle');
}
function registerDirectory(t, ready) {
  assert.equal(path.dirname(ready.dataDir), path.resolve(os.tmpdir()));
  assert.match(path.basename(ready.dataDir), /^aidesignhub-zcode-case-/);
  t.after(() => fs.rmSync(ready.dataDir, { recursive: true, force: true }));
}
async function connected(t, options = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', bootstrap(options)], stderr: 'pipe',
    env: { AIDESIGNHUB_URL: 'http://127.0.0.1:1', AIDESIGNHUB_TOKEN: 'caller-credential-not-for-test' } });
  const readyPromise = readyFrom(transport.stderr); let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'official-sdk-case-fixture-not-zcode', version: '1.0.0' });
  await client.connect(transport); const ready = await readyPromise; registerDirectory(t, ready);
  t.after(() => client.close());
  return { client, ready, getStderr: () => stderr };
}
async function availableRun(client, ready) {
  await until(() => receipt(ready).runId);
  const result = await client.callTool({ name: 'hub_run_list', arguments: {} });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.result.length, 1);
  return result.structuredContent.result[0];
}
function assertStopped(ready) {
  const item = receipt(ready);
  assert.equal(item.status, 'stopped'); assert.equal(item.grantRevoked, true);
  assert.equal(item.gatewayStopped, true); assert.equal(item.bridgeExited, true);
  const access = JSON.parse(fs.readFileSync(path.join(ready.dataDir, 'agent-access.json'), 'utf8'));
  assert.equal(access.grants.length, 1); const grant = access.grants[0];
  assert.deepEqual(grant.scopes, [...SCOPES]); assert.equal('token' in grant, false);
  assert.match(grant.tokenHash, /^[a-f0-9]{64}$/); assert.ok(grant.revokedAt);
  assert.equal(grant.expiresAt, item.grantExpiresAt); assert.ok(grant.expiresAt - grant.createdAt <= DEFAULT_TIMEOUT_MS);
  assert.equal(grant.temporary, undefined, 'The wrapper must not expand or bypass the read-only temporary-grant policy.');
  assert.throws(() => process.kill(item.bridgePid, 0), error => error.code === 'ESRCH');
  return item;
}

test('case harness SDK lists exactly five scoped tools and submits sourced output for human review only', async t => {
  const { client, ready, getStderr } = await connected(t);
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [...TOOLS].sort());
  const run = await availableRun(client, ready); assert.equal(run.status, 'waiting_agent');
  const tasks = await client.callTool({ name: 'hub_task_list', arguments: {} });
  assert.equal(tasks.structuredContent.jobs.length, 1); assert.equal(tasks.structuredContent.tasks.length, 1);
  const claimed = await client.callTool({ name: 'hub_run_claim', arguments: { runId: run.id } });
  assert.equal(claimed.isError, false); assert.equal(claimed.structuredContent.projectId, PROJECT_ID);
  assert.match(claimed.structuredContent.input.instruction, /PUBLIC_CASE_BODY_NOT_IN_RECEIPT/);
  assert.ok(claimed.structuredContent.input.instruction.includes(SOURCE_URL));
  const report = await client.callTool({ name: 'hub_run_report', arguments: { runId: run.id, message: '整理公开来源字段。' } });
  assert.equal(report.isError, false);
  const result = await client.callTool({ name: 'hub_artifact_submit', arguments: { runId: run.id, requestId: 'fixture-result-1', content: JSON.stringify(output) } });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.status, 'awaiting_review');
  const saved = store(ready); const item = saved.cases[0];
  assert.equal(saved.projects.length, 1); assert.equal(saved.projects[0].id, PROJECT_ID);
  assert.equal(saved.members.length, 1); assert.equal(saved.members[0].id, MEMBER_ID);
  assert.equal(saved.agentHub.connections.length, 1); assert.equal(saved.agentHub.connections[0].mode, 'inbound');
  for (const key of ['messages', 'channels', 'decisions', 'risks', 'knowledgeDocs', 'contractMilestones', 'scopeChanges', 'connectorSettings']) assert.deepEqual(saved[key], []);
  assert.equal(item.sourceUrl, SOURCE_URL); assert.equal(item.research.status, 'awaiting_review');
  assert.equal(item.research.fields.area.status, 'source-quoted'); assert.equal(item.area, '420,000 GSF');
  assert.equal(saved.agentHub.runs[0].status, 'awaiting_review'); assert.equal(saved.agentHub.jobs[0].status, 'doing');
  assert.equal(JSON.parse(saved.agentHub.runs[0].output).summary, output.summary);
  assert.equal(fs.readFileSync(path.join(ready.dataDir, 'case-pages', `${item.id}.txt`), 'utf8'), page.text);
  const before = receipt(ready);
  assert.equal(before.protocolInitialized, true); assert.equal(before.contextRead, true); assert.equal(before.runClaimed, true);
  assert.equal(before.artifactSubmitted, true); assert.equal(before.researchStatus, 'awaiting_review');
  assert.equal(before.humanApproved, false); assert.equal(before.acceptanceStatus, 'awaiting-human-review');
  assert.equal(before.toolCallCounts.hub_artifact_submit, 1); assert.equal(before.clientIdentityVerified, false);
  assert.equal(JSON.stringify(before).includes(output.summary), false); assert.equal(JSON.stringify(before).includes('official-sdk'), false);
  assert.equal(getStderr().includes('caller-credential-not-for-test'), false);
  await client.close(); const final = assertStopped(ready); assert.equal(final.stopReason, 'stdin-eof');
  assert.equal(final.researchStatus, 'awaiting_review'); assert.equal(final.humanApproved, false);
});

test('case harness denies project/knowledge/write/review/collection and foreign-run access', async t => {
  const { client, ready } = await connected(t); const run = await availableRun(client, ready);
  for (const name of ['hub_project_context', 'hub_knowledge_search', 'hub_skill_get', 'hub_task_create', 'hub_task_start', 'hub_case_collect', 'hub_case_list', 'hub_review_run']) {
    await assert.rejects(client.callTool({ name, arguments: {} }), /unknown|unauthorized/i);
  }
  await assert.rejects(client.callTool({ name: 'hub_run_list', arguments: { projectId: 'project_jiangwan' } }), /not allowed/i);
  const foreign = await client.callTool({ name: 'hub_run_claim', arguments: { runId: 'run_real_project' } }); assert.equal(foreign.isError, true);
  const unclaimed = await client.callTool({ name: 'hub_artifact_submit', arguments: { runId: run.id, requestId: 'without-claim', content: JSON.stringify(output) } });
  assert.equal(unclaimed.isError, true); assert.equal(store(ready).agentHub.runs[0].status, 'waiting_agent');
  assert.equal(receipt(ready).artifactSubmitted, false); assert.equal(receipt(ready).deniedToolCallCount, 11);
  await client.close(); assertStopped(ready);
});

test('case harness invalid JSON or invalid evidence field becomes a failed research result, never approval', async t => {
  for (const content of ['not structured JSON', JSON.stringify({ name: 'Wrong', evidence: 'not-an-array' })]) {
    const { client, ready } = await connected(t); const run = await availableRun(client, ready);
    await client.callTool({ name: 'hub_run_claim', arguments: { runId: run.id } });
    const submitted = await client.callTool({ name: 'hub_artifact_submit', arguments: { runId: run.id, requestId: 'invalid-fixture', content } });
    assert.equal(submitted.isError, false, 'The original artifact is preserved even when case validation fails.');
    const saved = store(ready); assert.equal(saved.agentHub.runs[0].output, content);
    assert.equal(saved.cases[0].research.status, 'failed'); assert.ok(saved.cases[0].research.error);
    const before = receipt(ready); assert.equal(before.artifactSubmitted, true); assert.equal(before.researchStatus, 'failed');
    assert.equal(before.acceptanceStatus, 'validation-or-run-failed'); assert.equal(before.humanApproved, false);
    await client.close(); const final = assertStopped(ready); assert.equal(final.researchStatus, 'failed');
  }
});

test('case harness contradictory numeric fields are visibly unverified rather than accepted', async t => {
  const { client, ready } = await connected(t); const run = await availableRun(client, ready);
  await client.callTool({ name: 'hub_run_claim', arguments: { runId: run.id } });
  const candidate = { ...output, area: '999 GSF', evidence: output.evidence.map(item => item.field === 'area' ? { ...item, value: '999 GSF' } : item) };
  await client.callTool({ name: 'hub_artifact_submit', arguments: { runId: run.id, requestId: 'wrong-number', content: JSON.stringify(candidate) } });
  assert.equal(store(ready).cases[0].research.fields.area.status, 'needs_verification');
  assert.equal(receipt(ready).fieldVerificationRequired, true); assert.equal(receipt(ready).acceptanceStatus, 'fields-need-verification');
  assert.equal(receipt(ready).humanApproved, false); await client.close(); assertStopped(ready);
});

test('case harness source failure still handshakes and records failure without creating an invented task', async t => {
  const { client, ready } = await connected(t, { fetcher: 'async () => {throw new Error("FIXTURE_PAGE_ERROR_BODY");}' });
  await until(() => receipt(ready).researchStatus === 'failed');
  assert.deepEqual((await client.callTool({ name: 'hub_run_list', arguments: {} })).structuredContent.result, []);
  const before = receipt(ready); assert.equal(before.protocolInitialized, true); assert.equal(before.researchPreparing, false);
  assert.equal(before.artifactSubmitted, false); assert.equal(before.runId, undefined);
  assert.equal(JSON.stringify(before).includes('FIXTURE_PAGE_ERROR_BODY'), false);
  assert.equal(store(ready).agentHub.jobs.length, 0); await client.close(); assertStopped(ready);
});

test('case harness initializes during pending fetch, and timeout aborts preparation and owned bridge', async t => {
  const fetcher = 'async (_url,{signal}) => new Promise((resolve,reject) => { if(signal.aborted) reject(new Error("aborted")); else signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}); })';
  const { client, ready, getStderr } = await connected(t, { timeoutMs: 800, fetcher });
  assert.equal(receipt(ready).protocolInitialized, true); assert.equal(receipt(ready).researchPreparing, true);
  assert.deepEqual((await client.callTool({ name: 'hub_run_list', arguments: {} })).structuredContent.result, []);
  assert.deepEqual((await client.callTool({ name: 'hub_task_list', arguments: {} })).structuredContent.jobs, []);
  assert.equal(receipt(ready).contextRead, false, 'An empty preparation-time list is not delivered research context.');
  try { await until(() => receipt(ready).status === 'stopped'); }
  catch { throw new Error(`Case timeout cleanup stalled: ${JSON.stringify(receipt(ready))}; fixture diagnostics: ${getStderr()}`); }
  const final = assertStopped(ready); assert.equal(final.stopReason, 'timeout'); assert.equal(final.researchStatus, 'failed');
  assert.equal(final.artifactSubmitted, false); await client.close();
});

test('case harness Node SIGTERM handler closes without pretending Windows force-kill can run cleanup', async t => {
  const child = spawn(process.execPath, ['-e', bootstrap({ signal: true })], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Signal cleanup timed out')); }, 5000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  const ready = await readyFrom(child.stderr); registerDirectory(t, ready);
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
  assert.equal(await done, 0); assert.equal(stdout, '');
  const final = assertStopped(ready); assert.equal(final.stopReason, 'sigterm'); assert.equal(final.protocolInitialized, false);
});

test('case harness exhausted receipt sharing-lock retries cannot skip grant revocation or process cleanup', async t => {
  const code = `require(${JSON.stringify(entry)}).startCaseTestServer({fetchPage:${fixtureFetcher}}).then(async session => {
    const fs=require('node:fs'), rename=fs.renameSync; let failures=process.platform==='win32'?6:1;
    fs.renameSync=(from,to)=>{if(to===session.receiptPath&&failures-->0){const error=new Error('fixture sharing lock');error.code='EPERM';throw error;}return rename(from,to);};
    process.emit('SIGTERM'); await session.closed;
  });`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Receipt failure interrupted cleanup')); }, 5000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  const ready = await readyFrom(child.stderr); registerDirectory(t, ready);
  assert.equal(await done, 0);
  const final = assertStopped(ready); assert.equal(final.receiptWriteFailed, true); assert.equal(final.cleanupFailed, undefined);
});

test('case harness CLI cannot select arbitrary source/data directory or increase lifetime', () => {
  assert.equal(timeoutFromArgs([]), DEFAULT_TIMEOUT_MS);
  for (const args of [['--source', 'https://example.com'], ['--data-dir', 'C:\\real'], ['--fixture', 'fixture.json'], ['--timeout-ms', '1800001']]) assert.throws(() => timeoutFromArgs(args));
});
