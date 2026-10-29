import path from 'node:path';
import { existsSync } from 'node:fs';
import { KnowledgeService } from './runtime/knowledge/service';
import { createKnowledgeExport } from './runtime/knowledge/export';

const dataDirectory = process.env.ADH_KNOWLEDGE_DATA_DIR;
if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error('ADH_KNOWLEDGE_DATA_DIR must be an explicit absolute directory');
const assets = process.env.ADH_KNOWLEDGE_ASSETS_DIR || path.join(__dirname, 'assets');
process.env.BYCJ_KNOWLEDGE_ASSETS_DIR = assets;
process.env.HF_HUB_OFFLINE = '1';
process.env.TRANSFORMERS_OFFLINE = '1';
let blockedNetworkRequests = 0;
globalThis.fetch = async () => { blockedNetworkRequests += 1; throw new Error('KNOWLEDGE_OFFLINE_ONLY: network access is disabled'); };
const capabilities = {
  engine: 'anythingllm', offlineOnly: true,
  embeddingAssets: existsSync(path.join(assets, 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx')),
  ocrAssets: existsSync(path.join(assets, 'ocr', 'chi_sim.traineddata.gz')),
  corpus: true, exportFormats: ['docx', 'xlsx', 'pptx'],
};
const service = new KnowledgeService(dataDirectory);
let initialized: Promise<void> | undefined;
const initialize = () => initialized ??= service.initialize();
const summary = () => ({ ...service.summary(), capabilities,
  degraded: !capabilities.embeddingAssets || !capabilities.ocrAssets || service.summary().retrievalStatus !== 'ready',
  blockedNetworkRequests,
});

async function invoke(method: string, args: Record<string, any> = {}) {
  await initialize();
  switch (method) {
    case 'init': return { ...service.listProjects(), summary: summary(), capabilities };
    case 'summary': return summary();
    case 'listProjects': return { ...service.listProjects(), summary: summary() };
    case 'createProject': return service.createProject(args as { name: string; description?: string });
    case 'updateProject': return service.updateProject(args.projectId, args);
    case 'removeProject': return service.removeProject(args.projectId);
    case 'listSources': return { ...service.list(args.projectId), summary: summary() };
    case 'addFiles': return service.addFiles(args.projectId, args.filePaths);
    case 'addFolder': return service.addFolder(args.projectId, args.folderPath);
    case 'removeSource': return service.removeSource(args.sourceId, args.projectId);
    case 'reindex': return service.reindexProject(args.projectId);
    case 'search': return service.search(args.projectId, args.query || '', args.limit);
    case 'corpus': return service.readCorpusPage(args.projectId, args.cursor, args.pageSize);
    case 'export': {
      const result = createKnowledgeExport(args as any);
      return { base64: result.buffer.toString('base64'), suggestedName: result.suggestedName, mimeType: result.mimeType };
    }
    default: throw new Error(`KNOWLEDGE_METHOD_UNKNOWN: ${method}`);
  }
}

let queue: Promise<unknown> = Promise.resolve();
process.on('message', (request: { id: string | number; method: string; args?: Record<string, any> }) => {
  if (!request || !['string', 'number'].includes(typeof request.id) || typeof request.method !== 'string') return;
  const action = async () => {
    try { process.send?.({ id: request.id, ok: true, result: await invoke(request.method, request.args) }); }
    catch (error) { process.send?.({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  queue = queue.then(action, action);
});
process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'ready', capabilities });
