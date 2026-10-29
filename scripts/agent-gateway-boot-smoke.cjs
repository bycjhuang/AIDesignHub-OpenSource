'use strict';

// Local tool entry restore: a previously enabled entry comes back at boot on the
// persisted port, the real MCP bridge can call it, and turning it off sticks.
// Isolated store, synthetic read-only grant, no personal data and no models.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'BYCJ_WORKBENCH_SMOKE', 'AIDESIGNHUB_LEGACY_TEAM_SYNC', 'AIDESIGNHUB_DEMO_COMPANY']) delete env[key];
  const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
  const child = require('node:child_process').spawn(fs.existsSync(bundled) ? bundled : require('electron'), [__filename], {
    env, cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-gateway-smoke-'));
  const dataDir = path.join(output, 'aidesignhub-smoke-gateway');
  process.env.AIDESIGNHUB_DATA_DIR = dataDir;
  for (const key of ['BYCJ_WORKBENCH_SMOKE', 'AIDESIGNHUB_LEGACY_TEAM_SYNC', 'AIDESIGNHUB_DEMO_COMPANY']) delete process.env[key];
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function keepTestHidden() {};
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, 'dialog', { value: { ...electron.dialog, showErrorBox(title, message) { console.error(`${title}: ${message}`); } } });
  Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); }
  }});
  const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));

  // Speak JSON-RPC to the real stdio bridge exactly the way a configured client does.
  const bridgeCall = (url, token, messages, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'hub-mcp.cjs')], {
      env: {
        SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP,
        ELECTRON_RUN_AS_NODE: '1', AIDESIGNHUB_URL: url, AIDESIGNHUB_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const results = new Map();
    const failures = [];
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Bridge timed out. stderr: ${failures.join(' | ')}`)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        results.set(message.id, message);
        if (results.size === messages.length) { clearTimeout(timer); child.kill(); resolve(results); }
      }
    });
    child.stderr.on('data', chunk => failures.push(String(chunk).trim()));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  const start = async () => {
    const port = await freePort();
    // Leave the store exactly as a session that had enabled the entry would have.
    const { LocalBackend } = require('../backend/local-backend.cjs');
    const seeded = new LocalBackend({ dataDir });
    seeded.mutate(store => { store.settings.agentGatewayEnabled = true; store.settings.agentPort = port; return true; });
    const Module = require('node:module'), originalLoad = Module._load;
    const mainPath = path.resolve(__dirname, '../electron-main.cjs');
    let hub;
    Module._load = function captureHub(name, parent, isMain) {
      if (parent?.filename === mainPath) {
        if (name === 'electron') return testElectron;
        if (name === './backend/agent-hub.cjs') {
          const real = originalLoad.call(this, name, parent, isMain);
          return { ...real, AgentHub: class extends real.AgentHub { constructor(options) { super(options); hub = this; } } };
        }
      }
      return originalLoad.call(this, name, parent, isMain);
    };
    try { require('../electron-main.cjs'); } finally { Module._load = originalLoad; }

    const watchdog = setTimeout(() => { console.error(`Gateway boot smoke timeout: ${output}`); app.exit(1); }, 90000);
    let win;
    try {
      for (let i = 0; i < 200; i++) {
        win = BrowserWindow.getAllWindows()[0];
        const ready = win && hub && await win.webContents.executeJavaScript('Boolean(window.bycjWorkbench && window.bycjWorkbench.agentSnapshot)').catch(() => false);
        if (ready) break;
        await pause();
      }
      assert.ok(win && hub, 'Actual application initialized');
      let snapshot;
      for (let i = 0; i < 100; i++) {
        snapshot = await win.webContents.executeJavaScript('window.bycjWorkbench.agentSnapshot()');
        if (snapshot.gateway?.running) break;
        await pause();
      }
      assert.equal(snapshot.gateway.running, true, 'A previously enabled entry is restored at boot');
      assert.equal(snapshot.gateway.port, port, 'The restored entry keeps the persisted port');
      assert.equal(snapshot.gateway.url, `http://127.0.0.1:${port}`);
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
      assert.equal(stored.settings.agentPort, port);
      assert.equal(stored.settings.agentGatewayEnabled, true);
      const rendered = await win.webContents.executeJavaScript(`({
        state: document.getElementById('agentGatewayState').textContent,
        url: document.getElementById('agentGatewayUrl').value,
        button: document.getElementById('agentGatewayToggle').textContent,
      })`);
      assert.equal(rendered.state, '本机入口已开启');
      assert.equal(rendered.url, `http://127.0.0.1:${port}`);
      assert.equal(rendered.button, '关闭本机入口');
      fs.writeFileSync(path.join(output, 'gateway-restored.png'), (await win.webContents.capturePage()).toPNG());
      const anonymous = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(anonymous.status, 401, 'The restored entry still requires a project grant');
      const projectId = hub.backend.projectId();
      const grant = hub.createGrant({ label: 'gateway boot smoke', projectId, memberId: hub.backend.store.settings.currentMemberId, scopes: ['project:read'] });
      const replies = await bridgeCall(`http://127.0.0.1:${port}`, grant.token, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-boot-smoke', version: '1' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_project_context', arguments: {} } },
      ]);
      assert.equal(replies.get(1).result.serverInfo.name, 'AIDesignHub');
      const tools = replies.get(2).result.tools;
      assert.ok(tools.some(tool => tool.name === 'hub_project_context'));
      const context = JSON.parse(replies.get(3).result.content[0].text);
      assert.equal(context.project.id, projectId);
      assert.ok(context.member.length > 0);
      const activity = await win.webContents.executeJavaScript('window.bycjWorkbench.agentSnapshot()');
      const usage = activity.grants.find(item => item.id === grant.id);
      assert.equal(usage.callCount, 1, 'The Hub records the inbound call on the grant');
      assert.equal(usage.lastTool, 'hub_project_context');
      const readGrantRows = () => win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#agentGrantList .agent-grant-row')).map(row => row.textContent).join(' | ')`);
      let grantRows = '';
      for (let i = 0; i < 50; i++) {
        grantRows = await readGrantRows();
        if (/已调用 1 次/.test(grantRows)) break;
        await pause();
      }
      assert.match(grantRows, /已调用 1 次/, 'The grant row shows the client call, not just the grant');
      const disabled = await win.webContents.executeJavaScript('window.bycjWorkbench.agentGatewayToggle(false)');
      assert.equal(disabled.running, false);
      const storedAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
      assert.equal(storedAfter.settings.agentGatewayEnabled, false, 'Turning the entry off is remembered');
      await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }));
      const errors = await win.webContents.executeJavaScript('window.__BYCJ_WORKBENCH_ERRORS__ || []');
      assert.deepEqual(errors, []);
      const report = { ok: true, output, port, restoredAtBoot: true, anonymousStatus: anonymous.status, bridgeTools: tools.length, grantScopes: grant.scopes, disabledPersisted: true, realAgentExecution: false, modelCalls: 0 };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
      clearTimeout(watchdog); console.log(JSON.stringify(report, null, 2)); app.quit();
    } catch (error) {
      clearTimeout(watchdog); console.error(error); console.error(`Artifacts: ${output}`);
      try { fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, output }, null, 2)); } catch {}
      app.exit(1);
    }
  };
  start().catch(error => { console.error(error); app.exit(1); });
}
