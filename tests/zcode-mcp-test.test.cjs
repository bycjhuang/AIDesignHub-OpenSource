'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { timeoutFromArgs, DEFAULT_TIMEOUT_MS, PROJECT_ID, PROJECT_NAME, MEMBER_ID } = require('../scripts/zcode-mcp-test.cjs');
const entry = path.join(__dirname, '..', 'scripts', 'zcode-mcp-test.cjs');

function readyFrom(stream) {
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated MCP startup timed out')), 10000);
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.event === 'aidesignhub-zcode-test-ready') { clearTimeout(timeout); resolve(message); }
      }
    });
  });
}
function inspectReceipt(ready) { return JSON.parse(fs.readFileSync(ready.receiptPath, 'utf8')); }
function cleanupDirectory(t, ready) {
  assert.equal(path.dirname(ready.dataDir), path.resolve(os.tmpdir()));
  assert.match(path.basename(ready.dataDir), /^aidesignhub-zcode-/);
  t.after(() => fs.rmSync(ready.dataDir, { recursive: true, force: true }));
}
function finished(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Test entry did not exit')); }, 10000);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
function assertStopped(ready) {
  const receipt = inspectReceipt(ready);
  assert.equal(receipt.status, 'stopped'); assert.equal(receipt.grantRevoked, true);
  assert.equal(receipt.gatewayStopped, true); assert.equal(receipt.bridgeExited, true);
  const access = JSON.parse(fs.readFileSync(path.join(ready.dataDir, 'agent-access.json'), 'utf8'));
  assert.equal(access.grants.length, 1); assert.deepEqual(access.grants[0].scopes, ['project:read']);
  assert.match(access.grants[0].tokenHash, /^[a-f0-9]{64}$/); assert.ok(access.grants[0].revokedAt);
  assert.equal('token' in access.grants[0], false);
  assert.throws(() => process.kill(receipt.bridgePid, 0), error => error.code === 'ESRCH');
  return receipt;
}

test('ZCode test entry official SDK exposes only synthetic project context and refuses escalation', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe',
    env: { AIDESIGNHUB_URL: 'http://127.0.0.1:1', AIDESIGNHUB_TOKEN: 'caller-secret-must-not-be-used' } });
  const readyPromise = readyFrom(transport.stderr);
  let diagnostics = ''; transport.stderr.on('data', chunk => { diagnostics += chunk; });
  const client = new Client({ name: 'official-sdk-test-client-not-zcode', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const ready = await readyPromise; cleanupDirectory(t, ready);
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name), ['hub_project_context']);
  const result = await client.callTool({ name: 'hub_project_context', arguments: {} });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.project.id, PROJECT_ID);
  assert.equal(result.structuredContent.project.name, PROJECT_NAME);
  assert.deepEqual(result.structuredContent.member.map(member => member.id), [MEMBER_ID]);
  for (const name of ['hub_task_list', 'hub_task_create', 'hub_knowledge_search', 'hub_artifact_submit']) {
    await assert.rejects(client.callTool({ name, arguments: {} }), /unauthorized|unknown/i);
  }
  await assert.rejects(client.callTool({ name: 'hub_project_context', arguments: { projectId: 'project_jiangwan' } }), /not allowed/i);
  const store = JSON.parse(fs.readFileSync(path.join(ready.dataDir, 'store.json'), 'utf8'));
  for (const [key, value] of Object.entries(store)) if (Array.isArray(value)) assert.equal(value.length, ['projects', 'members'].includes(key) ? 1 : 0, key);
  assert.deepEqual(store.agentHub, { version: 1, connections: [], jobs: [], runs: [], events: [] });
  const before = inspectReceipt(ready);
  assert.equal(before.protocolInitialized, true); assert.equal(before.contextCallCount, 1);
  assert.equal(before.deniedToolCallCount, 5); assert.equal(before.clientIdentityVerified, false);
  assert.equal(JSON.stringify(before).includes('official-sdk-test-client'), false);
  await client.close();
  const receipt = assertStopped(ready); assert.equal(receipt.stopReason, 'stdin-eof');
  assert.equal(JSON.stringify({ receipt, store, diagnostics, result }).includes('caller-secret-must-not-be-used'), false);
  await assert.rejects(fetch(`http://127.0.0.1:${receipt.loopbackPort}/mcp`, { signal: AbortSignal.timeout(1000) }));
});

test('ZCode test entry raw EOF drains MCP output and exits with its bridge revoked', async t => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const done = finished(child); const ready = await readyFrom(child.stderr); cleanupDirectory(t, ready);
  let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-eof-test', version: '1' } } }) + '\n');
  assert.equal((await done).code, 0);
  const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 1); assert.equal(messages[0].id, 1); assert.equal(messages[0].result.serverInfo.name, 'AIDesignHub');
  const receipt = assertStopped(ready); assert.equal(receipt.protocolInitialized, true); assert.equal(receipt.toolCalled, false);
});

test('ZCode test entry timeout closes idle input and creates a unique directory each launch', async t => {
  const directories = [];
  for (let index = 0; index < 2; index++) {
    const child = spawn(process.execPath, [entry, '--timeout-ms', '250'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const done = finished(child); const ready = await readyFrom(child.stderr); cleanupDirectory(t, ready); directories.push(ready.dataDir);
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    assert.equal((await done).code, 0); assert.equal(stdout, '');
    const receipt = assertStopped(ready); assert.equal(receipt.stopReason, 'timeout'); assert.equal(receipt.protocolInitialized, false);
  }
  assert.equal(new Set(directories).size, 2);
});

test('ZCode test entry SIGTERM handler revokes and closes without fabricating initialization', async t => {
  // Windows process.kill(SIGTERM) is an uncatchable OS termination; exercise the
  // registered Node handler explicitly, without claiming OS force-kill is graceful.
  const code = `require(${JSON.stringify(entry)}).startTestServer().then(async session => { process.emit('SIGTERM'); await session.closed; });`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const done = finished(child); const ready = await readyFrom(child.stderr); cleanupDirectory(t, ready);
  assert.equal((await done).code, 0); const receipt = assertStopped(ready);
  assert.equal(receipt.stopReason, 'sigterm'); assert.equal(receipt.protocolInitialized, false); assert.equal(receipt.toolCalled, false);
});

test('ZCode test entry does not accept a real data directory or extend its 30 minute lifetime', () => {
  assert.equal(timeoutFromArgs([]), DEFAULT_TIMEOUT_MS); assert.equal(timeoutFromArgs(['--timeout-ms', '100']), 100);
  for (const args of [['--data-dir', 'C:\\real'], ['--timeout-ms', '1800001'], ['--timeout-ms', '0'], ['--timeout-ms', 'NaN']]) assert.throws(() => timeoutFromArgs(args));
});
