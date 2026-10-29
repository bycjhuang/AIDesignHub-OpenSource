import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeHit, KnowledgeImportResult, KnowledgeProject, KnowledgeSource, KnowledgeSummary } from '../../packages/contracts/desktop';
import { DEFAULT_EMBEDDING_MODEL, LocalEmbeddingService, type KnowledgeEmbedder } from './embedding';
import { parseKnowledgeFile, SUPPORTED_KNOWLEDGE_EXTENSIONS, type ParsedSection } from './parser';
import { combineKnowledgeMatches, isValidKnowledgeVector, keywordSearch } from './search';
import { AnythingLlmKnowledgeEngine, type KnowledgeEngineChunk, type KnowledgeEngineOptions } from './anythingllm';
import { readKnowledgeCorpusPage, type KnowledgeCorpusPage } from './corpus';
import { KNOWLEDGE_PARSER_REVISION } from './officeParser';
export type { KnowledgeCorpusPage, KnowledgeCorpusSource, KnowledgeCorpusSegment } from './corpus';

type StoredProject = Omit<KnowledgeProject, 'sourceCount' | 'chunkCount'>;
type StoredSource = KnowledgeSource & { filePath: string; fingerprint: string; parsedSections?: ParsedSection[] };
type StoredChunk = KnowledgeEngineChunk;
type KnowledgeStateV2 = { version: 2; retrievalEngine?: 'anythingllm'; updatedAt: number | null; projects: StoredProject[]; sources: StoredSource[]; chunks: StoredChunk[] };
type LegacyStateV1 = { version: 1; updatedAt: number | null; sources: Array<Omit<StoredSource, 'projectId'>>; chunks: Array<Omit<StoredChunk, 'projectId'>> };

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FOLDER_FILES = 2_000;
const MAX_PROJECTS = 100;

function publicSource(source: StoredSource): KnowledgeSource {
  const { filePath: _filePath, fingerprint: _fingerprint, parsedSections: _parsedSections, ...result } = source;
  return result;
}

export class KnowledgeService {
  private readonly statePath: string;
  private readonly embedder: KnowledgeEmbedder;
  private readonly engine: AnythingLlmKnowledgeEngine;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private state: KnowledgeStateV2 = { version: 2, updatedAt: null, projects: [], sources: [], chunks: [] };

  constructor(private readonly dataDirectory: string, embedder?: KnowledgeEmbedder, engineOptions?: KnowledgeEngineOptions) {
    this.statePath = path.join(dataDirectory, 'knowledge-index.json');
    this.embedder = embedder ?? new LocalEmbeddingService(dataDirectory);
    this.engine = new AnythingLlmKnowledgeEngine(dataDirectory, this.embedder, engineOptions);
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    let original: Buffer | undefined;
    try {
      original = await readFile(this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (original) {
      let parsed: KnowledgeStateV2 | LegacyStateV1;
      try { parsed = JSON.parse(original.toString('utf8')); }
      catch (error) { throw new Error('知识库索引 JSON 损坏，原索引未覆盖，请从备份恢复。', { cause: error }); }
      const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
      if (!parsed || !Array.isArray(parsed.sources) || !Array.isArray(parsed.chunks)
        || parsed.sources.some((source) => !source || !validId(source.id) || typeof source.name !== 'string' || typeof source.filePath !== 'string'
          || (source.parsedSections !== undefined && (!Array.isArray(source.parsedSections) || source.parsedSections.some((section) => !section || typeof section.locator !== 'string' || typeof section.text !== 'string'))))
        || parsed.chunks.some((chunk) => !chunk || !validId(chunk.id) || !validId(chunk.sourceId) || typeof chunk.text !== 'string' || !parsed.sources.some((source) => source.id === chunk.sourceId))
        || new Set(parsed.sources.map((source) => source.id)).size !== parsed.sources.length
        || new Set(parsed.chunks.map((chunk) => chunk.id)).size !== parsed.chunks.length) {
        throw new Error('知识库索引格式损坏，原索引已保留，请从备份恢复。');
      }
      if (parsed?.version === 2 && Array.isArray(parsed.projects) && Array.isArray(parsed.sources) && Array.isArray(parsed.chunks)) {
        if (parsed.projects.some((project) => !project || !validId(project.id) || typeof project.name !== 'string')
          || new Set(parsed.projects.map((project) => project.id)).size !== parsed.projects.length) throw new Error('知识库项目索引格式损坏，原索引已保留。');
        if (parsed.sources.some((source) => !parsed.projects.some((project) => project.id === source.projectId))
          || parsed.chunks.some((chunk) => !parsed.sources.some((source) => source.id === chunk.sourceId && source.projectId === chunk.projectId))) throw new Error('知识库索引关联损坏，原索引已保留。');
        this.state = parsed;
      } else if (parsed?.version === 1 && Array.isArray(parsed.sources) && Array.isArray(parsed.chunks)) {
        const project = this.newProject('默认知识库', '从旧版桌面知识索引自动迁移');
        this.state = {
          version: 2,
          updatedAt: parsed.updatedAt,
          projects: [project],
          sources: parsed.sources.map((source) => ({ ...source, projectId: project.id })),
          chunks: parsed.chunks.map((chunk) => ({ ...chunk, projectId: project.id })),
        };
      } else throw new Error('知识库索引版本无法识别，原索引已保留。');
      if (this.state.retrievalEngine !== 'anythingllm') {
        await this.backupOriginal(original, parsed.version);
        this.state.retrievalEngine = 'anythingllm';
        await this.persist();
      }
    }
    if (!this.state.projects.length) {
      this.state.projects.push(this.newProject('我的第一个知识库', '可上传项目资料并基于资料问答'));
      await this.persist();
    }
    await this.engine.initialize();
  }

  private async backupOriginal(original: Buffer, version: number) {
    const directory = path.join(this.dataDirectory, 'knowledge-migrations', 'anythingllm-v1');
    await mkdir(directory, { recursive: true });
    const backupPath = path.join(directory, 'knowledge-index.before-anythingllm.json');
    const digest = createHash('sha256').update(original).digest('hex');
    try { await writeFile(backupPath, original, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (createHash('sha256').update(await readFile(backupPath)).digest('hex') !== digest) throw new Error('首次迁移备份与当前索引不一致；为保护资料，未覆盖备份或索引。');
    }
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = { version: 1, target: 'anythingllm', upstreamCommit: '3e4f9411b67f2dd7fa9fc6f2b95dfacbda0633ba', originalVersion: version, backup: path.basename(backupPath), sha256: digest, createdAt: new Date().toISOString() };
    try { await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (JSON.parse(await readFile(manifestPath, 'utf8')).sha256 !== digest) throw new Error('知识库迁移备份校验失败，原索引已保留。');
    }
  }

  private mutate<T>(operation: () => Promise<T>, rollback = true): Promise<T> {
    const action = async () => { const previous = rollback ? structuredClone(this.state) : this.state; try { return await operation(); } catch (error) { this.state = previous; throw error; } };
    const result = this.operationQueue.then(action, action); this.operationQueue = result.then(() => undefined, () => undefined); return result;
  }

  summary(): KnowledgeSummary {
    return {
      projectCount: this.state.projects.length,
      sourceCount: this.state.sources.length,
      indexedSourceCount: this.state.sources.filter((source) => source.status === 'indexed').length,
      chunkCount: this.state.chunks.length,
      vectorizedChunkCount: this.state.chunks.filter((chunk) => chunk.embeddingModel === this.embedder.model && isValidKnowledgeVector(chunk.embedding)).length,
      embeddingStatus: this.embedder.status,
      embeddingModel: this.embedder.model || DEFAULT_EMBEDDING_MODEL,
      retrievalEngine: 'anythingllm', retrievalStatus: this.engine.status, retrievalError: this.engine.error,
      updatedAt: this.state.updatedAt,
    };
  }

  listProjects() {
    const projects = this.state.projects.map((project) => this.publicProject(project)).sort((a, b) => b.updatedAt - a.updatedAt);
    return { projects, summary: this.summary() };
  }

  async createProject(input: { name: string; description?: string }) {
    return this.mutate(async () => {
    if (this.state.projects.length >= MAX_PROJECTS) throw new Error(`最多创建 ${MAX_PROJECTS} 个知识库项目。`);
    const name = this.validateProjectName(input.name);
    const project = this.newProject(name, String(input.description || '').trim().slice(0, 500));
    this.state.projects.unshift(project);
    await this.persist();
    return this.publicProject(project);
    });
  }

  async updateProject(projectId: string, input: { name?: string; description?: string }) {
    return this.mutate(async () => {
    const project = this.requireProject(projectId);
    if (input.name !== undefined) project.name = this.validateProjectName(input.name);
    if (input.description !== undefined) project.description = input.description.trim().slice(0, 500);
    project.updatedAt = Date.now();
    await this.persist();
    return this.publicProject(project);
    });
  }

  async removeProject(projectId: string) {
    return this.mutate(async () => {
    await this.engine.removeProject(projectId);
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter((project) => project.id !== projectId);
    this.state.sources = this.state.sources.filter((source) => source.projectId !== projectId);
    this.state.chunks = this.state.chunks.filter((chunk) => chunk.projectId !== projectId);
    const removed = before !== this.state.projects.length;
    if (removed && !this.state.projects.length) this.state.projects.push(this.newProject('我的第一个知识库', '可上传项目资料并基于资料问答'));
    if (removed) await this.persist();
    return { removed, summary: this.summary() };
    });
  }

  list(projectId?: string) {
    const resolvedProjectId = projectId || this.state.projects[0]?.id;
    return {
      sources: this.state.sources.filter((source) => !resolvedProjectId || source.projectId === resolvedProjectId).map(publicSource).sort((a, b) => b.indexedAt - a.indexedAt),
      summary: this.summary(),
    };
  }

  async readCorpusPage(projectId?: string, cursor?: string, pageSize?: number): Promise<KnowledgeCorpusPage> {
    return this.mutate(async () => {
      const project = this.requireProject(projectId || this.state.projects[0]?.id || '');
      return readKnowledgeCorpusPage(project.id, this.state.sources, this.state.chunks, cursor, pageSize);
    }, false);
  }

  async reindexProject(projectId?: string): Promise<KnowledgeImportResult> {
    return this.mutate(async () => {
      const project = this.requireProject(projectId || this.state.projects[0]?.id || '');
      const paths = this.state.sources.filter((source) => source.projectId === project.id).map((source) => source.filePath);
      return this.importFiles(project.id, paths, true);
    });
  }

  async addFiles(projectId: string | undefined, filePaths: string[]): Promise<KnowledgeImportResult> {
    return this.mutate(() => this.importFiles(projectId, filePaths));
  }
  private async importFiles(projectId: string | undefined, filePaths: string[], forceReparse = false): Promise<KnowledgeImportResult> {
    const project = this.requireProject(projectId || this.state.projects[0]?.id || '');
    const added: KnowledgeSource[] = [];
    const skipped: KnowledgeImportResult['skipped'] = [];
    for (const filePath of [...new Set(filePaths)].slice(0, MAX_FOLDER_FILES)) {
      try { added.push(publicSource(await this.indexFile(project.id, filePath, forceReparse))); }
      catch (error) { skipped.push({ name: path.basename(filePath), reason: error instanceof Error ? error.message : '索引失败' }); }
    }
    if (added.length) { project.updatedAt = Date.now(); await this.persist(); }
    return { added, skipped, summary: this.summary() };
  }

  async addFolder(projectId: string | undefined, folderPath: string): Promise<KnowledgeImportResult> {
    const files: string[] = [];
    await this.collectFolderFiles(path.resolve(folderPath), files, 0);
    return this.addFiles(projectId, files);
  }

  async removeSource(sourceId: string, projectId?: string) {
    return this.mutate(async () => {
    const target = this.state.sources.find((source) => source.id === sourceId && (!projectId || source.projectId === projectId));
    if (target) await this.engine.removeSource(target.projectId, sourceId, this.state.chunks);
    const before = this.state.sources.length;
    this.state.sources = this.state.sources.filter((source) => source.id !== sourceId || (projectId && source.projectId !== projectId));
    const retainedIds = new Set(this.state.sources.map((source) => source.id));
    this.state.chunks = this.state.chunks.filter((chunk) => retainedIds.has(chunk.sourceId));
    const removed = before !== this.state.sources.length;
    if (removed) await this.persist();
    return { removed, summary: this.summary() };
    });
  }

  async search(projectId: string | undefined, query: string, requestedLimit: number): Promise<KnowledgeHit[]> {
    return this.mutate(() => this.searchCurrent(projectId, query, requestedLimit), false);
  }
  private async searchCurrent(projectId: string | undefined, query: string, requestedLimit: number): Promise<KnowledgeHit[]> {
    const resolvedProjectId = projectId || this.state.projects[0]?.id;
    if (!resolvedProjectId || !query.trim()) return [];
    if (!this.state.chunks.some((chunk) => chunk.projectId === resolvedProjectId)) return [];
    let queryVector: number[] = [];
    try { queryVector = await this.embedder.embedQuery(query); } catch { /* Keyword fallback remains available offline. */ }
    const sourceMap = new Map(this.state.sources.filter((source) => source.projectId === resolvedProjectId).map((source) => [source.id, source]));
    const chunks = this.state.chunks.filter((chunk) => chunk.projectId === resolvedProjectId && sourceMap.has(chunk.sourceId));
    const limit = Math.max(1, Math.min(64, Math.round(Number.isFinite(requestedLimit) && requestedLimit ? requestedLimit : 6)));
    const keyword = keywordSearch(chunks.map((chunk) => ({ ...chunk, sourceName: sourceMap.get(chunk.sourceId)!.name })), query);
    const semantic = await this.engine.semanticSearch(resolvedProjectId, chunks, queryVector, limit);
    const matches = combineKnowledgeMatches(keyword, semantic, limit);
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    return matches.map((match) => {
      const chunk = chunkMap.get(match.id)!;
      const source = sourceMap.get(chunk.sourceId)!;
      return { citationId: chunk.id, projectId: resolvedProjectId, sourceId: chunk.sourceId, sourceName: source.name, locator: chunk.locator, text: chunk.text, score: match.score, retrievalMode: match.retrievalMode };
    });
  }

  private publicProject(project: StoredProject): KnowledgeProject {
    return { ...project, sourceCount: this.state.sources.filter((source) => source.projectId === project.id).length, chunkCount: this.state.chunks.filter((chunk) => chunk.projectId === project.id).length };
  }
  private newProject(name: string, description: string): StoredProject { const now = Date.now(); return { id: randomUUID(), name, description, createdAt: now, updatedAt: now }; }
  private validateProjectName(name: string) { const value = String(name || '').trim(); if (!value) throw new Error('请输入知识库名称。'); return value.slice(0, 80); }
  private requireProject(projectId: string) { const project = this.state.projects.find((item) => item.id === projectId); if (!project) throw new Error('知识库项目不存在。'); return project; }

  private async collectFolderFiles(folderPath: string, files: string[], depth: number): Promise<void> {
    if (depth > 12 || files.length >= MAX_FOLDER_FILES) return;
    for (const entry of await readdir(folderPath, { withFileTypes: true })) {
      if (files.length >= MAX_FOLDER_FILES) break;
      if (entry.name.startsWith('.') || ['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      const entryPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) await this.collectFolderFiles(entryPath, files, depth + 1);
      else if (entry.isFile() && SUPPORTED_KNOWLEDGE_EXTENSIONS.has(path.extname(entry.name).slice(1).toLowerCase())) files.push(entryPath);
    }
  }

  private async indexFile(projectId: string, inputPath: string, forceReparse = false): Promise<StoredSource> {
    const filePath = path.resolve(inputPath);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('不是普通文件。');
    if (fileStat.size > MAX_FILE_BYTES) throw new Error('文件超过 64 MB 限制。');
    const extension = path.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_KNOWLEDGE_EXTENSIONS.has(extension)) throw new Error(`暂不支持 .${extension} 文件。`);
    const fingerprint = createHash('sha256').update(filePath.toLocaleLowerCase('en-US')).update(String(fileStat.size)).update(String(fileStat.mtimeMs)).digest('hex');
    const existing = this.state.sources.find((source) => source.projectId === projectId && source.filePath.toLocaleLowerCase('en-US') === filePath.toLocaleLowerCase('en-US'));
    const existingChunks = existing ? this.state.chunks.filter((chunk) => chunk.sourceId === existing.id) : [];
    const existingNeedsRetry = existing
      ? existing.status !== 'indexed' || existingChunks.length === 0 || existingChunks.some((chunk) => chunk.embeddingModel !== this.embedder.model || !isValidKnowledgeVector(chunk.embedding))
        || (['docx', 'xlsx', 'pptx'].includes(extension) && existing.parserRevision !== KNOWLEDGE_PARSER_REVISION)
      : false;
    if (existing?.fingerprint === fingerprint && !existingNeedsRetry && !forceReparse) return existing;
    const id = existing?.id ?? randomUUID();
    const sourceName = existing?.name ?? path.basename(filePath);
    let parsed;
    try { parsed = await parseKnowledgeFile(filePath); }
    catch (error) { parsed = { text: '', sections: [], status: 'metadata-only' as const, warning: error instanceof Error ? error.message : '文件解析失败' }; }
    if (existing && existingChunks.length && !parsed.sections.length) throw new Error(`重新解析失败，已保留原索引。${parsed.warning || '没有解析到正文。'}`);
    const imported = parsed.sections.length ? await this.engine.importSections(projectId, id, sourceName, parsed.sections) : { chunks: [], warning: undefined };
    const chunks = imported.chunks;
    parsed.warning = [parsed.warning, imported.warning].filter(Boolean).join(' ') || undefined;
    if (existing && existingChunks.length && !chunks.length) throw new Error(`重新索引失败，已保留原索引。${parsed.warning || '没有生成正文片段。'}`);
    if (existing) await this.engine.removeSource(projectId, existing.id, existingChunks);
    const source: StoredSource = { id, projectId, filePath, fingerprint, name: sourceName, extension, size: fileStat.size, modifiedAt: fileStat.mtimeMs, indexedAt: Date.now(), chunkCount: chunks.length, status: chunks.length ? 'indexed' : parsed.status, error: parsed.warning, parserRevision: KNOWLEDGE_PARSER_REVISION, parsedSections: parsed.sections };
    this.state.sources = [source, ...this.state.sources.filter((item) => item.id !== id)];
    this.state.chunks = [...this.state.chunks.filter((chunk) => chunk.sourceId !== id), ...chunks];
    this.state.updatedAt = Date.now();
    return source;
  }

  private async persist() {
    this.state.retrievalEngine = 'anythingllm';
    this.state.updatedAt = Date.now();
    const nextPath = `${this.statePath}.next`;
    await writeFile(nextPath, JSON.stringify(this.state), 'utf8');
    await rename(nextPath, this.statePath);
  }
}
