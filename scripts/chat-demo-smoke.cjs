'use strict';

// Standalone renderer verification: no Hub backend, preload, user data or model.
// Run with `node scripts/chat-demo-smoke.cjs`; artifacts go to an OS temp folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const local = path.join(__dirname, '..', '.runtime', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const executable = fs.existsSync(local) ? local : require('electron');
  const child = spawn(executable, [__filename], {
    cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const root = path.resolve(__dirname, '..');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-chat-demo-smoke-'));
  app.setPath('userData', path.join(output, 'electron-profile'));
  app.disableHardwareAcceleration();
  const blockedNetwork = [];
  const rendererErrors = [];
  let win;

  function installAudit() {
    window.__demoAudit = { bridge: [], network: [], media: [], storage: [], errors: [] };
    const deny = bucket => function forbidden(...args) {
      window.__demoAudit[bucket].push(String(args[0] || 'called'));
      throw new Error(`Demo must not use ${bucket}`);
    };
    window.fetch = deny('network');
    window.XMLHttpRequest = function () { return { open: deny('network'), send: deny('network') }; };
    window.WebSocket = deny('network');
    window.EventSource = deny('network');
    window.bycjWorkbench = new Proxy({}, { get: (_, key) => deny('bridge').bind(null, key) });
    window.MediaRecorder = deny('media');
    window.SpeechRecognition = deny('media');
    window.webkitSpeechRecognition = deny('media');
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = deny('media');
      navigator.mediaDevices.getDisplayMedia = deny('media');
    }
    if (navigator.clipboard) {
      navigator.clipboard.read = deny('media');
      navigator.clipboard.readText = deny('media');
    }
    for (const store of [localStorage, sessionStorage]) {
      const prototype = Object.getPrototypeOf(store);
      prototype.setItem = deny('storage');
      prototype.getItem = deny('storage');
      prototype.removeItem = deny('storage');
      prototype.clear = deny('storage');
    }
    indexedDB.open = deny('storage');
    window.addEventListener('error', event => window.__demoAudit.errors.push(String(event.message)));
    window.addEventListener('unhandledrejection', event => window.__demoAudit.errors.push(String(event.reason)));
  }

  app.whenReady().then(async () => {
    try {
      for (const file of ['chat-demo-ui.js', 'chat-demo.css', 'tests/fixtures/chat-demo-ui-smoke.cjs']) {
        if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing demo file: ${file}`);
      }
      const scriptUrl = pathToFileURL(path.join(root, 'chat-demo-ui.js')).href;
      const reviewUrl = pathToFileURL(path.join(root, 'context-review-demo.js')).href;
      const cssUrl = pathToFileURL(path.join(root, 'chat-demo.css')).href;
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${pathToFileURL(root + path.sep).href}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file: 'unsafe-inline'; style-src 'self' file: 'unsafe-inline'; img-src 'self' file: data: blob:; connect-src 'none'; font-src 'none'; media-src blob: data:"><link rel="stylesheet" href="${cssUrl}"><style>*{box-sizing:border-box}body{margin:0;background:#f4f5fa;font-family:Arial,'Microsoft YaHei',sans-serif;color:#273047}#hubChatDemo{height:100dvh;width:100%;min-width:0}</style></head><body><div id="hubChatDemo"></div><script>(${installAudit.toString()})();</script><script src="${scriptUrl}"></script></body></html>`;
      const htmlPath = path.join(output, 'demo.html');
      fs.writeFileSync(htmlPath, html.replace(`<script src="${scriptUrl}">`, `<script src="${reviewUrl}"></script><script src="${scriptUrl}">`));
      win = new BrowserWindow({
        show: false, width: 1180, height: 900,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false },
      });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        blockedNetwork.push(details.url); callback({ cancel: true });
      });
      win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { rendererErrors.push(`Permission requested: ${permission}`); callback(false); });
      win.webContents.setWindowOpenHandler(({ url }) => { rendererErrors.push(`External window requested: ${url}`); return { action: 'deny' }; });
      win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`Renderer gone: ${details.reason}`));
      await win.loadFile(htmlPath);
      const { runChatDemoSmoke } = require('../tests/fixtures/chat-demo-ui-smoke.cjs');
      const result = await runChatDemoSmoke(win, { output });
      const audit = await win.webContents.executeJavaScript('window.__demoAudit');
      for (const [key, events] of Object.entries(audit)) if (events.length) throw new Error(`${key}: ${JSON.stringify(events)}`);
      const { runHubChatDemoIntegration } = require('../tests/fixtures/chat-demo-integration-smoke.cjs');
      result.integration = await runHubChatDemoIntegration(win, { root, output, installAuditSource: installAudit.toString() });
      if (blockedNetwork.length || rendererErrors.length) throw new Error(JSON.stringify({ blockedNetwork, rendererErrors }));
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, ...result, audit, blockedNetwork, rendererErrors }, null, 2));
      console.log(JSON.stringify({ passed: true, ...result, output, audit }, null, 2));
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error.stack || error);
      if (win && !win.isDestroyed()) {
        try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
      }
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error.stack || error), blockedNetwork, rendererErrors }, null, 2));
      console.error(`Artifacts: ${output}`);
      app.exit(1);
    }
  });
}
