'use strict';

// Opt-in, no-model handshake probe. Never run as part of the ordinary test suite.
// Usage: node probe-dsh-acp.cjs <absolute node.exe> <absolute dsh/lib/bin.js>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const [runtime, entry] = process.argv.slice(2);
if (!runtime || !entry || !path.isAbsolute(runtime) || !path.isAbsolute(entry)) throw new Error('Absolute runtime and entry paths are required.');
const resolveFromDsh = createRequire(entry);
const dependencies = ['@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-acp', '@agentclientprotocol/sdk'];
for (const name of dependencies) resolveFromDsh.resolve(name);
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-dsh-acp-'));
const env = { DSH_HOME: probeDir, npm_config_offline: 'true', CI: 'true' };
for (const name of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
// No API keys/tokens/proxy credentials are copied from the invoking environment.
const child = spawn(runtime, [entry, '--profile', 'acp'], { cwd: probeDir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', stderr = '', result, failure, killTimer;
function kill() {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
  } else child.kill('SIGKILL');
}
const timer = setTimeout(() => { failure = 'initialize timed out after 35 seconds'; kill(); }, 35000);
child.stdin.on('error', () => {});
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 4000); });
child.stdout.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) { failure = 'stdout limit exceeded'; kill(); return; }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { failure = 'stdout is not protocol-pure'; kill(); return; }
    if (message.id === 1) {
      if (message.error) failure = `initialize error: ${message.error.code}`;
      else result = message.result;
      clearTimeout(timer); child.stdin.end(); killTimer = setTimeout(kill, 2000);
    }
  }
});
child.on('error', cause => { failure = `spawn failed: ${cause.code}`; });
child.on('close', (code, signal) => {
  clearTimeout(timer); clearTimeout(killTimer);
  const report = { probe: 'initialize-only', modelCalls: 0, sessionCreated: false, userConfigTouched: false, temporaryDshHome: probeDir, dependenciesPresent: dependencies, exitCode: code, signal, initialized: !!result, result, failure, stderr };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = result?.protocolVersion === 1 ? 0 : 1;
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'aidesignhub-readonly-probe', version: '0.1.0' } } }) + '\n');
