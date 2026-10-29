'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { KnowledgeWorkerClient } = require('./knowledge-engine/client.cjs');
const { answerKnowledge } = require('./knowledge-answer.cjs');

const TYPES = { project: '项目资料', regulation: '规范与技术规定', meeting: '会议与决定', enterprise: '企业设计标准', contract: '合同与商务资料' };
const SUPPORTED = new Set('txt md markdown csv json html htm xml log doc docx ppt pptx xls xlsx pdf png jpg jpeg webp bmp tif tiff'.split(' '));
const ID = /^[a-zA-Z0-9:_-]{1,160}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function json(file, fallback) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  try { return JSON.parse(text); } catch { throw new Error('知识库记录损坏，原记录已保留，请从备份恢复。'); }
}
async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staged = `${file}.${randomUUID()}.next`;
  await fs.writeFile(staged, JSON.stringify(value));
  await fs.rename(staged, file);
}

/** Hub project ownership and legacy-data adapter around the BYCJ local engine. */
class KnowledgeWorkbench {
  constructor({ backend, dataDir = backend?.dataDir, modelService, payloadRoot, nodeExe,
    workerFactory = options => new KnowledgeWorkerClient(options), answer = answerKnowledge } = {}) {
    if (!backend || !dataDir) throw new TypeError('Knowledge workbench requires the Hub backend and data directory');
    this.backend = backend; this.root = path.join(dataDir, 'knowledge-workbench-v1');
    this.modelService = modelService; this.payloadRoot = payloadRoot; this.nodeExe = nodeExe;
    this.workerFactory = workerFactory; this.answer = answer;
    this.contexts = new Map(); this.serial = new Map(); this.active = new Map();
  }

  project(projectId) {
    if (typeof projectId !== 'string' || !ID.test(projectId)) throw new Error('请选择有效的项目。');
    const project = this.backend.store.projects.find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在或已删除。');
    return project;
  }

  async context(projectId) {
    const project = this.project(projectId);
    if (!this.contexts.has(projectId)) {
      const pending = this.openProject(project).catch(error => { this.contexts.delete(projectId); throw error; });
      this.contexts.set(projectId, pending);
    }
    return this.contexts.get(projectId);
  }

  async openProject(project) {
    const directory = path.join(this.root, 'projects', digest(project.id).slice(0, 32));
    await fs.mkdir(directory, { recursive: true });
    const indexFile = path.join(directory, 'knowledge-index.json');
    const migrationFile = path.join(directory, 'hub-migration.json');
    if (!await exists(indexFile)) await this.seedLegacy(project, directory);
    const worker = this.workerFactory({ payloadRoot: this.payloadRoot, nodeExe: this.nodeExe, dataDir: directory });
    await worker.start();
    return { directory, worker, migration: await json(migrationFile, null), projectId: project.id };
  }

  async seedLegacy(project, directory) {
    const documents = this.backend.store.knowledgeDocs.filter(doc => doc.projectId === project.id);
    const now = Date.now();
    const groups = new Map();
    for (const doc of documents) {
      const kind = Object.hasOwn(TYPES, doc.sourceType) ? doc.sourceType : 'project';
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(doc);
    }
    if (!groups.size) groups.set('project', []);
    const state = { version: 2, retrievalEngine: 'anythingllm', updatedAt: now, projects: [], sources: [], chunks: [] };
    for (const [kind, docs] of groups) {
      const libraryId = `adh-${digest(project.id).slice(0, 16)}-${kind}`;
      state.projects.push({ id: libraryId, name: TYPES[kind], description: `来自 ${project.name} 的本机资料`, createdAt: now, updatedAt: now });
      for (const doc of docs) {
        if (!ID.test(doc.id)) throw new Error('原知识资料 ID 无效，未修改原库。');
        const filePath = doc.storedPath || doc.originalPath;
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('原资料缺少本机来源位置，未修改原库。');
        const parts = (doc.chunks || []).filter(chunk => typeof chunk.text === 'string' && chunk.text.trim());
        const info = await fs.stat(filePath).catch(() => null);
        state.sources.push({ id: doc.id, projectId: libraryId, filePath, name: String(doc.name),
          fingerprint: '', extension: String(doc.extension || path.extname(filePath).slice(1)),
          size: info?.size ?? doc.size ?? 0, modifiedAt: info?.mtimeMs ?? doc.updatedAt ?? now,
          indexedAt: doc.importedAt || now, chunkCount: parts.length, status: parts.length ? 'indexed' : 'metadata-only',
          error: [doc.warning, '已保留旧版片段；更新解析后可建立语义索引并处理完整正文。', !info && '原文件暂不可用，已有片段仍保留。'].filter(Boolean).join(' '),
        });
        parts.forEach((part, index) => state.chunks.push({ id: `${doc.id}:${index}`, projectId: libraryId,
          sourceId: doc.id, locator: String(part.locator || '正文'), text: part.text,
          normalizedText: part.text.normalize('NFKC').toLowerCase() }));
      }
    }
    const backup = path.join(this.root, 'migrations', 'hub-original-v1.json');
    await fs.mkdir(path.dirname(backup), { recursive: true });
    if (!await exists(backup)) await fs.writeFile(backup, JSON.stringify(this.backend.store), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const manifest = { version: 1, createdAt: now, projectId: project.id, originalSources: documents.length,
      originalChunks: state.chunks.length, originalStoreSha256: digest(await fs.readFile(backup)),
      originalsRetained: true, reindexRecommended: documents.length > 0 };
    await save(path.join(directory, 'hub-migration.json'), manifest);
    await save(path.join(directory, 'knowledge-index.json'), state);
  }

  async library(context, libraryId) {
    if (typeof libraryId !== 'string' || !ID.test(libraryId)) throw new Error('请选择有效的资料库。');
    const value = await context.worker.request('listProjects', {});
    const library = value.projects.find(item => item.id === libraryId);
    if (!library) throw new Error('资料库不属于当前项目。');
    return library;
  }

  async exclusive(projectId, operation) {
    this.project(projectId);
    const previous = this.serial.get(projectId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.serial.set(projectId, next);
    try { return await next; } finally { if (this.serial.get(projectId) === next) this.serial.delete(projectId); }
  }

  async listLibraries(projectId) {
    const context = await this.context(projectId);
    const result = await context.worker.request('listProjects', {});
    return { libraries: result.projects, summary: result.summary, migration: context.migration };
  }

  async createLibrary(projectId, input) {
    if (!object(input) || typeof input.name !== 'string') throw new Error('请输入资料库名称。');
    return this.exclusive(projectId, async () => (await this.context(projectId)).worker.request('createProject', {
      name: input.name, description: String(input.description || '').slice(0, 500),
    }));
  }

  async updateLibrary(projectId, libraryId, input) {
    return this.exclusive(projectId, async () => {
      const context = await this.context(projectId); await this.library(context, libraryId);
      return context.worker.request('updateProject', { projectId: libraryId,
        ...(typeof input?.name === 'string' ? { name: input.name } : {}),
        ...(typeof input?.description === 'string' ? { description: input.description.slice(0, 500) } : {}) });
    });
  }

  async removeLibrary(projectId, libraryId) {
    return this.exclusive(projectId, async () => {
      const context = await this.context(projectId); await this.library(context, libraryId);
      const { sources } = await context.worker.request('listSources', { projectId: libraryId });
      const result = await context.worker.request('removeProject', { projectId: libraryId });
      const ids = new Set(sources.map(item => item.id));
      this.backend.mutate(store => { store.knowledgeDocs = store.knowledgeDocs.filter(doc => doc.projectId !== projectId || !ids.has(doc.id)); return true; });
      return result;
    });
  }

  async listSources(projectId, libraryId) {
    const context = await this.context(projectId); await this.library(context, libraryId);
    const result = await context.worker.request('listSources', { projectId: libraryId });
    const state = await json(path.join(context.directory, 'knowledge-index.json'), null);
    const origins = await json(path.join(context.directory, 'source-origins.json'), {});
    return { ...result, sources: result.sources.map(source => {
      const record = state?.sources.find(item => item.id === source.id);
      const origin = record && origins[record.filePath];
      return origin ? { ...source, relativePath: origin.relativePath } : source;
    }) };
  }

  async importFiles(projectId, libraryId, filePaths, folderRoot) {
    return this.exclusive(projectId, async () => {
      const context = await this.context(projectId); await this.library(context, libraryId);
      const accepted = []; const skipped = [];
      const originsFile = path.join(context.directory, 'source-origins.json');
      const origins = await json(originsFile, {});
      const index = await json(path.join(context.directory, 'knowledge-index.json'), { sources: [] });
      const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      for (const filePath of [...new Set(filePaths)].slice(0, 2000)) {
        const info = await fs.stat(filePath).catch(() => null);
        if (!info?.isFile() || !SUPPORTED.has(path.extname(filePath).slice(1).toLowerCase()) || info.size > 64 * 1024 * 1024) {
          skipped.push({ name: path.basename(filePath), reason: '文件类型不支持、不可读取或超过 64 MB。' }); continue;
        }
        const existing = index.sources.find(source => source.projectId === libraryId && origins[source.filePath]?.originalPath
          && canonical(origins[source.filePath].originalPath) === canonical(filePath));
        const target = existing?.filePath || path.join(context.directory, 'files', randomUUID(), path.basename(filePath));
        const ownedRoot = path.resolve(context.directory, 'files') + path.sep;
        if (!path.resolve(target).startsWith(ownedRoot)) throw new Error('资料副本位置无效，未覆盖原文件。');
        const previousOrigin = origins[target];
        if (!previousOrigin || previousOrigin.originalSize !== info.size || previousOrigin.originalMtime !== info.mtimeMs || !await exists(target)) {
          await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(filePath, target);
        }
        accepted.push(target);
        origins[target] = { originalPath: filePath, originalSize: info.size, originalMtime: info.mtimeMs,
          relativePath: folderRoot ? path.relative(folderRoot, filePath) : previousOrigin?.relativePath || path.basename(filePath) };
      }
      await save(originsFile, origins);
      const result = await context.worker.request('addFiles', { projectId: libraryId, filePaths: accepted });
      await this.mirror(context, libraryId);
      return { ...result, skipped: [...skipped, ...(result.skipped || [])] };
    });
  }

  async importFolder(projectId, libraryId, folderPath) {
    const files = [];
    async function collect(directory, depth) {
      if (depth > 12 || files.length >= 2000) return;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (files.length >= 2000) break;
        if (entry.name.startsWith('.') || ['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file, depth + 1);
        else if (entry.isFile() && SUPPORTED.has(path.extname(file).slice(1).toLowerCase())) files.push(file);
      }
    }
    await collect(folderPath, 0);
    const result = await this.importFiles(projectId, libraryId, files, folderPath);
    if (files.length >= 2000) result.skipped.push({ name: '文件夹', reason: '本次最多处理 2000 个文件，可能还有未导入资料。' });
    return result;
  }

  async mirror(context, libraryId) {
    const state = await json(path.join(context.directory, 'knowledge-index.json'), null);
    if (!state) return;
    const origins = await json(path.join(context.directory, 'source-origins.json'), {});
    const sources = state.sources.filter(source => source.projectId === libraryId);
    const mapped = sources.map(source => ({ id: source.id, projectId: context.projectId, name: source.name,
      originalPath: origins[source.filePath]?.originalPath || source.filePath, storedPath: source.filePath, extension: source.extension, sourceType: 'project', scope: 'local',
      size: source.size, importedAt: source.indexedAt, updatedAt: source.indexedAt, status: source.status, warning: source.error,
      knowledgeLibraryId: libraryId, sectionCount: source.parsedSections?.length || 0, chunkCount: source.chunkCount,
      chunks: state.chunks.filter(chunk => chunk.sourceId === source.id).map(chunk => ({ locator: chunk.locator, text: chunk.text })) }));
    this.backend.mutate(store => {
      for (const doc of mapped) {
        const existing = store.knowledgeDocs.find(item => item.projectId === context.projectId && item.id === doc.id);
        if (existing) Object.assign(existing, { ...doc, originalPath: existing.originalPath || doc.originalPath,
          sourceType: existing.sourceType || 'project', scope: existing.scope || 'local', importedAt: existing.importedAt || doc.importedAt });
        else store.knowledgeDocs.push(doc);
      }
      return true;
    });
  }

  async reindex(projectId, libraryId) {
    return this.exclusive(projectId, async () => {
      const context = await this.context(projectId); await this.library(context, libraryId);
      const result = await context.worker.request('reindex', { projectId: libraryId }); await this.mirror(context, libraryId); return result;
    });
  }

  async removeSource(projectId, libraryId, sourceId) {
    return this.exclusive(projectId, async () => {
      const context = await this.context(projectId); await this.library(context, libraryId);
      const result = await context.worker.request('removeSource', { sourceId, projectId: libraryId });
      if (result.removed) this.backend.mutate(store => { store.knowledgeDocs = store.knowledgeDocs.filter(doc => doc.id !== sourceId || doc.projectId !== projectId); return true; });
      return result;
    });
  }

  async search(projectId, libraryId, query) {
    if (typeof query !== 'string' || query.length > 20000) throw new Error('检索问题过长。');
    const context = await this.context(projectId); await this.library(context, libraryId);
    const hits = await context.worker.request('search', { projectId: libraryId, query, limit: 12 });
    return { query, hits, summary: await context.worker.request('summary', {}) };
  }

  async searchAll(projectId, query) {
    if (typeof query !== 'string' || query.length > 20000) throw new Error('检索问题过长。');
    const context = await this.context(projectId); const { projects } = await context.worker.request('listProjects', {});
    const matches = [];
    for (const library of projects) matches.push(...await context.worker.request('search', { projectId: library.id, query, limit: 8 }));
    const selected = matches.sort((a, b) => b.score - a.score).slice(0, 8);
    return { query, answer: selected.length ? selected.slice(0, 4).map((hit, index) => `${index + 1}. 《${hit.sourceName}》${hit.locator}：${hit.text.slice(0, 700)}`).join('\n\n') : '当前项目知识库没有检索到相关资料。',
      hits: selected.map(hit => ({ documentId: hit.sourceId, documentName: hit.sourceName, locator: hit.locator,
        excerpt: hit.text.slice(0, 420), score: hit.score, retrievalMode: hit.retrievalMode })) };
  }

  async removeLegacyDocument(projectId, documentId) {
    const context = await this.context(projectId); const state = await json(path.join(context.directory, 'knowledge-index.json'), null);
    const source = state?.sources.find(item => item.id === documentId);
    if (source) return this.removeSource(projectId, source.projectId, documentId);
    return this.backend.mutate(store => {
      const before = store.knowledgeDocs.length;
      store.knowledgeDocs = store.knowledgeDocs.filter(doc => doc.id !== documentId || doc.projectId !== projectId);
      return { removed: before !== store.knowledgeDocs.length };
    });
  }

  modelStatus() { const status = this.modelService?.status?.() || {}; return { configured: !!status.configured, provider: status.provider, model: status.model }; }
  historyFile(context, libraryId) { return path.join(context.directory, 'history', `${digest(libraryId)}.json`); }

  async history(projectId, libraryId) {
    const context = await this.context(projectId); await this.library(context, libraryId);
    return { messages: await json(this.historyFile(context, libraryId), []) };
  }

  async ask(projectId, libraryId, input, owner, onProgress) {
    if (!object(input) || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 20000) throw new Error('请输入问题，最多 20000 字。');
    const requestId = String(input.requestId || '');
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) || this.active.has(requestId)) throw new Error('问答请求标识无效或正在处理。');
    const controller = new AbortController(); this.active.set(requestId, { controller, owner, projectId });
    try {
      return await this.exclusive(projectId, async () => {
        controller.signal.throwIfAborted();
        const context = await this.context(projectId); await this.library(context, libraryId);
        const result = await this.answer({ question: input.question, scope: input.scope, format: input.format,
          libraryId, worker: context.worker, modelService: this.modelService, signal: controller.signal,
          onProgress: progress => onProgress?.({ ...progress, requestId, projectId, libraryId }) });
        controller.signal.throwIfAborted();
        this.active.get(requestId).committing = true;
        onProgress?.({ phase: 'saving', message: '正在保存完整结果…', requestId, projectId, libraryId });
        const exportId = randomUUID();
        await save(path.join(context.directory, 'results', `${exportId}.json`), { version: 1, projectId, libraryId,
          question: input.question, result, createdAt: Date.now() });
        const historyFile = this.historyFile(context, libraryId); const history = await json(historyFile, []);
        const response = { ...result, exportId };
        const { exportInput: _largeInput, ...compact } = response;
        history.push({ id: randomUUID(), role: 'user', content: input.question, createdAt: Date.now() },
          { id: randomUUID(), role: 'assistant', content: String(result.answer || ''), ...compact, createdAt: Date.now() });
        await save(historyFile, history.slice(-60));
        await this.mirror(context, libraryId);
        return compact;
      });
    } finally { this.active.delete(requestId); }
  }

  cancel(requestId, owner) {
    const request = this.active.get(String(requestId));
    if (!request || request.owner !== owner) return { cancelled: false };
    if (request.committing) return { cancelled: false, committing: true };
    request.controller.abort(); return { cancelled: true };
  }

  async exportResult(projectId, libraryId, input) {
    const context = await this.context(projectId); await this.library(context, libraryId);
    if (!object(input) || !/^[0-9a-f-]{36}$/.test(input.exportId) || !['xlsx', 'docx', 'pptx'].includes(input.format)) throw new Error('导出结果或文件类型无效。');
    const artifact = await json(path.join(context.directory, 'results', `${input.exportId}.json`), null);
    if (!artifact || artifact.projectId !== projectId || artifact.libraryId !== libraryId || !artifact.result?.exportInput) throw new Error('完整结果不存在，无法用聊天预览代替导出。');
    return context.worker.request('export', { ...artifact.result.exportInput, format: input.format });
  }

  async sourcePath(projectId, libraryId, sourceId) {
    const context = await this.context(projectId); await this.library(context, libraryId);
    const state = await json(path.join(context.directory, 'knowledge-index.json'), null);
    const source = state?.sources.find(item => item.projectId === libraryId && item.id === sourceId);
    if (!source) throw new Error('资料不属于当前知识库。');
    return source.filePath;
  }

  async dispose() {
    for (const request of this.active.values()) request.controller.abort();
    const contexts = await Promise.allSettled([...this.contexts.values()]);
    await Promise.allSettled(contexts.filter(item => item.status === 'fulfilled').map(item => item.value.worker.close()));
    this.contexts.clear();
  }
}

module.exports = { KnowledgeWorkbench, SUPPORTED, seedTypes: TYPES };
