'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { KnowledgeWorkerClient, resolveKnowledgePayloadRoot } = require('../backend/knowledge-engine/client.cjs');
const { dependencyClosure } = require('../scripts/stage-knowledge-engine.cjs');

const payloadRoot = path.resolve(__dirname, '../.runtime/knowledge');
const staged = existsSync(path.join(payloadRoot, 'worker.cjs'));

function exportedXml(buffer) {
  const files = new Map();
  for (let at = 0; at + 30 < buffer.length && buffer.readUInt32LE(at) === 0x04034b50;) {
    const method = buffer.readUInt16LE(at + 8), size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26), extraLength = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength), start = at + 30 + nameLength + extraLength;
    const bytes = buffer.subarray(start, start + size);
    if (name.endsWith('.xml')) files.set(name, (method === 8 ? require('node:zlib').inflateRawSync(bytes) : bytes).toString('utf8'));
    at = start + size;
  }
  return files;
}

function makePdf(objects) {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = parts[0].length;
  for (const [index, body] of objects.entries()) {
    offsets.push(length);
    const item = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    parts.push(item); length += item.length;
  }
  const xref = length;
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test('knowledge dependency closure includes production/nested peers while excluding dev and absent optional packages', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function manifest(name, data, parent = root) {
    const directory = path.join(parent, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...data }));
    return directory;
  }
  const primary = await manifest('primary', { dependencies: { runtime: '1' }, optionalDependencies: { absent: '1' }, devDependencies: { unrelated: '1' }, peerDependencies: { peer: '1' } });
  await manifest('runtime', {});
  await manifest('peer', {}, primary);
  await manifest('unrelated', {});
  const closure = await dependencyClosure(root, ['primary']);
  assert.deepEqual(closure.packages.map(item => item.name).sort(), ['peer', 'primary', 'runtime']);
  assert.ok(closure.packages.find(item => item.name === 'peer').path.includes('primary/node_modules/peer'));
});

test('worker requires an explicit data root and refuses to use Electron as its native host', async t => {
  assert.throws(() => new KnowledgeWorkerClient(), /absolute dataDir/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'worker.cjs'), '');
  await writeFile(path.join(root, 'electron.exe'), '');
  const client = new KnowledgeWorkerClient({ payloadRoot: root, nodeExe: path.join(root, 'electron.exe'), dataDir: path.join(root, 'data') });
  await assert.rejects(client.start(), /NODE_REQUIRED/);
});

test('installed worker launches from bundled resources without using the development payload', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-install-'));
  t.after(async () => {
    const real = await require('node:fs/promises').realpath(root);
    assert.equal(path.dirname(real).toLowerCase(), (await require('node:fs/promises').realpath(os.tmpdir())).toLowerCase());
    assert.match(path.basename(real), /^adh-knowledge-install-/);
    await rm(real, { recursive: true, force: true });
  });
  const appDir = path.join(root, 'resources', 'app');
  const resourcesPath = path.join(root, 'resources');
  const installed = resolveKnowledgePayloadRoot({ appDir, resourcesPath, isPackaged: true });
  const development = resolveKnowledgePayloadRoot({ appDir, resourcesPath, isPackaged: false });
  await mkdir(installed, { recursive: true }); await mkdir(development, { recursive: true });
  await writeFile(path.join(development, 'worker.cjs'), "throw new Error('The installed app used its development directory');");
  await writeFile(path.join(installed, 'worker.cjs'), "process.on('message',m=>process.send({id:m.id,ok:true,result:{runtime:'installed'}}));process.on('disconnect',()=>process.exit(0));process.send({type:'ready'});");
  const client = new KnowledgeWorkerClient({ payloadRoot: installed, nodeExe: process.execPath, dataDir: path.join(root, 'data') });
  try { assert.deepEqual(await client.start(), { runtime: 'installed' }); } finally { await client.close(); }
  const config = JSON.parse(await readFile(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.ok(config.build.extraResources.some(item => item.from === '.runtime/installer-resources/public/knowledge' && path.resolve(resourcesPath, item.to) === installed), 'The installer must carry the audited worker, standalone Node, native dependencies and offline assets at the runtime location.');
  const dependencies = config.build.extraResources.find(item => item.to === 'knowledge/node_modules');
  assert.equal(dependencies?.from, '.runtime/installer-resources/public/knowledge/node_modules', 'electron-builder excludes a mapping root node_modules directory, so dependencies require their own mapping.');
  const from = path.join(root, 'payload', 'node_modules'), to = path.join(root, 'copied', 'node_modules');
  await mkdir(path.join(from, '@fixture', 'native-runtime'), { recursive: true });
  await writeFile(path.join(from, '@fixture', 'native-runtime', 'package.json'), '{"name":"@fixture/native-runtime"}');
  const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
  await copyFiles([new FileMatcher(from, to, value => value, dependencies.filter)]);
  assert.equal(JSON.parse(await readFile(path.join(to, '@fixture/native-runtime/package.json'), 'utf8')).name, '@fixture/native-runtime');
});

test('staged knowledge dependencies resolve entirely inside the Hub payload', { skip: !staged }, async () => {
  const closure = await dependencyClosure(payloadRoot);
  assert.equal(closure.modulesRoot, path.join(payloadRoot, 'node_modules'));
  const manifest = JSON.parse(await readFile(path.join(payloadRoot, 'payload-manifest.json'), 'utf8'));
  assert.equal(closure.packages.length, manifest.packages);
  const worker = await readFile(path.join(payloadRoot, 'worker.cjs'), 'utf8');
  assert.ok(!worker.includes('D:/BYCJ') && !worker.includes('D:\\\\BYCJ'));
});

test('real standalone worker retains legacy full corpus and indexes mixed Office/PDF/OCR with local E5 and native exports', { skip: !staged, timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-mixed-'));
  const dataDir = path.join(root, 'data');
  const fixtures = path.join(root, 'fixtures');
  await mkdir(dataDir, { recursive: true });
  await mkdir(fixtures, { recursive: true });
  const legacyText = '遗留唯一锚点：保留旧资料第001项。' + '旧资料正文与中文尺寸图纸说明。'.repeat(2500);
  const legacySource = { id: 'legacy-source', projectId: 'legacy-project', name: '旧资料.txt', filePath: path.join(fixtures, 'unavailable-original.txt'), fingerprint: 'legacy', extension: 'txt', status: 'indexed', chunkCount: 1, size: 1, modifiedAt: 1, indexedAt: 1 };
  await writeFile(path.join(dataDir, 'knowledge-index.json'), JSON.stringify({ version: 2, retrievalEngine: 'anythingllm', updatedAt: 1,
    projects: [{ id: 'legacy-project', name: 'Hub原知识库测试资料', description: 'synthetic seed', createdAt: 1, updatedAt: 1 }],
    sources: [legacySource], chunks: [{ id: 'legacy-chunk', projectId: 'legacy-project', sourceId: 'legacy-source', locator: '旧正文', text: legacyText, normalizedText: legacyText }] }));
  const client = new KnowledgeWorkerClient({ payloadRoot, dataDir });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  const initialized = await client.start();
  assert.equal(initialized.projects[0].id, 'legacy-project');
  assert.equal(initialized.summary.capabilities.embeddingAssets, true);
  assert.equal(initialized.summary.capabilities.ocrAssets, true);
  let cursor;
  let corpus = '';
  let pages = 0;
  do {
    const page = await client.request('corpus', { projectId: 'legacy-project', cursor, pageSize: 1 });
    assert.equal(page.sources[0].contentOrigin, 'legacy-chunks');
    assert.ok(page.warnings.some(value => value.includes('历史片段')));
    corpus += page.segments.map(item => item.text).join('');
    cursor = page.nextCursor || undefined; pages += 1;
  } while (cursor);
  assert.ok(pages > 1);
  assert.equal(corpus, legacyText);
  const legacyHits = await client.request('search', { projectId: 'legacy-project', query: '遗留唯一锚点', limit: 4 });
  assert.equal(legacyHits[0].text, legacyText);
  assert.equal(legacyHits[0].citationId, 'legacy-chunk');
  const project = await client.request('createProject', { name: '混合建筑资料', description: '临时测试' });
  await client.request('updateProject', { projectId: project.id, description: '更新后的临时说明' });
  const textPath = path.join(fixtures, '自然采光.txt');
  await writeFile(textPath, '建筑教室采用北向侧窗提供均匀自然采光，窗地面积比应满足设计要求。');
  const documents = [textPath];
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const exported = await client.request('export', { format, title: '建筑验收数据', markdown: '# 建筑验收数据\n\n学校教室设计与自然采光。',
      tables: [{ name: '面积表', columns: ['房间', '面积'], rows: [['教室', 120], ['阅览室', 360]] }],
      sources: [{ name: '合成测试资料', locator: '面积表' }], coverage: '已覆盖全部测试行' });
    assert.ok(exported.mimeType.includes('officedocument'));
    const buffer = Buffer.from(exported.base64, 'base64');
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    const parts = exportedXml(buffer), identity = require('../assets/release-identity.json');
    assert.match([...parts.values()].join('\n'), /Powered by AIDesignHub/);
    assert.ok(parts.get('docProps/core.xml')?.includes(identity.releaseId));
    if (format === 'docx') {
      assert.match(parts.get('word/footer1.xml'), /Powered by AIDesignHub/);
      assert.match(parts.get('word/document.xml'), /w:footerReference/);
    }
    if (format === 'xlsx') assert.ok([...parts.values()].some(part => part.includes('oddFooter')));
    const file = path.join(fixtures, `面积表.${format}`); await writeFile(file, buffer); documents.push(file);
  }
  const pdfText = 'BT /F1 18 Tf 40 720 Td (School classroom daylight design area 240) Tj ET';
  const pdfFile = path.join(fixtures, 'text.pdf');
  await writeFile(pdfFile, makePdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`]));
  documents.push(pdfFile);
  const requirePayload = createRequire(path.join(payloadRoot, 'package.json'));
  const { createCanvas } = requirePayload('@napi-rs/canvas');
  const image = createCanvas(1400, 360);
  const context = image.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1400, 360);
  context.fillStyle = '#000'; context.font = '72px "Microsoft YaHei"';
  context.fillText('设计验收数量 120', 60, 120); context.fillText('采光面积 360 平方米', 60, 250);
  const imageFile = path.join(fixtures, 'ocr.png'); await writeFile(imageFile, image.toBuffer('image/png')); documents.push(imageFile);
  const jpeg = image.toBuffer('image/jpeg');
  const scanContent = 'q 560 0 0 144 20 500 cm /Im1 Do Q';
  const scanFile = path.join(fixtures, 'scan.pdf');
  await writeFile(scanFile, makePdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 360 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
    `<< /Length ${scanContent.length} >>\nstream\n${scanContent}\nendstream`]));
  documents.push(scanFile);
  const imported = await client.request('addFiles', { projectId: project.id, filePaths: documents });
  assert.deepEqual(imported.skipped, []);
  assert.equal(imported.added.length, 7);
  assert.ok(imported.added.every(item => item.status === 'indexed'), JSON.stringify(imported.added));
  const summary = await client.request('summary');
  assert.equal(summary.embeddingStatus, 'ready');
  assert.equal(summary.retrievalStatus, 'ready');
  assert.ok(summary.vectorizedChunkCount >= 7);
  assert.equal(summary.blockedNetworkRequests, 0);
  const hits = await client.request('search', { projectId: project.id, query: '自然采光', limit: 6 });
  assert.ok(hits.some(item => item.retrievalMode === 'hybrid' && item.text.includes('自然采光')));
  const all = await client.request('corpus', { projectId: project.id, pageSize: 32 });
  assert.equal(all.done, true);
  assert.equal(all.sources.length, 7);
  assert.ok(all.sources.every(item => item.contentOrigin === 'parsed-sections'));
  assert.ok(all.segments.filter(item => item.sourceName === 'ocr.png').some(item => item.text.includes('120')));
  assert.ok(all.segments.filter(item => item.sourceName === 'scan.pdf').some(item => item.text.includes('360')));
  assert.ok(all.segments.filter(item => item.sourceName === '面积表.xlsx').some(item => item.text.includes('教室') && item.text.includes('120')));
  await client.request('removeSource', { projectId: project.id, sourceId: imported.added[0].id });
  assert.equal((await client.request('listSources', { projectId: project.id })).sources.length, 6);
  const reindexed = await client.request('reindex', { projectId: project.id });
  assert.equal(reindexed.added.length, 6);
  await client.request('removeProject', { projectId: project.id });
  assert.deepEqual((await client.request('listProjects')).projects.map(item => item.id), ['legacy-project']);
  await assert.rejects(client.request('unsupported-operation'), /METHOD_UNKNOWN/);
});

test('missing model/OCR assets explicitly degrade to offline keyword indexing without network downloads', { skip: !staged, timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-degraded-'));
  const assetsDir = path.join(root, 'missing-assets'); await mkdir(assetsDir);
  const file = path.join(root, 'offline.txt'); await writeFile(file, '离线全文检索需要保留建筑设计资料。');
  const client = new KnowledgeWorkerClient({ payloadRoot, dataDir: path.join(root, 'data'), assetsDir });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  const initialized = await client.start();
  assert.equal(initialized.summary.degraded, true);
  assert.equal(initialized.capabilities.embeddingAssets, false);
  const projectId = initialized.projects[0].id;
  const imported = await client.request('addFiles', { projectId, filePaths: [file] });
  assert.equal(imported.added[0].status, 'indexed');
  assert.ok(imported.added[0].error.includes('不会联网下载'));
  const hits = await client.request('search', { projectId, query: '建筑设计', limit: 3 });
  assert.equal(hits[0].retrievalMode, 'keyword');
  assert.ok(hits[0].text.includes('建筑设计'));
  const png = path.join(root, 'empty.png');
  await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3UbZsAAAAASUVORK5CYII=', 'base64'));
  const unavailableOcr = await client.request('addFiles', { projectId, filePaths: [png] });
  assert.equal(unavailableOcr.added[0].status, 'metadata-only');
  assert.ok(unavailableOcr.added[0].error.includes('本地 OCR 资源未安装'));
  const summary = await client.request('summary');
  assert.equal(summary.embeddingStatus, 'unavailable');
  assert.equal(summary.blockedNetworkRequests, 0);
});

test('reindexing a migrated source preserves its display filename instead of the internal archive basename', { skip: !staged, timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adh-knowledge-display-name-'));
  const dataDir = path.join(root, 'data');
  const assetsDir = path.join(root, 'no-model-assets');
  const storedPath = path.join(root, 'owned-files', 'doc-12345-内部归档.txt');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(assetsDir, { recursive: true }), mkdir(path.dirname(storedPath), { recursive: true })]);
  await writeFile(storedPath, '重新解析后的建筑采光设计说明，保留原始文件展示名。');
  const sourceName = '原始建筑设计说明.txt';
  await writeFile(path.join(dataDir, 'knowledge-index.json'), JSON.stringify({ version: 2, retrievalEngine: 'anythingllm', updatedAt: 1,
    projects: [{ id: 'migrated-project', name: '迁移知识库', createdAt: 1, updatedAt: 1 }],
    sources: [{ id: 'migrated-source', projectId: 'migrated-project', name: sourceName, filePath: storedPath,
      fingerprint: 'old-import', extension: 'txt', status: 'indexed', chunkCount: 1, size: 1, modifiedAt: 1, indexedAt: 1 }],
    chunks: [{ id: 'old-chunk', projectId: 'migrated-project', sourceId: 'migrated-source', locator: '原正文', text: '旧建筑检索缓存', normalizedText: '旧建筑检索缓存' }] }));
  const client = new KnowledgeWorkerClient({ payloadRoot, dataDir, assetsDir });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.start();
  const reindexed = await client.request('reindex', { projectId: 'migrated-project' });
  assert.deepEqual(reindexed.skipped, []);
  assert.equal(reindexed.added[0].id, 'migrated-source');
  assert.equal(reindexed.added[0].name, sourceName);
  assert.notEqual(reindexed.added[0].name, path.basename(storedPath));
  const sources = await client.request('listSources', { projectId: 'migrated-project' });
  assert.equal(sources.sources[0].name, sourceName);
  const corpus = await client.request('corpus', { projectId: 'migrated-project' });
  assert.equal(corpus.sources[0].contentOrigin, 'parsed-sections');
  assert.equal(corpus.segments[0].sourceName, sourceName);
  const hits = await client.request('search', { projectId: 'migrated-project', query: '建筑采光', limit: 4 });
  assert.equal(hits[0].sourceName, sourceName);
  const persisted = JSON.parse(await readFile(path.join(dataDir, 'knowledge-index.json'), 'utf8'));
  assert.equal(persisted.sources[0].name, sourceName);
});
