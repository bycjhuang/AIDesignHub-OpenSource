'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(path.join(root, '.runtime', 'electron.exe'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code ?? 1; }); child.on('error', error => { console.error(error.message); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, protocol } = require('electron');
  const { registerCaseArticleIpc, articleUrl } = require('../backend/case-article-ipc.cjs');
  const { renderDocument } = require('../backend/case-web-archive.cjs');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-offline-reader-'));
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  protocol.registerSchemesAsPrivileged([{ scheme: 'adh-case', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
    try {
      const file = path.join(output, 'fixture.png'), picture = require('../tests/fixtures/smoke-case.cjs').imageDataUrl;
      fs.writeFileSync(file, Buffer.from(picture.split(',')[1], 'base64'));
      const item = { id: 'case_offline_reader', projectId: 'p1', name: '离线图文测试', sourceUrl: 'https://architecture.example.org/project' };
      const assets = Array.from({ length: 32 }, (_, index) => ({ id: `image_${crypto.randomUUID()}`, sourceUrl: `https://architecture.example.org/project/${index}.png`, contentType: 'image/png', width: 1800, height: 1200 }));
      const page = { title: item.name, url: item.sourceUrl, text: '图文顺序测试' };
      Object.defineProperty(page,'rawHtml',{ value: `<article><h2>原文小标题</h2>${assets.map((asset,index)=>`<p>第${index+1}段正文</p><img src="${asset.sourceUrl}" alt="项目原图${index+1}">`).join('')}<script>window.UNSAFE=true</script></article>` });
      const document = renderDocument(page, assets.map(asset => ({ ...asset, assetId: asset.id })));
      // Eager fixture loading verifies every local resource without running
      // script inside the production reader's deliberately scriptless frame.
      document.html=document.html.replaceAll('loading="lazy"','loading="eager"');
      const served=new Set();
      const service = { previews: {}, find: id => id === item.id ? item : null, articleDocument: () => document };
      registerCaseArticleIpc({ ipcMain: { handle() {}, removeHandler() {} }, protocol, service, backend: { projectId: () => 'p1' }, appDir: root,
        images: { list: () => assets, getAsset: id => { const asset = assets.find(value => value.id === id); if (!asset) throw new Error('foreign image'); served.add(id); return { ...asset, path: file }; } } });
      const parent = path.join(output,'reader.html'), csp = fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0];
      fs.writeFileSync(parent, `<!doctype html><meta charset="utf-8">${csp}<style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe sandbox="" src="${articleUrl(item.id)}"></iframe>`);
      await win.loadFile(parent);
      let frame;
      for (let index=0; index<80; index++) {
        frame = win.webContents.mainFrame.frames.find(value => value.url.startsWith('adh-case:'));
        if (frame&&served.size===32) break;
        await new Promise(resolve => setTimeout(resolve,50));
      }
      assert(frame);assert.equal(served.size,32);assert(!document.html.includes('<script>'));assert(document.html.indexOf('第1段正文')<document.html.indexOf('第32段正文'));
      let scriptBlocked=false;try{await frame.executeJavaScript('window.UNSAFE=true');}catch{scriptBlocked=true;}assert(scriptBlocked);
      fs.writeFileSync(path.join(output,'reader.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok:true, nativeSandboxedReader:true, localImageResponses:served.size, articleOrder:true, scriptsBlocked:true, output })); win.destroy(); app.quit();
    } catch (error) { console.error(JSON.stringify({ ok:false, error:error?.message||String(error), output })); app.exit(1); }
  });
}
