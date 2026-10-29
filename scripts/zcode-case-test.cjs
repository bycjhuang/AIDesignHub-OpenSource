#!/usr/bin/env node
'use strict';

// Authorized public-case acceptance harness, never the user's real workspace.
// CLI accepts a shorter lifetime only; source/dataDir/permissions cannot be changed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AgentHub } = require('../backend/agent-hub.cjs');
const { AgentGateway } = require('../backend/agent-gateway.cjs');
const { CaseResearchService } = require('../backend/case-research.cjs');

const DEFAULT_TIMEOUT_MS = 1800000;
const SOURCE_URL = 'https://ennead.com/work/shanghai-astronomy-museum/#aidesignhub-case-acceptance';
const PROJECT_ID = 'project_zcode_case_synthetic';
const MEMBER_ID = 'member_zcode_case_synthetic';
const SCOPES = Object.freeze(['tasks:read', 'runs:write']);
const TOOLS = Object.freeze(['hub_task_list', 'hub_run_list', 'hub_run_claim', 'hub_run_report', 'hub_artifact_submit']);

function timeoutFromArgs(args) {
  if (!args.length) return DEFAULT_TIMEOUT_MS;
  if (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1])) throw new Error('Invalid test arguments');
  const value = Number(args[1]);
  if (!Number.isSafeInteger(value) || value < 100 || value > DEFAULT_TIMEOUT_MS) throw new Error('Invalid test timeout');
  return value;
}
function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  // Windows readers/antivirus can briefly deny replacement of an open receipt.
  // Retry only transient sharing violations, with a bounded total of 155 ms.
  const delays = [5, 10, 20, 40, 80];
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); return; }
    catch (cause) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(cause.code) || attempt >= delays.length) throw cause;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
    }
  }
}
function bridgeEnvironment(url, token) {
  const env = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'SYSTEMDRIVE', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (/^electron(?:\.exe)?$/i.test(path.basename(process.execPath))) env.ELECTRON_RUN_AS_NODE = '1';
  return { ...env, AIDESIGNHUB_URL: url, AIDESIGNHUB_TOKEN: token };
}

async function startCaseTestServer({ timeoutMs = DEFAULT_TIMEOUT_MS, fetchPage } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error('Invalid test timeout');
  if (fetchPage !== undefined && typeof fetchPage !== 'function') throw new Error('Invalid fixture fetcher');
  // fetchPage is module-only test injection. The CLI has no fixture/source/data-dir flag.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-zcode-case-'));
  const receiptPath = path.join(dataDir, 'case-test-receipt.json');
  const deadline = Date.now() + timeoutMs;
  const receipt = {
    kind: 'isolated-public-case-acceptance', version: 1, createdAt: new Date().toISOString(),
    pid: process.pid, projectId: PROJECT_ID, sourceUrl: SOURCE_URL,
    syntheticProjectOnly: true, publicSourceOnly: true, clientIdentityVerified: false,
    scopes: [...SCOPES], allowedTools: [...TOOLS], status: 'starting',
    protocolInitialized: false, initializationCount: 0, toolListCount: 0,
    toolCallCounts: Object.fromEntries(TOOLS.map(name => [name, 0])), deniedToolCallCount: 0,
    researchPreparing: true, researchStatus: 'queued', runStatus: null, artifactSubmitted: false,
    contextRead: false, runClaimed: false, humanApproved: false,
    grantPolicy: 'normal-grant-with-shortened-isolated-test-lifetime', grantExpiresAt: deadline,
    grantRevoked: false, gatewayStopped: false, bridgeExited: false,
  };
  // Receipts are diagnostic, never a reason to abandon revocation or child cleanup.
  // The grant hash write below deliberately does NOT use this best-effort wrapper.
  const writeReceipt = (required = false) => {
    try { atomicJson(receiptPath, receipt); }
    catch (cause) {
      if (required) throw cause;
      if (!receipt.receiptWriteFailed) process.stderr.write('Isolated case receipt could not be updated; cleanup continues.\n');
      receipt.receiptWriteFailed = true;
    }
  };
  writeReceipt(true);
  let backend, hub, cases, gateway, grantId, bridge, bridgeClosed = false, bridgeCode;
  let stopping, lifetimeTimer, collectHandle, caseId;
  const cleanupFailure = (stage, cause) => {
    receipt.cleanupFailed = true; receipt.cleanupFailureStage = stage;
    receipt.cleanupErrorCode = typeof cause?.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : 'EXCEPTION';
  };
  let resolveClosed, resolveBridge;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const bridgeDone = new Promise(resolve => { resolveBridge = resolve; });
  const snapshotState = () => {
    const item = caseId && cases?.find(caseId);
    if (item) {
      receipt.caseId = item.id; receipt.researchStatus = item.research.status;
      receipt.researchPreparing = ['queued', 'fetching'].includes(item.research.status);
      if (item.research.jobId) receipt.jobId = item.research.jobId;
      if (item.research.runId) receipt.runId = item.research.runId;
      const run = hub.state.runs.find(value => value.id === item.research.runId);
      receipt.runStatus = run?.status || null;
      receipt.artifactSubmitted = Boolean(run?.artifactId);
      receipt.humanApproved = run?.status === 'succeeded';
      receipt.fieldStatuses = Object.fromEntries(Object.entries(item.research.fields).map(([field, value]) => [field, value.status]));
      receipt.fieldVerificationRequired = Object.values(item.research.fields).some(value => ['unsupported', 'needs_verification'].includes(value.status));
      receipt.acceptanceStatus = item.research.status === 'failed' ? 'validation-or-run-failed'
        : item.research.status === 'awaiting_review' ? (receipt.fieldVerificationRequired ? 'fields-need-verification' : 'awaiting-human-review') : 'pending-agent';
    }
    writeReceipt();
  };
  const waitBridge = async ms => {
    if (!bridge || bridgeClosed) return;
    let timer;
    await Promise.race([bridgeDone, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  };
  const onEof = () => { void stop('stdin-eof'); };
  const onSigterm = () => { void stop('sigterm'); };
  const onSigint = () => { void stop('sigint'); };
  const onStdoutError = () => { void stop('stdout-closed'); };
  function stop(reason) {
    if (stopping) return stopping;
    stopping = (async () => {
      clearTimeout(lifetimeTimer); clearImmediate(collectHandle);
      receipt.lifecyclePhase = 'closing-input'; writeReceipt();
      process.stdin.unpipe(bridge?.stdin); process.stdin.pause();
      if (bridge?.stdin.writable) bridge.stdin.end();
      if (reason === 'stdin-eof') await waitBridge(1200);
      receipt.lifecyclePhase = 'revoking-grant'; writeReceipt();
      try { if (hub && grantId) { hub.revokeGrant(grantId); receipt.grantRevoked = true; } }
      catch (cause) { cleanupFailure('revoke-grant', cause); }
      // Stop the page fetch promptly and close our owned bridge to stop its HTTP
      // traffic before closing the gateway. Receipt persistence errors must never
      // interrupt this cleanup sequence.
      try { cases?.dispose(); } catch (cause) { cleanupFailure('dispose-cases', cause); }
      if (bridge && !bridgeClosed) {
        receipt.lifecyclePhase = 'stopping-bridge'; writeReceipt();
        try { bridge.kill('SIGTERM'); } catch { /* Only this owned child. */ }
        await waitBridge(1000);
        if (!bridgeClosed) { try { bridge.kill('SIGKILL'); } catch {} await waitBridge(1000); }
      }
      receipt.lifecyclePhase = 'stopping-gateway'; writeReceipt();
      try { await gateway?.stop(); receipt.gatewayStopped = true; }
      catch (cause) { cleanupFailure('stop-gateway', cause); }
      receipt.lifecyclePhase = 'disposing-case-service'; writeReceipt();
      try { hub?.dispose(); cases?.syncRuns(); await cases?.idle(); snapshotState(); }
      catch (cause) { cleanupFailure('dispose-hub', cause); }
      cases?.removeListener('changed', snapshotState); hub?.removeListener('changed', snapshotState);
      receipt.bridgeExited = !bridge || bridgeClosed;
      if (bridgeCode !== undefined) receipt.bridgeExitCode = bridgeCode;
      receipt.status = receipt.cleanupFailed || !receipt.bridgeExited ? 'cleanup-failed' : 'stopped';
      receipt.lifecyclePhase = 'finished';
      receipt.stopReason = reason; receipt.stoppedAt = new Date().toISOString();
      try { writeReceipt(); } catch (cause) { cleanupFailure('write-final-receipt', cause); }
      process.stdin.removeListener('end', onEof); process.stdout.removeListener('error', onStdoutError);
      process.removeListener('SIGTERM', onSigterm); process.removeListener('SIGINT', onSigint);
      if (receipt.cleanupFailed || ['startup-failed', 'bridge-failed'].includes(reason)) process.exitCode = 1;
      resolveClosed({ dataDir, receiptPath, status: receipt.status });
    })();
    return stopping;
  }
  try {
    backend = new LocalBackend({ dataDir });
    backend.mutate(store => {
      for (const key of Object.keys(store)) if (Array.isArray(store[key])) store[key] = [];
      store.settings = { currentProjectId: PROJECT_ID, currentMemberId: MEMBER_ID, currentRole: 'designer' };
      store.projects = [{ id: PROJECT_ID, name: 'AIDesignHub 公开案例隔离测试项目', city: '虚构测试城市', type: '公开案例验收', stage: 'test' }];
      store.members = [{ id: MEMBER_ID, projectId: PROJECT_ID, name: '虚构案例测试成员', role: 'designer', active: true }];
      store.agentHub = { version: 1, connections: [{ id: 'zcode', provider: 'zcode', label: 'ZCode 隔离测试', mode: 'inbound', verifiedAt: null }], jobs: [], runs: [], events: [] };
      return true;
    });
    hub = new AgentHub({ backend }); // Intentionally no execute adapter.
    cases = new CaseResearchService({ backend, hub, ...(fetchPage ? { fetchPage } : {}) });
    cases.on('changed', snapshotState); hub.on('changed', snapshotState);
    const grant = hub.createGrant({ label: '公开案例隔离测试授权', projectId: PROJECT_ID, memberId: MEMBER_ID, scopes: [...SCOPES], expiresInDays: 1 });
    grantId = grant.id;
    // Do NOT expand core TEMPORARY_SCOPES. This explicitly authorized test grant is
    // normal, narrowed to exactly two scopes, and its own hash record is shortened
    // atomically before the bridge can see the token. No raw token is serialized.
    const storedGrant = hub.access.grants.find(value => value.id === grantId);
    storedGrant.expiresAt = Math.min(storedGrant.expiresAt, deadline);
    atomicJson(hub.secretFile, hub.access);
    gateway = new AgentGateway({ hub });
    const originalRpc = gateway._rpc.bind(gateway);
    gateway._rpc = async (message, principal) => {
      try {
        const result = await originalRpc(message, principal);
        if (message?.method === 'initialize' && result?.protocolVersion) {
          receipt.protocolInitialized = true; receipt.initializationCount++; receipt.protocolVersion = result.protocolVersion;
          result.instructions += ' This is an isolated public-case test. The fixed source is preparing in the background; task/run lists may initially be empty. Only the available test run can be claimed. Submit evidence-backed JSON and leave it awaiting human review. Never approve or access real files.';
        } else if (message?.method === 'tools/list' && result?.tools) receipt.toolListCount++;
        else if (message?.method === 'tools/call') {
          const name = message.params?.name;
          if (result?.isError === false && TOOLS.includes(name)) {
            receipt.toolCallCounts[name]++;
            if (name === 'hub_run_claim' || (name === 'hub_task_list' && result.structuredContent?.jobs?.length > 0)) receipt.contextRead = true;
            if (name === 'hub_run_claim') receipt.runClaimed = true;
          } else receipt.deniedToolCallCount++;
        }
        snapshotState(); return result;
      } catch (error) {
        if (message?.method === 'tools/call') { receipt.deniedToolCallCount++; snapshotState(); }
        throw error;
      }
    };
    const { url, port } = await gateway.start(); receipt.loopbackPort = port;
    bridge = spawn(process.execPath, [path.join(__dirname, 'hub-mcp.cjs')], { cwd: dataDir, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: bridgeEnvironment(url, grant.token) });
    delete grant.token; receipt.bridgePid = bridge.pid;
    bridge.stdin.on('error', () => {});
    bridge.stderr.on('data', () => { receipt.bridgeDiagnosticSeen = true; });
    bridge.on('error', () => { void stop('bridge-failed'); });
    bridge.on('close', code => { bridgeClosed = true; bridgeCode = code; resolveBridge(); if (!stopping) void stop(code === 0 ? 'bridge-exited' : 'bridge-failed'); });
    process.on('SIGTERM', onSigterm); process.on('SIGINT', onSigint); process.stdout.on('error', onStdoutError);
    process.stdin.once('end', onEof); bridge.stdout.pipe(process.stdout, { end: false }); process.stdin.pipe(bridge.stdin);
    lifetimeTimer = setTimeout(() => { void stop('timeout'); }, Math.max(1, deadline - Date.now()));
    receipt.status = 'ready'; writeReceipt();
    process.stderr.write(`${JSON.stringify({ event: 'aidesignhub-zcode-case-test-ready', dataDir, receiptPath })}\n`);
    // Do not hold up MCP initialize while the public website is being fetched.
    collectHandle = setImmediate(() => {
      if (stopping) return;
      try {
        const item = cases.collect({ projectId: PROJECT_ID, url: SOURCE_URL, connectionId: 'zcode' }, { allowDispatch: false });
        caseId = item.id; snapshotState();
        cases.idle().then(snapshotState).catch(() => { receipt.researchPreparing = false; receipt.researchStatus = 'failed'; receipt.acceptanceStatus = 'source-preparation-failed'; writeReceipt(); });
      } catch { receipt.researchPreparing = false; receipt.researchStatus = 'failed'; receipt.acceptanceStatus = 'source-preparation-failed'; writeReceipt(); }
    });
    if (process.stdin.readableEnded) void stop('stdin-eof');
    return { dataDir, receiptPath, closed, stop };
  } catch {
    process.stderr.write('AIDesignHub isolated case test could not start.\n');
    await stop('startup-failed'); return { dataDir, receiptPath, closed, stop };
  }
}
async function main() { const session = await startCaseTestServer({ timeoutMs: timeoutFromArgs(process.argv.slice(2)) }); await session.closed; }
if (require.main === module) main().catch(() => { process.stderr.write('AIDesignHub isolated case test failed.\n'); process.exitCode = 1; });
module.exports = { startCaseTestServer, timeoutFromArgs, DEFAULT_TIMEOUT_MS, SOURCE_URL, PROJECT_ID, MEMBER_ID, SCOPES, TOOLS };
