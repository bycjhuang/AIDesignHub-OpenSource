import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { LanceDb } from '../../vendor/anythingllm/runtime/lance.cjs';
import { TextSplitter } from '../../vendor/anythingllm/runtime/TextSplitter.cjs';
import type { KnowledgeEmbedder } from './embedding';
import type { ParsedSection } from './parser';
import { isValidKnowledgeVector, MIN_SEMANTIC_SIMILARITY, type KnowledgeSearchMatch } from './search';

export type KnowledgeEngineChunk = { id: string; projectId: string; sourceId: string; locator: string; text: string; normalizedText: string; embedding?: number[]; embeddingModel?: string };
export type KnowledgeEngineOptions = { loadNative?: () => Promise<any> };
type VectorRecord = { id: string; values: number[]; metadata: Record<string, any> };
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 80;

/** Executes the pinned AnythingLLM core, with instance-scoped host services. */
export class AnythingLlmKnowledgeEngine {
  status: 'ready' | 'degraded' = 'degraded';
  error: string | undefined;
  private provider: any;
  private nativeLoading?: Promise<any>;
  private queue: Promise<unknown> = Promise.resolve();
  private capture: VectorRecord[] = [];
  private records: Array<{ docId: string; vectorId: string }> = [];

  constructor(private readonly dataDirectory: string, private readonly embedder: KnowledgeEmbedder, private readonly options: KnowledgeEngineOptions = {}) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result;
  }
  private degraded(error: unknown) {
    this.status = 'degraded'; this.error = `AnythingLLM 本地向量引擎不可用，已降级本地全文检索：${error instanceof Error ? error.message : String(error)}`;
  }
  async initialize() { try { await this.getProvider(); } catch (error) { this.degraded(error); } }
  private async getProvider() {
    if (this.provider) return this.provider;
    if (!this.nativeLoading) this.nativeLoading = (async () => {
      const native = await (this.options.loadNative?.() ?? import('@lancedb/lancedb'));
      const provider = new LanceDb({
        lancedb: native, storageDirectory: path.join(this.dataDirectory, 'anythingllm'),
        getEmbeddingEngineSelection: () => ({
          embeddingMaxChunkLength: CHUNK_SIZE, embeddingPrefix: '',
          embedChunks: async (texts: string[]) => {
            const vectors: number[][] = [];
            for (let offset = 0; offset < texts.length; offset += 8) {
              const batch = texts.slice(offset, offset + 8); const result = await this.embedder.embedDocuments(batch);
              if (result.length !== batch.length || result.some((vector) => !isValidKnowledgeVector(vector))) throw new Error('本地模型返回了无效向量。');
              vectors.push(...result);
            }
            if (vectors.some((vector) => vector.length !== vectors[0].length)) throw new Error('本地模型返回了不同维度的向量。');
            return vectors;
          },
        }),
        SystemSettings: { getValueOrFallback: async (input: { label: string }) => input.label === 'text_splitter_chunk_size' ? CHUNK_SIZE : CHUNK_OVERLAP },
        cachedVectorInformation: async () => ({ exists: false }),
        storeVectorResult: async (groups: VectorRecord[][]) => { this.capture.push(...groups.flat()); },
        toChunks: function* (items: unknown[], size: number) { for (let start = 0; start < items.length; start += size) yield items.slice(start, start + size); },
        DocumentVectors: {
          bulkInsert: async (rows: Array<{ docId: string; vectorId: string }>) => { this.records.push(...rows); },
          where: async ({ docId }: { docId: string }) => this.records.filter((row) => row.docId === docId),
        },
        sourceIdentifier: (source: { title?: string; published?: string }) => source.title && source.published ? `title:${source.title}-timestamp:${source.published}` : randomUUID(),
        NativeEmbeddingReranker: class { constructor() { throw new Error('本地知识库未启用重排模型。'); } },
      });
      await provider.connect(); this.provider = provider; this.status = 'ready'; this.error = undefined; return provider;
    })();
    try { return await this.nativeLoading; } finally { this.nativeLoading = undefined; }
  }
  async splitSections(projectId: string, sourceId: string, sections: ParsedSection[]): Promise<KnowledgeEngineChunk[]> {
    const chunks: KnowledgeEngineChunk[] = [];
    for (const section of sections) {
      const splitter = new TextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });
      const texts = await splitter.splitText(section.text) as string[];
      texts.forEach((text, index) => chunks.push({ id: `${sourceId}:chunk:${chunks.length + 1}`, projectId, sourceId, locator: index ? `${section.locator} · 片段 ${index + 1}` : section.locator, text, normalizedText: text.normalize('NFKC').toLocaleLowerCase('zh-CN') }));
    }
    return chunks;
  }
  async importSections(projectId: string, sourceId: string, sourceName: string, sections: ParsedSection[]) {
    return this.serial(async () => {
      const fallback = await this.splitSections(projectId, sourceId, sections);
      const namespace = `bycj_ingest_${randomUUID().replaceAll('-', '_')}`; let provider: any; this.capture = []; this.records = [];
      try {
        provider = await this.getProvider();
        for (const section of sections) {
          const result = await provider.addDocumentToNamespace(namespace, { docId: sourceId, pageContent: section.text, projectId, sourceId, sourceName, locator: section.locator }, null, true);
          if (!result?.vectorized) throw new Error(result?.error || 'AnythingLLM 文档索引失败。');
        }
        const chunks = this.capture.map((record): KnowledgeEngineChunk => ({ id: record.id, projectId, sourceId, locator: String(record.metadata.locator || '正文'), text: record.metadata.text, normalizedText: record.metadata.text.normalize('NFKC').toLocaleLowerCase('zh-CN'), embedding: record.values, embeddingModel: this.embedder.model }));
        if (chunks.length !== fallback.length) throw new Error('AnythingLLM 索引片段数量与文档分段不一致。');
        chunks.forEach((chunk, index) => { chunk.locator = fallback[index].locator; });
        this.status = 'ready'; this.error = undefined; return { chunks, warning: undefined };
      } catch (error) { this.degraded(error); return { chunks: fallback, warning: this.error }; }
      finally {
        if (provider && await provider.hasNamespace(namespace).catch(() => false)) {
          await provider.deleteDocumentFromNamespace(namespace, sourceId).catch(() => undefined);
          const { client } = await provider.connect(); await provider.deleteVectorsInNamespace(client, namespace).catch(() => undefined);
        }
        this.capture = []; this.records = [];
      }
    });
  }
  private projectPrefix(projectId: string) { return `bycj_p_${createHash('sha256').update(projectId).digest('hex').slice(0, 20)}_`; }
  private async synchronize(provider: any, projectId: string, chunks: KnowledgeEngineChunk[], dimensions: number) {
    const eligible = chunks.filter((chunk) => chunk.projectId === projectId && chunk.embeddingModel === this.embedder.model && isValidKnowledgeVector(chunk.embedding) && chunk.embedding.length === dimensions);
    if (!eligible.length) return null;
    const signature = createHash('sha256').update(this.embedder.model).update(JSON.stringify(eligible)).digest('hex').slice(0, 24);
    const prefix = `${this.projectPrefix(projectId)}d${dimensions}_`; const namespace = `${prefix}${signature}`; const { client } = await provider.connect();
    const exists = await provider.namespaceExists(client, namespace);
    const rowCount = exists ? await provider.namespaceCount(namespace).catch(() => -1) : -1;
    if (!exists || rowCount !== eligible.length) {
      if (exists) await provider.deleteVectorsInNamespace(client, namespace);
      await provider.updateOrCreateCollection(client, eligible.map((chunk) => ({ id: chunk.id, vector: chunk.embedding, text: chunk.text, projectId: chunk.projectId, sourceId: chunk.sourceId, locator: chunk.locator })), namespace);
      if (await provider.namespaceCount(namespace) !== eligible.length) throw new Error('AnythingLLM 向量缓存重建未完成。');
    }
    this.records = eligible.map((chunk) => ({ docId: chunk.sourceId, vectorId: chunk.id }));
    // A completed generation replaces only derived tables in this project.
    for (const table of await provider.tables()) if (table.startsWith(prefix) && table !== namespace) await provider.deleteVectorsInNamespace(client, table);
    return namespace;
  }
  async semanticSearch(projectId: string, chunks: KnowledgeEngineChunk[], queryVector: number[], limit: number): Promise<KnowledgeSearchMatch[]> {
    if (!isValidKnowledgeVector(queryVector)) return [];
    return this.serial(async () => {
      try {
        const provider = await this.getProvider(); const namespace = await this.synchronize(provider, projectId, chunks, queryVector.length); if (!namespace) return [];
        const { client } = await provider.connect();
        const result = await provider.similarityResponse({ client, namespace, queryVector, similarityThreshold: MIN_SEMANTIC_SIMILARITY, topN: limit });
        this.status = 'ready'; this.error = undefined;
        return result.sourceDocuments.filter((document: any) => Number.isFinite(document.score) && document.score >= MIN_SEMANTIC_SIMILARITY).map((document: any) => ({ id: document.id, score: Math.min(1, document.score), retrievalMode: 'hybrid' as const }));
      } catch (error) { this.degraded(error); return []; }
    });
  }
  async removeSource(projectId: string, sourceId: string, chunks: KnowledgeEngineChunk[]) {
    return this.serial(async () => {
      try {
        const provider = await this.getProvider(); this.records = chunks.filter((chunk) => chunk.projectId === projectId && chunk.sourceId === sourceId).map((chunk) => ({ docId: sourceId, vectorId: chunk.id }));
        for (const namespace of await provider.tables()) if (namespace.startsWith(this.projectPrefix(projectId))) await provider.deleteDocumentFromNamespace(namespace, sourceId);
      } catch (error) { this.degraded(error); }
    });
  }
  async removeProject(projectId: string) {
    return this.serial(async () => {
      try {
        const provider = await this.getProvider(); const { client } = await provider.connect();
        for (const namespace of await provider.tables()) if (namespace.startsWith(this.projectPrefix(projectId))) await provider.deleteVectorsInNamespace(client, namespace);
      } catch (error) { this.degraded(error); }
    });
  }
}
