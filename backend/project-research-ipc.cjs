'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { exportCaseBenchmarkPresentation } = require('./research-presentation.cjs');
const { exportResearchAnalysisPage, selectResearchImages } = require('./research-analysis-page.cjs');
const { safeProfileForContext } = require('./project-research-profiles.cjs');

function registerProjectResearchIpc({ ipcMain, service, backend, imageCollection, dialog, nativeImage, appDir, localOnly = () => {}, beforeStart = async () => {}, exportPresentation = exportCaseBenchmarkPresentation, exportAnalysisPage = exportResearchAnalysisPage }) {
  const trustedUrl = pathToFileURL(path.join(appDir, 'index.html')).href;
  const guard = event => {
    const frame = event?.senderFrame;
    if (!frame || frame.parent || frame.url !== trustedUrl) throw new Error('此页面无权访问项目调研。');
    localOnly();
  };
  const project = payload => {
    const id = backend.projectId();
    if (payload?.projectId && payload.projectId !== id) throw new Error('项目已切换，请回到当前项目重试。');
    return id;
  };
  const task = payload => {
    if (typeof payload?.id !== 'string' || payload.id.length > 100) throw new Error('调研任务编号无效。');
    const record = service.get(payload.id);
    if (!record || record.projectId !== project(payload)) throw new Error('调研任务不属于当前项目。');
    return record;
  };
  const handle = (name, action) => ipcMain.handle(`workbench:project-research-${name}`, (event, payload) => { guard(event); return action(payload); });
  handle('list', payload => {
    const projectId = project(payload), current = backend.store.projects.find(item => item.id === projectId);
    return { projectId, project: { id: projectId, name: current?.name || '', researchProfile: safeProfileForContext(current) }, tasks: service.list(projectId) };
  });
  handle('get', payload => task(payload));
  handle('start', async payload => {
    const projectId = project(payload);
    await beforeStart();
    if (project() !== projectId) throw new Error('项目已切换，已取消派单。');
    return service.start({ projectId, brief: payload?.brief, connectionId: payload?.connectionId, maxCases: payload?.maxCases, seedUrls: payload?.seedUrls, includeProjectContext: payload?.includeProjectContext !== false });
  });
  handle('retry', async payload => {
    const record = task(payload), projectId = record.projectId;
    await beforeStart();
    if (project() !== projectId) throw new Error('项目已切换，已取消派单。');
    return service.retry(record.id);
  });
  handle('revalidate', payload => { const record = task(payload); return service.revalidate(record.id); });
  handle('export', async payload => {
    const record = task(payload), projectId = record.projectId;
    if (!['completed', 'complete', 'partial', 'failed', 'interrupted', 'cancelled'].includes(record.status)) throw new Error('请等待调研和图片归档结束后导出。');
    if (!record.cases?.length) throw new Error('本次尚无可导出的案例资料。');
    const title = String(record.title || record.brief || '案例研究').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70);
    const analysis = payload?.format === 'html';
    const template = payload?.template === 'editorial' ? 'editorial' : 'brief';
    const fileName = `${title}${analysis ? '' : (template === 'editorial' ? '_杂志版' : '_研究简报')}.${analysis ? 'html' : 'pptx'}`;
    const selected = await dialog.showSaveDialog({ title: analysis ? '保存案例分析页' : `保存案例研究 PPT（${template === 'editorial' ? '杂志版' : '简报版'}）`, defaultPath: fileName, filters: [{ name: analysis ? '离线案例分析页' : 'PowerPoint', extensions: [analysis ? 'html' : 'pptx'] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    if (project() !== projectId) throw new Error('项目已切换，已取消导出。');
    const latest = task(payload), ids = new Set();
    const collectIds = result => {
      if (!result || typeof result !== 'object') return;
      for (const id of Array.isArray(result.assetIds) ? result.assetIds : []) if (typeof id === 'string') ids.add(id);
      if (Array.isArray(result.images)) for (const image of result.images) { if (image?.assetId || image?.id) ids.add(image.assetId || image.id); }
      else if (result.images && typeof result.images === 'object') collectIds(result.images);
    };
    collectIds(latest.images); collectIds(latest.imageArchive); collectIds(latest);
    const cases = latest.cases.map(item => {
      collectIds(item.images); collectIds(item.imageArchive); collectIds(item);
      const caseId = item.caseId || item.id;
      const saved = backend.store.cases.find(value => value.id === caseId && value.projectId === projectId);
      return { ...saved, ...item, caseId };
    });
    const images = [], warnings = [];
    for (const id of ids) {
      try { const image = imageCollection.getAsset(id); if (image.projectId !== projectId) throw new Error('图片不属于当前项目。'); images.push(image); }
      catch { warnings.push('有一张已归档图片无法读取，请在项目素材库核对。'); }
    }
    const projectData = backend.store.projects.find(item => item.id === projectId), selectedImages = selectResearchImages(latest, images, 8);
    const result = await (analysis ? exportAnalysisPage : exportPresentation)({ research: { ...latest, archivedImageCount: images.length, warnings: [...(latest.warnings || []), ...warnings] }, project: projectData, cases, images: selectedImages, outputPath: selected.filePath, template, allowedImageRoots: imageCollection.originalsDir ? [imageCollection.originalsDir] : [], convertImage: bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('图片无法转换为 PowerPoint 支持的格式。');
      return image.toPNG();
    } });
    return { canceled: false, ...result, warnings: [...warnings, ...(result.warnings || [])] };
  });
}

module.exports = { registerProjectResearchIpc };
