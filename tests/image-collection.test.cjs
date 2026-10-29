'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { ImageCollectionService, LIMITS } = require('../backend/image-collection.cjs');
const fixture = require('./fixtures/smoke-case.cjs');

function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, bytes])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, name, bytes, checksum]);
}
function png(width = 400, height = 240, color = 120) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, color);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}
const thumb = png(80, 48);
function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-image-test-'));
  const projects = [{ id: 'project_a' }, { id: 'project_b' }];
  const cases = [{ id: 'case_a', projectId: 'project_a' }, { id: 'case_b', projectId: 'project_b' }, { id: 'case_a2', projectId: 'project_a' }];
  const dependencies = { dataDir, findProject: id => projects.find(item => item.id === id), findCase: id => cases.find(item => item.id === id),
    fetchPage: async () => ({ ...fixture.page, finalUrl: 'https://cases.example.org/final', images: [{ url: fixture.imageUrl, alt: '公开项目图' }] }),
    fetchImage: async url => ({ sourceUrl: url, finalUrl: url, dataUrl: fixture.imageDataUrl, contentType: 'image/png' }),
    makeThumbnail: async () => thumb, ...options };
  const service = new ImageCollectionService(dependencies);
  t.after(() => { service.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, dataDir, dependencies, projects, cases };
}
async function settled(service, id) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = service.get(id);
    if (!['discovering', 'loading', 'saving'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Synthetic image task did not settle');
}
async function saveAll(service, id, note = '') {
  const value = service.get(id);
  const pending = service.save({ sessionId: id, candidateIds: value.candidates.filter(item => ['ready', 'duplicate'].includes(item.status)).map(item => item.id), note });
  assert.equal(pending.status, 'saving'); return settled(service, id);
}

test('gooood media IDs enable a validated full-size candidate while retaining the published source and falling back on incompatible images', async t => {
  const published='https://oss.gooood.cn/uploads/2022/11/project-960x600.png', original='https://oss.gooood.cn/uploads/2022/11/project.png', sourceUrl='https://www.gooood.cn/project.htm';
  const calls=[];let compatible=true;
  const {service}=setup(t,{fetchImage:async url=>{calls.push(url);return {sourceUrl:url,finalUrl:url,dataUrl:url===original?compatible?png(1920,1200,80):png(100,100,90):png(960,600,100),contentType:'image/png'};}});
  const articlePage={url:sourceUrl,finalUrl:sourceUrl,title:'项目原文',text:'完整项目原文。',imagesComplete:true,images:[{url:published,alt:'项目图',publisherMediaId:'123',publishedWidth:960,publishedHeight:600}]};
  const first=await service.collectArticle({projectId:'project_a',caseId:'case_a',sourceUrl},{page:articlePage});
  assert.deepEqual(calls,[original]);assert.equal(first.images[0].sourceUrl,published);assert.equal(first.images[0].finalUrl,original);assert.equal(first.images[0].resolutionStatus,'original-available');
  const saved=service.list({projectId:'project_a',caseId:'case_a'})[0];assert.equal(saved.width,1920);assert.equal(saved.sources[0].resolutionStatus,'original-available');
  compatible=false;calls.length=0;
  const fallback=await service.collectArticle({projectId:'project_a',caseId:'case_a2',sourceUrl},{page:articlePage});
  assert.deepEqual(calls,[original,published]);assert.equal(fallback.images[0].resolutionStatus,'published-fallback');assert.match(fallback.images[0].originalError,/尺寸/);assert.equal(fallback.images[0].width,960);
  calls.length=0;
  await service.collectArticle({projectId:'project_a',caseId:'case_a2',sourceUrl:'https://unrelated.example.org/project'},{page:{...articlePage,url:'https://unrelated.example.org/project',finalUrl:'https://unrelated.example.org/project'}});
  assert.deepEqual(calls,[published]);
});

test('a GIF thumbnail decoder failure never discards validated original bytes and a partial retry only downloads missing resources',async t=>{
  const original='https://pictures.example.org/original.png',animatedUrl='https://pictures.example.org/project-animation.gif',sourceUrl='https://cases.example.org/animation-project';
  const single=Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==','base64');single.writeUInt16LE(400,6);single.writeUInt16LE(240,8);const frameStart=single.indexOf(0x2c),animated=Buffer.concat([single.subarray(0,-1),single.subarray(frameStart,single.length-1),Buffer.from([0x3b])]);
  const calls=[];let unavailable=true;
  const {service}=setup(t,{fetchImage:async url=>{calls.push(url);if(url===animatedUrl&&unavailable)throw new Error('临时网络不可用');return {sourceUrl:url,finalUrl:url,dataUrl:url===animatedUrl?`data:image/gif;base64,${animated.toString('base64')}`:png(400,240,100),contentType:url===animatedUrl?'image/gif':'image/png'};},makeThumbnail:async dataUrl=>{if(dataUrl.startsWith('data:image/gif'))throw new Error('图片无法解码。');return thumb;}});
  const page={url:sourceUrl,finalUrl:sourceUrl,title:'动态机制案例',text:'正文和机制动图。',imagesComplete:true,images:[{url:original},{url:animatedUrl}]};
  const first=await service.collectArticle({projectId:'project_a',caseId:'case_a',sourceUrl},{page});
  assert.equal(first.savedCount,1);assert.equal(first.failedCount,1);assert.equal(first.status,'partial');
  unavailable=false;calls.length=0;
  const complete=await service.collectArticle({projectId:'project_a',caseId:'case_a',sourceUrl},{page});
  assert.deepEqual(calls,[animatedUrl]);assert.equal(complete.status,'complete');assert.equal(complete.savedCount,2);assert.equal(complete.failedCount,0);
  const gif=service.list({projectId:'project_a',caseId:'case_a'}).find(image=>image.contentType==='image/gif');assert(gif);assert.equal(gif.thumbnailUrl,'');
  assert(fs.readFileSync(service.getAsset(gif.id).path).equals(animated));
});

test('start is immediate, originals stay on disk, snapshots contain only bounded thumbnails and source metadata', async t => {
  let calls = 0;
  const { service } = setup(t, { fetchPage: async (url, options) => { calls++; assert.equal(options.maxImages, LIMITS.candidates); return { ...fixture.page, finalUrl: 'https://cases.example.org/final' }; } });
  const start = service.start({ projectId: 'project_a', caseId: 'case_a', sourceUrl: fixture.sourceUrl });
  assert.equal(start.status, 'discovering'); assert.equal(calls, 0);
  const result = await settled(service, start.id), candidate = result.candidates[0];
  assert.equal(result.status, 'ready'); assert.deepEqual(result.progress, { done: 1, total: 1 });
  assert.equal(candidate.width, 400); assert.equal(candidate.height, 240); assert.equal(candidate.sourcePageUrl, fixture.sourceUrl);
  assert.equal(candidate.thumbnailUrl, thumb); assert.equal(candidate.path, undefined); assert.equal(candidate.dataUrl, undefined);
  assert(!JSON.stringify(result).includes(fixture.imageDataUrl));
  const original = service.getCandidate(start.id, candidate.id);
  assert(fs.existsSync(original.path)); assert.equal(original.hash, crypto.createHash('sha256').update(fs.readFileSync(original.path)).digest('hex'));
  assert.equal(service.list({ projectId: 'project_a' }).length, 0);
});

test('save is idempotent, content hashes share physical originals, and every page/image source survives restart', async t => {
  const { service, dataDir, dependencies } = setup(t, { fetchPage: async () => ({ ...fixture.page, images: [
    { url: 'https://images.example.org/a.png', alt: '建筑正面' }, { url: 'https://other.example.org/b.png', alt: '同一项目另一来源' }] }) });
  const start = service.start({ projectId: 'project_a', caseId: 'case_a', sourceUrl: fixture.sourceUrl });
  let result = await settled(service, start.id);
  assert.deepEqual(result.candidates.map(item => item.status), ['ready', 'duplicate']);
  service.save({ sessionId: start.id, candidateIds: [result.candidates[0].id], note: '庭院空间参考' });
  result = await settled(service, start.id); assert.equal(result.savedCount, 1);
  let assets = service.list({ projectId: 'project_a', caseId: 'case_a' }); assert.equal(assets.length, 1); assert.equal(assets[0].sources.length, 2);
  assert.equal(assets[0].note, '庭院空间参考'); assert.equal(assets[0].sourcePageUrl, fixture.sourceUrl); assert.equal(assets[0].path, undefined);
  const id = assets[0].id; await saveAll(service, start.id, '更新备注');
  assets = service.list({ projectId: 'project_a' }); assert.equal(assets[0].id, id); assert.equal(assets[0].sources.length, 2); assert.equal(assets[0].note, '更新备注');
  assert.equal(fs.readdirSync(path.join(dataDir, 'image-collection', 'originals')).length, 1);
  assert.equal(fs.readdirSync(path.join(dataDir, 'image-collection', 'staging', start.id)).length, 0);
  assert.equal(service.getCandidate(start.id, result.candidates[0].id).path, service.getAsset(id).path);
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'image-collection', 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets[0].path, undefined); assert.equal(manifest.assets[0].sources[0].pageFinalUrl, fixture.page.finalUrl);
  service.dispose(); const reopened = new ImageCollectionService(dependencies); t.after(() => reopened.dispose());
  assert.equal(reopened.list({ projectId: 'project_a' })[0].id, id); assert(fs.existsSync(reopened.getAsset(id).path));
});

test('case and project ownership is enforced; sharing content across cases preserves project isolation', async t => {
  const { service } = setup(t);
  assert.throws(() => service.start({ sourceUrl: fixture.sourceUrl, projectId: 'project_missing' }), /项目不存在/);
  assert.throws(() => service.start({ sourceUrl: fixture.sourceUrl, projectId: 'project_a', caseId: 'case_b' }), /不属于/);
  assert.throws(() => service.list({ projectId: 'project_a', caseId: 'case_b' }), /不属于/);
  const first = service.start({ projectId: 'project_a', caseId: 'case_a', sourceUrl: fixture.sourceUrl }); await settled(service, first.id); await saveAll(service, first.id);
  const second = service.start({ projectId: 'project_a', caseId: 'case_a2', sourceUrl: 'https://cases.example.org/second' });
  const secondReady = await settled(service, second.id);
  assert.equal(secondReady.candidates[0].savedAssetId, undefined, 'An existing original still needs confirmation for the new source/case');
  assert.equal(secondReady.candidates[0].existingAssetId, service.list({ projectId: 'project_a' })[0].id);
  await saveAll(service, second.id);
  assert.equal(service.list({ projectId: 'project_a' }).length, 1); assert.equal(service.list({ projectId: 'project_a', caseId: 'case_a2' }).length, 1);
  assert.deepEqual(service.list({ projectId: 'project_a' })[0].caseIds, ['case_a', 'case_a2']);
  assert.equal(service.list({ projectId: 'project_b' }).length, 0);
  const third = service.start({ projectId: 'project_b', caseId: 'case_b', sourceUrl: fixture.sourceUrl }); await settled(service, third.id); await saveAll(service, third.id);
  const a = service.list({ projectId: 'project_a' })[0], b = service.list({ projectId: 'project_b' })[0];
  assert.notEqual(a.id, b.id); assert.equal(service.getAsset(a.id).path, service.getAsset(b.id).path); assert.equal(b.sources.length, 1);
});

test('browser discoveries use the same public URL and raster checks; image hotlink retry is explicit, bounded and has no cookies', async t => {
  const calls = [];
  const { service } = setup(t, { capturePage: async (url, options) => {
    options.onCandidates([{ url: 'https://images.example.org/protected.png', sourcePageUrl: url }, { url: 'http://127.0.0.1/private.png' }, { url: 'file:///C:/private.png' }, {}]);
    return { title: '浏览器中可见的建筑', finalUrl: url, images: [{ url: 'https://images.example.org/protected.png' }, { url: 'https://images.example.org/spoof.png' }] };
  }, fetchImage: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('spoof.png')) return { dataUrl: 'data:image/png;base64,PHN2Zz48L3N2Zz4=', contentType: 'image/png' };
    if (!options.referrer) throw Object.assign(new Error('HTTP 403'), { code: 'HTTP_ERROR', statusCode: 403 });
    return { dataUrl: fixture.imageDataUrl, contentType: 'image/png', finalUrl: url };
  } });
  const start = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl, mode: 'browser' }); const result = await settled(service, start.id);
  assert.equal(result.title, '浏览器中可见的建筑'); assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].status, 'ready'); assert.equal(result.candidates[1].status, 'error');
  const protectedCalls = calls.filter(call => call.url.endsWith('protected.png'));
  assert.equal(protectedCalls.length, 2); assert.equal(protectedCalls[0].options.referrer, undefined); assert.equal(protectedCalls[1].options.referrer, fixture.sourceUrl);
  assert(calls.every(call => !call.options.Cookie && !call.options.Authorization));
  assert(!calls.some(call => /127\.0\.0\.1|file:/.test(call.url)));
});

test('retry downloads only failed candidates and keeps successful originals; cancelled reads cannot write late', async t => {
  const counts = new Map(); let failing = true;
  const { service } = setup(t, { fetchPage: async () => ({ ...fixture.page, images: [{ url: 'https://images.example.org/good.png' }, { url: 'https://images.example.org/retry.png' }] }),
    fetchImage: async url => { counts.set(url, (counts.get(url) || 0) + 1); if (url.endsWith('retry.png') && failing) throw new Error('synthetic unavailable'); return { dataUrl: fixture.imageDataUrl, contentType: 'image/png', finalUrl: url }; } });
  const start = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl }); let result = await settled(service, start.id);
  const good = result.candidates.find(item => item.sourceUrl.endsWith('good.png')), failed = result.candidates.find(item => item.status === 'error');
  const original = service.getCandidate(start.id, good.id).path; failing = false;
  assert.equal(service.retry({ sessionId: start.id, candidateIds: [failed.id] }).status, 'loading'); result = await settled(service, start.id);
  assert(result.candidates.every(item => ['ready', 'duplicate'].includes(item.status))); assert.equal(counts.get(good.sourceUrl), 1); assert.equal(counts.get(failed.sourceUrl), 2);
  assert.equal(service.getCandidate(start.id, good.id).path, original);
  assert.throws(() => service.retry({ sessionId: start.id }), /没有可重试/);
});

test('browser candidates produce thumbnails before capture finishes and repeated batches never refetch one source', async t => {
  let finishCapture, sawFirst; const gate = new Promise(resolve => { finishCapture = resolve; });
  const first = new Promise(resolve => { sawFirst = resolve; }); let imageCalls = 0;
  const { service } = setup(t, { capturePage: async (url, { onCandidates }) => {
    onCandidates([{ url: fixture.imageUrl, sourcePageUrl: url }]);
    onCandidates([{ url: fixture.imageUrl, sourcePageUrl: url }]);
    await gate; return { title: '滚动采集', finalUrl: url, images: [{ url: fixture.imageUrl, sourcePageUrl: url }] };
  }, fetchImage: async url => { imageCalls++; return { dataUrl: fixture.imageDataUrl, finalUrl: url, contentType: 'image/png' }; } });
  service.on('changed', value => { if (value.candidates.some(item => item.thumbnailUrl)) sawFirst(value); });
  const start = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl, mode: 'browser' });
  const preview = await first; assert.equal(preview.status, 'discovering'); assert.equal(preview.candidates[0].status, 'ready');
  finishCapture(); const result = await settled(service, start.id); assert.equal(result.status, 'ready'); assert.equal(imageCalls, 1); assert.equal(result.progress.done, 1);
});

test('cancellation remains final despite late readers and an explicit retry can finish without resurrecting old results', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }); const reading = new Promise(resolve => { started = resolve; }); let calls = 0;
  const { service } = setup(t, { fetchImage: async url => { calls++; if (calls === 1) { started(); await gate; } return { dataUrl: fixture.imageDataUrl, contentType: 'image/png', finalUrl: url }; } });
  const start = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl }); await reading;
  assert.equal(service.cancel(start.id).status, 'cancelled');
  assert.throws(() => service.getCandidate(start.id, service.get(start.id).candidates[0].id), /尚未读取成功/);
  service.retry({ sessionId: start.id }); const result = await settled(service, start.id); assert.equal(result.candidates[0].status, 'ready');
  release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.get(start.id).status, 'ready'); assert.equal(service.get(start.id).candidates.length, 1);
});

test('global network concurrency and candidate count are bounded across sessions', async t => {
  let active = 0, peak = 0, calls = 0;
  const { service } = setup(t, { fetchPage: async () => ({ ...fixture.page, images: Array.from({ length: LIMITS.candidates + 20 }, (_, index) => ({ url: `https://images.example.org/${index}.png` })) }),
    fetchImage: async url => { active++; peak = Math.max(peak, active); calls++; await new Promise(resolve => setTimeout(resolve, 1)); active--; return { dataUrl: fixture.imageDataUrl, contentType: 'image/png', finalUrl: url }; } });
  const first = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl });
  const second = service.start({ projectId: 'project_b', sourceUrl: fixture.sourceUrl });
  assert.throws(() => service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl }), /两个/);
  const results = await Promise.all([settled(service, first.id), settled(service, second.id)]);
  assert(peak <= LIMITS.concurrency); assert.equal(calls, LIMITS.candidates * 2); assert(results.every(value => value.candidates.length === LIMITS.candidates && value.truncated));
});

test('untrusted paths, oversized or spoofed images and invalid save selections fail closed', async t => {
  const { service, cases } = setup(t, { fetchImage: async () => ({ dataUrl: `data:image/png;base64,${'A'.repeat(LIMITS.imageBytes * 2)}` }) });
  for (const sourceUrl of ['file:///D:/secret.png', 'http://localhost/', 'https://name:secret@example.org/']) assert.throws(() => service.start({ projectId: 'project_a', sourceUrl }));
  const start = service.start({ projectId: 'project_a', caseId: 'case_a', sourceUrl: fixture.sourceUrl }); const result = await settled(service, start.id);
  assert.equal(result.candidates[0].status, 'error'); assert.equal(service.list({ projectId: 'project_a' }).length, 0);
  assert.throws(() => service.save({ sessionId: start.id, candidateIds: ['../../secret'] }), /尚未读取成功/);
  cases.splice(0, 1); assert.throws(() => service.get(start.id), /不属于/);
});

test('full staging or asset storage reports a bounded failure without creating a partial manifest', async t => {
  const { service, dataDir } = setup(t);
  const actualDiskBytes = service.diskBytes.bind(service);
  service.diskBytes = directory => directory === service.stagingDir ? LIMITS.stagingBytes : actualDiskBytes(directory);
  const full = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl }); const failed = await settled(service, full.id);
  assert.equal(failed.candidates[0].status, 'error'); assert.match(failed.candidates[0].error, /容量上限/);
  service.diskBytes = actualDiskBytes;
  service.retry({ sessionId: full.id }); const ready = await settled(service, full.id); assert.equal(ready.candidates[0].status, 'ready');
  service.diskBytes = directory => directory === service.originalsDir ? LIMITS.assetBytes : actualDiskBytes(directory);
  const saved = await saveAll(service, full.id); assert.equal(saved.savedCount, 0); assert(saved.errors.some(message => /容量上限/.test(message)));
  assert.equal(service.list({ projectId: 'project_a' }).length, 0); assert(!fs.existsSync(path.join(dataDir, 'image-collection', 'manifest.json')));
  assert.equal(fs.readdirSync(service.originalsDir).length, 0);
});

test('saved source corruption is detected and staging cleanup never removes permanent originals', async t => {
  const { service, dataDir } = setup(t);
  const start = service.start({ projectId: 'project_a', sourceUrl: fixture.sourceUrl }); await settled(service, start.id); await saveAll(service, start.id);
  const asset = service.list({ projectId: 'project_a' })[0], original = service.getAsset(asset.id).path;
  const data = fs.readFileSync(original); data[data.length - 1] ^= 1; fs.writeFileSync(original, data);
  assert.throws(() => service.getAsset(asset.id), /校验失败/);
  const after = await saveAll(service, start.id); assert(after.errors.some(message => /校验失败|已变化/.test(message)));
  service.dispose(); assert(fs.existsSync(original)); assert.equal(fs.readdirSync(path.join(dataDir, 'image-collection', 'staging')).length, 0);
});
