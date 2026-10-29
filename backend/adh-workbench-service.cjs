'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { fetchPublicPage, validatePublicUrl } = require('./public-page.cjs');
const { exportCaseBenchmarkPresentation } = require('./research-presentation.cjs');
const { exportResearchAnalysisPage, selectResearchImages } = require('./research-analysis-page.cjs');
const { searchPublicWeb } = require('./public-search.cjs');
const { AdhCollaboration } = require('./adh-collaboration.cjs');
const { AdhAgentSettings, SETTINGS_ACTIONS } = require('./adh-agent-settings.cjs');
// Keep the workbench usable while an optional skill-sharing update is incomplete.
let TeamSkillLibrary;
try { ({ TeamSkillLibrary } = require('./team-skill-library.cjs')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND' || fs.existsSync(path.join(__dirname, 'team-skill-library.cjs'))) throw error; }

const array = value => Array.isArray(value) ? value : [];
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const requestedTemplate = value => {
  const raw = typeof value === 'string' ? value : '';
  const editorial = Math.max(raw.lastIndexOf('杂志'), raw.lastIndexOf('editorial'), raw.lastIndexOf('暗色'));
  const brief = Math.max(raw.lastIndexOf('简报'), raw.lastIndexOf('brief'));
  return editorial >= 0 && editorial > brief ? 'editorial' : brief >= 0 ? 'brief' : '';
};
const clone = value => JSON.parse(JSON.stringify(value));
const fault = (code, message) => Object.assign(new Error(message), { code });
const terminal = new Set(['complete', 'partial', 'failed', 'interrupted', 'cancelled']);

class AdhWorkbenchService extends EventEmitter {
  constructor({ backend, hub, projectHub, cases, research, images, shell, nativeImage, fetchPage = fetchPublicPage, searchWeb = searchPublicWeb, beforeExternalDispatch = async () => {}, agentPairing, assertLocalAgentSettings = () => {}, clipboard, gatewayStatus, setGatewayEnabled, skillSecrets, teamSkills }) {
    super(); Object.assign(this, { backend, hub, projectHub, cases, research, images, shell, nativeImage, fetchPage, searchWeb, beforeExternalDispatch, agentPairing, assertLocalAgentSettings, clipboard, gatewayStatus, setGatewayEnabled });
    this.sessions = new Map(); this.root = path.join(backend.dataDir, 'adh-artifacts'); this.server = null; this.connection = null;
    backend.mutate(store => { store.adhArtifacts ||= []; return true; });
    this.collaboration = new AdhCollaboration(this);
    this.agentSettings = new AdhAgentSettings(this);
    this.teamSkills = teamSkills || (TeamSkillLibrary ? new TeamSkillLibrary({ dataDir: backend.dataDir, ...skillSecrets, getIdentity: () => {
      const member = backend.store.members.find(item => item.id === backend.store.settings.currentMemberId && item.projectId === backend.projectId());
      return { id: member?.id || backend.store.settings.currentMemberId || 'local-designer', name: member?.name || '本机设计师', role: member?.role || backend.store.settings.currentRole || 'designer' };
    } }) : null);
  }
  projectId() { return this.backend.projectId(); }
  session(id) {
    if (typeof id !== 'string' || !id || id.length > 200 || /[\x00-\x1f]/.test(id)) throw fault('INVALID_SESSION', '请先在 ADH 新建或打开一个会话。');
    let value = this.sessions.get(id);
    if (!value) { value = { id, projectId: this.projectId(), selectedCaseIds: [], executorId: 'adh', executorIds: [], presentationTemplate: this.backend.store.settings.casePresentationTemplate === 'editorial' ? 'editorial' : 'brief', revision: 0 }; this.sessions.set(id, value); }
    return value;
  }
  assertScope(payload) {
    const session = this.session(payload.sessionId), current = this.projectId();
    if (payload.projectId && payload.projectId !== current || session.projectId !== current) throw fault('PROJECT_CHANGED', '当前项目已切换，请在 ADH 新发一条指令，重新带入当前项目。');
    return session;
  }
  selectCases(ids, projectId) {
    if (!Array.isArray(ids) || ids.length > 50) throw fault('INVALID_CASES', '一次最多选择 50 个案例。');
    return [...new Set(ids)].map(id => {
      if (typeof id !== 'string' || !this.backend.store.cases.some(item => item.id === id && item.projectId === projectId)) throw fault('CASE_SCOPE', '所选案例不属于当前项目，请重新选择。');
      return id;
    });
  }
  catalog(projectId, ids) {
    return this.backend.store.cases.filter(item => item.projectId === projectId && (!ids || ids.includes(item.id))).slice(0, 100).map(item => ({
      id: item.id, name: item.name, type: item.typeLabel || item.type || '', area: item.research?.fields?.area?.value || item.area || null,
      location: item.location || item.research?.fields?.location?.value || null, tags: array(item.tags).slice(0, 8),
      summary: text(item.latestProjectResearch?.summary || item.notes || item.description, 240), sourceUrl: item.sourceUrl,
      imageCount: this.images.list({ projectId, caseId: item.id }).length,
      verification: item.research?.status || 'not_reviewed' }));
  }
  safeContext(projectId) {
    const source = this.projectHub.context(projectId), result = {};
    for (const key of ['projectId', 'project', 'tasks', 'decisions', 'risks', 'truncated', 'revision']) if (source[key] !== undefined) result[key] = source[key];
    return result;
  }
  snapshot(session) {
    const context = this.safeContext(session.projectId), projectId = session.projectId;
    const externalRuns = this.hub.state.runs.filter(item => item.projectId === projectId && item.adhSessionId === session.id).slice(-40).map(item => ({ id: item.id, ...this.collaboration.task(item) }));
    const executors = [{ id: 'adh', label: 'ADH Agent', internal: true }, ...this.hub.snapshot(projectId).connections.filter(item => (['cli', 'acp'].includes(item.mode) && item.command) || item.mode === 'openclaw-http' && item.endpoint).map(item => ({ id: item.id, label: item.label, mode: item.mode, internal: false }))];
    return { project: context.project, context, selectedCaseIds: [...session.selectedCaseIds], presentationTemplate: session.presentationTemplate, presentationPagesPerCase: { min: 1, max: 3 }, executorId: session.executorId, executorIds: [...array(session.executorIds)], workflowAction: session.workflowAction || null, executors, externalExecutors: executors.filter(item => !item.internal), collaborationBatches: this.collaboration.batches(projectId, session.id),
      cases: this.catalog(projectId), research: this.research.list(projectId).filter(item => item.origin === 'adh' && item.adhSessionId === session.id).slice(0, 12).reverse().map(item => ({ id: item.id, title: item.title, status: item.status, origin: item.origin, sessionId: item.adhSessionId, caseIds: array(item.cases).map(value => value.caseId).filter(Boolean), imageCount: array(item.assetIds).length })),
      artifacts: this.backend.store.adhArtifacts.filter(item => item.projectId === projectId && item.sessionId === session.id).slice(-12).map(({ filePath, ...item }) => ({ ...item, type: item.format, title: `${item.title} · ${item.format === 'pptx' ? 'PPT' : '分析页'}` })),
      runs: externalRuns, externalRun: externalRuns[externalRuns.length - 1] || null,
      artifactOpen: session.artifactOpen?.status === 'failed' ? session.artifactOpen : null };
  }
  async handle(payload, { signal } = {}) {
    if (!payload || typeof payload !== 'object') throw fault('INVALID_REQUEST', 'ADH 请求无效。');
    const args = payload.arguments || {}, caller = payload.caller || 'tool', action = payload.action;
    if (typeof action === 'string' && action.startsWith('skill_library_')) return this.handleSkillLibrary(action.slice(14), args, caller);
    if (SETTINGS_ACTIONS.has(action)) return this.agentSettings.handle(payload);
    if (action === 'collaboration_catalog') {
      if (caller !== 'client') throw fault('USER_ACTION_REQUIRED', '请在 ADH 协作目录查看任务。');
      return this.collaboration.catalog();
    }
    if (action === 'collaboration_feed') return this.collaboration.feed(args, caller);
    if (action === 'collaboration_pending') return this.collaboration.pendingOrigins(args, caller);
    if (action === 'collaboration_ack') return this.collaboration.acknowledge(args, caller);
    if (['snapshot', 'prepare_context'].includes(action)) {
      const session = this.session(payload.sessionId), projectId = this.projectId();
      if (payload.projectId && payload.projectId !== projectId) throw fault('PROJECT_CHANGED', '项目已切换，请重新打开当前项目。');
      if (session.projectId !== projectId) { session.projectId = projectId; session.selectedCaseIds = []; session.executorId = 'adh'; session.executorIds = []; session.presentationTemplate = this.backend.store.settings.casePresentationTemplate === 'editorial' ? 'editorial' : 'brief'; session.artifactOpen = null; session.revision++; }
      if (caller === 'client') {
        if (args.caseIds !== undefined) session.selectedCaseIds = this.selectCases(args.caseIds, projectId);
        if (args.executorId !== undefined) this.setExecutor(session, args.executorId, args.executorIds);
        if (['research', 'presentation'].includes(args.action)) session.pendingWorkflow = args.action;
        const style = requestedTemplate(args.prompt);
        if (style) session.presentationTemplate = style;
      }
      if (args.turnKey !== undefined) {
        const key = String(args.turnKey).slice(0, 100);
        if (key !== session.turnKey) { session.workflowAction = session.pendingWorkflow || null; session.pendingWorkflow = null; session.turnKey = key; }
      }
      return this.snapshot(session);
    }
    const session = this.assertScope(payload), projectId = session.projectId;
    switch (action) {
      case 'select_presentation_template':
        if (caller !== 'client') throw fault('USER_ACTION_REQUIRED', '请在输入框旁选择案例 PPT 风格。');
        if (!['brief', 'editorial'].includes(args.template)) throw fault('INVALID_TEMPLATE', '请选择简报版或杂志版。');
        this.backend.mutate(store => { store.settings.casePresentationTemplate = args.template; return true; });
        session.presentationTemplate = args.template;
        return this.snapshot(session);
      case 'select_executor':
        if (caller !== 'client') throw fault('USER_ACTION_REQUIRED', '请在 ADH 输入框的执行器菜单中选择外部 Agent。');
        this.setExecutor(session, args.executorId, args.executorIds); return this.snapshot(session);
      case 'select_cases':
        if (caller !== 'client') throw fault('USER_ACTION_REQUIRED', '请从案例库选择案例。');
        session.selectedCaseIds = this.selectCases(args.caseIds, projectId); return this.snapshot(session);
      case 'case_catalog': {
        const query = text(args.query, 500).toLowerCase();
        const catalog = this.catalog(projectId, args.caseIds ? this.selectCases(args.caseIds, projectId) : null);
        const words = query.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g) || [];
        const terms = [...new Set(words.flatMap(word => /^[\u4e00-\u9fff]+$/.test(word) && word.length > 3 ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))] : [word]))];
        const ranked = query ? catalog.map(item => { const title = `${item.name} ${item.type}`, body = `${title} ${item.summary} ${array(item.tags).join(' ')}`.toLowerCase(); return { item, score: terms.reduce((sum, term) => sum + (body.includes(term) ? title.includes(term) ? 3 : 1 : 0), 0) }; }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.item) : catalog;
        const fallback = query && !ranked.length;
        return { projectId, cases: (fallback ? catalog : ranked).slice(0, Math.max(1, Math.min(60, Number(args.limit) || 60))), selectedCaseIds: session.selectedCaseIds, ...(fallback ? { note: '关键词未精确匹配，返回本项目案例索引供 ADH 判断，不能据此认定没有合适案例。' } : {}) };
      }
      case 'case_details': {
        if (Array.isArray(args.caseIds)) return { projectId, cases: this.selectCases(args.caseIds, projectId).slice(0, 4).map(caseId => this.caseDetails({ caseId }, projectId)) };
        return this.caseDetails(args, projectId);
      }
      case 'web_search': return this.searchWeb({ query: args.query, limit: args.limit, signal });
      case 'web_read': {
        const sourceUrl = validatePublicUrl(args.url).href, page = await this.fetchPage(sourceUrl, { signal, maxImages: 600, includeSmallImages: true, timeoutMs: 20000 });
        return { sourceUrl, finalUrl: page.finalUrl, title: page.title, text: text(page.text, 45000), truncated: String(page.text || '').length > 45000,
          images: array(page.images).slice(0, 100).map(item => ({ url: item.url, alt: item.alt, contentScope: item.contentScope, context: text(item.context, 180) })), retrievedAt: page.retrievedAt };
      }
      case 'research_archive': {
        const result = args.result || args.research || args;
        const record = await this.research.ingestAdhResult({ projectId, sessionId: session.id, brief: args.brief || args.title || 'ADH 案例调研', result, requestId: args.requestId, signal, selectedCaseIds: session.selectedCaseIds });
        return { researchId: record.id, status: record.status, cases: record.cases, sources: record.sources, references: record.references, imageCount: array(record.assetIds).length,
          images: array(record.images).map(item => ({ id: item.assetId || item.id, caseIds: item.caseIds, width: item.width, height: item.height, sourcePageUrl: item.sourcePageUrl, sourceUrl: item.sourceUrl })), warnings: record.warnings, errors: record.errors };
      }
      case 'presentation_create': return this.createPresentation(args, session, signal);
      case 'external_dispatch': return this.dispatchExternal(args, session, caller);
      case 'external_dispatch_many': return this.collaboration.dispatch(args, session, caller);
      case 'external_status': {
        if (!args.runId) return { runs: this.hub.state.runs.filter(item => item.projectId === projectId && item.adhSessionId === session.id).slice(-10).map(item => ({ id: item.id, status: item.status, connectionId: item.connectionId, error: item.error })) };
        const run = this.hub.state.runs.find(item => item.id === args.runId && item.projectId === projectId && item.adhSessionId === session.id);
        if (!run) throw fault('RUN_SCOPE', '此任务不属于当前 ADH 会话。');
        return { runId: run.id, status: run.status, output: text(run.output, 40000), error: run.error || null };
      }
      case 'artifact_open': {
        if (caller !== 'client') throw fault('USER_ACTION_REQUIRED', '请点击 ADH 成果栏打开文件。');
        const artifact = this.backend.store.adhArtifacts.find(item => item.id === args.artifactId && item.projectId === projectId && item.sessionId === session.id);
        if (!artifact) throw fault('ARTIFACT_SCOPE', '此成果不属于当前项目与会话。');
        const resolved = fs.realpathSync(artifact.filePath), root = fs.realpathSync(this.root), relative = path.relative(root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw fault('ARTIFACT_PATH', '成果文件位置无效。');
          if (session.artifactOpen?.artifactId === artifact.id && session.artifactOpen.status === 'opening') return { opened: false, opening: true, message: session.artifactOpen.message };
          const opening = session.artifactOpen = { artifactId: artifact.id, status: 'opening', message: '已交给系统打开，请完成系统提示。' };
          // Windows may keep openPath pending while its app chooser is visible.
          // Acknowledging that handoff keeps the composer responsive without claiming the file opened.
          const launched = Promise.resolve().then(() => this.shell.openPath(resolved)).then(error => {
            opening.status = error ? 'failed' : 'opened';
            opening.message = error ? '本机未能打开此成果文件，请检查是否安装了相应应用。' : '';
            if (session.artifactOpen === opening) this.emit('changed', projectId);
            return error ? { opened: false, error: opening.message } : { opened: true };
          }, () => {
            opening.status = 'failed'; opening.message = '本机未能打开此成果文件，请检查是否安装了相应应用。';
            if (session.artifactOpen === opening) this.emit('changed', projectId);
            return { opened: false, error: opening.message };
          });
          let timer;
          try {
            const result = await Promise.race([launched, new Promise(resolve => { timer = setTimeout(() => resolve({ opened: false, opening: true, message: opening.message }), 1200); })]);
            if (result.error) throw fault('ARTIFACT_OPEN_FAILED', result.error);
            return result;
          } finally { clearTimeout(timer); }
      }
      default: throw fault('UNKNOWN_ACTION', '未知的 ADH 项目操作。');
    }
  }
  async handleSkillLibrary(action, args, caller) {
    if (caller !== 'skill-library-ui') throw fault('USER_ACTION_REQUIRED', '请在 AI Hub 技能中心管理共享技能。');
    const library = this.teamSkills;
    if (!library) throw fault('SKILL_LIBRARY_UNAVAILABLE', '共享技能组件尚未安装完成，请完成更新后重启 AI Hub。');
    switch (action) {
      case 'catalog': {
        const local = library.list(); let remote = [], remoteError;
        if (library.status().remote.connected) {
          try { remote = await library.listRemote(); }
          catch (error) { remoteError = error.message || '团队主机暂不可连接，请稍后刷新。'; }
        }
        return { teamSkills: [...local.map(skill => ({ ...skill, origin: 'local' })), ...remote.map(skill => ({ ...skill, origin: 'remote', canUnshare: false }))], sharing: { ...library.status(), ...(remoteError ? { remoteError } : {}) } };
      }
      case 'body': return { skill: args.origin === 'remote' ? await library.getRemote(args.id) : library.get(args.id) };
      case 'share': return { skill: library.share({ skill: args.skill }) };
      case 'unshare': library.unshare(args.id); return { removed: true };
      case 'server-start': await library.start({}); return { sharing: library.status() };
      case 'server-stop': await library.stop(); return { sharing: library.status() };
      case 'connect': await library.connect({ url: args.url, token: args.token }); return { sharing: library.status() };
      case 'disconnect': library.disconnect(); return { sharing: library.status() };
      default: throw fault('UNKNOWN_ACTION', '未知的技能共享操作。');
    }
  }
  setExecutor(session, id, ids) {
    let executorIds = [];
    if (id === 'collaboration') {
      executorIds = this.collaboration.connections(ids || []).map(item => item.id);
    } else if (id !== 'adh') {
      const connection = this.hub.connection(id);
      if (!['cli', 'acp', 'openclaw-http'].includes(connection.mode)) throw fault('INVALID_EXECUTOR', '此 Agent 暂不支持主动派单。');
      executorIds = [id];
    }
    if (session.executorId === id && JSON.stringify(array(session.executorIds)) === JSON.stringify(executorIds)) return;
    session.executorId = id;
    session.executorIds = executorIds;
    session.revision++;
  }
  caseDetails(args, projectId) {
    const id = this.selectCases([args.caseId], projectId)[0], item = this.backend.store.cases.find(value => value.id === id);
    let body = '';
    try { const root = fs.realpathSync(this.cases.pagesDir), target = fs.realpathSync(path.join(root, `${id}.txt`)); if (path.dirname(target) === root) body = fs.readFileSync(target, 'utf8'); } catch {}
    const start = Math.max(0, Math.min(150000, Number(args.offset) || 0)), records = this.images.list({ projectId, caseId: id });
    const latest = item.latestProjectResearch;
    return { projectId, case: { ...this.catalog(projectId, [id])[0], fields: latest?.fields || item.research?.fields || {}, evidence: latest?.evidence || item.research?.evidence || [], sources: latest?.sources || item.research?.sources || [], references: latest?.references || item.projectReferences || [] },
      text: body.slice(start, start + 35000), offset: start, hasMore: body.length > start + 35000,
      images: records.map(asset => {
        const stored = this.images.getAsset(asset.id);
        return { id: asset.id, name: asset.name, width: asset.width, height: asset.height, sourceUrl: asset.sourceUrl, sourcePageUrl: asset.sourcePageUrl, filePath: stored.path };
      }) };
  }
  async createPresentation(args, session, signal) {
    signal?.throwIfAborted(); const projectId = session.projectId;
    const caseIds = args.caseIds ? this.selectCases(args.caseIds, projectId) : session.selectedCaseIds;
    let research = args.researchId ? this.research.get(args.researchId) : this.research.list(projectId).find(item => item.origin === 'adh' && item.adhSessionId === session.id && terminal.has(item.status));
    if (research && research.projectId !== projectId) throw fault('RESEARCH_SCOPE', '调研结果不属于当前项目。');
    if (args.researchId && research && (research.origin !== 'adh' || research.adhSessionId !== session.id)) throw fault('RESEARCH_SESSION', '这是其他会话的调研记录。请通过 caseIds 深读案例，在本次 ADH 对话中提出逐页方案。');
    if (research && !terminal.has(research.status)) throw fault('RESEARCH_RUNNING', '请等待案例和图片归档结束。');
    if (!research && !caseIds.length) throw fault('NO_CASES', '请先读取案例索引，选择适合当前项目的案例。');
    const chosen = caseIds.length ? caseIds : array(research?.cases).map(item => item.caseId).filter(Boolean);
    const saved = chosen.map(id => this.backend.store.cases.find(item => item.id === id && item.projectId === projectId)).filter(Boolean);
    const cases = saved.map(item => ({ caseId: item.id, name: item.name, summary: text(item.latestProjectResearch?.summary || item.notes || item.description, 6000), primarySourceUrl: item.sourceUrl, sourceUrls: [item.sourceUrl], fields: item.latestProjectResearch?.fields || item.research?.fields || {}, sources: item.latestProjectResearch?.sources || item.research?.sources || [{ url: item.sourceUrl }], references: item.latestProjectResearch?.references || item.projectReferences || [] }));
    if (args.slides !== undefined && (!Array.isArray(args.slides) || args.slides.length > 24 || args.slides.some(item => !item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300 || item.body !== undefined && (typeof item.body !== 'string' || item.body.length > 5000) || item.imageAssetIds !== undefined && !Array.isArray(item.imageAssetIds) || item.sourceUrls !== undefined && !Array.isArray(item.sourceUrls)))) throw fault('INVALID_SLIDES', '请提交最多 24 页的逐页方案，标题与正文用文字，图片和来源用数组。');
    const slideReferences = array(args.slides).filter(item => /参考|借鉴|建议|策略|启示|应用|对比/.test(item.title || '')).map(item => ({ point: item.title, application: item.body, sourceUrls: item.sourceUrls, limitation: 'ADH 分析建议，适用条件需人工复核。' }));
    const references = array(args.references).length ? args.references : slideReferences.length ? slideReferences : research?.references;
    if (!array(references).length && !array(args.slides).length) throw fault('ANALYSIS_REQUIRED', '请由 ADH 提炼项目参考点后生成案例 PPT。');
    const assets = new Map(); for (const id of chosen) for (const item of this.images.list({ projectId, caseId: id })) assets.set(item.id, this.images.getAsset(item.id));
    const requestedIds = [...new Set([...array(args.imageAssetIds), ...array(args.slides).flatMap(item => array(item.imageAssetIds))])];
    for (const id of requestedIds) if (!assets.has(id)) throw fault('IMAGE_SCOPE', 'ADH 选择的图片不属于本次案例。');
    if (assets.size && !array(args.slides).some(item => array(item.imageAssetIds).length)) throw fault('IMAGE_SELECTION_REQUIRED', '案例已有高清图，请在逐页方案的 imageAssetIds 中选择适合的图片后再生成。');
    const record = { ...(research || {}), title: text(args.title || '项目案例研究', 120), origin: 'adh', adhSessionId: session.id, projectId, cases,
      sources: research?.sources || cases.flatMap(item => item.sources), references: array(references), summary: text(args.summary || research?.summary, 10000),
      projectSnapshot: { ...this.safeContext(projectId), researchProfile: this.safeContext(projectId).project?.researchProfile },
      slidePlan: array(args.slides).slice(0, 30), archivedImageCount: assets.size };
    const selectedPictures = requestedIds.length ? requestedIds.slice(0, 96).map(id => assets.get(id)) : selectResearchImages(record, [...assets.values()], 6);
    const format = args.format === 'html' ? 'html' : 'pptx', template = session.presentationTemplate || (args.template === 'editorial' ? 'editorial' : 'brief'), id = `artifact_${crypto.randomUUID()}`;
    const pictures = format === 'html' ? selectResearchImages(record, selectedPictures, 3) : selectedPictures;
    const directory = path.join(this.root, projectId.replace(/[^a-z0-9_-]/ig, '_'), id); fs.mkdirSync(directory, { recursive: true });
    const filename = `${text(args.title || '案例研究', 70).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.${format}`, filePath = path.join(directory, filename);
    const project = this.backend.store.projects.find(item => item.id === projectId);
    const result = await (format === 'html' ? exportResearchAnalysisPage : exportCaseBenchmarkPresentation)({ research: record, project, cases, images: pictures, outputPath: filePath, template, allowedImageRoots: [this.images.originalsDir], convertImage: bytes => this.nativeImage.createFromBuffer(bytes).toPNG() });
    signal?.throwIfAborted();
    const artifact = { id, projectId, sessionId: session.id, researchId: research?.id || null, origin: 'adh', title: record.title, format, template: format === 'pptx' ? template : null, filePath, filename, slideCount: result.slideCount, imageCount: result.imageCount, createdAt: Date.now() };
    this.backend.mutate(store => { store.adhArtifacts.push(artifact); return true; });
    this.emit('changed', projectId);
    return { artifactId: id, title: record.title, filename, format, template: format === 'pptx' ? template : null, filePath, slideCount: result.slideCount, imageCount: result.imageCount, warnings: result.warnings || [], message: '成果已保存在当前项目，可从 ADH 成果栏打开。' };
  }
  async dispatchExternal(args, session, caller) {
    const connectionId = args.connectionId || session.executorId;
    if (!connectionId || connectionId === 'adh' || caller !== 'client' && connectionId !== session.executorId) throw fault('USER_ACTION_REQUIRED', '请先在执行器菜单明确选择外部 Agent，再发起协作。');
    if (caller === 'client') this.setExecutor(session, connectionId);
    const result = await this.collaboration.dispatch({ ...args, connectionId }, session, caller, { single: true });
    return { ...result.tasks[0], batchId: result.batchId, message: result.message };
  }
  async start() {
    if (this.server) return this.connection;
    try { await this.teamSkills?.restore(); } catch { /* Sharing status retains the recovery error; projects remain available. */ }
    const token = crypto.randomBytes(32).toString('hex');
    const server = http.createServer(async (req, res) => {
      const send = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
      const authorization = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${token}`);
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.origin || authorization.length !== expected.length || !crypto.timingSafeEqual(authorization, expected)) return send(403, { ok: false, error: { code: 'FORBIDDEN', message: 'ADH 项目连接无效。' } });
      if (req.method !== 'POST' || req.url !== '/adh-workbench') return send(404, { ok: false });
      const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fault('TOO_LARGE', '请求超过允许范围。'); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')), result = await this.handle(payload, { signal: controller.signal });
        send(200, SETTINGS_ACTIONS.has(payload.action) ? { ok: true, result } : { ok: true, ...result });
      } catch (error) { send(400, { ok: false, error: { code: error.code || 'ACTION_FAILED', message: text(error.message, 800) } }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server; this.connection = { endpoint: `http://127.0.0.1:${server.address().port}/adh-workbench`, token }; return this.connection;
  }
  dispose() { this.collaboration.dispose(); void this.teamSkills?.stop({ preserveEnabled: true }); this.server?.close(); this.server = null; this.connection = null; this.sessions.clear(); }
}
module.exports = { AdhWorkbenchService };
