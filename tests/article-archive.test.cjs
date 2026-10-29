'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ImageCollectionService } = require('../backend/image-collection.cjs');
const { parsePublicHtml } = require('../backend/public-page.cjs');
const fixture = require('./fixtures/smoke-case.cjs');
function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-article-'));
  const options = { dataDir, findProject: id => id === 'p' && { id }, findCase: id => id === 'c' && { id, projectId: 'p' },
    makeThumbnail: () => '', fetchPage: async () => { throw new Error('Unexpected page fetch'); },
    fetchImage: async url => ({ sourceUrl: url, finalUrl: url, dataUrl: fixture.imageDataUrl, contentType: 'image/png' }), ...overrides };
  const service = new ImageCollectionService(options);
  t.after(() => { service.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return {service, dataDir, options};
}
const payload = { projectId: 'p', caseId: 'c', sourceUrl: 'https://mp.weixin.qq.com/s/article' };
function page(count = 35) {
  return parsePublicHtml('<title>建筑案例</title><div id="js_content"><p>完整文章正文</p>' + Array.from({length: count}, (_, i) => '<img data-src="https://images.example/' + i + '.png">').join('') + '</div>', payload.sourceUrl);
}
test('entire article archive exceeds the preview batch, deduplicates originals and survives restart', async t => {
  const requested = [];
  const {service, options} = setup(t, { fetchImage: async url => { requested.push(url); return {dataUrl: fixture.imageDataUrl, finalUrl: url}; } });
  const progress = [];
  const result = await service.collectArticle(payload, { page: page(), onProgress: value => progress.push(value.status) });
  assert.equal(requested.length, 35); assert.equal(result.discoveredCount, 35);
  assert.equal(result.complete, true); assert.equal(result.failedCount, 0); assert.equal(result.savedCount, 1);
  assert.equal(result.images.length, 35); assert(result.images.every(image => image.assetId));
  assert(progress.includes('saving')); assert.match(result.text, /完整文章正文/);
  service.dispose(); const restored = new ImageCollectionService(options); t.after(() => restored.dispose());
  assert.equal(restored.getArticle({projectId:'p', caseId:'c', articleId:result.articleId}).text, result.text);
  assert.equal(restored.list({projectId:'p',caseId:'c'}).length, 1);
  assert.throws(() => restored.getArticle({projectId:'other',articleId:result.articleId}), /项目/);
});
test('partial archive keeps original body and the exact failed image rather than claiming all complete', async t => {
  const {service} = setup(t, { fetchImage: async url => { if(url.endsWith('/2.png')) throw new Error('fixture unavailable'); return {dataUrl:fixture.imageDataUrl,finalUrl:url}; } });
  const result = await service.collectArticle(payload, {page:page(4)});
  assert.equal(result.status, 'partial'); assert.equal(result.complete, false);
  assert.equal(result.failedCount, 1); assert.equal(result.images.filter(image=>image.error).length, 1);
  assert.match(service.getArticle({projectId:'p',caseId:'c'}).text, /完整文章正文/);
});
test('WeChat highest-resolution address falls back explicitly to the published image', async t => {
  const requested=[];
  const {service} = setup(t,{fetchImage:async url=>{requested.push(url);if(new URL(url).pathname.endsWith('/0'))throw Error('original unavailable');return {dataUrl:fixture.imageDataUrl,finalUrl:url};}});
  const html='<div id="js_content"><p>正文</p><img data-src="https://mmbiz.qpic.cn/mmbiz_png/fixture/640?wx_fmt=png"></div>';
  const result=await service.collectArticle(payload,{page:parsePublicHtml(html,payload.sourceUrl)});
  assert(requested.some(url=>new URL(url).pathname.endsWith('/0')));
  assert(requested.some(url=>new URL(url).pathname.endsWith('/640')));
  assert.equal(result.savedCount,1);assert.equal(result.images[0].resolutionStatus,'published-fallback');
});
test('saved verification HTML is rejected, inert scripts and non-public image URLs are excluded', () => {
  assert.throws(()=>parsePublicHtml('<p>环境异常，请完成验证</p>',payload.sourceUrl), /验证页/);
  const result=parsePublicHtml('<div id="js_content">正文<script>throw 1</script><img src="file:///C:/private.png"><img src="http://127.0.0.1/private"></div>',payload.sourceUrl);
  assert.equal(result.images.length,0);assert(!result.text.includes('throw'));
});

test('retry of an article session automatically saves only failed downloads and updates durable completion', async t => {
  let failing = true; const calls = [];
  const {service} = setup(t, { fetchImage: async url => { calls.push(url); if (failing && url.endsWith('/2.png')) throw Error('temporary failure'); return {dataUrl:fixture.imageDataUrl,finalUrl:url}; } });
  const first = await service.collectArticle(payload, {page:page(4)}); assert.equal(first.status,'partial');
  failing = false;
  const retry = service.retry({sessionId:first.sessionId}); assert.equal(retry.archiveStatus,'collecting');
  await service.sessions.get(first.sessionId).articleWork;
  const stored = service.getArticle({projectId:'p',caseId:'c',articleId:first.articleId});
  assert.equal(stored.status,'complete'); assert.equal(stored.failedCount,0); assert(stored.images.every(image=>image.assetId));
  assert.equal(calls.filter(url=>url.endsWith('/0.png')).length,1); assert.equal(calls.filter(url=>url.endsWith('/2.png')).length,2);
});

test('an unavailable re-read records an attempt and preserves the last complete offline article', async t => {
  const {service} = setup(t);
  const first = await service.collectArticle(payload,{page:page(2)});
  service.fetchPage = async () => { throw Error('verification required'); };
  const failed = await service.collectArticle(payload); assert.equal(failed.status,'error');
  const stored = service.getArticle({projectId:'p',caseId:'c',articleId:first.articleId});
  assert.equal(stored.complete,true); assert.equal(stored.text,first.text); assert.deepEqual(stored.assetIds,first.assetIds);
  assert.equal(stored.lastAttempt.status,'error');
});

test('a partial re-read cannot drop a prior successful original mapping', async t => {
  let fail = false;
  const {service} = setup(t,{fetchImage:async url=>{if(fail)throw Error('offline');return {dataUrl:fixture.imageDataUrl,finalUrl:url};}});
  const first = await service.collectArticle(payload,{page:page(2)}); fail=true;
  await service.collectArticle(payload,{page:page(2)});
  const stored=service.getArticle({projectId:'p',caseId:'c'}); assert.deepEqual(stored.assetIds,first.assetIds); assert.equal(stored.lastAttempt.status,'partial');
});

test('browser article text is archived while image-only capture never claims full article completion', async t => {
  let body = '';
  const {service} = setup(t,{capturePage:async url=>({finalUrl:url,title:'动态文章',text:body,description:'动态简介',images:[{url:'https://images.example/a.png'}]})});
  const onlyImages=await service.collectArticle({...payload,mode:'browser'}); assert.equal(onlyImages.status,'partial'); assert.equal(onlyImages.complete,false);
  body='浏览器里真实呈现的文章正文';
  const article=await service.collectArticle({...payload,mode:'browser'}); assert.equal(article.status,'complete'); assert.equal(article.text,body); assert.equal(article.description,'动态简介');
});

test('only trusted service options can inject a scoped local-image reader', async t => {
  const {service}=setup(t,{fetchImage:async()=>{throw Error('public network unavailable');}});
  let calls=0;
  const result=await service.collectArticle({...payload,fetchImage:'renderer supplied'}, {page:page(2),fetchImage:async url=>{calls++;return {dataUrl:fixture.imageDataUrl,finalUrl:url};}});
  assert.equal(calls,2); assert.equal(result.complete,true);
  const rejected=await service.collectArticle({...payload,fetchImage:()=>({dataUrl:fixture.imageDataUrl})},{page:page(2)}); assert.equal(rejected.savedCount,0);
});

test('manual cancel of an article session never restarts it as an automatic save', async t => {
  let release, started; const waiting=new Promise(resolve=>{started=resolve;}); const blocked=new Promise(resolve=>{release=resolve;});
  const {service}=setup(t,{fetchImage:async url=>{if(url.endsWith('/1.png')){started();await blocked;}return {dataUrl:fixture.imageDataUrl,finalUrl:url};}});
  const initial=service.startArticle(payload,{page:page(2)}); await waiting;
  assert.equal(service.cancel(initial.id).status,'cancelled'); release(); await service.sessions.get(initial.id).articleWork;
  assert.equal(service.get(initial.id).status,'cancelled'); assert.equal(service.get(initial.id).archiveStatus,'cancelled'); assert.equal(service.list({projectId:'p'}).length,0);
});

test('article files above the old 8 MiB limit remain readable while redirected archive directories are rejected', t => {
  const {service,dataDir}=setup(t); const articleId='article_'+'a'.repeat(64), directory=path.join(dataDir,'image-collection','articles');
  const file=path.join(directory,articleId+'.json');
  fs.writeFileSync(file,JSON.stringify({version:1,articleId,projectId:'p',caseId:'c',archivedAt:new Date().toISOString(),images:[],text:'正文',sourceMetadata:'x'.repeat(9*1024*1024)}));
  assert.equal(service.getArticle({projectId:'p',caseId:'c',articleId}).text,'正文');
  const displaced=directory+'-original'; fs.renameSync(directory,displaced);
  try { fs.symlinkSync(displaced,directory,'junction'); }
  catch(cause){fs.renameSync(displaced,directory);if(['EPERM','EACCES'].includes(cause.code)){t.diagnostic('Directory symlink creation unavailable');return;}throw cause;}
  assert.throws(()=>service.getArticle({projectId:'p',caseId:'c',articleId}),/目录无效/);
  fs.unlinkSync(directory); fs.renameSync(displaced,directory);
});

test('three concurrent case archives queue for bounded collector slots instead of failing the third case', async t => {
  let active=0, peak=0;
  const {service}=setup(t,{fetchImage:async url=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,12));active--;return {dataUrl:fixture.imageDataUrl,finalUrl:url};}});
  const work=Array.from({length:3},(_,index)=>service.collectArticle({...payload,sourceUrl:payload.sourceUrl+index},{page:page(4)}));
  const results=await Promise.all(work); assert(results.every(result=>result.complete)); assert.equal(results.length,3); assert(peak<=3);
  assert.equal(service.sessions.size,3);
});

test('queued article cancellation and service disposal settle without creating a third session', async t => {
  let release; const blocked=new Promise(resolve=>{release=resolve;});
  const {service}=setup(t,{fetchImage:async url=>{await blocked;return {dataUrl:fixture.imageDataUrl,finalUrl:url};}});
  const first=service.startArticle(payload,{page:page(1)}), second=service.startArticle({...payload,sourceUrl:payload.sourceUrl+'2'},{page:page(1)});
  const controller=new AbortController(); const queued=service.collectArticle({...payload,sourceUrl:payload.sourceUrl+'3'},{page:page(1),signal:controller.signal});
  controller.abort(Error('cancel queued')); await assert.rejects(queued,/cancel queued/); assert.equal(service.sessions.size,2);
  const disposed=service.collectArticle({...payload,sourceUrl:payload.sourceUrl+'4'},{page:page(1)});
  service.dispose(); release(); await assert.rejects(disposed,/已关闭/);
  await Promise.allSettled([service.sessions.get(first.id).articleWork,service.sessions.get(second.id).articleWork]);
});
