'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { validatePublicUrl } = require('./public-page.cjs');

// Only decoded, bounded raster previews cross the bridge. Original files stay
// behind opaque asset/candidate IDs and are exported through a native picker.
function rasterPreview(nativeImage, input, { edge = 2400, maxBytes = 1536 * 1024 } = {}) {
  const image = Buffer.isBuffer(input) ? nativeImage.createFromBuffer(input) : nativeImage.createFromDataURL(input);
  if (image.isEmpty()) throw new Error('图片无法解码。');
  const original = image.getSize();
  if (!original.width || !original.height || original.width * original.height > 24000000) throw new Error('图片尺寸超过预览范围。');
  let size = Math.min(edge, Math.max(original.width, original.height));
  for (let attempt = 0; attempt < 5; attempt++) {
    const ratio = Math.min(1, size / Math.max(original.width, original.height));
    const preview = image.resize({ width: Math.max(1, Math.round(original.width * ratio)), height: Math.max(1, Math.round(original.height * ratio)), quality: 'good' });
    const bytes = preview.toJPEG(82);
    if (bytes.length <= maxBytes) return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: original.width, height: original.height };
    size = Math.floor(size * 0.7);
  }
  throw new Error('图片预览过大，请导出原图查看。');
}

function registerImageCollectionIpc({ ipcMain, service, backend, dialog, shell, nativeImage, appDir, localOnly = () => {} }) {
  const trustedUrl = pathToFileURL(path.join(appDir, 'index.html')).href;
  const guard = event => {
    const frame = event?.senderFrame;
    if (!frame || frame.parent || frame.url !== trustedUrl) throw new Error('此页面无权访问项目素材。');
    localOnly();
  };
  const project = payload => {
    const current = backend.projectId();
    if (payload?.projectId && payload.projectId !== current) throw new Error('项目已切换，请重新打开当前项目素材库。');
    return current;
  };
  const session = id => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('采集任务无效。');
    const value = service.get(id);
    if (!value || value.projectId !== project()) throw new Error('此采集任务不属于当前项目。');
    return value;
  };
  const asset = id => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('素材编号无效。');
    const value = service.getAsset(id);
    if (!value || value.projectId !== project()) throw new Error('此素材不属于当前项目。');
    return value;
  };
  const storedBytes = record => {
    if (!record?.path || !path.isAbsolute(record.path)) throw new Error('素材文件不存在。');
    const stat = fs.lstatSync(record.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('素材文件状态或大小无效。');
    return fs.readFileSync(record.path);
  };
  const handle = (name, action) => ipcMain.handle(`workbench:image-collection-${name}`, (event, payload) => { guard(event); return action(payload); });
  handle('start', payload => service.start({ sourceUrl: payload?.sourceUrl, mode: payload?.mode, caseId: payload?.caseId, projectId: project(payload) }));
  handle('archive', payload => service.startArticle({ sourceUrl: payload?.sourceUrl, mode: payload?.mode, caseId: payload?.caseId, projectId: project(payload) }));
  handle('import', async payload => {
    const projectId = project(payload);
    const sourceUrl = validatePublicUrl(payload?.sourceUrl).href;
    const selected = await dialog.showOpenDialog({ title: '导入浏览器保存的文章 HTML', properties: ['openFile'], filters: [{ name: '网页 HTML', extensions: ['html', 'htm'] }] });
    if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
    if (project() !== projectId) throw new Error('项目已切换，已取消导入。');
    const imported = require('./saved-article.cjs').readSavedArticle(selected.filePaths[0], sourceUrl);
    return service.startArticle({ sourceUrl, projectId, caseId: payload?.caseId }, imported);
  });
  handle('get', id => { session(id); return service.get(id); });
  handle('cancel', id => { session(id); return service.cancel(id); });
  handle('retry', payload => { session(payload?.sessionId); return service.retry({ sessionId: payload.sessionId, candidateIds: payload.candidateIds }); });
  handle('save', payload => { session(payload?.sessionId); return service.save({ sessionId: payload.sessionId, candidateIds: payload.candidateIds, note: payload.note }); });
  handle('list', payload => service.list({ projectId: project(payload), caseId: payload?.caseId }));
  handle('preview', payload => {
    let record;
    if (payload?.assetId) record = asset(payload.assetId);
    else { session(payload?.sessionId); record = service.getCandidate(payload.sessionId, payload?.candidateId); }
    return rasterPreview(nativeImage, storedBytes(record));
  });
  handle('reveal', id => {
    const record = asset(id);
    storedBytes(record);
    shell.showItemInFolder(record.path);
    return { opened: true };
  });
  handle('export', async payload => {
    const projectId = project();
    const article = payload?.articleId || payload?.caseId ? service.getArticle({ projectId, articleId: payload.articleId, caseId: payload.caseId }) : null;
    const assetIds = payload?.assetIds || article?.assetIds;
    if (!Array.isArray(assetIds) || (!assetIds.length && !article) || assetIds.length > 600) throw new Error('请选择 1 至 600 张已归档图片，或选择已保存的文章。');
    const records = [...new Set(assetIds)].map(asset);
    const selected = await dialog.showOpenDialog({ title: '选择原图导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
    if (project() !== projectId) throw new Error('项目已切换，已取消导出。');
    const destination = path.join(selected.filePaths[0], `AIDesignHub-images-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 6)}`);
    fs.mkdirSync(destination);
    const manifest = [];
    for (let index = 0; index < records.length; index++) {
      const record = asset(records[index].id);
      storedBytes(record);
      const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[record.contentType] || path.extname(record.path).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) throw new Error('素材格式不支持导出。');
      const stem = String(record.name || record.alt || 'image').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || 'image';
      const filename = `${String(index + 1).padStart(3, '0')}-${stem}${extension}`;
      fs.copyFileSync(record.path, path.join(destination, filename), fs.constants.COPYFILE_EXCL);
      const { path: internalPath, thumbnailUrl, ...metadata } = record;
      manifest.push({ ...metadata, filename });
    }
    if (article) {
      fs.writeFileSync(path.join(destination, 'article.txt'), `${article.title || '网页文章'}\n来源：${article.sourceUrl}\n保存时间：${article.retrievedAt || article.createdAt || ''}\n\n${article.text || article.description || ''}`, { flag: 'wx' });
      fs.writeFileSync(path.join(destination, 'article.json'), JSON.stringify(article, null, 2), { flag: 'wx' });
    }
    fs.writeFileSync(path.join(destination, 'sources.json'), JSON.stringify({ version: 1, projectId, exportedAt: new Date().toISOString(), ...(article ? { articleId: article.articleId, complete: article.complete, errors: article.errors } : {}), images: manifest }, null, 2), { flag: 'wx' });
    return { canceled: false, count: manifest.length, directory: destination };
  });
}

module.exports = { registerImageCollectionIpc, rasterPreview };
