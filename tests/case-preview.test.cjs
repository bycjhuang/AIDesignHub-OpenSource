'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CasePreviewService } = require('../backend/case-preview.cjs');
const fixture = require('./fixtures/smoke-case.cjs');

function setup(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-preview-test-'));
  const item = { id: 'legacy_case', projectId: 'test_project', sourceUrl: fixture.sourceUrl, name: '用户手写案例名', location: '用户手写地点', notes: '用户手写笔记', type: 'hotel' };
  const items = [item];
  const service = new CasePreviewService({ dataDir, findCase: id => items.find(value => value.id === id), fetchPage: fixture.fetchPage, fetchImage: fixture.fetchImage, ...options });
  return { service, item, items, dataDir };
}

test('legacy case preview includes real cached raster and readable text without changing user fields', async () => {
  const { service, item, dataDir } = setup(); const before = JSON.stringify(item);
  const result = await service.preview(item.id);
  assert.equal(result.status, 'ready'); assert.equal(result.title, '江湾美术馆');
  assert.equal(result.images[0].dataUrl, fixture.imageDataUrl); assert.equal(result.images[0].width, 400);
  assert.equal(result.images[0].sourceUrl, fixture.imageUrl); assert.match(result.text, /公共庭院/);
  assert.equal(result.sourceUrl, fixture.sourceUrl); assert.equal(result.textTruncated, false);
  assert.equal(JSON.stringify(item), before); assert.equal(result.candidates, undefined); assert.equal(result.loaded, undefined);
  assert.equal(fs.readdirSync(path.join(dataDir, 'case-previews')).filter(name => name.endsWith('.json')).length, 1);
  service.dispose();
});

test('parallel requests coalesce and disk cache avoids extra requests until explicit refresh', async () => {
  let pages = 0, images = 0;
  const { service, item, dataDir, items } = setup({ fetchPage: async url => { pages++; await new Promise(resolve => setTimeout(resolve, 10)); return fixture.fetchPage(url); },
    fetchImage: async url => { images++; return fixture.fetchImage(url); } });
  await Promise.all([service.preview(item.id), service.preview(item.id), service.preview(item.id)]);
  assert.equal(pages, 1); assert.equal(images, 1);
  await service.preview(item.id); assert.equal(pages, 1);
  const reopened = new CasePreviewService({ dataDir, findCase: id => items.find(value => value.id === id), fetchPage: async () => { throw new Error('must use cache'); } });
  assert.equal((await reopened.preview(item.id)).images.length, 1);
  await service.preview(item.id, { refresh: true }); assert.equal(pages, 2); assert.equal(images, 2);
  service.dispose(); reopened.dispose();
});

test('research-seeded page is reused and never reruns an external Agent', async () => {
  const { service, item } = setup({ fetchPage: async () => { throw new Error('no duplicate fetch'); } });
  service.seed(item.id, fixture.page);
  const result = await service.preview(item.id); assert.equal(result.images.length, 1); assert.equal(result.error, null);
  service.dispose();
});

test('preview without source or with private source fails closed and does not fabricate an image', async () => {
  let requests = 0;
  const { service, item } = setup({ fetchPage: async () => { requests++; return fixture.page; } });
  item.sourceUrl = '';
  assert.match((await service.preview(item.id)).error, /未记录原始网页/);
  item.sourceUrl = 'http://127.0.0.1/private';
  const value = await service.preview(item.id); assert.equal(value.images.length, 0); assert.match(value.error, /本机|内网/);
  assert.equal(requests, 0);
  await assert.rejects(service.preview('../unknown'), /案例不存在/); service.dispose();
});

test('image errors retain readable text and source, unsafe image references are not fetched', async () => {
  const calls = [];
  const { service, item } = setup({ fetchPage: async () => ({ ...fixture.page, images: [
    { url: 'file:///C:/secret.png' }, { url: 'http://169.254.169.254/image.png' }, { url: fixture.imageUrl, alt: 'cover' },
  ] }), fetchImage: async url => { calls.push(url); throw new Error('HTTP 403'); } });
  const result = await service.preview(item.id);
  assert.equal(result.status, 'partial'); assert.equal(result.images.length, 0); assert.match(result.text, /公共庭院/);
  assert.match(result.error, /图片暂时无法加载/); assert.deepEqual(calls, [fixture.imageUrl]);
  assert.equal(result.warnings.length, 1); service.dispose();
});

test('preview text, gallery size and network concurrency have explicit bounds', async () => {
  let running = 0, peak = 0, calls = 0;
  const { service, item } = setup({ fetchPage: async () => ({ ...fixture.page, text: 'x'.repeat(100005), images: Array.from({ length: 20 }, (_, index) => ({ url: `https://images.example.org/${index}.png` })) }),
    fetchImage: async url => { running++; peak = Math.max(peak, running); calls++; await new Promise(resolve => setTimeout(resolve, 5)); running--; return { ...await fixture.fetchImage(fixture.imageUrl), sourceUrl: url }; } });
  const result = await service.preview(item.id);
  assert.equal(result.text.length, 100000); assert.equal(result.textTruncated, true);
  assert.equal(result.images.length, 4); assert.equal(peak, 3); assert(calls <= 5);
  service.dispose();
});

test('concurrent preview pages are limited to three and deleted cases are not saved again', async () => {
  let running = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, items, dataDir } = setup({ fetchPage: async () => { running++; peak = Math.max(peak, running); await gate; running--; return { ...fixture.page, images: [] }; } });
  for (let index = 0; index < 6; index++) items.push({ ...items[0], id: `case_${index}` });
  const deleted = items[0]; const promises = items.map(item => service.preview(item.id));
  items.shift(); release(); await Promise.all(promises);
  assert.equal(peak, 3); assert.equal(fs.existsSync(service.cachePath(deleted.id, deleted.sourceUrl)), false);
  assert.equal(fs.readdirSync(path.join(dataDir, 'case-previews')).length, 6); service.dispose();
});

test('malformed or huge embedded images cannot enter bridge output, and stale cache stays labelled', async () => {
  const { service, item } = setup({ fetchImage: async () => ({ dataUrl: 'data:image/svg+xml,<svg onload="evil()"/>' }) });
  const result = await service.preview(item.id); assert.equal(result.images.length, 0); assert.equal(result.warnings.length, 1);
  const file = service.cachePath(item.id, item.sourceUrl), cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  cached.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; fs.writeFileSync(file, JSON.stringify(cached));
  assert.equal((await service.preview(item.id)).stale, true); service.dispose();
});
