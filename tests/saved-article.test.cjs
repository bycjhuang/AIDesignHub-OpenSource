'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readSavedArticle } = require('../backend/saved-article.cjs');
const { ImageCollectionService } = require('../backend/image-collection.cjs');
const fixture = require('./fixtures/smoke-case.cjs');

test('a complete saved webpage imports its companion originals without a network request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-saved-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, '建筑案例_files'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'image.png'), Buffer.from(fixture.imageDataUrl.split(',')[1], 'base64'));
  const file = path.join(root, '建筑案例.html');
  fs.writeFileSync(file, '<title>建筑案例</title><div id="js_content"><p>已通过浏览器阅读的完整正文</p><img src="建筑案例_files/image.png"></div>');
  const imported = readSavedArticle(file, 'https://mp.weixin.qq.com/s/article');
  assert.equal(imported.page.localImageCount, 1);
  assert.match(imported.page.images[0].url, /^https:\/\/saved-article\.aidesignhub\.example\//);
  const service = new ImageCollectionService({ dataDir: path.join(root, 'data'), findProject: () => ({id:'p'}), makeThumbnail: () => '', fetchPage: async () => { throw Error('Network must not be used'); }, fetchImage: async () => { throw Error('Network must not be used'); } });
  t.after(() => service.dispose());
  const archived = await service.collectArticle({ projectId:'p', sourceUrl:'https://mp.weixin.qq.com/s/article' }, imported);
  assert.equal(archived.savedCount, 1, JSON.stringify({ errors: archived.errors, images: archived.images })); assert.equal(archived.complete, true);
  assert.match(archived.text, /完整正文/);
  assert.deepEqual(fs.readFileSync(service.getAsset(archived.assetIds[0]).path), Buffer.from(fixture.imageDataUrl.split(',')[1], 'base64'));
});

test('saved HTML cannot read unrelated or traversing local files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-saved-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'article.html');
  fs.writeFileSync(file, '<p>正文</p><img src="../secret.png"><img src="other_files/secret.png"><img src="file:///C:/secret.png"><img src="article_files/../../secret.png">');
  const imported = readSavedArticle(file, 'https://mp.weixin.qq.com/s/article');
  assert.equal(imported.page.localImageCount, 0);
  assert(!imported.page.images.some(image => image.url.includes('saved-article.aidesignhub.example')));
});
