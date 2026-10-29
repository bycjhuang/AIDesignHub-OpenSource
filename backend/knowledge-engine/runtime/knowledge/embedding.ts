import { existsSync } from 'node:fs';
import path from 'node:path';
import type { KnowledgeEmbeddingStatus } from '../../packages/contracts/desktop';

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

export interface KnowledgeEmbedder {
  readonly model: string;
  readonly status: KnowledgeEmbeddingStatus;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

type FeatureExtractor = (texts: string | string[], options: Record<string, unknown>) => Promise<any>;

export class LocalEmbeddingService implements KnowledgeEmbedder {
  readonly model = DEFAULT_EMBEDDING_MODEL;
  status: KnowledgeEmbeddingStatus = 'idle';
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;
  private lastFailureAt = 0;

  constructor(private readonly dataDirectory: string) {}

  async embedDocuments(texts: string[]) {
    if (!texts.length) return [];
    return this.embed(texts.map((text) => `passage: ${text}`));
  }

  async embedQuery(text: string) {
    const vectors = await this.embed([`query: ${text}`]);
    return vectors[0] ?? [];
  }

  private async embed(texts: string[]) {
    const extractor = await this.getExtractor();
    const tensor = await extractor(texts, { pooling: 'mean', normalize: true });
    const values = tensor.tolist() as number[][];
    return values.map((vector) => vector.map((value) => Number(value)));
  }

  private async getExtractor() {
    if (this.extractor) return this.extractor;
    if (this.loading) return this.loading;
    if (this.status === 'unavailable' && Date.now() - this.lastFailureAt < 5 * 60_000) {
      throw new Error('本地向量模型暂不可用，请稍后重试。');
    }
    this.status = 'loading';
    this.loading = (async () => {
      try {
        const transformers = await import('@huggingface/transformers');
        const bundledAssets = process.env.BYCJ_KNOWLEDGE_ASSETS_DIR;
        const bundledCache = bundledAssets ? path.join(bundledAssets, 'models') : '';
        const hasBundledModel = Boolean(bundledCache && existsSync(bundledCache));
        transformers.env.cacheDir = hasBundledModel ? bundledCache : path.join(this.dataDirectory, 'models');
        transformers.env.allowLocalModels = true;
        if (!hasBundledModel) throw new Error('本地 E5 模型资源未安装，已保留离线全文检索；不会联网下载。');
        transformers.env.allowRemoteModels = false;
        const extractor = await transformers.pipeline('feature-extraction', this.model, {
          dtype: 'q8',
          local_files_only: true,
          cache_dir: transformers.env.cacheDir || undefined,
        }) as unknown as FeatureExtractor;
        this.extractor = extractor;
        this.status = 'ready';
        return extractor;
      } catch (error) {
        this.status = 'unavailable';
        this.lastFailureAt = Date.now();
        throw error;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
}
