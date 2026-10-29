'use strict';
// Real native Host and renderer with synthetic skills and a separate data root.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AdhWorkbenchService } = require('../backend/adh-workbench-service.cjs');
const { DshRuntimeManager } = require('../backend/dsh-runtime.cjs');
const root = path.resolve(__dirname, '..', '.test-skill-ui-smoke');
let manager, service, win;
const report = { ok: false, syntheticDataOnly: true, modelRequests: 0 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  await fs.mkdir(root, { recursive: true });
  const directory = path.join(root, 'agents', 'skills', 'team-share-fixture');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: team-share-fixture\ndescription: 团队共享验收专用合成技能\n---\n# 合成测试技能\n只供界面验收，不包含真实项目资料。\n<script>window.fixtureExecuted=true</script>\n');
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
  const backend = new LocalBackend({ dataDir: path.join(root, 'data') });
  service = new AdhWorkbenchService({ backend, hub: Object.assign(new (require('node:events').EventEmitter)(), { state: { runs: [], connections: [], jobs: [] } }), projectHub: {}, cases: {}, research: {}, images: {} });
  await service.start();
  manager = new DshRuntimeManager({ userDataDir: path.join(root, 'user-data'), cacheRoot: path.join(process.env.APPDATA, 'bycj-design-workbench-prototype', 'cache'),
    pluginsSourceDir: path.resolve(__dirname, '../backend/dsh-plugins'), getModelStatus: () => null, getWorkbenchConnection: () => service.connection, emit() {} });
  await manager.start();
  if (manager.getState().status !== 'ready') throw new Error('Native Host not ready: ' + manager.getState().status);
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL(manager.getAuthUrl());
  async function until(script, label) {
    for (let index = 0; index < 120; index++) { if (await win.webContents.executeJavaScript(script).catch(() => false)) return; await pause(250); }
    throw new Error('UI timeout: ' + label);
  }
  await until("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim()==='技能中心')", 'native skills navigation');
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='技能中心').click()");
  await until("document.body.innerText.includes('team-share-fixture') && document.body.innerText.includes('本机技能')", 'local skill catalog');
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('article')).find(card=>card.textContent.includes('team-share-fixture')).querySelector('.adh-sl-actions button').click()");
  await until("document.body.innerText.includes('更新分享')", 'share persisted');
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent.trim().startsWith('团队共享')).click()");
  await until("document.body.innerText.includes('team-share-fixture') && document.body.innerText.includes('取消分享')", 'team card');
  const stored = service.teamSkills.list();
  if (stored.length !== 1 || stored[0].skillId !== 'team-share-fixture') throw new Error('Unexpected shared snapshot');
  report.author = stored[0].author.name;
  const cardText = await win.webContents.executeJavaScript('document.body.innerText');
  if (!cardText.includes(report.author)) throw new Error('Share author missing');
  await fs.writeFile(path.join(root, 'team-tab.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('article')).find(card=>card.textContent.includes('team-share-fixture')).querySelector('.adh-sl-open').click()");
  await until("document.querySelector('dialog pre')?.textContent.includes('<script>')", 'read-only shared detail');
  if (await win.webContents.executeJavaScript('window.fixtureExecuted === true')) throw new Error('Instruction text executed');
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='关闭技能说明').click()");
  await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='取消分享').click()");
  await until("!document.body.innerText.includes('team-share-fixture')", 'unshare reflected');
  report.ok = true; report.checks = ['real registry list', 'share snapshot', 'author identity', 'team tab', 'text-only detail', 'unshare'];
}
app.whenReady().then(run).catch(async error => { report.error = error.message; report.ui = await win?.webContents.executeJavaScript('document.body.innerText.slice(-6000)').catch(()=>null); }).finally(async () => {
  try { win?.destroy(); await manager?.stop(); service?.dispose(); await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
  finally { app.exit(report.ok ? 0 : 1); }
});




