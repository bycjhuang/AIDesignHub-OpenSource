#!/usr/bin/env node
'use strict';

// Explicit, single-writer runner for the user-authorized Jiangwan research.
// Uses the existing Agent connection; never edits its saved configuration.
const fs = require('node:fs');
const path = require('node:path');
const MAX_DURATION_MS = 12 * 60 * 1000;
const TERMINAL = new Set(['complete', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const match = /^--(data-dir|output-dir|agent|revalidate)(?:=(.*))?$/.exec(argv[index]);
    if (!match) throw new Error('仅支持 --data-dir、--output-dir、--agent、--revalidate 参数。');
    const value = match[2] === undefined ? argv[++index] : match[2];
    if (!value || value.startsWith('--') || options[match[1]]) throw new Error('参数缺失或重复。');
    options[match[1]] = value;
  }
  for (const name of ['data-dir', 'output-dir']) if (!options[name] || !path.isAbsolute(options[name])) throw new Error(`必须显式提供绝对路径 --${name}。`);
  if (!fs.statSync(path.join(options['data-dir'], 'store.json'), { throwIfNoEntry: false })?.isFile()) throw new Error('指定数据目录没有现有 store.json；不会新建空白业务库。');
  if (options.agent && !/^[a-z0-9_-]{1,100}$/i.test(options.agent)) throw new Error('Agent 连接编号格式无效。');
  if (options.revalidate && !/^research_[a-z0-9-]{1,90}$/i.test(options.revalidate)) throw new Error('需复核的调研任务编号格式无效。');
  return { dataDir: path.resolve(options['data-dir']), outputDir: path.resolve(options['output-dir']), connectionId: options.agent || 'deepseek', revalidateId: options.revalidate || null };
}
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temporary, file);
}
function emit(id, status, progress, numbers = {}) { process.stdout.write(JSON.stringify({ id: id || null, status, progress, ...numbers }) + '\n'); }

async function run(options, nativeImage) {
  const { LocalBackend } = require('../backend/local-backend.cjs');
  const { ProjectHub } = require('../backend/project-hub.cjs');
  const { AgentHub } = require('../backend/agent-hub.cjs');
  const { executeAgent } = require('../backend/agent-executors.cjs');
  const { CaseResearchService } = require('../backend/case-research.cjs');
  const { ImageCollectionService } = require('../backend/image-collection.cjs');
  const { ResearchImageService } = require('../backend/research-images.cjs');
  const { ProjectResearchService } = require('../backend/project-research.cjs');
  const { exportCaseBenchmarkPresentation } = require('../backend/research-presentation.cjs');
  const { exportResearchAnalysisPage } = require('../backend/research-analysis-page.cjs');
  const { acquireServiceLock } = require('../backend/service-lock.cjs');
  const startedAt = Date.now(), deadline = startedAt + MAX_DURATION_MS - 20000;
  const release = acquireServiceLock(options.dataDir), executing = new Set();
  let backend, projectHub, hub, cases, collection, research, taskId, stopReason;
  const reportPath = path.join(options.outputDir, 'report.json');
  const report = { startedAt: new Date(startedAt).toISOString(), realAgentExecution: !options.revalidateId, reusesAgentResult: Boolean(options.revalidateId), connectionId: options.connectionId, durationLimitMs: MAX_DURATION_MS, exports: {}, warnings: [] };
  const requestStop = reason => {
    stopReason ||= reason;
    const runId = taskId && research?.get(taskId)?.runId;
    if (runId) { try { hub.cancelRun(runId); } catch {} }
    research?.dispose();
  };
  const interrupted = () => requestStop('signal');
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    fs.mkdirSync(options.outputDir, { recursive: true });
    if (options.revalidateId && fs.existsSync(reportPath)) {
      const backupPath = path.join(options.outputDir, 'first-attempt-report.json');
      if (!fs.existsSync(backupPath)) fs.copyFileSync(reportPath, backupPath, fs.constants.COPYFILE_EXCL);
      report.firstAttemptReport = backupPath;
    }
    backend = new LocalBackend({ dataDir: options.dataDir }); projectHub = new ProjectHub({ backend });
    const projectId = backend.projectId(), project = backend.store.projects.find(item => item.id === projectId);
    if (!project || !/江湾/.test(project.name || '')) throw new Error('当前项目不是江湾项目，请先核对 Hub 当前项目后再运行。');
    if (!project.researchProfile || typeof project.researchProfile !== 'object') throw new Error('江湾项目缺少已授权的 researchProfile，请先补齐研究背景。');
    const profile = JSON.parse(JSON.stringify(project.researchProfile)), profileText = JSON.stringify(profile);
    if (profileText.length > 3200) throw new Error('演示研究背景过长，请先精简为明确的项目指标与研究问题。');
    hub = new AgentHub({ backend, projectContext: id => projectHub.context(id), execute: async (connection, input) => {
      if (options.revalidateId) throw new Error('复核模式禁止新模型调用；仅可复用已有 Agent 输出。');
      if (connection.id !== options.connectionId) throw new Error('本次 runner 仅允许用户指定的 Agent 连接。');
      const promise = executeAgent({ ...connection, timeoutMs: 600000 }, input); executing.add(promise);
      try { return await promise; } finally { executing.delete(promise); }
    } });
    // Validate the saved connection without invoking a model or saving changes.
    if (!options.revalidateId) {
      const connection = hub.connection(options.connectionId);
      if (!['cli', 'acp', 'openclaw-http'].includes(connection.mode)) throw new Error('指定 Agent 没有可主动执行的现有连接配置。');
    }
    cases = new CaseResearchService({ backend, hub });
    collection = new ImageCollectionService({ dataDir: options.dataDir,
      findCase: id => backend.store.cases.find(item => item.id === id), findProject: id => backend.store.projects.find(item => item.id === id) });
    const imageResearch = new ResearchImageService({ collection });
    research = new ProjectResearchService({ backend, hub, cases, imageResearch, projectContext: id => projectHub.context(id) });
    const brief = [
      '为江湾文化商业中心完成一次真实的两案例对标研究，并形成一页案例分析及可编辑研究PPT。',
      '研究对象为中型滨水文化商业项目，重点比较：开放街巷与滨水慢行的连续性；文化公共节点的空间组织；雨棚、檐廊、连廊与灰空间；文化活动和商业运营、分时开放及服务流线的协调。',
      '可优先搜索上海蟠龙天地、成都麓湖水城等候选，也可根据实际资料选择更合适的项目；不要因为给了名称就跳过搜索或把不匹配的大型项目直接套用。每案例比较至少两个真实详情来源并获取实景高清图。',
      `本次已授权的项目研究背景如下：${profileText}`,
      profile.isSynthetic ? '上述 researchProfile 明确为用户授权编制的演示假设，不是测绘、规划许可或已批准指标。分析时必须明确区分项目假设、来源事实与Agent设计建议。' : '上述研究背景按当前Hub项目记录使用，未经来源支持的条件与指标应标为待核实。',
      '只允许读取和检索公开互联网资料，不能读取、上传或附加本机项目文件、凭据、私人账号与其他项目资料。遇登录、验证或限流请保留链接和失败原因。最终遵循Hub要求的严格JSON协议，name及事实字段附连续原文quote。',
    ].join('\n\n');
    if (options.revalidateId) {
      const existing = research.get(options.revalidateId);
      if (!existing || existing.projectId !== projectId) throw new Error('需复核的任务不属于当前江湾项目。');
      if (typeof research.revalidate !== 'function') throw new Error('当前代码尚未提供既有成果复核，请先完成更新。');
      emit(existing.id, 'requested', 'revalidation_requested');
    }
    const task = options.revalidateId ? await research.revalidate(options.revalidateId)
      : research.start({ projectId, connectionId: options.connectionId, brief, maxCases: 2, seedUrls: [], includeProjectContext: true });
    taskId = task.id; report.id = taskId; report.projectId = projectId; report.runId = task.runId; report.connectionId = task.connectionId || options.connectionId; report.projectAssumptionsSynthetic = profile.isSynthetic === true;
    if (options.revalidateId) report.validationAttempt = task.validationAttempt || null;
    writeJson(reportPath, { ...report, status: task.status });
    let previous = '', previousAt = 0;
    const progress = () => {
      const current = research.get(taskId); if (!current) return;
      const stage = current.progress?.stage || current.status;
      const completed = Number.isFinite(current.progress?.completed) ? current.progress.completed : undefined;
      const total = Number.isFinite(current.progress?.total) ? current.progress.total : undefined;
      const key = `${current.status}:${stage}:${completed}:${total}`;
      if (key !== previous && (current.status !== previous.split(':')[0] || Date.now() - previousAt >= 1000)) {
        previous = key; previousAt = Date.now(); emit(taskId, current.status, stage, { ...(completed === undefined ? {} : { completed }), ...(total === undefined ? {} : { total }) });
      }
    };
    research.on('changed', progress); progress();
    while (!TERMINAL.has(research.get(taskId)?.status)) {
      if (stopReason || Date.now() >= deadline) { requestStop(stopReason || 'time_limit'); break; }
      await delay(400);
    }
    research.removeListener('changed', progress);
    if (stopReason) await Promise.race([research.idle(), delay(1500)]);
    const finalTask = research.get(taskId);
    report.status = finalTask.status; report.stopReason = stopReason || null; report.runStatus = hub.state.runs.find(item => item.id === finalTask.runId)?.status || null;
    report.caseCount = finalTask.cases?.length || 0; report.savedCaseCount = (finalTask.cases || []).filter(item => item.caseId).length;
    report.sourceCount = finalTask.sources?.length || 0;
    report.sources = (finalTask.sources || []).map(source => ({ url: source.url, title: source.title, status: source.status, error: source.error || null }));
    report.warnings.push(...(finalTask.warnings || []), ...(finalTask.errors || [])); if (finalTask.error) report.warnings.push(finalTask.error);
    const ids = new Set(finalTask.assetIds || []);
    for (const image of [...(finalTask.images || []), ...(finalTask.imageArchive?.images || [])]) if (image.assetId || image.id) ids.add(image.assetId || image.id);
    for (const item of finalTask.cases || []) {
      for (const image of item.images || []) if (image.assetId || image.id) ids.add(image.assetId || image.id);
      // An interrupted archive may already have saved real images before the
      // task's final manifest update. Recover only this research's case assets.
      if (item.caseId) for (const image of collection.list({ projectId, caseId: item.caseId })) ids.add(image.id);
    }
    const assets = [];
    for (const id of ids) {
      try { const asset = collection.getAsset(id); if (asset.projectId === projectId) assets.push(asset); }
      catch { report.warnings.push('一张本次归档图片无法读取，未用于导出。'); }
    }
    const selected = [], hashes = new Set();
    const addImage = image => { if (image && selected.length < 6 && !hashes.has(image.hash)) { hashes.add(image.hash); selected.push(image); } };
    // Give both cases representation before filling the six-image selection.
    for (const item of finalTask.cases || []) addImage(assets.find(image => image.caseId === item.caseId || image.caseIds?.includes(item.caseId)));
    for (const image of assets) addImage(image);
    report.archivedImageCount = assets.length; report.selectedImages = selected.map(image => ({ id: image.id, width: image.width, height: image.height, sourcePageUrl: image.sourcePageUrl, sourceUrl: image.sourceUrl }));
    if (selected.length < 6) report.warnings.push(`本次实际可用图片为 ${selected.length} 张，未用其他素材补足六张。`);
    const exportRecord = { ...finalTask, projectSnapshot: { ...(finalTask.projectSnapshot || {}), researchProfile: profile }, warnings: [...report.warnings] };
    if (finalTask.cases?.length) {
      emit(taskId, finalTask.status, 'exporting', { images: selected.length });
      const base = { research: exportRecord, project, images: selected, allowedImageRoots: [collection.originalsDir] };
      try { report.exports.analysis = await exportResearchAnalysisPage({ ...base, outputPath: path.join(options.outputDir, '江湾文化商业中心_案例分析.html') }); }
      catch (error) { report.warnings.push(`分析页导出失败：${error.message}`); }
      try { report.exports.presentation = await exportCaseBenchmarkPresentation({ ...base, outputPath: path.join(options.outputDir, '江湾文化商业中心_对标案例.pptx'), convertImage: bytes => {
        const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw new Error('归档图片无法转换为PNG。'); return image.toPNG();
      } }); }
      catch (error) { report.warnings.push(`PPT导出失败：${error.message}`); }
    } else report.warnings.push('没有返回可供分析的案例，未生成空白演示文稿。');
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    report.researchRecord = path.join(options.dataDir, 'project-research', `${taskId}-${finalTask.revision}.json`);
    writeJson(reportPath, report);
    emit(taskId, finalTask.status, 'saved', { cases: report.savedCaseCount, images: assets.length, exported: Object.keys(report.exports).length });
    if (!['complete', 'completed', 'partial'].includes(finalTask.status) || !Object.keys(report.exports).length) process.exitCode = 1;
    return report;
  } catch (error) {
    if (taskId) requestStop('runner_error');
    report.status = 'runner_error'; report.error = String(error.message || error).slice(0, 1000); report.finishedAt = new Date().toISOString();
    if (fs.existsSync(options.outputDir)) writeJson(reportPath, report);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    try {
      for (const service of [research, cases, collection, hub, projectHub]) { try { service?.dispose(); } catch {} }
      await Promise.race([Promise.allSettled([...executing]), delay(1500)]);
    } finally { release(); }
  }
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    process.stdout.write('node scripts/run-project-research.cjs --data-dir <绝对现有数据目录> --output-dir <绝对输出目录> [--agent=deepseek] [--revalidate=<既有任务编号>]\n'); return;
  }
  const options = argumentsFor(process.argv.slice(2));
  if (!process.versions.electron) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
    const executable = fs.existsSync(bundled) ? bundled : require('electron');
    const child = require('node:child_process').spawn(executable, [__filename, ...process.argv.slice(2)], { env, cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
    process.once('SIGINT', () => child.kill('SIGINT')); process.once('SIGTERM', () => child.kill('SIGTERM'));
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }); }); return;
  }
  const { app, nativeImage } = require('electron');
  app.setPath('userData', path.join(options.outputDir, '.runner-profile')); app.disableHardwareAcceleration();
  await app.whenReady(); let exitCode = 0;
  try { await run(options, nativeImage); exitCode = process.exitCode || 0; }
  catch (error) { emit(null, 'runner_error', String(error.message || error).slice(0, 300)); exitCode = 1; }
  finally { app.exit(exitCode); }
}

if (process.versions.electron || require.main === module) main().catch(error => { emit(null, 'runner_error', String(error.message || error).slice(0, 300)); process.exitCode = 1; });
module.exports = { argumentsFor, run };
