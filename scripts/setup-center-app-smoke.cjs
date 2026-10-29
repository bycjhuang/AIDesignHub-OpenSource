'use strict';

// Actual renderer setup flow with an isolated store and synthetic Agent probes.
// It never uses personal model settings, external Agent processes or project files.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
  const { app, BrowserWindow, session } = electron;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-setup-smoke-'));
  process.env.AIDESIGNHUB_DATA_DIR = path.join(output, 'aidesignhub-smoke-setup');
  for (const key of ['BYCJ_WORKBENCH_SMOKE', 'AIDESIGNHUB_LEGACY_TEAM_SYNC', 'AIDESIGNHUB_DEMO_COMPANY']) delete process.env[key];
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function keepTestHidden() {};
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, 'dialog', { value: { ...electron.dialog, showErrorBox(title, message) { console.error(`${title}: ${message}`); } } });
  Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); }
  }});
  const requests = [];
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  }));
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
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const watchdog = setTimeout(() => { console.error(`Setup smoke timeout: ${output}`); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    let win;
    try {
      for (let i = 0; i < 150; i++) {
        win = BrowserWindow.getAllWindows()[0];
        if (win && hub && await win.webContents.executeJavaScript(`Boolean(window.aidesignSetupUI && document.getElementById('hubSetupWelcome') && document.querySelector('#view-agents[data-agent-loaded="true"]'))`).catch(() => false)) break;
        await pause();
      }
      assert.ok(win && hub, 'Actual application initialized');
      const entry = await win.webContents.executeJavaScript(`(async () => {
        const $ = id => document.getElementById(id);
        const wait = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Setup UI timed out'); };
        const entry = $('hubGlobalModelSettings');
        const nonModalOnboarding = $('hubSetupWelcome')?.tagName === 'ASIDE' && !document.querySelector('dialog[open]');
        const globalEntryVisible = !!entry && getComputedStyle(entry).display !== 'none' && entry.textContent.includes('模型设置');
        const advancedCollapsed = !$('agentAdvancedConnection').open;
        entry.click();await wait(()=>$('hubModelForm'));
        const modelDialog = $('hubModelForm').closest('dialog');
        const modelDialogOpened = modelDialog.open;
        modelDialog.close();await window.aidesignSetupUI.refresh();
        return { nonModalOnboarding, globalEntryVisible, advancedCollapsed, modelDialogOpened, noSecretExposed: !entry.textContent.includes('sk-') };
      })()`);
      assert.ok(Object.values(entry).every(Boolean), JSON.stringify(entry));
      fs.writeFileSync(path.join(output, 'global-model-entry.png'), (await win.webContents.capturePage()).toPNG());
      process.env.BYCJ_WORKBENCH_SMOKE = '1';
      let dispatch;
      try { dispatch = await require('../tests/fixtures/dispatch-ui-smoke.cjs').runDispatchSmoke(win, hub); }
      finally { delete process.env.BYCJ_WORKBENCH_SMOKE; }
      await win.webContents.executeJavaScript(`document.getElementById('agentOpenSettings').click()`);
      await pause();
      fs.writeFileSync(path.join(output, 'executor-cards.png'), (await win.webContents.capturePage()).toPNG());
      const errors = await win.webContents.executeJavaScript('window.__BYCJ_WORKBENCH_ERRORS__ || []');
      assert.deepEqual(errors, []); assert.deepEqual(requests, []);
      const report = { ok: true, output, entry, dispatch, rendererErrors: errors, networkRequests: 0, realAgentExecution: false };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
      clearTimeout(watchdog); console.log(JSON.stringify(report, null, 2)); app.quit();
    } catch (error) {
      const diagnostics = await win?.webContents.executeJavaScript('({errors:window.__BYCJ_WORKBENCH_ERRORS__,text:document.body.innerText.slice(-5000)})').catch(() => null);
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, diagnostics }, null, 2));
      if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      clearTimeout(watchdog); console.error(error); console.error(`Artifacts: ${output}`); app.exit(1);
    }
  });
}
