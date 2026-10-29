'use strict';
// Real application + preload + IPC + filesystem, with synthetic public-page
// transport and an isolated profile. No live project, credentials or models.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'BYCJ_WORKBENCH_SMOKE', 'AIDESIGNHUB_DATA_DIR', 'AIDESIGNHUB_DEMO_COMPANY', 'AIDESIGNHUB_LEGACY_TEAM_SYNC']) delete env[key];
  const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
  const child = require('node:child_process').spawn(fs.existsSync(bundled) ? bundled : require('electron'), [__filename], { env, cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const electron = require('electron');
  const { app, BrowserWindow, nativeImage } = electron;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-image-app-'));
  const importHtml = path.join(output, 'saved-article.html');
  fs.writeFileSync(importHtml, '<title>已保存的建筑文章</title><div id="js_content"><p>导入完整正文</p><img src="saved-article_files/cover.png"><img src="saved-article_files/large.png"></div><script>window.articleImportExecuted=true</script>');
  const dataDir = path.join(output, 'data');
  process.env.AIDESIGNHUB_DATA_DIR = dataDir;
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function keepTestHidden() {};
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); }
  } });
  Object.defineProperty(testElectron, 'dialog', { value: { ...electron.dialog,
    showErrorBox(title, message) { console.error(`${title}: ${message}`); },
    showOpenDialog: async options => ({ canceled: false, filePaths: [options?.properties?.includes('openFile') ? importHtml : output] }),
  } });
  const fixture = require('../tests/fixtures/smoke-case.cjs');
  fs.mkdirSync(path.join(output, 'saved-article_files'));
  fs.writeFileSync(path.join(output, 'saved-article_files', 'cover.png'), Buffer.from(fixture.imageDataUrl.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(output, 'saved-article_files', 'large.png'), nativeImage.createFromDataURL(fixture.imageDataUrl).resize({ width: 1800, height: 1080 }).toPNG());
  const sourceUrl = 'https://collection-fixture.example/gallery';
  let collection;
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function testDependencies(name, parent, isMain) {
    if (parent?.filename === path.resolve(__dirname, '../electron-main.cjs')) {
      if (name === 'electron') return testElectron;
      if (name === './backend/case-research.cjs') {
        const real = originalLoad.call(this, name, parent, isMain);
        return { ...real, CaseResearchService: class extends real.CaseResearchService {
          constructor(options) { super({ ...options, fetchPage: fixture.fetchPage, fetchImage: fixture.fetchImage }); }
        } };
      }
      if (name === './backend/image-collection.cjs') {
        const real = originalLoad.call(this, name, parent, isMain);
        return { ...real, ImageCollectionService: class extends real.ImageCollectionService {
          constructor(options) {
            super({ ...options,
              fetchPage: async url => {
                assert.equal(url, sourceUrl);
                return { title: '滨水美术馆图片采集样本', text: '固定样本完整文章正文：滨水美术馆的建筑与空间。', finalUrl: sourceUrl, images: [
                  { url: 'https://images.example/cover.png', alt: '<img src=x onerror="window.collectionXss=true">立面参考' },
                  { url: 'https://images.example/duplicate.png', alt: '相同图片的另一个来源' },
                  { url: 'https://images.example/large.png', alt: '高分辨率空间参考' },
                  { url: 'https://images.example/fail.png', alt: '网络失败样本' },
                ] };
              },
              fetchImage: async url => {
                if (url.endsWith('/fail.png')) throw new Error('固定样本：图片服务暂不可用');
                const image = nativeImage.createFromDataURL(fixture.imageDataUrl);
                const large = url.endsWith('/large.png');
                const bytes = large ? image.resize({ width: 1800, height: 1080 }).toPNG() : image.toPNG();
                return { sourceUrl: url, finalUrl: url, width: large ? 1800 : 400, height: large ? 1080 : 240, byteLength: bytes.length, contentType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
              },
            });
            collection = this;
          }
        } };
      }
    }
    return originalLoad.call(this, name, parent, isMain);
  };
  try { require('../electron-main.cjs'); } finally { Module._load = originalLoad; }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const watchdog = setTimeout(() => { console.error(`Image collection smoke timed out: ${output}`); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    let win;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:'));
        if (win && collection && await win.webContents.executeJavaScript('Boolean(window.aidesignImageCollection && window.bycjWorkbench.imageCollectionStart)').catch(() => false)) break;
        await delay(100);
      }
      assert.ok(win && collection, 'Application and image service initialized');
      const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
      const result = await run(async url => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const waitFor = async (check, label) => { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(50); } throw new Error(label); };
        const api = window.bycjWorkbench;
        const data = await api.bootstrap();
        document.querySelector('[data-view="cases"]').click();
        await window.aidesignImageCollection.open({ projectId: data.project.id, sourceUrl: url, title: '滨水美术馆' });
        return { projectId: data.project.id, title: document.title, modalVisible: true };
      }, sourceUrl);
      // The concrete UI assertions are maintained alongside the collection UI.
      // A missing hook fails this test instead of passing on backend state alone.
      Object.assign(result, await require('../tests/fixtures/image-collection-ui-smoke.cjs').run({ win, sourceUrl, output }));
      Object.assign(result, await run(async url => {
        const $ = id => document.getElementById(id);
        const wait = async (predicate, label) => { for(let i=0;i<250;i++){if(predicate())return;if(i%8===0&&!$('imageCollectionRefresh').disabled)$('imageCollectionRefresh').click();await new Promise(resolve=>setTimeout(resolve,50));}throw Error(label+': '+$('imageCollectionError').textContent); };
        const data = await window.bycjWorkbench.bootstrap();
        await window.aidesignImageCollection.open({projectId:data.project.id,sourceUrl:url,collectAll:true});
        await wait(()=>!$('imageCollectionExportArticle').hidden&&!$('imageCollectionStart').disabled,'Entire article archive did not finish');
        $('imageCollectionExportArticle').click();
        await wait(()=>$('imageCollectionDialog').innerText.includes('整篇导出已完成'),'Article export did not complete');
        $('imageCollectionImportHtml').click();
        await wait(()=>!$('imageCollectionStart').disabled&&$('imageCollectionDialog').innerText.includes('已保存的建筑文章'),'Saved article import did not finish');
        if(window.articleImportExecuted)throw Error('Imported HTML script executed');
        $('imageCollectionExportArticle').click();
        await wait(()=>$('imageCollectionDialog').innerText.includes('整篇导出已完成'),'Imported article export did not complete');
        return {entireArticleArchived:true,entireArticleExported:true,savedHtmlImported:true,importScriptsInert:true};
      },sourceUrl));
      const articleExports = fs.readdirSync(output,{recursive:true}).filter(name=>name.endsWith('article.txt'));
      assert.ok(articleExports.length>=2,'Both complete article exports contain a body file');
      assert.ok(articleExports.some(name=>fs.readFileSync(path.join(output,name),'utf8').includes('导入完整正文')),'Imported body reaches the exported file');
      const assets = collection.list({ projectId: result.projectId });
      assert.ok(assets.length >= 2, 'Selected originals were archived');
      for (const item of assets) {
        const internal = collection.getAsset(item.id);
        assert.ok(fs.statSync(internal.path).size > 0);
        assert.equal(Object.hasOwn(item, 'path'), false);
      }
      const { ImageCollectionService } = require('../backend/image-collection.cjs');
      const restored = new ImageCollectionService({ dataDir, findProject: id => id === result.projectId ? { id } : null, findCase: () => null });
      assert.equal(restored.list({ projectId: result.projectId }).length, assets.length, 'Archive survives service restart');
      restored.dispose();
      result.errors = await run(() => window.__BYCJ_WORKBENCH_ERRORS__ || []);
      assert.deepEqual(result.errors, []);
      fs.writeFileSync(path.join(output, 'workbench.png'), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, ...result, archived: assets.length }, null, 2));
      console.log(JSON.stringify({ ok: true, ...result, archived: assets.length, output }));
      clearTimeout(watchdog);
      app.quit();
    } catch (error) {
      const diagnostics = await win?.webContents.executeJavaScript('({text:document.body.innerText.slice(-7000),errors:window.__BYCJ_WORKBENCH_ERRORS__||[]})').catch(() => null);
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, diagnostics }, null, 2));
      console.error(JSON.stringify({ ok: false, message: error.message, output }));
      clearTimeout(watchdog);
      app.exit(1);
    }
  });
}
