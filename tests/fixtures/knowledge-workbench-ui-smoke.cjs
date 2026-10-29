'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '../..');
let win;
const run = async () => {
  const $ = name => document.querySelector(`[data-kw="${name}"]`);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, label) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(15); } throw new Error(label + ': ' + $('error')?.textContent); };
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const input = (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
  const calls = [];
  let project = { id: 'project-a' }; let progress; let pending;
  const libraries = { 'project-a': [{ id: 'lib-a', name: '门店设计资料', description: '规范、任务书与会议纪要', sourceCount: 2 }], 'project-b': [{ id: 'lib-b', name: '另一项目资料' }] };
  const sources = [
    { id: 'source-a', name: '消防规范.pdf', path: 'D:/测试资料/规范/消防规范.pdf', extension: 'pdf', chunkCount: 12, status: 'indexed', error: '已保留旧版片段；更新解析后可建立语义索引并处理完整正文。' },
    { id: 'source-b', name: '<img src=x onerror=window.knowledgeXss=true>.docx', path: 'D:/测试资料/任务书.docx', extension: 'docx', chunkCount: 8, status: 'indexed', error: '扫描版资料尚未 OCR。 已保留旧版片段；更新解析后可建立语义索引并处理完整正文。 原文件暂不可用。' },
  ];
  const hit = { sourceId: 'source-a', sourceName: '消防规范.pdf', locator: '第 12 页', text: '消防车道转弯半径应根据设计车型确定。<script>window.knowledgeXss=true</script>' };
  const api = {
    async listKnowledgeLibraries(id) { calls.push(['libraries', id]); return { libraries: libraries[id] || [], summary: {} }; },
    async createKnowledgeLibrary(id, data) { calls.push(['create', id, data]); const library = { id: 'new-lib', ...data }; libraries[id].push(library); return library; },
    async updateKnowledgeLibrary(id, libraryId, data) { calls.push(['update', id, libraryId, data]); const library = libraries[id].find(item => item.id === libraryId); Object.assign(library, data); return library; },
    async removeKnowledgeLibrary(id, libraryId) { calls.push(['remove-library', id, libraryId]); libraries[id] = libraries[id].filter(item => item.id !== libraryId); },
    async listKnowledgeSources(id, libraryId) { calls.push(['sources', id, libraryId]); return { sources: libraryId === 'lib-a' ? sources : [], summary: { chunkCount: libraryId === 'lib-a' ? 20 : 0 } }; },
    async getKnowledgeHistory(id, libraryId) { return { messages: libraryId === 'lib-a' ? [{ id: 'old', role: 'assistant', content: '原有 Hub 项目资料已保留。' }] : [] }; },
    async chooseKnowledgeFiles(id, libraryId) { calls.push(['files', id, libraryId]); return { added: 1, skipped: [] }; },
    async chooseKnowledgeFolder(id, libraryId) { calls.push(['folder', id, libraryId]); return { added: 2, skipped: [] }; },
    async reindexKnowledgeLibrary(id, libraryId) { calls.push(['reindex', id, libraryId]); },
    async removeKnowledgeSource(id, libraryId, sourceId) { calls.push(['remove-source', id, libraryId, sourceId]); },
    async searchKnowledgeLibrary(id, libraryId, query) { calls.push(['search', id, libraryId, query]); return { hits: [hit], query }; },
    async answerKnowledgeLibrary(id, libraryId, data) {
      calls.push(['answer', id, libraryId, data]);
      if (data.question.includes('延迟')) return new Promise((resolve, reject) => { pending = { resolve, reject, requestId: data.requestId, committing: data.question.includes('延迟保存') }; });
      progress({ projectId: id, libraryId, requestId: data.requestId, phase: 'map', processedSources: 1, totalSources: 2, processedChunks: 12, totalChunks: 20 });
      return { answer: '## 设计指标\n| 项目 | 要求 |\n| --- | --- |\n| 消防车道 | 按设计车型核定 |\n\n<img src=x onerror=window.knowledgeXss=true>', citations: [hit], coverage: { processedSources: 2, totalSources: 2, processedChunks: 20, totalChunks: 20 }, exportId: 'export-1', model: { used: true, provider: 'local-config', model: 'fixture-model' } };
    },
    async cancelKnowledgeAnswer(requestId) {
      calls.push(['cancel', requestId]);
      if (pending?.requestId === requestId) {
        if (pending.committing) return { cancelled: false, committing: true };
        pending.reject(new Error('任务已取消')); pending = null; return { cancelled: true };
      }
      return { cancelled: false };
    },
    async exportKnowledgeResult(id, libraryId, data) { calls.push(['export', id, libraryId, data]); return { filePath: 'D:/结果/设计指标.xlsx', suggestedName: '设计指标.xlsx' }; },
    async getKnowledgeModelStatus() { return { configured: true, provider: '本机配置', model: 'fixture-model' }; },
    async revealKnowledgeSource(id, libraryId, sourceId) { calls.push(['reveal', id, libraryId, sourceId]); },
    onKnowledgeProgress(callback) { progress = callback; return () => { calls.push(['unsubscribe']); }; },
  };
  const workbench = window.createKnowledgeWorkbench({ api, getProject: () => project });
  await workbench.refresh();
  await wait(() => !$('send').hidden && $('title').textContent === '门店设计资料', 'project library did not load');
  check($('messages').textContent.includes('原有 Hub 项目资料已保留'), 'existing Hub history missing');
  check(!window.knowledgeXss && !document.querySelector('[onerror]'), 'source metadata executed as HTML');
  check(!document.querySelector('.kw-source-tree').textContent.includes('已保留旧版片段'), 'shared migration warning repeated in source rows');
  check(document.querySelector('.kw-source-tree').textContent.includes('尚未 OCR') && document.querySelector('.kw-source-tree').textContent.includes('原文件暂不可用'), 'real per-file warnings were hidden');
  check([...document.querySelectorAll('.kw-source-open')].every(element => element.title.includes('已保留旧版片段')), 'complete source warning was lost from hover details');
  check($('disclosure').textContent.includes('本次使用的资料文本会发送给已配置模型'), 'privacy disclosure missing');
  input($('filter'), '消防'); check(document.querySelectorAll('.kw-source-row').length === 1, 'source name filter failed'); input($('filter'), '');
  $('search-tab').click(); input($('search-query'), '消防车道'); $('search-form').requestSubmit();
  await wait(() => document.querySelector('.kw-search-hit'), 'offline search did not return original text');
  check(calls.filter(call => call[0] === 'answer').length === 0, 'search unexpectedly invoked answer/model');
  document.querySelector('.kw-search-hit button').click(); check($('dialog').open && $('dialog').textContent.includes('第 12 页'), 'citation preview missing');
  [...$('dialog').querySelectorAll('button')].find(button => button.textContent === '定位原文件').click(); await delay(10); check(calls.some(call => call[0] === 'reveal' && call[3] === 'source-a'), 'source reveal did not use trusted source id'); $('dialog').close();
  $('chat-tab').click(); input($('question'), '完整整理全部资料，生成 Excel'); $('scope').value = 'all'; $('format').value = 'xlsx'; $('ask-form').requestSubmit();
  await wait(() => document.querySelector('.kw-exports'), 'answer/export controls missing');
  check(document.querySelector('.kw-message-content table'), 'native answer table not displayed');
  check(!window.knowledgeXss && !document.querySelector('[onerror]'), 'answer or citation executed HTML');
  const sent = calls.find(call => call[0] === 'answer'); check(sent[1] === 'project-a' && sent[2] === 'lib-a' && sent[3].scope === 'all' && sent[3].format === 'xlsx', 'whole corpus request routing wrong');
  [...document.querySelectorAll('.kw-export')].find(button => button.textContent === 'Excel').click(); await wait(() => calls.some(call => call[0] === 'export'), 'export missing');
  check(calls.find(call => call[0] === 'export')[3].exportId === 'export-1', 'large result export pointer lost');
  await wait(() => !$('send').hidden && !$('question').disabled, 'export did not settle');
  input($('question'), '延迟处理，等待取消'); $('ask-form').requestSubmit(); await wait(() => pending, 'cancel fixture not pending');
  $('stop').click(); await wait(() => !$('question').disabled, 'cancel did not settle');
  check($('question').value === '延迟处理，等待取消', 'cancel destroyed original question');
  input($('question'), '延迟保存完整结果'); $('ask-form').requestSubmit(); await wait(() => pending?.committing, 'commit fixture not pending');
  $('stop').click(); await wait(() => $('progress-label').textContent.includes('正在保存完整结果'), 'late cancel did not show committing status');
  check($('question').disabled && $('stop').disabled && !$('error').textContent.includes('取消'), 'late cancel falsely completed or cancelled the active request');
  pending.resolve({ answer: '完整结果已保存。', citations: [hit], exportId: 'export-commit', incomplete: false, model: { used: true } }); pending = null;
  await wait(() => !$('question').disabled && $('messages').textContent.includes('完整结果已保存'), 'committing answer was lost after cancellation');
  check(!$('question').value && !document.querySelector('.kw-message:last-child').classList.contains('kw-incomplete'), 'saved complete answer was incorrectly marked incomplete');
  input($('question'), '项目 A 的未发送草稿');
  project = { id: 'project-b' }; await workbench.refresh(); check(!$('messages').textContent.includes('原有 Hub'), 'history leaked across projects'); check(!$('question').value, 'draft leaked across projects');
  project = { id: 'project-a' }; await workbench.refresh(); check($('question').value === '项目 A 的未发送草稿', 'project draft did not survive switching');
  input($('question'), '延迟处理，切换项目'); $('ask-form').requestSubmit(); await wait(() => pending, 'late-result fixture not pending');
  project = { id: 'project-b' }; await workbench.refresh(); check(calls.filter(call => call[0] === 'cancel').length >= 2, 'project switch did not cancel active answer'); check(!$('messages').textContent.includes('切换项目'), 'late answer leaked to next project');
  project = { id: 'project-a' }; await workbench.refresh();
  $('files').click(); await wait(() => calls.some(call => call[0] === 'files') && !$('files').disabled, 'file import action missing');
  $('folder').click(); await wait(() => calls.some(call => call[0] === 'folder') && !$('folder').disabled, 'folder import action missing');
  $('reindex').click(); await wait(() => calls.some(call => call[0] === 'reindex') && !$('reindex').disabled, 'reindex action missing');
  $('create').click(); const nameInput = $('dialog').querySelector('input'); input(nameInput, '新资料库'); $('dialog').querySelector('form').requestSubmit();
  await wait(() => $('title').textContent === '新资料库', 'create library did not select result');
  $('rename').click(); input($('dialog').querySelector('input'), '更名后的资料库'); $('dialog').querySelector('form').requestSubmit();
  await wait(() => $('title').textContent === '更名后的资料库', 'library rename missing');
  $('remove-library').click(); [...$('dialog').querySelectorAll('button')].find(button => button.textContent === '确认移除').click();
  await wait(() => $('title').textContent === '门店设计资料', 'remove library did not restore remaining library');
  project = null; await workbench.refresh(); check(!document.querySelector('.kw-source-row') && !$('messages').textContent.includes('原有 Hub'), 'cleared project left prior data visible');
  project = { id: 'project-a' }; await workbench.refresh();
  workbench.dispose(); check(calls.some(call => call[0] === 'unsubscribe'), 'progress listener leaked');
  return { pass: true, checks: ['history', 'source-filter', 'offline-search', 'citations', 'xss-text', 'whole-corpus', 'table', 'native-export-pointer', 'cancel-preserves-question', 'late-cancel-waits-for-commit', 'project-history-isolation', 'project-draft-isolation', 'late-result-isolation', 'file-folder-import', 'reindex', 'library-crud', 'listener-dispose'], calls: calls.map(call => call[0]), modelCalls: 0, simulatedBackend: true };
};

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-ui-'));
  app.setPath('userData', path.join(directory, 'browser-user'));
  await app.whenReady();
  const htmlFile = path.join(directory, 'fixture.html');
  await fs.writeFile(htmlFile, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Knowledge UI fixture</title><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'knowledge-workbench.css')).href}"><style>body{margin:0;padding:24px;background:#f4f5f8;font-family:"Segoe UI","Microsoft YaHei",sans-serif}button,input,textarea,select{font:inherit}</style><div id="knowledge-workbench-root"></div><script src="${pathToFileURL(path.join(root, 'knowledge-workbench-ui.js')).href}"></script></html>`);
  win = new BrowserWindow({ show: false, width: 1280, height: 920, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(htmlFile);
  const report = await win.webContents.executeJavaScript(`(${run.toString()})()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  report.screenshot = path.join(directory, 'knowledge-workbench.png');
  await fs.writeFile(report.screenshot, (await win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(root, '.test-harness-upgrade', 'knowledge-ui-acceptance.json'), JSON.stringify(report, null, 2));
  console.log('KNOWLEDGE_UI_PASS ' + JSON.stringify(report));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => { win?.destroy(); app.exit(process.exitCode || 0); });
setTimeout(() => { console.error('KNOWLEDGE_UI_TIMEOUT'); app.exit(1); }, 45000).unref();
