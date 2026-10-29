'use strict';

// Actual hidden Electron windows, real renderer / preload / IPC / encrypted
// settings, but synthetic installation inventory and protocol/model planners.
// Both phases share one newly-created temp userData directory. No live account,
// project database, executable or model endpoint is read or contacted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-device-setup-smoke-'));
  const env = { ...process.env, AIDESIGNHUB_SETUP_SMOKE_ROOT: output };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'BYCJ_WORKBENCH_SMOKE', 'AIDESIGNHUB_DATA_DIR', 'AIDESIGNHUB_DEMO_COMPANY', 'AIDESIGNHUB_LEGACY_TEAM_SYNC']) delete env[name];
  const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
  const executable = fs.existsSync(bundled) ? bundled : require('electron');
  let normalBytes;
  try {
    for (const mode of ['normal', 'demo']) {
      const result = spawnSync(executable, [__filename, mode], { env, cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      assert.equal(result.error, undefined, `${mode} child launch failed`);
      assert.equal(result.status, 0, `${mode} child failed; artifacts: ${output}`);
      if (mode === 'normal') normalBytes = fs.readFileSync(path.join(output, 'profile/design-workbench-v1/store.json'));
      else assert.ok(normalBytes.equals(fs.readFileSync(path.join(output, 'profile/design-workbench-v1/store.json'))), 'Demo startup must not change the normal project database');
    }
    const normal = JSON.parse(fs.readFileSync(path.join(output, 'normal-result.json'), 'utf8'));
    const demo = JSON.parse(fs.readFileSync(path.join(output, 'demo-result.json'), 'utf8'));
    assert.equal(normal.model.model, demo.model.model);
    assert.equal(demo.model.scope, 'device');
    assert.equal(demo.projects, 3);
    assert.equal(normal.projects, 1);
    assert.ok(fs.existsSync(path.join(output, 'profile/device-settings-v1/model-private/model-config.enc')));
    for (const mode of ['design-workbench-v1', 'demo-company-v1']) assert.equal(fs.existsSync(path.join(output, 'profile', mode, 'model-private/model-config.enc')), false);
    const report = { ok: true, output, sharedEncryptedDeviceSettings: true, independentBusinessStores: true, normalStoreUnchangedByDemo: true, normal, demo };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error); console.error(`Artifacts: ${output}`); process.exitCode = 1; }
} else {
  const electron = require('electron');
  const { app, BrowserWindow, session } = electron;
  const output = process.env.AIDESIGNHUB_SETUP_SMOKE_ROOT;
  assert.ok(output && path.dirname(output) === path.resolve(os.tmpdir()) && /^aidesignhub-device-setup-smoke-/.test(path.basename(output)));
  const mode = process.argv[2];
  assert.ok(['normal', 'demo'].includes(mode));
  const profile = path.join(output, 'profile');
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  if (mode === 'demo') process.env.AIDESIGNHUB_DEMO_COMPANY = '1'; else delete process.env.AIDESIGNHUB_DEMO_COMPANY;
  for (const name of ['AIDESIGNHUB_DATA_DIR', 'BYCJ_WORKBENCH_SMOKE', 'AIDESIGNHUB_LEGACY_TEAM_SYNC']) delete process.env[name];
  const requests = [], probes = [], plans = [], rendererConsoleErrors = [];
  const blockNetwork = () => { requests.push('blocked-main-network'); throw new Error('Network is forbidden in device setup smoke'); };
  globalThis.fetch = blockNetwork;
  for (const moduleName of ['node:http', 'node:https']) { const client = require(moduleName); client.request = blockNetwork; client.get = blockNetwork; }
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => { requests.push('blocked-renderer-network'); callback({ cancel: true }); }));
  BrowserWindow.prototype.show = function keepHidden() {};
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); this.webContents.on('console-message', details => { if (details.level === 'error' || details.level === 3) rendererConsoleErrors.push(details.message); }); }
  } });
  const executable = path.join(output, 'synthetic-agent.exe');
  if (!fs.existsSync(executable)) fs.writeFileSync(executable, 'Synthetic fixture. Never execute.');
  const discovery = () => ({ checkedAt: Date.now(), warnings: ['合成安装清单，仅用于离线 UI 验证。'], candidates: ['deepseek', 'openclaw', 'hermes', 'chatgpt', 'zcode'].map(provider => {
    const runtime = ['deepseek', 'openclaw', 'hermes'].includes(provider), protocol = provider === 'openclaw' ? 'cli' : 'acp';
    return { id: `fixture-${provider}`, provider, label: `${provider} 合成安装`, installed: true, kind: runtime ? 'runtime' : 'desktop', version: 'smoke', source: executable, modelVerified: false, pairingSupported: runtime, pairable: runtime, protocol: runtime ? protocol : 'mcp', connectionState: runtime ? 'not-paired' : 'client-authorization-required', evidence: [], limitations: [],
      ...(runtime ? { config: { provider, label: `${provider} 合成执行器`, mode: protocol, command: executable, args: provider === 'openclaw' ? ['agent', '--agent', 'main', '--session-id', '{sessionId}', '--message-file', '{promptFile}', '--json'] : [], cwd: '', timeoutMs: 300000 } } : {}) };
  }) });
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function loadFixtures(name, parent, isMain) {
    if (name === 'electron' && parent?.filename === path.resolve(__dirname, '../electron-main.cjs')) return testElectron;
    if (name.endsWith('/agent-runtime-discovery.cjs')) return { discoverAgentRuntimes: discovery, safeCliProbe: () => null };
    if (name.endsWith('/agent-executors.cjs')) return {
      executeAgent: async () => { throw new Error('Agent tasks forbidden in setup smoke'); },
      probeAgentConnection: async connection => { probes.push({ provider: connection.provider, mode: connection.mode }); return { level: connection.mode === 'acp' ? 'protocol' : 'cli', code: 'SYNTHETIC_PROTOCOL_READY', modelCalled: false, message: '合成接口检查通过；没有执行真实程序或调用模型。' }; },
    };
    const actual = originalLoad.call(this, name, parent, isMain);
    if (name.endsWith('/model-service.cjs')) return { ...actual, ModelService: class OfflineModelService extends actual.ModelService {
      async planDeviceSetup(input) { assert.deepEqual(Object.keys(input), ['candidates']); for (const item of input.candidates) assert.deepEqual(Object.keys(item).sort(), ['id', 'installed', 'mode', 'pairable', 'provider', 'version']); plans.push(input.candidates.length); return { candidateIds: input.candidates.filter(x => x.pairable).map(x => x.id) }; }
    } };
    return actual;
  };
  try { require('../electron-main.cjs'); } finally { Module._load = originalLoad; }
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const watchdog = setTimeout(() => { console.error(`${mode} setup smoke timeout; ${output}`); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    let win, step = 'startup';
    try {
      for (let i = 0; i < 200; i++) { win = BrowserWindow.getAllWindows()[0]; if (win && await win.webContents.executeJavaScript(`!!window.aidesignSetupUI && !!window.aidesignAgentSetupUI && document.querySelector('#hubGlobalModelSettings')?.dataset.configured !== undefined`).catch(() => false)) break; await pause(); }
      assert.ok(win);
      const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);
      const wait = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await run(fn)) return; await pause(); } throw new Error(label); };
      const capture = async filename => { await pause(); fs.writeFileSync(path.join(output, `${mode}-${filename}.png`), (await win.webContents.capturePage()).toPNG()); };
      await run(() => window.aidesignHubChatUI?.close());
      const before = await run(async () => ({ model: await window.bycjWorkbench.projectModelStatus(), bootstrap: await window.bycjWorkbench.bootstrap() }));
      assert.equal(before.model.configured, mode === 'demo');
      assert.equal(before.model.scope, 'device');
      assert.equal(await run(() => { const button = document.querySelector('#hubGlobalModelSettings'), r = button.getBoundingClientRect(); return button.closest('aside') !== null && r.width > 0 && r.height > 0; }), true, 'Model settings must be visible independently from chat');
      if (mode === 'normal') {
        await wait(() => !!document.querySelector('#hubSetupWelcome'), 'First-use setup introduction missing');
        await capture('first-use');
      } else assert.equal(await run(() => !!document.querySelector('#hubSetupWelcome')), false, 'Demo should reuse configured device model');
      step = 'open global model settings';
      await run(() => document.querySelector('#hubGlobalModelSettings').click());
      await wait(() => !!document.querySelector('dialog[open] #hubModelForm'), 'Global button did not open model settings');
      await capture('model-dialog');
      if (mode === 'normal') {
        step = 'save synthetic model configuration without network';
        await run(() => { const form = document.querySelector('#hubModelForm'); form.elements.autoPair.checked = false; form.elements.autoPair.dispatchEvent(new Event('change')); form.elements.provider.value = 'deepseek'; form.elements.baseUrl.value = 'https://api.deepseek.com/v1'; form.elements.model.value = 'deepseek-flash'; form.elements.apiKey.value = 'synthetic-smoke-key-not-a-real-key'; form.requestSubmit(); });
        await wait(() => !document.querySelector('dialog[open] #hubModelForm') && document.querySelector('#hubGlobalModelSettings').dataset.configured === 'true', 'Saving model settings failed');
        assert.equal(probes.length, 0, 'Opting out of auto-pair must not launch a probe');
        assert.equal(plans.length, 0, 'Opting out must not call model planning');
        assert.equal(await run(() => !!document.querySelector('#hubSetupWelcome')), false);
      } else {
        assert.equal(await run(() => document.querySelector('#hubModelForm').elements.model.value), 'deepseek-flash');
        assert.equal(await run(() => document.querySelector('#hubModelForm').elements.apiKey.value), '', 'Saved key must never be returned to renderer');
        await run(() => document.querySelector('#hubModelForm').closest('dialog').close());
      }
      step = 'controlled automatic pairing UI';
      await run(() => { void window.aidesignAgentSetupUI.autoPair(); });
      await wait(() => document.querySelector('#agentSettingsDialog').open && document.querySelector('#agentAutoPairState').dataset.busy === 'false' && document.querySelector('#agentAutoPairState').textContent.includes('3 个执行器'), 'Automatic pairing result did not render');
      const snapshot = await run(() => window.bycjWorkbench.agentSnapshot());
      const connected = snapshot.connections.filter(c => ['deepseek', 'openclaw', 'hermes'].includes(c.provider) && c.validation?.ok);
      assert.equal(connected.length, 3);
      assert.ok(connected.every(c => c.validation.modelCalled === false && c.verifiedAt === null));
      assert.equal(await run(() => document.querySelectorAll('[data-agent-device]').length), 5);
      const guiState = await run(() => ['chatgpt', 'zcode'].map(id => document.querySelector(`[data-agent-device="${id}"]`).textContent));
      assert.ok(guiState.every(text => text.includes('需客户端授权')));
      assert.equal(plans.length, 1);assert.equal(probes.length, 3);
      await capture('automatic-pairing');
      const model = await run(() => window.bycjWorkbench.projectModelStatus());
      assert.equal(model.configured, true);assert.equal(model.hasApiKey, true);assert.equal(Object.hasOwn(model, 'apiKey'), false);
      assert.deepEqual(requests, [], 'No HTTP, model or external Agent request is allowed');
      const errors = await run(() => window.__BYCJ_WORKBENCH_ERRORS__ || []);
      assert.deepEqual(errors, []);assert.deepEqual(rendererConsoleErrors, []);assert.equal(win.isVisible(), false);
      const storePath = path.join(profile, mode === 'normal' ? 'design-workbench-v1' : 'demo-company-v1', 'store.json');
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      assert.equal(JSON.stringify(store).includes('synthetic-smoke-key-not-a-real-key'), false);
      const encrypted = fs.readFileSync(path.join(profile, 'device-settings-v1/model-private/model-config.enc'));
      assert.equal(encrypted.includes(Buffer.from('synthetic-smoke-key-not-a-real-key')), false);
      const result = { ok: true, mode, projects: store.projects.length, model, visibleGlobalModelSettings: true, automaticPairing: { controlledFixture: true, protocolProbes: probes.length, plannerCalls: plans.length, paired: 3, requiresClientAuthorization: 2, externalModelCalls: 0 }, networkRequests: requests.length, errors, rendererConsoleErrors };
      fs.writeFileSync(path.join(output, `${mode}-result.json`), JSON.stringify(result, null, 2));
      clearTimeout(watchdog); console.log(`${mode}: device setup smoke passed`); app.quit();
    } catch (error) {
      clearTimeout(watchdog);
      if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(output, `${mode}-failure.png`), (await win.webContents.capturePage()).toPNG()); fs.writeFileSync(path.join(output, `${mode}-failure-dom.txt`), await win.webContents.executeJavaScript('document.body.innerText')); } catch {} }
      fs.writeFileSync(path.join(output, `${mode}-failure.json`), JSON.stringify({ step, error: error.stack, requests, probes, plans, rendererConsoleErrors }, null, 2));
      console.error(error); console.error(`${mode} step: ${step}; artifacts: ${output}`); app.exit(1);
    }
  });
}
