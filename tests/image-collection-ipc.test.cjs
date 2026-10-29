'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { registerImageCollectionIpc } = require('../backend/image-collection-ipc.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-image-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'original.png');
  fs.writeFileSync(source, Buffer.from('unchanged-original-file'));
  const assets = new Map([
    ['a', { id: 'a', projectId: 'p1', name: '../../外墙:*', path: source, sourcePageUrl: 'https://design.example/project', sourceUrl: 'https://images.example/original.png', contentType: 'image/png', note: '立面参考', thumbnailUrl: 'data:image/png;base64,AA==', hash: 'content-fingerprint' }],
    ['foreign', { id: 'foreign', projectId: 'p2', path: source }],
  ]);
  const handlers = new Map();
  let currentProject = 'p1';
  const service = {
    get: id => ({ id, projectId: id === 'foreign-session' ? 'p2' : 'p1' }),
    getAsset: id => assets.get(id),
    start: value => value, list: value => value,
    save: value => value, cancel: id => ({ id }), retry: value => value,
  };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) };
  const shell = { showItemInFolder: file => { shell.revealed = file; } };
  registerImageCollectionIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, service,
    backend: { projectId: () => currentProject }, dialog, shell, nativeImage: {}, appDir: root,
  });
  const trusted = { senderFrame: { url: pathToFileURL(path.join(root, 'index.html')).href, parent: null } };
  const call = (name, payload, event = trusted) => handlers.get(`workbench:image-collection-${name}`)(event, payload);
  return { root, source, call, dialog, shell, trusted, service, assets, switchProject: () => { currentProject = 'p2'; } };
}

test('image bridge rejects remote pages and child frames before accessing any project', t => {
  const context = setup(t);
  assert.throws(() => context.call('list', {}, { senderFrame: { url: 'https://example.org', parent: null } }), /无权/);
  assert.throws(() => context.call('list', {}, { senderFrame: { ...context.trusted.senderFrame, parent: {} } }), /无权/);
  assert.throws(() => context.call('list', {}, {}), /无权/);
});

test('all image actions are confined to current project and opaque IDs', t => {
  const { call } = setup(t);
  assert.throws(() => call('start', { projectId: 'p2', sourceUrl: 'https://example.org' }), /项目已切换/);
  assert.throws(() => call('get', 'foreign-session'), /不属于当前项目/);
  assert.throws(() => call('save', { sessionId: 'foreign-session', candidateIds: ['a'] }), /不属于当前项目/);
  assert.throws(() => call('retry', { sessionId: 'foreign-session' }), /不属于当前项目/);
  assert.throws(() => call('reveal', 'foreign'), /不属于当前项目/);
  assert.throws(() => call('reveal', '../../store.json'), /不属于当前项目/);
});

test('export copies originals without overwrite and includes source manifest without internal paths', async t => {
  const { call, source } = setup(t);
  const first = await call('export', { assetIds: ['a', 'a'] });
  const second = await call('export', { assetIds: ['a'] });
  assert.equal(first.count, 1);
  assert.notEqual(first.directory, second.directory);
  const manifestText = fs.readFileSync(path.join(first.directory, 'sources.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.images[0].note, '立面参考');
  assert.equal(manifest.images[0].sourcePageUrl, 'https://design.example/project');
  assert.equal(manifest.images[0].hash, 'content-fingerprint');
  assert.equal(Object.hasOwn(manifest.images[0], 'path'), false);
  assert.equal(manifestText.includes('data:image/'), false);
  assert.equal(path.dirname(path.resolve(first.directory, manifest.images[0].filename)), first.directory);
  assert.deepEqual(fs.readFileSync(path.join(first.directory, manifest.images[0].filename)), fs.readFileSync(source));
  await assert.rejects(call('export', { assetIds: ['foreign'] }), /不属于当前项目/);
});

test('canceling export and switching project during native picker cause no file writes', async t => {
  const context = setup(t);
  context.dialog.showOpenDialog = async () => ({ canceled: true });
  assert.deepEqual(await context.call('export', { assetIds: ['a'] }), { canceled: true });
  context.dialog.showOpenDialog = async () => { context.switchProject(); return { canceled: false, filePaths: [context.root] }; };
  await assert.rejects(context.call('export', { assetIds: ['a'] }), /项目已切换/);
  assert.deepEqual(fs.readdirSync(context.root), ['original.png']);
});

test('article export includes saved body, every original and explicit completion evidence', async t => {
  const context = setup(t);
  context.service.getArticle = ({projectId, articleId}) => {
    assert.equal(projectId, 'p1'); assert.equal(articleId, 'article-fixture');
    return { articleId, projectId, title: '微信建筑文章', text: '完整正文\n第二段', sourceUrl: 'https://mp.weixin.qq.com/s/article', assetIds: ['a'], complete: false, errors: ['另一个图片未完成'] };
  };
  context.assets.get('a').contentType = 'image/gif';
  const result = await context.call('export', { articleId: 'article-fixture' });
  assert.match(fs.readFileSync(path.join(result.directory, 'article.txt'), 'utf8'), /完整正文/);
  const sources = JSON.parse(fs.readFileSync(path.join(result.directory, 'sources.json'), 'utf8'));
  assert.equal(sources.articleId, 'article-fixture'); assert.equal(sources.complete, false);
  assert.equal(sources.images.length, 1); assert.match(sources.images[0].filename, /\.gif$/);
  assert(!fs.readFileSync(path.join(result.directory, 'article.json'), 'utf8').includes(context.root));
});

test('saved HTML import uses native selection and never executes embedded page scripts', async t => {
  const context = setup(t);
  const html = path.join(context.root, 'article.html');
  fs.writeFileSync(html, '<title>导入文章</title><div id="js_content"><p>建筑正文</p><img data-src="https://images.example/original.png"></div><script>globalThis.importExecuted=true</script>');
  context.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [html] });
  context.service.startArticle = (payload, options) => ({ payload, page: options.page });
  const result = await context.call('import', { projectId: 'p1', sourceUrl: 'https://mp.weixin.qq.com/s/article' });
  assert.equal(result.page.imagesComplete, true); assert.equal(result.page.images.length, 1);
  assert.match(result.page.text, /建筑正文/); assert(!result.page.text.includes('importExecuted'));
  assert.equal(globalThis.importExecuted, undefined);
  context.dialog.showOpenDialog = async () => { context.switchProject(); return { canceled: false, filePaths: [html] }; };
  await assert.rejects(context.call('import', { sourceUrl: 'https://mp.weixin.qq.com/s/article' }), /项目已切换/);
});
