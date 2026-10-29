'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePublicHtml } = require('../backend/public-page.cjs');
const { CaseWebArchive, prepareArticlePage, renderDocument } = require('../backend/case-web-archive.cjs');
const { CaseResearchService } = require('../backend/case-research.cjs');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AgentHub } = require('../backend/agent-hub.cjs');

const sourceUrl = 'https://projects.example.org/public/article';
const full = 'https://pictures.example.org/project-original.png', published = 'https://pictures.example.org/project-small.png', second = 'https://pictures.example.org/interior-large.png';
const firstId = 'image_11111111-1111-4111-8111-111111111111', secondId = 'image_22222222-2222-4222-8222-222222222222';
const html = `<!doctype html><html><head><title>滨水文化中心</title></head><body><header><img src="https://ads.example.org/header.jpg"></header><main><article class="entry-content-shell"><p>第一段<strong>设计背景</strong></p><p style="text-align:center;background-image:url(https://private.example.org/track)"><a href="${full}" data-media-id="123"><img src="${published}" width="960" height="600" alt="首层公共界面" onerror="fetch('https://private.example.org')"></a></p><figcaption>第一张图的图注</figcaption><p>第二段与下一张图片紧邻。</p><picture><source srcset="${second} 2400w"><img src="https://pictures.example.org/interior-small.png" alt="二层文化展厅"></picture><table><tr><th>面积</th><td>12000㎡</td></tr></table><p><a href="https://architect.example.org/project">设计方资料</a></p><script>fetch('https://private.example.org/leak')</script><iframe src="file:///C:/secret.txt"></iframe><svg><script>alert(1)</script></svg><div class="article-latest-jobs"><img src="https://jobs.example.org/recruit.jpg">招聘广告</div></article><aside><img src="https://ads.example.org/sidebar.jpg"></aside></main></body></html>`;

function removeDirectory(root){const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('adh-article-test-')); fs.rmSync(resolved, { recursive: true, force: true });}
function directory(t,autoCleanup=true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-article-test-'));
  if(autoCleanup)t.after(() => removeDirectory(root));
  return root;
}
function page() { return prepareArticlePage(parsePublicHtml(html, sourceUrl)); }
function archived() { return { status: 'complete', complete: true, images: [
  { sourceUrl: full, finalUrl: full, assetId: firstId, width: 2400, height: 1500 },
  { sourceUrl: second, finalUrl: second, assetId: secondId, width: 2400, height: 1600 },
] }; }

test('offline article retains text-image order and tables, uses local originals, excludes publisher chrome and active HTML', () => {
  const p = page(), result = renderDocument(p, archived().images, p.articleTemplate);
  assert.equal(p.images.find(item=>item.alt==='二层文化展厅').url,second);
  assert.equal(p.articleTemplate.imageGroups.length, 3); // the explicitly declared background is a missing local image, never a remote request
  assert.equal(result.assetIds.length, 2); assert.equal(result.missing.length, 1);
  assert(result.html.indexOf('第一段') < result.html.indexOf(`images/${firstId}`));
  assert(result.html.indexOf(`images/${firstId}`) < result.html.indexOf('第二段'));
  assert(result.html.indexOf('第二段') < result.html.indexOf(`images/${secondId}`));
  assert.match(result.html, /<table><tr><th>面积<\/th><td>12000㎡<\/td><\/tr><\/table>/);
  assert.match(result.html, /Content-Security-Policy/);
  assert(!/<(?:script|iframe|svg|form|object)\b|\bonerror\s*=|\bsrcset\s*=|<img[^>]+src="https?:/i.test(result.html));
  assert(!result.html.includes('招聘广告')); assert(!result.html.includes('ads.example.org')); assert(!result.html.includes('fetch('));
  assert(result.links.includes('https://architect.example.org/project')); assert(!JSON.stringify(p).includes('rawHtml'));
});

test('responsive originals keep comma-bearing CDN queries intact and prefer the largest declared source',()=>{
  const large='https://pictures.example.org/photo?auto=compress,fit=crop,w=2400',small='https://pictures.example.org/photo?auto=compress,fit=crop,w=960';
  const prepared=prepareArticlePage(parsePublicHtml(`<article><p>项目正文</p><img src="${small}" srcset="${small} 960w, ${large} 2400w"></article>`,sourceUrl));
  assert.equal(prepared.images[0].url,large);assert(prepared.images[0].fallbackUrls.includes(small));assert.equal(prepared.images.length,1);
});

test('publisher media originals are resolved only from inert declared media IDs and no serialized script reaches the document', () => {
  const original = 'https://pictures.example.org/declared-full.png';
  const pool = [{ id: 1, source_url: 2, sizes: 3 }, 123, original, { large: 4 }, { source_url: 5, width: 6, height: 7 }, full, 2400, 1500];
  const p = prepareArticlePage(parsePublicHtml(`<article><p>正文</p><a data-media-id="123" href="${published}"><img src="${published}" width="960" height="600"></a></article><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(pool)}</script>`, sourceUrl));
  assert.equal(p.images[0].url, original); assert.equal(p.images[0].declaredOriginal, true); assert(p.images[0].fallbackUrls.includes(published));
  assert.equal(p.articleTemplate.imageGroups.length, 1); assert(!p.articleTemplate.fragment.includes('__NUXT_DATA__'));
});

test('offline snapshots survive restart, retain source separately, preserve successful mappings on partial reread and reject symlink documents', t => {
  const root = directory(t), archive = new CaseWebArchive(root), item = { id: 'case_local', projectId: 'project_local', sourceUrl };
  const p = prepareArticlePage(parsePublicHtml(`<article><p>原文</p><img src="${full}" alt="原图"></article>`, sourceUrl));
  const saved = archive.save(item, p, archived()); assert.equal(saved.complete, true); assert.equal(saved.assetCount, 1);
  const reopened = new CaseWebArchive(root), document = reopened.document(item); assert.match(document.html, /images\/image_/); assert.deepEqual(document.assetIds, [firstId]);
  assert.equal(fs.readFileSync(archive.paths(item).source, 'utf8'), p.rawHtml);
  const retry = archive.save(item, p, { status: 'partial', complete: false, images: [], errors: ['temporary image outage'] });
  assert.equal(retry.assetCount, 1); assert(!reopened.document(item).html.includes('暂未保存'));
  const foreign = { ...item, projectId: 'other' }; assert.throws(() => reopened.document(foreign), /当前项目/);
  const files = archive.paths(item), moved = `${files.document}.kept`;
  fs.renameSync(files.document, moved);
  try { fs.symlinkSync(moved, files.document); assert.throws(() => reopened.document(item), /文件无效/); } catch (error) { if (error.code !== 'EPERM') throw error; }
});

test('missing-image metadata retains the actual per-image archive failure instead of replacing it with a generic placeholder',t=>{
  const archive=new CaseWebArchive(directory(t)),item={id:'case_failure',projectId:'project_local',sourceUrl};
  const p=prepareArticlePage(parsePublicHtml(`<article><p>项目原文。</p><img src="${full}"></article>`,sourceUrl));
  const saved=archive.save(item,p,{status:'partial',complete:false,errors:[],images:[{sourceUrl:full,assetId:'',error:'原图下载超时，请重试。'}]});
  assert.equal(saved.missingCount,1);assert.deepEqual(saved.failures,[{sourceUrl:full,message:'原图下载超时，请重试。'}]);
});

test('opening legacy cases starts one complete archive without re-running research or external dispatch and later reads remain offline', async t => {
  const root = directory(t,false), backend = new LocalBackend({ dataDir: root }), hub = new AgentHub({ backend }); let reads = 0, downloads = 0;
  const cases = new CaseResearchService({ backend, hub, fetchPage: async (url, options) => { reads++; assert.equal(options.maxImages, 600); assert.equal(options.includeSmallImages, true); return parsePublicHtml(`<article><p>完整正文</p><img src="${full}"><p>图后正文</p><img src="${second}"></article>`, sourceUrl); },
    archiveArticle: async (payload, options) => { downloads++; assert.equal(options.page.images.length, 2); return archived(); } });
  t.after(() => { cases.dispose(); hub.dispose(); removeDirectory(root); });
  const item = backend.addCase({ projectId: 'project_jiangwan', name: '已核准案例', sourceUrl, type: 'culture' });
  cases.update(item.id, value => { value.research = { revision: 1, status: 'verified', fields: { name: { value: '已核准案例', status: 'source-quoted' } } }; });
  const original = JSON.stringify(cases.find(item.id).research);
  assert.equal(cases.article(item.id).status, 'collecting'); assert.equal(cases.article(item.id).status, 'collecting');
  await cases.idle(); const result = cases.article(item.id);
  assert.equal(result.available, true); assert.equal(result.complete, true); assert.equal(result.imageCount, 2); assert.equal(result.assetCount, 2); assert.equal(result.missingCount, 0);
  assert.equal(reads, 1); assert.equal(downloads, 1); assert.equal(JSON.stringify(cases.find(item.id).research), original);
  assert.equal(hub.state.jobs.length, 0); assert.equal(hub.state.runs.length, 0);
  const document = cases.articleDocument(item.id); assert.equal(document.assetIds.length, 2); assert.match(document.html, /图后正文/);
  cases.article(item.id); cases.articleDocument(item.id); assert.equal(reads, 1);
});
