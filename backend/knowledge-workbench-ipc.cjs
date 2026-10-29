'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { KnowledgeWorkbench, SUPPORTED } = require('./knowledge-workbench.cjs');

function assertKnowledgeSender(event, owner, rendererFile) {
  if (!owner || owner.isDestroyed?.() || event.sender !== owner.webContents
    || event.sender.isDestroyed?.() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许此页面访问本机知识库。');
  let valid = false;
  try { const current = new URL(event.senderFrame.url); current.search = ''; current.hash = ''; valid = current.href === pathToFileURL(rendererFile).href; } catch {}
  if (!valid) throw new Error('不允许此页面访问本机知识库。');
}

function registerKnowledgeWorkbenchIpc({ ipcMain, dialog, shell, mainWindow, rendererFile, backend, modelService, ...options }) {
  const service = new KnowledgeWorkbench({ backend, modelService, ...options });
  const channels = [];
  function handle(name, action) {
    const channel = `workbench:kb-${name}`;
    ipcMain.handle(channel, (event, ...args) => { assertKnowledgeSender(event, mainWindow(), rendererFile); return action(event, ...args); });
    channels.push(channel);
  }
  handle('libraries', (_event, projectId) => service.listLibraries(projectId));
  handle('create', (_event, projectId, input) => service.createLibrary(projectId, input));
  handle('update', (_event, projectId, libraryId, input) => service.updateLibrary(projectId, libraryId, input));
  handle('remove', (_event, projectId, libraryId) => service.removeLibrary(projectId, libraryId));
  handle('sources', (_event, projectId, libraryId) => service.listSources(projectId, libraryId));
  handle('reindex', (_event, projectId, libraryId) => service.reindex(projectId, libraryId));
  handle('remove-source', (_event, projectId, libraryId, sourceId) => service.removeSource(projectId, libraryId, sourceId));
  handle('search', (_event, projectId, libraryId, query) => service.search(projectId, libraryId, query));
  handle('history', (_event, projectId, libraryId) => service.history(projectId, libraryId));
  handle('model', () => service.modelStatus());
  handle('ask', (event, projectId, libraryId, input) => service.ask(projectId, libraryId, input, event.sender.id, progress => {
    if (!event.sender.isDestroyed()) event.sender.send('workbench:kb-progress', progress);
  }));
  handle('cancel', (event, requestId) => service.cancel(requestId, event.sender.id));
  handle('files', async (_event, projectId, libraryId) => {
    await service.listSources(projectId, libraryId);
    const result = await dialog.showOpenDialog(mainWindow(), { title: '导入知识资料', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '资料文件', extensions: [...SUPPORTED] }] });
    if (result.canceled) return { added: [], skipped: [], cancelled: true };
    return service.importFiles(projectId, libraryId, result.filePaths);
  });
  handle('folder', async (_event, projectId, libraryId) => {
    await service.listSources(projectId, libraryId);
    const result = await dialog.showOpenDialog(mainWindow(), { title: '导入资料文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths?.[0]) return { added: [], skipped: [], cancelled: true };
    return service.importFolder(projectId, libraryId, result.filePaths[0]);
  });
  handle('export', async (_event, projectId, libraryId, input) => {
    const output = await service.exportResult(projectId, libraryId, input);
    const extension = input.format;
    const result = await dialog.showSaveDialog(mainWindow(), { title: '导出完整知识库结果', defaultPath: output.suggestedName,
      filters: [{ name: { xlsx: 'Excel 工作簿', docx: 'Word 文档', pptx: 'PowerPoint 演示文稿' }[extension], extensions: [extension] }] });
    if (result.canceled || !result.filePath) return null;
    const filePath = result.filePath.toLowerCase().endsWith(`.${extension}`) ? result.filePath : `${result.filePath}.${extension}`;
    const buffer = Buffer.from(output.base64, 'base64');
    if (buffer.length > 64 * 1024 * 1024) throw new Error('导出文件过大，请缩小本次处理范围。');
    await fs.writeFile(filePath, buffer);
    return { filePath, suggestedName: path.basename(filePath), bytes: buffer.length };
  });
  handle('reveal', async (_event, projectId, libraryId, sourceId) => {
    const file = await service.sourcePath(projectId, libraryId, sourceId); shell.showItemInFolder(file); return { revealed: true };
  });
  return { service, dispose: async () => { for (const channel of channels) ipcMain.removeHandler(channel); await service.dispose(); } };
}

module.exports = { assertKnowledgeSender, registerKnowledgeWorkbenchIpc };
