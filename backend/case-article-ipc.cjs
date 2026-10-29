'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');

const SCHEME = 'adh-case';
const identifier = /^[a-z0-9_-]{1,200}$/i;
const documentPolicy = "default-src 'none'; img-src adh-case://local; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
const articleUrl = id => `${SCHEME}://local/${encodeURIComponent(id)}/index.html`;
const assetUrl = (caseId, assetId) => `${SCHEME}://local/${encodeURIComponent(caseId)}/images/${encodeURIComponent(assetId)}`;

function registerCaseArticleIpc({ ipcMain, protocol, service, images, backend, appDir }) {
  const trusted = pathToFileURL(path.join(appDir, 'index.html')).href;
  function ownCase(id) {
    if (typeof id !== 'string' || !identifier.test(id)) throw new Error('案例标识无效。');
    const item = service.find(id);
    if (!item || item.projectId !== backend.projectId()) throw new Error('此案例不属于当前项目。');
    return item;
  }
  function mainFrame(event) {
    if (!event.senderFrame || event.senderFrame.parent || event.senderFrame.url !== trusted) throw new Error('此页面不能读取项目案例。');
  }
  ipcMain.handle('workbench:case-article', async (event, id, options) => {
    mainFrame(event); ownCase(id);
    const result = await service.article(id, { refresh: options?.refresh === true });
    ownCase(id);
    const metadata = Object.fromEntries(['status','complete','assetCount','imageCount','missingCount','failures','title','sourceUrl','links','available','updatedAt','archivedAt','retrievedAt','error','message','failedCount','truncated','preservedPrevious'].filter(key => result[key] !== undefined).map(key => [key,result[key]]));
    return { ...metadata, ...(result.available ? { url: `${articleUrl(id)}?v=${encodeURIComponent(String(result.updatedAt || result.archivedAt || result.retrievedAt || 1))}` } : {}) };
  });
  async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== `${SCHEME}:` || url.hostname !== 'local' || url.port || url.username || url.password || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
      const parts = url.pathname.split('/').slice(1).map(value => decodeURIComponent(value));
      const item = ownCase(parts[0]);
      if (parts.length === 2 && parts[1] === 'index.html') {
        const doc = service.articleDocument(item.id);
        if (!doc || typeof doc.html !== 'string' || Buffer.byteLength(doc.html) > 8 * 1024 * 1024) throw new Error('本地文章尚未准备完成。');
        return new Response(request.method === 'HEAD' ? null : doc.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': documentPolicy, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (parts.length !== 3 || parts[1] !== 'images' || !identifier.test(parts[2])) return new Response(null, { status: 404 });
      const asset = images.list({ projectId: item.projectId, caseId: item.id }).find(value => value.id === parts[2]);
      if (!asset) return new Response(null, { status: 404 });
      const thumbnail = url.searchParams.get('thumbnail') === '1' && /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=]+)$/i.exec(asset.thumbnailUrl || '');
      if (thumbnail && asset.thumbnailUrl.length < 256 * 1024) return new Response(request.method === 'HEAD' ? null : Buffer.from(thumbnail[2], 'base64'), { headers: { 'Content-Type': `image/${thumbnail[1].toLowerCase()}`, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
      const stored = images.getAsset(asset.id), stat = fs.statSync(stored.path);
      if (!/^image\/(png|jpeg|webp|gif)$/.test(stored.contentType) || !stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('本地原图不可用。');
      const body = request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(stored.path));
      return new Response(body, { headers: { 'Content-Type': stored.contentType, 'Content-Length': String(stat.size), 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('本地案例资料暂不可用，请返回案例重新加载。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
  }
  protocol?.handle(SCHEME, handle);
  service.previews.localPreview = item => {
    ownCase(item.id);
    let archivedIds;
    try { const saved = service.webArchive?.read(item); if (saved?.assetIds?.length) archivedIds = new Set(saved.assetIds); } catch {}
    const available = images.list({ projectId: item.projectId, caseId: item.id });
    const byId = new Map(available.map(asset => [asset.id, asset]));
    const records = (archivedIds ? [...archivedIds].map(id => byId.get(id)).filter(Boolean) : available).slice(0, 600);
    if (!records.length) return null;
    return { caseId: item.id, status: 'ready', title: item.name, description: item.notes || '', text: '', sourceUrl: item.sourceUrl,
      retrievedAt: item.imageArchive?.updatedAt || item.updatedAt, cached: true, local: true, imageCandidateCount: records.length, hasMoreImages: false,
      images: records.map(asset => ({ dataUrl: `${assetUrl(item.id, asset.id)}?thumbnail=1`, originalUrl: assetUrl(item.id, asset.id), sourceUrl: asset.sourceUrl, alt: asset.name || item.name, width: asset.width, height: asset.height })) };
  };
  return { handle, dispose: () => { protocol?.unhandle(SCHEME); ipcMain.removeHandler('workbench:case-article'); } };
}

module.exports = { registerCaseArticleIpc, articleUrl, assetUrl, documentPolicy, SCHEME };
