'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { KnowledgeWorkbench } = require('../backend/knowledge-workbench.cjs');
const { assertKnowledgeSender } = require('../backend/knowledge-workbench-ipc.cjs');
const { pathToFileURL } = require('node:url');

class ContractWorker {
  constructor({ dataDir }) { this.directory = dataDir; }
  async start() { this.state = JSON.parse(await fs.readFile(path.join(this.directory, 'knowledge-index.json'))); }
  async close() {}
  async request(method, args) {
    if (method === 'listProjects') return { projects: this.state.projects, summary: { sourceCount: this.state.sources.length } };
    if (method === 'listSources') return { sources: this.state.sources.filter(item => item.projectId === args.projectId), summary: {} };
    if (method === 'summary') return {};
    if (method === 'search') return this.state.chunks.filter(item => item.projectId === args.projectId);
    if (method === 'export') return { base64: Buffer.from(JSON.stringify(args)).toString('base64'), suggestedName: `result.${args.format}`, mimeType: 'test' };
    if (method === 'addFiles') {
      const added = [];
      for (const file of args.filePaths) {
        const id = `source-${this.state.sources.length}`; const text = await fs.readFile(file, 'utf8');
        const source = { id, projectId: args.projectId, filePath: file, name: path.basename(file), extension: 'txt', chunkCount: 1, status: 'indexed', size: text.length };
        this.state.sources.push(source); this.state.chunks.push({ id: `${id}-chunk`, projectId: args.projectId, sourceId: id, locator: '正文', text }); added.push(source);
      }
      await fs.writeFile(path.join(this.directory, 'knowledge-index.json'), JSON.stringify(this.state)); return { added, skipped: [], summary: {} };
    }
    if (method === 'removeSource') {
      const target = this.state.sources.find(item => item.id === args.sourceId && item.projectId === args.projectId);
      this.state.sources = this.state.sources.filter(item => item !== target);
      await fs.writeFile(path.join(this.directory, 'knowledge-index.json'), JSON.stringify(this.state)); return { removed: !!target };
    }
    throw new Error(`Unexpected contract method: ${method}`);
  }
}

async function fixture(t, answer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-workbench-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'source.txt'); await fs.writeFile(original, '消防车道净宽度不应小于4米。');
  const backend = { dataDir: root, store: { projects: [{ id: 'project-a', name: 'A' }, { id: 'project-b', name: 'B' }],
    knowledgeDocs: [{ id: 'doc-a', projectId: 'project-a', name: 'source.txt', storedPath: original, extension: 'txt', sourceType: 'regulation',
      chunks: [{ locator: '第1页', text: '消防车道净宽度不应小于4米。' }], status: 'indexed' }] }, mutate(fn) { return fn(this.store); } };
  const service = new KnowledgeWorkbench({ backend, answer, workerFactory: options => new ContractWorker(options) });
  t.after(() => service.dispose());
  return { root, original, backend, service };
}

test('legacy migration preserves original documents, chunks and store; repeated open does not duplicate records', async t => {
  const f = await fixture(t); const before = JSON.stringify(f.backend.store);
  const first = await f.service.listLibraries('project-a');
  const second = await f.service.listLibraries('project-a');
  assert.equal(first.libraries.length, 1); assert.equal(first.libraries[0].id, second.libraries[0].id);
  assert.equal(first.migration.originalSources, 1);
  const context = await f.service.context('project-a');
  const state = JSON.parse(await fs.readFile(path.join(context.directory, 'knowledge-index.json')));
  assert.equal(state.sources[0].filePath, f.original); assert.equal(state.chunks[0].text, f.backend.store.knowledgeDocs[0].chunks[0].text);
  assert.equal(state.sources[0].parsedSections, undefined); // Overlapping legacy snippets do not pretend to be a full corpus.
  assert.equal(JSON.stringify(f.backend.store), before);
  assert.equal(await fs.readFile(f.original, 'utf8'), '消防车道净宽度不应小于4米。');
});

test('a library or source from another Hub project cannot be read, searched or exported', async t => {
  const { service } = await fixture(t); const a = (await service.listLibraries('project-a')).libraries[0];
  await service.listLibraries('project-b');
  await assert.rejects(service.search('project-b', a.id, '消防'), /不属于当前项目/);
  await assert.rejects(service.sourcePath('project-b', a.id, 'doc-a'), /不属于当前项目/);
  await assert.rejects(service.context('../outside'), /有效的项目/);
});

test('complete results persist outside previews and survive history reload; missing artifacts never fall back to preview export', async t => {
  const rows = Array.from({ length: 140 }, (_, index) => [index, `完整行${index}`]);
  const f = await fixture(t, async () => ({ answer: '只显示前两行的预览', citations: [], coverage: '完整读取', incomplete: false,
    exportInput: { format: 'xlsx', title: '资料表', markdown: 'preview', tables: [{ name: '完整表', columns: ['序号', '内容'], rows }] } }));
  const library = (await f.service.listLibraries('project-a')).libraries[0];
  const response = await f.service.ask('project-a', library.id, { question: '整理全部', requestId: 'request1' }, 1);
  assert.equal(response.exportInput, undefined); assert.ok(response.exportId);
  const history = await f.service.history('project-a', library.id); assert.equal(history.messages[1].exportId, response.exportId);
  const exported = await f.service.exportResult('project-a', library.id, { exportId: response.exportId, format: 'xlsx' });
  assert.equal(JSON.parse(Buffer.from(exported.base64, 'base64')).tables[0].rows.length, 140);
  const context = await f.service.context('project-a'); await fs.unlink(path.join(context.directory, 'results', `${response.exportId}.json`));
  await assert.rejects(f.service.exportResult('project-a', library.id, { exportId: response.exportId, format: 'docx' }), /完整结果不存在/);
});

test('imports copy files to owned storage and mirror project reads; removing a source leaves the selected original intact', async t => {
  const f = await fixture(t); const library = (await f.service.listLibraries('project-a')).libraries[0];
  const result = await f.service.importFiles('project-a', library.id, [f.original]); assert.equal(result.added.length, 1);
  const source = f.backend.store.knowledgeDocs.find(item => item.id === result.added[0].id);
  assert.notEqual(source.storedPath, f.original); assert.ok(source.storedPath.startsWith(f.service.root + path.sep));
  assert.equal(source.chunks[0].text, '消防车道净宽度不应小于4米。');
  await f.service.removeSource('project-a', library.id, source.id);
  assert.ok(!f.backend.store.knowledgeDocs.some(item => item.id === source.id));
  assert.equal(await fs.readFile(f.original, 'utf8'), '消防车道净宽度不应小于4米。');
});

test('only the owning renderer can cancel an active request and cancelled work is not stored or replayed', async t => {
  let calls = 0;
  const f = await fixture(t, ({ signal }) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const library = (await f.service.listLibraries('project-a')).libraries[0];
  const pending = f.service.ask('project-a', library.id, { question: '整理', requestId: 'cancel-request' }, 41);
  while (!calls) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.service.cancel('cancel-request', 42).cancelled, false);
  assert.equal(f.service.cancel('cancel-request', 41).cancelled, true);
  await assert.rejects(pending, /cancelled/); assert.equal(calls, 1);
  assert.deepEqual((await f.service.history('project-a', library.id)).messages, []);
});

test('knowledge IPC trusts only the main local renderer and rejects child views or remote pages', () => {
  const file = path.resolve(__dirname, '../index.html'); const frame = { url: `${pathToFileURL(file).href}#knowledge` };
  const sender = { mainFrame: frame, isDestroyed: () => false }; const owner = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: frame }; assert.doesNotThrow(() => assertKnowledgeSender(event, owner, file));
  assert.throws(() => assertKnowledgeSender({ ...event, senderFrame: { url: frame.url } }, owner, file), /不允许/);
  frame.url = 'https://example.invalid'; assert.throws(() => assertKnowledgeSender(event, owner, file), /不允许/);
});

test('late cancellation reports saving rather than claiming to cancel an already committed result', async t => {
  const f = await fixture(t, async () => ({ answer: '完成', citations: [], exportInput: { format: 'docx', title: '结果', markdown: '完成' } }));
  const library = (await f.service.listLibraries('project-a')).libraries[0]; let late;
  const result = await f.service.ask('project-a', library.id, { question: '读取', requestId: 'late-cancel' }, 7,
    progress => { if (progress.phase === 'saving') late = f.service.cancel('late-cancel', 7); });
  assert.deepEqual(late, { cancelled: false, committing: true });
  assert.ok(result.exportId); assert.equal((await f.service.history('project-a', library.id)).messages.length, 2);
});

test('legacy removal updates both indexes without unlinking the only archived original', async t => {
  const f = await fixture(t); await f.service.listLibraries('project-a');
  assert.equal((await f.service.removeLegacyDocument('project-a', 'doc-a')).removed, true);
  assert.equal(f.backend.store.knowledgeDocs.length, 0);
  assert.equal(await fs.readFile(f.original, 'utf8'), '消防车道净宽度不应小于4米。');
});
