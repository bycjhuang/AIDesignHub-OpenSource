'use strict';
// Full application workflow with an isolated profile, synthetic Agent output,
// and injected public-page transport. No real model or live project is used.
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
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-research-app-'));
  const dataDir = path.join(output, 'data'), pptPath = path.join(output, 'case-research.pptx');
  process.env.AIDESIGNHUB_DATA_DIR = dataDir;
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function keepTestHidden() {};
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); }
  } });
  Object.defineProperty(testElectron, 'dialog', { value: { ...electron.dialog,
    showErrorBox(title, message) { console.error(`${title}: ${message}`); },
    showSaveDialog: async () => ({ canceled: false, filePath: pptPath }),
  } });
  const fixture = require('../tests/fixtures/smoke-case.cjs');
  const sourceA = 'https://architecture.example.org/river-museum';
  const sourceB = 'https://landscape.example.org/river-museum';
  const sourceC = 'https://design.example.org/community-center';
  const pageCalls = [], imageCalls = [], executionCalls = [];
  let backend, hub, researchService, collection;
  const descriptions = new Map([
    [sourceA, { name: '隔离样本·江湾美术馆', body: '项目名称：隔离样本·江湾美术馆\n项目类型：美术馆\n建筑面积：12000平方米\n项目地址：上海\n设计单位：测试设计院\n院落连接滨水步道，展厅与夜间公共通道分开管理。', image: 'museum-large' }],
    [sourceB, { name: '隔离样本·江湾美术馆景观', body: '项目名称：隔离样本·江湾美术馆\n景观步道沿水岸布置，公共庭院连接入口和室外活动空间。此为程序验收资料。', image: 'museum-large-duplicate' }],
    [sourceC, { name: '隔离样本·城北社区中心', body: '项目名称：隔离样本·城北社区中心\n项目类型：社区中心\n建筑面积：6000平方米\n项目地址：杭州\n设计单位：测试设计工作室\n社区活动室围绕公共内院组织。', image: 'community-large' }],
  ]);
  const fakeSources = urls => urls.map(url => ({ url, title: descriptions.get(url).name, evidence: descriptions.get(url).body, quote: descriptions.get(url).body, status: 'read', read: true }));
  const fakeResearch = {
    title: '隔离验收：滨水公共空间案例调研', summary: '固定样例对比美术馆与社区中心的庭院、公共步道和开放边界。此为软件验收，不是真实调研。',
    sources: fakeSources([sourceA, sourceB, sourceC]),
    cases: [
      { name: '隔离样本·江湾美术馆', primarySourceUrl: sourceA, summary: descriptions.get(sourceA).body, sources: fakeSources([sourceA, sourceB]), sourceUrls: [sourceA, sourceB], evidence: [{ field: 'name', value: '隔离样本·江湾美术馆', sourceUrl: sourceA, quote: '项目名称：隔离样本·江湾美术馆' }], references: [{ point: '院落组织公共空间', title: '院落组织公共空间', evidence: '院落连接滨水步道。', relevance: '对应当前项目的公共空间开放需求。', application: '复核夜间开放边界。', limitation: '需结合安全与运营条件。', sourceUrls: [sourceA, sourceB] }], imageUrls: ['https://images.example.org/museum-large.png'] },
      { name: '隔离样本·城北社区中心', primarySourceUrl: sourceC, summary: descriptions.get(sourceC).body, sources: fakeSources([sourceC]), sourceUrls: [sourceC], evidence: [{ field: 'name', value: '隔离样本·城北社区中心', sourceUrl: sourceC, quote: '项目名称：隔离样本·城北社区中心' }], references: [{ point: '活动空间围绕内院', application: '对照社区活动与室外空间的联系。', limitation: '先核对使用人群与场地尺度。', sourceUrls: [sourceC] }], imageUrls: ['https://images.example.org/community-large.png'] },
    ],
    references: [{ title: '公共空间的分时开放', point: '公共空间的分时开放', observation: '两个案例均用公共院落串联活动空间。', relevance: '对应当前项目的公共流线问题。', application: '复核门禁、运营时段与公共步道边界。', limitation: '需要进一步核对当地规范与运营约束。', sourceUrls: [sourceA, sourceC] }],
    limitations: ['程序验收样例，所有内容仅用于测试。'],
  };
  async function fetchPage(url) {
    pageCalls.push(url); const found = descriptions.get(url);
    assert(found, `Unexpected external page request: ${url}`);
    const images = [
      { url: `https://images.example.org/${found.image}.png`, alt: found.name + '公共空间', contentScope: 'article', context: found.body },
      { url: 'https://images.example.org/thumbnail.png', alt: '正文低分辨率图', contentScope: 'article' },
      { url: 'https://images.example.org/logo.png', alt: '站点Logo', contentScope: 'excluded' },
      { url: 'https://images.example.org/recommended.png', alt: '其他项目推荐', contentScope: 'excluded' },
    ];
    if (url === sourceB) images.push({ url: 'https://images.example.org/fail.png', alt: '正文下载失败样本', contentScope: 'article' });
    return { url, finalUrl: url, title: found.name, text: found.body, description: found.body, images, imagesComplete: true, imagesTruncated: false, retrievedAt: new Date().toISOString() };
  }
  async function fetchImage(url) {
    imageCalls.push(url);
    if (url.endsWith('/fail.png')) throw new Error('隔离样例：图片下载失败。');
    if (/\/(?:logo|recommended)\.png$/.test(url)) throw new Error('Unrelated image should have been filtered');
    const small = url.endsWith('/thumbnail.png'), community = url.endsWith('/community-large.png');
    const width = small ? 480 : community ? 1900 : 1800, height = small ? 288 : community ? 1140 : 1080;
    const bytes = nativeImage.createFromDataURL(fixture.imageDataUrl).resize({ width, height }).toPNG();
    return { sourceUrl: url, finalUrl: url, contentType: 'image/png', width, height, byteLength: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  }
  async function executeAgent(connection, input) {
    executionCalls.push({ connectionId: connection.id, prompt: input.prompt || input.instruction || '', inputKeys: Object.keys(input) });
    input.onEvent?.({ message: '隔离 Agent 正在比较固定来源并返回结构化成果。' });
    await new Promise(resolve => setTimeout(resolve, 80));
    return { ok: true, text: JSON.stringify(fakeResearch), outcome: 'completed' };
  }
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function testDependencies(name, parent, isMain) {
    if (parent?.filename === path.resolve(__dirname, '../electron-main.cjs')) {
      if (name === 'electron') return testElectron;
      if (name === './backend/agent-executors.cjs') return { ...originalLoad.call(this, name, parent, isMain), executeAgent };
      if (name === './backend/agent-hub.cjs') {
        const real = originalLoad.call(this, name, parent, isMain);
        return { ...real, AgentHub: class extends real.AgentHub {
          constructor(options) { super(options); hub = this; backend = options.backend; this.saveConnection({ id: 'smoke-research', provider: 'deepseek', label: '隔离调研执行器（合成样例）', mode: 'acp', command: process.execPath, args: [], timeoutMs: 30000 }); }
        } };
      }
      if (name === './backend/case-research.cjs') {
        const real = originalLoad.call(this, name, parent, isMain);
        return { ...real, CaseResearchService: class extends real.CaseResearchService { constructor(options) { super({ ...options, fetchPage, fetchImage }); } } };
      }
      if (name === './backend/image-collection.cjs') {
        const real = originalLoad.call(this, name, parent, isMain);
        return { ...real, ImageCollectionService: class extends real.ImageCollectionService { constructor(options) { super({ ...options, fetchPage, fetchImage }); collection = this; } } };
      }
      if (name === './backend/project-research.cjs') {
        const real = originalLoad.call(this, name, parent, isMain);
        return { ...real, ProjectResearchService: class extends real.ProjectResearchService { constructor(options) { super({ ...options, fetchPage }); researchService = this; } } };
      }
    }
    return originalLoad.call(this, name, parent, isMain);
  };
  try { require('../electron-main.cjs'); } finally { Module._load = originalLoad; }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const watchdog = setTimeout(() => { console.error(`Project research smoke timed out: ${output}`); app.exit(1); }, 120000);
  app.whenReady().then(async () => {
    let win;
    try {
      for (let index = 0; index < 300; index++) {
        win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:'));
        if (win && collection && researchService && await win.webContents.executeJavaScript('Boolean(window.bycjWorkbench?.projectResearchStart && document.getElementById("projectResearchForm"))').catch(() => false)) break;
        await delay(100);
      }
      assert(win && hub && collection && researchService, 'Real application and research services initialized');
      win.setSize(1440, 1060, false);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const $ = id => document.getElementById(id), api = window.bycjWorkbench;
        const wait = async (check, label) => { for (let i = 0; i < 600; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(label + ': ' + $('projectResearchNotice').textContent); };
        const bootstrap = await api.bootstrap(); document.querySelector('[data-view="cases"]').click(); $('hubChatClose')?.click(); $('openProjectResearch').click();
        await wait(() => [...$('projectResearchConnection').options].some(option => option.value === 'smoke-research'), 'Agent selector not ready');
        $('projectResearchConnection').value = 'smoke-research'; $('projectResearchBrief').value = '隔离验收：为当前项目调研两个滨水公共空间案例，比较院落、公共步道和开放边界。';
        $('projectResearchSeeds').value = ${JSON.stringify([sourceA, sourceB, sourceC].join('\n'))}; $('projectResearchCount').value = '2';
        $('projectResearchForm').requestSubmit($('projectResearchStart'));
        const task = await wait(async () => { const snapshot = await api.projectResearchList({ projectId: bootstrap.project.id }); return snapshot.tasks.find(item => ['completed', 'complete', 'partial', 'failed'].includes(item.status)); }, 'Research did not reach a terminal state');
        if (!task.cases?.length) throw Error('No archived cases: ' + JSON.stringify(task));
        await wait(() => [...document.querySelectorAll('#projectResearchTasks button')].some(button => button.textContent.includes('生成案例研究 PPT')), 'PPT button is missing');
        if ($('projectResearchDetail').hidden) [...document.querySelectorAll('#projectResearchTasks button')].find(button => button.textContent === '查看调研').click();
        await wait(() => !$('projectResearchDetail').hidden && $('projectResearchDetail').textContent.includes('全部来源'), 'Source details are missing');
        const sourceButtons = [...document.querySelectorAll('#projectResearchDetail .research-source-link')].map(button => button.textContent);
        [...document.querySelectorAll('#projectResearchTasks button')].find(button => button.textContent.includes('生成案例研究 PPT')).click();
        await wait(() => $('projectResearchNotice').textContent.includes('PPT 已保存'), 'PPT export did not finish');
        $('projectResearchPanel').scrollIntoView({ block: 'start' });
        const scroller = $('projectResearchPanel').closest('.workspace') || document.scrollingElement;
        if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop - 90);
        return { projectId: bootstrap.project.id, taskId: task.id, status: task.status, caseCount: task.cases.length, sourceButtons, task, exportNotice: $('projectResearchNotice').textContent, errors: window.__BYCJ_WORKBENCH_ERRORS__ || [] };
      })()`);
      assert.equal(executionCalls.length, 1, 'Exactly one explicit Agent dispatch');
      assert(result.caseCount >= 2); assert(result.sourceButtons.length >= 3); assert.deepEqual(result.errors, []);
      assert(fs.statSync(pptPath).size > 0, 'Real PPTX was written');
      const assets = collection.list({ projectId: result.projectId });
      assert(assets.length >= 2, 'Multiple high-resolution images archived');
      assert(assets.every(image => Math.max(image.width, image.height) >= 1600), 'Only measured high-resolution files archived');
      assert(!imageCalls.some(url => /\/(?:logo|recommended)\.png$/.test(url)), 'Unrelated page images never fetched');
      assert(backend.store.cases.filter(item => item.projectId === result.projectId).length >= 2, 'Research wrote cases back into Hub');
      const JSZip = require('jszip'), archive = await JSZip.loadAsync(fs.readFileSync(pptPath));
      const slides = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      const slideText = (await Promise.all(slides.map(name => archive.file(name).async('string')))).join('\n');
      assert.match(slideText, /公共空间/); assert.match(slideText, /1800 × 1080|1900 × 1140/);
      fs.writeFileSync(path.join(output, 'workbench.png'), (await win.webContents.capturePage()).toPNG());
      const report = { ok: true, ...result, output, pptPath, slides: slides.length, archivedImages: assets.length, pageRequests: pageCalls.length, imageRequests: imageCalls.length, executionCalls: executionCalls.length, boundary: 'Synthetic Agent and public-page transports only. Real UI, preload, IPC, AgentHub, workflow, archival and PPTX exporter.' };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: true, output, pptPath, status: result.status, cases: result.caseCount, images: assets.length, slides: slides.length, executionCalls: executionCalls.length }));
      clearTimeout(watchdog); app.quit();
    } catch (error) {
      const diagnostics = await win?.webContents.executeJavaScript('({text:document.body.innerText.slice(-9000),errors:window.__BYCJ_WORKBENCH_ERRORS__||[]})').catch(() => null);
      if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, diagnostics, executionCalls, pageCalls, imageCalls, research: researchService?.list?.(backend?.projectId?.()) }, null, 2));
      console.error(JSON.stringify({ ok: false, message: error.message, output })); clearTimeout(watchdog); app.exit(1);
    }
  });
}
