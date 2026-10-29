'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { registerCaseArticleIpc, assetUrl, articleUrl } = require('../backend/case-article-ipc.cjs');
const picture = require('./fixtures/smoke-case.cjs').imageDataUrl;

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-case-reader-')), file = path.join(directory, 'local.png');
  fs.writeFileSync(file, Buffer.from(picture.split(',')[1], 'base64'));
  const own = { id: 'case_own', projectId: 'project_a', name: '本地完整文章', sourceUrl: 'https://example.org/article' }, foreign = { id: 'case_foreign', projectId: 'project_b' };
  let projectId = 'project_a', reads = 0;
  const handlers = new Map(), service = { find: id => [own, foreign].find(item => item.id === id), previews: {}, article: async () => ({ available: true, status: 'complete', assetCount: 1, updatedAt: 2, filePath: '/must-not-reach-renderer' }), articleDocument: () => ({ html: '<!doctype html><article><h1>本地案例</h1><img src="images/asset_own"></article>', assetIds: ['asset_own'] }) };
  const asset = { id: 'asset_own', projectId: 'project_a', caseIds: ['case_own'], sourceUrl: 'https://example.org/image.png', width: 1600, height: 900, contentType: 'image/png', thumbnailUrl: picture };
  const images = { list: ({ projectId: id, caseId }) => id === 'project_a' && caseId === 'case_own' ? [asset] : [], getAsset: id => { assert.equal(id, asset.id); reads++; return { ...asset, path: file }; } };
  const registration = registerCaseArticleIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler() {} }, protocol: { handle() {}, unhandle() {} }, service, images, backend: { projectId: () => projectId }, appDir: process.cwd() });
  t.after(() => { registration.dispose(); if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('adh-case-reader-')) throw new Error('Invalid cleanup target'); fs.rmSync(directory, { recursive: true, force: true }); });
  return { registration, handlers, service, own, setProject: value => { projectId = value; }, reads: () => reads };
}

test('local reader streams only current-project case images and returns a script-free isolated document', async t => {
  const f = setup(t);
  const doc = await f.registration.handle(new Request(articleUrl('case_own')));
  assert.equal(doc.status, 200); assert.match(await doc.text(), /<h1>本地案例/);
  assert.match(doc.headers.get('content-security-policy'), /script-src 'none'/); assert.match(doc.headers.get('content-security-policy'), /sandbox/);
  const image = await f.registration.handle(new Request(assetUrl('case_own', 'asset_own')));
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert((await image.arrayBuffer()).byteLength > 0); assert.equal(f.reads(), 1);
  const thumbnail = await f.registration.handle(new Request(`${assetUrl('case_own', 'asset_own')}?thumbnail=1`));
  assert.equal(thumbnail.status, 200); assert.equal(f.reads(), 1);
  for (const url of [assetUrl('case_own','asset_foreign'), articleUrl('case_foreign'), 'adh-case://local/case_own/images/%2e%2e%2fsecret', 'adh-case://untrusted/case_own/index.html']) assert.notEqual((await f.registration.handle(new Request(url))).status, 200);
  f.setProject('project_b'); assert.equal((await f.registration.handle(new Request(assetUrl('case_own','asset_own')))).status, 404);
});

test('article bridge is restricted to the trusted top-level Hub frame and never returns file paths', async t => {
  const f = setup(t), handler = f.handlers.get('workbench:case-article'), frame = { url: pathToFileURL(path.join(process.cwd(), 'index.html')).href };
  const value = await handler({ senderFrame: frame }, 'case_own', {});
  assert.equal(value.url, `${articleUrl('case_own')}?v=2`); assert.equal(value.assetCount, 1); assert(!Object.hasOwn(value,'filePath'));
  await assert.rejects(handler({ senderFrame: { ...frame, parent: {} } },'case_own'), /不能读取/);
  await assert.rejects(handler({ senderFrame: { url: 'https://example.org' } },'case_own'), /不能读取/);
  await assert.rejects(handler({ senderFrame: frame },'case_foreign'), /不属于当前项目/);
  const preview = f.service.previews.localPreview(f.own);
  assert.equal(preview.local, true); assert.equal(preview.images.length, 1); assert.equal(preview.images[0].originalUrl, assetUrl('case_own','asset_own')); assert(!JSON.stringify(preview).includes('base64'));
});
