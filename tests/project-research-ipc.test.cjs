'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerProjectResearchIpc } = require('../backend/project-research-ipc.cjs');

function fixture() {
  const handlers = new Map(), appDir = path.resolve(__dirname, '..'); let current = 'p1', exported;
  const research = { id: 'r1', projectId: 'p1', status: 'partial', brief: '滨水社区参考', cases: [{ caseId: 'c1', name: '案例', imageArchive: { assetIds: ['image1', 'foreign'] } }] };
  const service = { get: () => research, list: () => [research], start: input => input, retry: id => ({ id }) };
  const dialog = { showSaveDialog: async () => ({ canceled: false, filePath: path.join(appDir, 'sample.pptx') }) };
  const imageCollection = { originalsDir: path.join(appDir, '.runtime', 'originals'), getAsset: id => ({ id, projectId: id === 'foreign' ? 'p2' : 'p1', path: 'opaque-trusted-path' }) };
  const options = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, appDir, backend: { projectId: () => current, store: { projects: [{ id: 'p1', name: '当前项目' }], cases: [{ id: 'c1', projectId: 'p1', summary: '已归档的正文' }] } }, service, imageCollection, dialog, nativeImage: {}, exportPresentation: async input => { exported = input; return { slideCount: 3, warnings: [] }; } };
  registerProjectResearchIpc(options);
  const trusted = { senderFrame: { url: pathToFileURL(path.join(appDir, 'index.html')).href, parent: null } };
  return { research, dialog, service, options, trusted, call: (name, payload, event = trusted) => handlers.get(`workbench:project-research-${name}`)(event, payload), switchProject: () => { current = 'p2'; }, exported: () => exported };
}

test('project research IPC rejects foreign frames, projects and renderer filesystem input', async () => {
  const f = fixture();
  assert.throws(() => f.call('list', {}, { senderFrame: { url: 'https://example.org', parent: null } }), /无权/);
  assert.throws(() => f.call('list', {}, { senderFrame: { ...f.trusted.senderFrame, parent: {} } }), /无权/);
  assert.throws(() => f.call('get', { id: 'r1', projectId: 'p2' }), /项目已切换/);
  f.switchProject(); assert.throws(() => f.call('get', { id: 'r1' }), /不属于当前项目/);
});

test('export joins saved case data and trusted opaque image ids, excluding foreign project assets', async () => {
  const f = fixture(), result = await f.call('export', { id: 'r1', projectId: 'p1', outputPath: 'C:/evil.pptx', images: [{ path: 'C:/private' }] });
  assert.equal(result.slideCount, 3); assert.equal(result.warnings.length, 1);
  const input = f.exported(); assert.equal(input.cases[0].summary, '已归档的正文'); assert.equal(input.images.length, 1); assert.equal(input.images[0].id, 'image1');
  assert.equal(input.outputPath, path.join(f.options.appDir, 'sample.pptx'));
  assert.deepEqual(input.allowedImageRoots, [f.options.imageCollection.originalsDir]);
  assert.equal(input.research.warnings.length, 1);
});

test('nested multi-source image archive objects export through opaque asset ids', async () => {
  const f = fixture(); f.research.images = { assetIds: ['image1'], images: [{ assetId: 'image1' }] };
  const result = await f.call('export', { id: 'r1' }); assert.equal(result.slideCount, 3); assert.equal(f.exported().images.length, 1);
});

test('export cancellation and project switch during native picker do not invoke exporter', async () => {
  const f = fixture(); f.dialog.showSaveDialog = async () => ({ canceled: true });
  assert.deepEqual(await f.call('export', { id: 'r1' }), { canceled: true }); assert.equal(f.exported(), undefined);
  f.dialog.showSaveDialog = async () => { f.switchProject(); return { canceled: false, filePath: 'unused.pptx' }; };
  await assert.rejects(f.call('export', { id: 'r1' }), /项目已切换/); assert.equal(f.exported(), undefined);
});

test('active research cannot be exported and dispatch drops renderer-provided paths and extra fields', async () => {
  const f = fixture(); f.research.status = 'researching'; await assert.rejects(f.call('export', { id: 'r1' }), /等待调研/);
  const result = await f.call('start', { brief: '公共空间调研', connectionId: 'agent', outputPath: 'C:/private', projectId: 'p1', includeProjectContext: false });
  assert.equal(result.projectId, 'p1'); assert.equal(result.includeProjectContext, false); assert.equal(result.outputPath, undefined);
});
