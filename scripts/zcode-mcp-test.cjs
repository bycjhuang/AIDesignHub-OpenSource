#!/usr/bin/env node
'use strict';

// Opt-in, isolated MCP connectivity test. No real workbench data or Agent models.
// stdout belongs exclusively to the existing MCP bridge; diagnostics go to stderr.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AgentHub } = require('../backend/agent-hub.cjs');
const { AgentGateway } = require('../backend/agent-gateway.cjs');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROJECT_ID = 'project_zcode_mcp_synthetic';
const MEMBER_ID = 'member_zcode_mcp_synthetic';
const PROJECT_NAME = 'AIDesignHub MCP 虚构测试项目';

function timeoutFromArgs(args) {
  if (!args.length) return DEFAULT_TIMEOUT_MS;
  if (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1])) throw new Error('Invalid test arguments');
  const timeoutMs = Number(args[1]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error('Invalid test timeout');
  return timeoutMs;
}

function bridgeEnvironment(url, token) {
  const env = {};
  // Do not forward unrelated model credentials, NODE_OPTIONS, or existing Hub auth.
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'SYSTEMDRIVE', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.AIDESIGNHUB_URL = url;
  env.AIDESIGNHUB_TOKEN = token;
  if (/^electron(?:\.exe)?$/i.test(path.basename(process.execPath))) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function startTestServer({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error('Invalid test timeout');
  // No data directory override exists: every launch MUST use a brand-new temp dir.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-zcode-'));
  const receiptPath = path.join(dataDir, 'test-receipt.json');
  const receipt = {
    kind: 'isolated-mcp-connectivity-test', version: 1, createdAt: new Date().toISOString(),
    pid: process.pid, projectId: PROJECT_ID, syntheticDataOnly: true,
    scopes: ['project:read'], allowedTools: ['hub_project_context'],
    clientIdentityVerified: false, protocolInitialized: false, initializationCount: 0,
    toolListCount: 0, toolCalled: false, contextCallCount: 0, deniedToolCallCount: 0,
    grantRevoked: false, gatewayStopped: false, bridgeExited: false, status: 'starting',
  };
  const writeReceipt = () => {
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, receiptPath);
  };
  writeReceipt();
  let hub, gateway, grantId, bridge, bridgeClosed = false, bridgeCode, stopping;
  let lifetimeTimer, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let resolveBridge;
  const bridgeDone = new Promise(resolve => { resolveBridge = resolve; });
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
      clearTimeout(lifetimeTimer);
      process.stdin.unpipe(bridge?.stdin); process.stdin.pause();
      if (bridge?.stdin.writable) bridge.stdin.end();
      // EOF is the normal MCP client close path. Let already-queued requests drain.
      if (reason === 'stdin-eof') await waitBridge(1200);
      try {
        if (hub && grantId) { hub.revokeGrant(grantId); receipt.grantRevoked = true; }
      } catch { receipt.cleanupFailed = true; }
      try { await gateway?.stop(); receipt.gatewayStopped = true; }
      catch { receipt.cleanupFailed = true; }
      if (bridge && !bridgeClosed) {
        try { bridge.kill('SIGTERM'); } catch { /* Only this owned child. */ }
        await waitBridge(1000);
        if (!bridgeClosed) {
          try { bridge.kill('SIGKILL'); } catch { /* OS shutdown may already have won. */ }
          await waitBridge(1000);
        }
      }
      try { hub?.dispose(); } catch { receipt.cleanupFailed = true; }
      receipt.bridgeExited = !bridge || bridgeClosed;
      if (bridgeCode !== undefined) receipt.bridgeExitCode = bridgeCode;
      receipt.status = receipt.cleanupFailed || !receipt.bridgeExited ? 'cleanup-failed' : 'stopped';
      receipt.stopReason = reason; receipt.stoppedAt = new Date().toISOString();
      try { writeReceipt(); } catch { receipt.cleanupFailed = true; }
      process.stdin.removeListener('end', onEof);
      process.removeListener('SIGTERM', onSigterm); process.removeListener('SIGINT', onSigint);
      process.stdout.removeListener('error', onStdoutError);
      if (receipt.cleanupFailed || reason === 'startup-failed' || reason === 'bridge-failed') process.exitCode = 1;
      resolveClosed({ dataDir, receiptPath, status: receipt.status });
    })();
    return stopping;
  }

  try {
    const backend = new LocalBackend({ dataDir });
    backend.mutate(store => {
      for (const key of Object.keys(store)) if (Array.isArray(store[key])) store[key] = [];
      store.settings = { currentProjectId: PROJECT_ID, currentMemberId: MEMBER_ID, currentRole: 'designer' };
      store.projects = [{ id: PROJECT_ID, name: PROJECT_NAME, city: '虚构测试城市', type: '仅用于 MCP 连通测试', stage: 'test' }];
      store.members = [{ id: MEMBER_ID, projectId: PROJECT_ID, name: '虚构只读测试成员', role: 'designer', active: true }];
      store.agentHub = { version: 1, connections: [], jobs: [], runs: [], events: [] };
      return true;
    });
    hub = new AgentHub({ backend }); // No execute adapter: this process cannot dispatch Agents.
    const grant = hub.createGrant({ label: '临时 MCP 连通测试', projectId: PROJECT_ID, memberId: MEMBER_ID,
      scopes: ['project:read'], temporary: true, expiresInMs: timeoutMs });
    grantId = grant.id;
    gateway = new AgentGateway({ hub });
    const originalRpc = gateway._rpc.bind(gateway);
    gateway._rpc = async (message, principal) => {
      try {
        const result = await originalRpc(message, principal);
        if (message?.method === 'initialize' && result?.protocolVersion) {
          receipt.protocolInitialized = true; receipt.initializationCount++;
          receipt.protocolVersion = result.protocolVersion;
        } else if (message?.method === 'tools/list' && Array.isArray(result?.tools)) receipt.toolListCount++;
        else if (message?.method === 'tools/call' && message.params?.name === 'hub_project_context' && result?.isError === false) {
          receipt.toolCalled = true; receipt.contextCallCount++;
        }
        writeReceipt();
        return result;
      } catch (error) {
        if (message?.method === 'tools/call') { receipt.deniedToolCallCount++; writeReceipt(); }
        throw error;
      }
    };
    const { url, port } = await gateway.start();
    receipt.loopbackPort = port;
    bridge = spawn(process.execPath, [path.join(__dirname, 'hub-mcp.cjs')], {
      cwd: dataDir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: bridgeEnvironment(url, grant.token),
    });
    // Raw token stays only in runtime memory / the owned bridge environment.
    delete grant.token;
    receipt.bridgePid = bridge.pid;
    bridge.stdin.on('error', () => { /* The bridge close/error event owns cleanup. */ });
    bridge.stderr.on('data', () => { receipt.bridgeDiagnosticSeen = true; });
    bridge.on('error', () => { void stop('bridge-failed'); });
    bridge.on('close', code => {
      bridgeClosed = true; bridgeCode = code; resolveBridge();
      if (!stopping) void stop(code === 0 ? 'bridge-exited' : 'bridge-failed');
    });
    process.on('SIGTERM', onSigterm); process.on('SIGINT', onSigint);
    process.stdout.on('error', onStdoutError);
    process.stdin.once('end', onEof);
    bridge.stdout.pipe(process.stdout, { end: false });
    process.stdin.pipe(bridge.stdin);
    lifetimeTimer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
    receipt.status = 'ready'; writeReceipt();
    process.stderr.write(`${JSON.stringify({ event: 'aidesignhub-zcode-test-ready', dataDir, receiptPath })}\n`);
    if (process.stdin.readableEnded) void stop('stdin-eof');
    return { dataDir, receiptPath, closed, stop };
  } catch {
    process.stderr.write('AIDesignHub isolated MCP test could not start.\n');
    await stop('startup-failed');
    return { dataDir, receiptPath, closed, stop };
  }
}

async function main() {
  const session = await startTestServer({ timeoutMs: timeoutFromArgs(process.argv.slice(2)) });
  await session.closed;
}
if (require.main === module) main().catch(() => { process.stderr.write('AIDesignHub isolated MCP test failed.\n'); process.exitCode = 1; });
module.exports = { startTestServer, timeoutFromArgs, DEFAULT_TIMEOUT_MS, PROJECT_ID, PROJECT_NAME, MEMBER_ID };
