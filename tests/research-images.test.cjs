'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { ImageCollectionService } = require('../backend/image-collection.cjs');
const { parsePublicHtml } = require('../backend/public-page.cjs');
const { ResearchImageService, selectResearchImages } = require('../backend/research-images.cjs');

function png(width, height, color = 120) {
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, bytes])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, color);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}
const hi = png(1800, 1000), small = png(400, 240), thumb = png(60, 40);
const source = 'https://architecture.example.org/project';
const page = (images, extra = {}) => ({ title: '庭院案例', text: '项目采用庭院布局，建筑面积为1200平方米。', finalUrl: source, images, ...extra });
function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-research-images-'));
  const collection = new ImageCollectionService({ dataDir, findProject: id => id === 'p' ? { id } : null,
    findCase: id => id === 'c' ? { id, projectId: 'p' } : null,
    makeThumbnail: () => thumb, fetchPage: async () => page([]), fetchImage: async url => ({ finalUrl: url, dataUrl: hi, contentType: 'image/png' }), ...options });
  t.after(() => { collection.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { collection, service: new ResearchImageService({ collection }), dataDir };
}

test('HTML context distinguishes article/gallery from recommendations, unknown metadata and sidebars', () => {
  const parsed = parsePublicHtml('<html><head><title>庭院项目</title><meta property="og:image" content="/cover.png"></head><body class="jv-banner-header"><main><article class="project-content"><p>项目正文</p><img src="/court.png"><div class="related-projects"><img src="/other.png"></div><img src="/second.png"></article><aside><img src="/aside.png"></aside></main><div><img src="/unknown.png"></div><div id="js_content"><img src="/wechat.png"></div></body></html>', source);
  const scopes = Object.fromEntries(parsed.images.map(item => [new URL(item.url).pathname, item.contentScope]));
  assert.equal(scopes['/court.png'], 'article'); assert.equal(scopes['/second.png'], 'article'); assert.equal(scopes['/wechat.png'], 'article');
  assert.equal(scopes['/other.png'], 'excluded'); assert.equal(scopes['/cover.png'], 'unknown'); assert.equal(scopes['/unknown.png'], 'unknown');
  const chosen = selectResearchImages(parsed, { url: source, imageUrls: ['https://architecture.example.org/other.png', 'https://architecture.example.org/unknown.png', 'https://images.example.org/not-published.png'] });
  assert.deepEqual(new Set(chosen.images.map(item => new URL(item.url).pathname)), new Set(['/court.png', '/second.png', '/wechat.png', '/unknown.png']));
  assert(chosen.rejected.some(item => item.reason === 'not-found-on-page')); assert(chosen.rejected.some(item => item.reason === 'unrelated-page-region'));
});

test('published high resolution variants match article image identity without inventing download URLs', () => {
  const smallUrl = 'https://images.adsttc.com/media/images/123/medium_jpg/court.jpg?1';
  const largeUrl = 'https://images.adsttc.com/media/images/123/large_jpg/court.jpg?2';
  const result = selectResearchImages(page([{ url: smallUrl, contentScope: 'article' }, { url: largeUrl, contentScope: 'unknown' },
    { url: 'https://images.adsttc.com/media/images/other/large_jpg/court.jpg', contentScope: 'unknown' }]), { url: source });
  assert.deepEqual(result.images.map(item => item.url), [largeUrl, smallUrl]);
  assert.equal(result.images[0].relevanceMethod, 'published-variant-of-article-image');
  assert.equal(result.rejected[0].reason, 'relevance-needs-review');
});

test('publisher gallery JSON exposes declared large images without evaluating code or requiring original-size login', () => {
  const state = JSON.stringify([{ url_large: 'https://images.adsttc.com/media/a/large_jpg/court.jpg', url_slideshow: 'https://images.adsttc.com/media/a/slideshow/court.jpg', image_alt: '庭院项目' }]).replaceAll('"', '&quot;');
  const galleryUrl = 'https://www.archdaily.com/123/courtyard/photo';
  const parsed = parsePublicHtml(`<title>画廊 庭院项目 / 建筑事务所 - 1</title><div id="gallery-items" data-images="${state}"></div>`, galleryUrl);
  assert.equal(parsed.images[0].url, 'https://images.adsttc.com/media/a/large_jpg/court.jpg'); assert.equal(parsed.images[0].contentScope, 'article');
  assert.equal(selectResearchImages(parsed, { url: source }).images.length, 2);
});

test('gallery ids alone never certify relevance; unrelated publisher gallery captions require review', () => {
  const images = [{ url: 'https://images.adsttc.com/media/a/large_jpg/court.jpg', alt: '庭院项目 - 图1', contentScope: 'article', context: 'div gallery-items' },
    { url: 'https://images.adsttc.com/media/b/large_jpg/house.jpg', alt: '另一住宅项目 - 图1', contentScope: 'article', context: 'div gallery-items' }];
  const known = page(images, { title: '画廊 庭院项目 / 建筑事务所 - 1', finalUrl: 'https://www.archdaily.com/123/courtyard/photo' });
  const result = selectResearchImages(known, { url: known.finalUrl });
  assert.deepEqual(result.images.map(item => item.url), [images[0].url]); assert.equal(result.rejected[0].reason, 'relevance-needs-review');
  const unknown = selectResearchImages({ ...known, finalUrl: source }, { url: source });
  assert.equal(unknown.images.length, 0); assert.equal(unknown.rejected.length, 2);
});

test('official Kokaistudios project storyboard backgrounds are scoped without accepting unrelated body or recommendation images', () => {
  const url = 'https://kokaistudios.com/portfolio/shanghai-suhe-mixc-world.html';
  const html = '<title>Shanghai Suhe MixC World</title><h1>Shanghai Suhe MixC World</h1><div style="background-image:url(/upload/body.jpg)"></div><div class="block storyboard main"><div class="slide"><img src="/images/spacer/spacer_16-9.png"><div class="image" style="background-image:url(/upload/project.jpg)"></div><div class="recommended"><div style="background-image:url(/upload/other.jpg)"></div></div></div></div>';
  const parsed = parsePublicHtml(html, url), selected = selectResearchImages(parsed, { url });
  assert.deepEqual(selected.images.map(item => item.url), ['https://kokaistudios.com/upload/project.jpg']);
  assert(selected.rejected.some(item => item.url.endsWith('/body.jpg') && item.reason === 'relevance-needs-review'));
  assert(selected.rejected.some(item => item.url.endsWith('/other.jpg') && item.reason === 'unrelated-page-region'));
  assert(selected.rejected.some(item => item.url.includes('/spacer/') && item.reason === 'unrelated-page-region'));
  const wrongSite = parsePublicHtml(html, 'https://architecture.example.org/portfolio/test.html');
  assert.equal(selectResearchImages(wrongSite, { url: wrongSite.url }).images.length, 0);
});

test('multiple sources preserve provenance, hash-deduplicate originals and reject low actual resolution before saving', async t => {
  const calls = [];
  const { service, collection, dataDir } = setup(t, { fetchImage: async url => { calls.push(url); return { finalUrl: url.replace('images.example.org', 'cdn.example.org'), dataUrl: url.endsWith('/small.png') ? small : hi, contentType: 'image/png' }; } });
  const result = await service.archiveSources({ projectId: 'p', caseId: 'c', sources: [
    { url: source, page: page([{ url: 'https://images.example.org/a.png', contentScope: 'article' }, { url: 'https://images.example.org/small.png', width: 9000, height: 6000, contentScope: 'article' }, { url: 'https://images.example.org/promo.png', contentScope: 'excluded' }]) },
    { url: `${source}-second`, page: page([{ url: 'https://images.example.org/b.png', contentScope: 'article' }], { finalUrl: `${source}-second` }) }
  ] });
  assert.equal(result.images.length, 1); assert.equal(result.assetIds.length, 1);
  assert.equal(result.images[0].width, 1800); assert.equal(result.images[0].height, 1000); assert.equal(result.images[0].path, undefined);
  assert.equal(result.images[0].sources.length, 2); assert.equal(result.sources[0].savedCount, 1); assert.equal(result.sources[1].savedCount, 1);
  assert(result.rejected.some(item => item.reason === 'below-resolution-threshold' && item.width === 400));
  assert(!calls.some(url => url.endsWith('/promo.png'))); assert.equal(collection.list({ projectId: 'p', caseId: 'c' }).length, 1);
  assert.equal(fs.readdirSync(path.join(dataDir, 'image-collection', 'originals')).length, 1);
  assert(fs.existsSync(collection.getAsset(result.assetIds[0]).path));
  assert.equal(result.policy.imageUnderstanding, false); assert.equal(result.images[0].resolutionStatus, 'downloaded-high-resolution');
});

test('the same page and content shared by two cases retain both case associations and per-case provenance', async t => {
  const { service, collection } = setup(t, { findCase: id => ['c', 'c2'].includes(id) ? { id, projectId: 'p' } : null });
  const sharedPage = page([{ url: 'https://images.example.org/shared.png', contentScope: 'article' }]);
  const result = await service.archiveSources({ projectId: 'p', sources: [{ url: source, caseId: 'c', page: sharedPage }, { url: source, caseId: 'c2', page: sharedPage }] });
  assert.equal(result.status, 'complete'); assert.equal(result.images.length, 1);
  assert.deepEqual(new Set(result.images[0].caseIds), new Set(['c', 'c2']));
  assert.deepEqual(new Set(result.images[0].sources.map(item => item.caseId)), new Set(['c', 'c2']));
  assert.deepEqual(result.sources.map(item => item.caseId), ['c', 'c2']);
  assert.equal(collection.list({ projectId: 'p', caseId: 'c' }).length, 1); assert.equal(collection.list({ projectId: 'p', caseId: 'c2' }).length, 1);
  assert.equal(result.sources[1].downloads[0].caseId, 'c2');
});

test('unknown images require explicit published selection; injected image URLs are never downloaded', async t => {
  const calls = [];
  const { service } = setup(t, { fetchImage: async url => { calls.push(url); return { finalUrl: url, dataUrl: hi, contentType: 'image/png' }; } });
  const result = await service.archiveSources({ projectId: 'p', sources: [{ url: source,
    imageUrls: ['https://images.example.org/selected.png', 'https://injected.example.org/fake.png'],
    page: page([{ url: 'https://images.example.org/selected.png', contentScope: 'unknown' }, { url: 'https://images.example.org/unconfirmed.png', contentScope: 'unknown' }]) }] });
  assert.deepEqual(calls, ['https://images.example.org/selected.png']); assert.equal(result.images.length, 1);
  assert(result.rejected.some(item => item.reason === 'relevance-needs-review')); assert(result.rejected.some(item => item.reason === 'not-found-on-page'));
});

test('failed sources preserve successful local results and never claim complete research', async t => {
  const { service } = setup(t, { fetchPage: async url => { if (url.endsWith('/blocked')) throw new Error('网页要求验证，未取得正文。'); return page([{ url: 'https://images.example.org/a.png', contentScope: 'article' }]); } });
  const result = await service.archiveSources({ projectId: 'p', sources: [{ url: source }, { url: 'https://architecture.example.org/blocked' }, { url: 'http://127.0.0.1/private' }] });
  assert.equal(result.status, 'partial'); assert.equal(result.images.length, 1); assert.equal(result.sources[1].status, 'error'); assert.equal(result.sources[2].status, 'error');
  assert.match(result.sources[1].errors.join(' '), /验证/);
});

test('an original that fails final integrity retrieval keeps the remaining archive partial', async t => {
  const other = png(1800, 1000, 121);
  const { service, collection } = setup(t, { fetchImage: async url => ({ finalUrl: url, dataUrl: url.endsWith('b.png') ? other : hi, contentType: 'image/png' }) });
  const getAsset = collection.getAsset.bind(collection);
  collection.getAsset = id => { if (collection.assets.find(item => item.id === id)?.sourceUrl.endsWith('b.png')) throw new Error('原图内容校验失败'); return getAsset(id); };
  const result = await service.archiveSources({ projectId: 'p', sources: [{ url: source, page: page([
    { url: 'https://images.example.org/a.png', contentScope: 'article' }, { url: 'https://images.example.org/b.png', contentScope: 'article' }
  ]) }] });
  assert.equal(result.sources[0].status, 'complete'); assert.equal(result.status, 'partial'); assert.equal(result.images.length, 1);
  assert.match(result.errors.join(' '), /内容校验失败/);
});

test('cancelled tasks do not save images and cross-project cases fail before network access', async t => {
  let calls = 0;
  const { service, collection } = setup(t, { fetchPage: async () => { calls++; return page([]); } });
  await assert.rejects(service.archiveSources({ projectId: 'p', caseId: 'foreign', sources: [{ url: source }] }), /案例不存在/);
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  const result = await service.archiveSources({ projectId: 'p', sources: [{ url: source }], signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.images.length, 0); assert.equal(collection.list({ projectId: 'p' }).length, 0); assert.equal(calls, 0);
});

test('cancellation during a download cancels the collector before any original is archived', async t => {
  const controller = new AbortController(); let started;
  const active = new Promise(resolve => { started = resolve; });
  const { service, collection } = setup(t, { fetchImage: (_url, options) => new Promise((_resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const pending = service.archiveSources({ projectId: 'p', signal: controller.signal, sources: [{ url: source, page: page([{ url: 'https://images.example.org/a.png', contentScope: 'article' }]) }] });
  await active; controller.abort(new Error('用户取消')); const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.sources[0].status, 'cancelled'); assert.equal(collection.list({ projectId: 'p' }).length, 0);
});

function waitingSaveCollection(onSave) {
  const collection = new EventEmitter();
  const value = { id: 'session', status: 'ready', errors: [], candidates: [{ id: 'candidate', sourceUrl: 'https://images.example.org/a.png', status: 'ready', width: 1800, height: 1000 }] };
  collection.assertScope = () => {};
  collection.start = () => structuredClone(value);
  collection.get = () => structuredClone(value);
  collection.getCandidate = () => ({ hash: 'same-content' });
  collection.save = () => { value.status = 'saving'; value.candidates[0].savedAssetId = 'asset'; onSave?.(); };
  collection.cancel = () => { value.status = 'cancelled'; collection.emit('changed', structuredClone(value)); };
  collection.getAsset = () => ({ id: 'asset', projectId: 'p', width: 1800, height: 1000, sources: [{ sourcePageUrl: source }] });
  return collection;
}

test('deadline during the final save cannot resolve as complete through a synchronous cancelled event', async () => {
  const collection = waitingSaveCollection(), service = new ResearchImageService({ collection, sessionTimeoutMs: 10 });
  const result = await service.archiveSources({ projectId: 'p', sources: [{ url: source, page: page([{ url: 'https://images.example.org/a.png', contentScope: 'article' }]) }] });
  assert.equal(result.status, 'partial'); assert.equal(result.images.length, 1); assert.equal(result.sources[0].savedCount, 1);
  assert.equal(result.sources[0].status, 'error'); assert.match(result.sources[0].errors.join(' '), /达到时限/);
});

test('cancellation during the final save retains already archived originals while keeping cancelled status', async () => {
  const controller = new AbortController(), collection = waitingSaveCollection(() => controller.abort(new Error('用户取消')));
  const service = new ResearchImageService({ collection, sessionTimeoutMs: 10 });
  const result = await service.archiveSources({ projectId: 'p', signal: controller.signal, sources: [{ url: source, page: page([{ url: 'https://images.example.org/a.png', contentScope: 'article' }]) }] });
  assert.equal(result.status, 'cancelled'); assert.equal(result.images.length, 1); assert.equal(result.sources[0].status, 'cancelled');
});
