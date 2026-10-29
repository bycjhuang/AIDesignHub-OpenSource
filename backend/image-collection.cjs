'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { validatePublicUrl, fetchPublicPage, fetchPublicImage, validateRasterImage } = require('./public-page.cjs');

const LIMITS = Object.freeze({ candidates: 600, imageBytes: 8 * 1024 * 1024, sessionBytes: 96 * 1024 * 1024,articleSessionBytes:192*1024*1024,
  stagingBytes: 256 * 1024 * 1024, assetBytes: 512 * 1024 * 1024, assets: 1000, sessions: 6,
  activeSessions: 2, concurrency: 3, thumbnailBytes: 48 * 1024, sessionTimeoutMs: 180000 });
const MIME_EXTENSION = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });
const ACTIVE = new Set(['discovering', 'loading', 'saving']);
const copy = value => JSON.parse(JSON.stringify(value));
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const identifier = prefix => `${prefix}_${crypto.randomUUID()}`;
const failure = cause => String(cause?.message || cause || '图片采集失败。').slice(0, 400);
const immediate = () => new Promise(resolve => setImmediate(resolve));
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('采集已取消。'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('采集已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function raster(dataUrl, maxBytes = LIMITS.imageBytes, allowSmall = false, allowAnimation = false) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxBytes * 4 / 3) + 100) throw new Error('图片超过单张读取上限。');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z\d+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new Error('仅支持经过验证的 PNG、JPEG、GIF 或静态 WebP 图片。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== match[2]) throw new Error('图片编码或大小无效。');
  const info = validateRasterImage(bytes, match[1].toLowerCase(), { allowSmall, allowAnimation });
  return { bytes, ...info };
}
function thumbnail(value) {
  if (!value) return '';
  try { const info = raster(value, LIMITS.thumbnailBytes, true); return info.width <= 1024 && info.height <= 1024 ? value : ''; } catch { return ''; }
}
// WeChat's public image CDN uses a numeric final path segment for resized
// variants. /0 is only a candidate: if unavailable, retain the published URL.
function originalImageUrl(value,candidate={}) {
  const url = validatePublicUrl(value);
  if (url.hostname === 'mmbiz.qpic.cn' && /^\/mmbiz_[a-z\d]+\/[^/]+\/[1-9]\d*\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/[1-9]\d*\/?$/, '/0'); return url.href;
  }
  let publisher;try{publisher=new URL(candidate.sourcePageUrl).hostname;}catch{}
  // A narrowly scoped WordPress publication-size candidate, checked against
  // actual decoded dimensions below; failures retain the published resource.
  if(['www.gooood.cn','gooood.cn'].includes(publisher)&&url.hostname==='oss.gooood.cn'&&/^\d{1,12}$/.test(candidate.publisherMediaId||'')&&/^\/uploads\/\d{4}\/\d{2}\/[^/]+-\d{2,5}x\d{2,5}\.(?:jpe?g|png|webp)$/i.test(url.pathname)){
    url.pathname=url.pathname.replace(/-\d{2,5}x\d{2,5}(\.(?:jpe?g|png|webp))$/i,'$1');return url.href;
  }
  return url.href;
}

class ImageCollectionService extends EventEmitter {
  constructor({ dataDir, findCase, findProject, fetchPage = fetchPublicPage, fetchImage = fetchPublicImage, capturePage, makeThumbnail } = {}) {
    super();
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof findProject !== 'function') throw new Error('图片素材服务需要绝对数据目录与项目校验器。');
    this.root = path.join(dataDir, 'image-collection');
    this.originalsDir = path.join(this.root, 'originals'); this.stagingDir = path.join(this.root, 'staging');
    this.articlesDir = path.join(this.root, 'articles');
    this.manifestPath = path.join(this.root, 'manifest.json');
    for (const dir of [this.root, this.originalsDir, this.stagingDir, this.articlesDir]) fs.mkdirSync(dir, { recursive: true });
    this.articlesRealDir = fs.realpathSync(this.articlesDir);
    this.findProject = findProject; this.findCase = findCase || (() => null);
    this.fetchPage = fetchPage; this.fetchImage = fetchImage; this.capturePage = capturePage;
    this.makeThumbnail = makeThumbnail || (dataUrl => thumbnail(dataUrl));
    this.sessions = new Map(); this.stopped = false; this.activeImages = 0; this.imageQueue = []; this.saveTail = Promise.resolve();
    this.assets = this.readManifest();
    // Staging is expendable and contains only service-generated UUID directories.
    for (const entry of fs.readdirSync(this.stagingDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^session_[a-f\d-]{36}$/.test(entry.name)) this.removeStaging(path.join(this.stagingDir, entry.name));
    }
  }
  assertOpen() { if (this.stopped) throw new Error('图片素材服务已关闭。'); }
  assertScope(projectId, caseId) {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || !this.findProject(projectId)) throw new Error('项目不存在。');
    if (caseId !== undefined && caseId !== null && (typeof caseId !== 'string' || !caseId || caseId.length > 200)) throw new Error('案例标识无效。');
    if (caseId && this.findCase(caseId)?.projectId !== projectId) throw new Error('案例不存在或不属于当前项目。');
  }
  session(id) {
    this.assertOpen(); const session = this.sessions.get(id);
    if (!session) throw new Error('图片采集会话不存在或已过期，请重新采集。');
    this.assertScope(session.value.projectId, session.value.caseId); return session;
  }
  activeSessionCount() {
    return [...this.sessions.values()].filter(session => ACTIVE.has(session.value.status) || session.value.archiveStatus === 'collecting').length;
  }
  snapshot(session) { return copy(session.value); }
  changed(session) { if (!this.stopped && this.listenerCount('changed')) this.emit('changed', this.snapshot(session)); }
  get(id) { return this.snapshot(this.session(id)); }
  current(session, generation) { return !this.stopped && session.generation === generation && !session.controller.signal.aborted; }
  removeStaging(directory) {
    const resolved = path.resolve(directory), base = path.resolve(this.stagingDir);
    if (path.dirname(resolved) !== base || !/^session_[a-f\d-]{36}$/.test(path.basename(resolved))) throw new Error('临时图片路径无效。');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  readManifest() {
    if (!fs.existsSync(this.manifestPath)) return [];
    if (fs.statSync(this.manifestPath).size > 72 * 1024 * 1024) throw new Error('图片素材清单超过读取上限。');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')); } catch { throw new Error('图片素材清单损坏，请保留数据并恢复备份。'); }
    if (value.version !== 1 || !Array.isArray(value.assets) || value.assets.length > LIMITS.assets) throw new Error('图片素材清单格式无效。');
    const ids = new Set();
    for (const asset of value.assets) {
      if (!asset || !/^image_[a-f\d-]{36}$/.test(asset.id) || ids.has(asset.id) || !/^[a-f\d]{64}$/.test(asset.hash)
        || !Object.hasOwn(MIME_EXTENSION, asset.contentType) || !Number.isInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > LIMITS.imageBytes
        || typeof asset.projectId !== 'string' || !Array.isArray(asset.sources) || asset.sources.length > 300 || !Array.isArray(asset.caseIds)) throw new Error('图片素材清单包含无效记录。');
      ids.add(asset.id);
      asset.thumbnailUrl = thumbnail(asset.thumbnailUrl);
      // Never accept a stored path from disk or a renderer. Paths are derived
      // exclusively from a validated content hash and a fixed MIME extension.
      delete asset.path; delete asset.filePath; delete asset.relativePath;
    }
    return value.assets;
  }
  persist() {
    const temporary = `${this.manifestPath}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, assets: this.assets }), { flag: 'wx' }); fs.renameSync(temporary, this.manifestPath); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  diskBytes(directory) {
    let total = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile()) total += fs.statSync(file).size;
      else if (directory === this.stagingDir && entry.isDirectory() && /^session_[a-f\d-]{36}$/.test(entry.name)) total += this.diskBytes(file);
    }
    return total;
  }
  assetPath(asset) { return path.join(this.originalsDir, `${asset.hash}.${MIME_EXTENSION[asset.contentType]}`); }
  safeFile(file, expectedBytes, expectedHash) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMITS.imageBytes || expectedBytes && stat.size !== expectedBytes) throw new Error('图片原文件无效或已被修改。');
    if (expectedHash && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expectedHash) throw new Error('图片原文件内容校验失败，请重新采集。');
    return file;
  }
  publicAsset(asset, caseId) {
    return { id: asset.id, projectId: asset.projectId, caseId: caseId || asset.caseId || null, caseIds: [...asset.caseIds],
      sourceUrl: asset.sourceUrl, sourcePageUrl: asset.sourcePageUrl, finalUrl: asset.finalUrl, name: asset.name, note: asset.note || '',
      width: asset.width, height: asset.height, byteLength: asset.byteLength, contentType: asset.contentType,
      thumbnailUrl: asset.thumbnailUrl, createdAt: asset.createdAt, updatedAt: asset.updatedAt, sources: copy(asset.sources) };
  }
  list({ projectId, caseId } = {}) {
    this.assertOpen(); this.assertScope(projectId, caseId);
    return this.assets.filter(asset => asset.projectId === projectId && (!caseId || asset.caseIds.includes(caseId))).map(asset => this.publicAsset(asset, caseId));
  }
  getAsset(id) {
    this.assertOpen(); const asset = this.assets.find(item => item.id === id);
    if (!asset) throw new Error('图片素材不存在。');
    this.assertScope(asset.projectId);
    return { ...this.publicAsset(asset), path: this.safeFile(this.assetPath(asset), asset.byteLength, asset.hash), hash: asset.hash };
  }
  getCandidate(sessionId, candidateId) {
    const session = this.session(sessionId), candidate = session.value.candidates.find(item => item.id === candidateId), stored = session.files.get(candidateId);
    if (!candidate || !stored) throw new Error('此图片尚未读取成功，无法查看原图。');
    return { ...copy(candidate), path: this.safeFile(stored.path, candidate.byteLength, stored.hash), hash: stored.hash, finalUrl: stored.finalUrl };
  }
  start(payload = {}, options = {}) {
    this.assertOpen(); this.assertScope(payload.projectId, payload.caseId);
    const sourceUrl = text(payload.sourceUrl, 8193); validatePublicUrl(sourceUrl);
    const mode = payload.mode === undefined ? 'static' : payload.mode;
    if (!['static', 'browser'].includes(mode)) throw new Error('请选择公开页面提取或浏览器采集。');
    if (mode === 'browser' && typeof this.capturePage !== 'function') throw new Error('当前版本尚未提供浏览器采集，请使用公开页面提取。');
    if (this.activeSessionCount() >= LIMITS.activeSessions) throw new Error('已有两个图片采集任务正在进行，请稍后再试。');
    while (this.sessions.size >= LIMITS.sessions) {
      const expired = [...this.sessions.values()].find(session => !ACTIVE.has(session.value.status) && session.value.archiveStatus !== 'collecting');
      if (!expired) throw new Error('图片采集任务已达到上限。');
      this.removeStaging(expired.directory); this.sessions.delete(expired.value.id);
    }
    const id = identifier('session'), directory = path.join(this.stagingDir, id); fs.mkdirSync(directory);
    const session = { directory, controller: new AbortController(), generation: 1, files: new Map(), seenUrls: new Set(), loadingIds: new Set(), loads: new Set(), diskBytes: 0,
      value: { id, sourceUrl, title: '', projectId: payload.projectId, caseId: payload.caseId || null, mode, status: 'discovering',
        candidates: [], progress: { done: 0, total: 0 }, errors: [], savedCount: 0, createdAt: new Date().toISOString() } };
    this.sessions.set(id, session);
    session.page = options.page?.imagesComplete === true ? options.page : null;
    // Trusted main-process import code can supply an exact, scoped image
    // reader. Functions are never accepted through a renderer payload.
    session.fetchImage = typeof options.fetchImage === 'function' ? options.fetchImage : this.fetchImage;
    session.work = Promise.resolve().then(() => this.discover(session, session.generation));
    return this.snapshot(session);
  }
  // Archive is an explicit action by a case/collection workflow. It uses the
  // same bounded downloader as the workbench and never invokes a model.
  startArticle(payload = {}, options = {}) {
    const started = this.start(payload, options), session = this.session(started.id);
    session.autoArchive = true;
    try{const previous=this.getArticle({projectId:payload.projectId,caseId:payload.caseId});session.reuseSaved=previous.sourceUrl===payload.sourceUrl&&(!previous.complete||previous.lastAttempt?.complete===false);}catch{}
    session.articleOptions = { onProgress: options.onProgress };
    this.archiveAfterWork(session, options);
    return this.snapshot(session);
  }
  archiveAfterWork(session, options = {}) {
    session.value.archiveStatus = 'collecting';
    session.articleWork = this.finishArticle(session, options);
    // IPC callers receive an immediate session and poll it; keep any eventual
    // storage failure visible there without creating an unhandled rejection.
    session.articleWork.catch(cause => {
      if (!this.stopped) { session.value.archiveStatus = 'error'; session.value.errors.push(failure(cause)); this.changed(session); }
    });
  }
  async collectArticle(payload = {}, options = {}) {
    this.assertOpen(); this.assertScope(payload.projectId, payload.caseId); validatePublicUrl(payload.sourceUrl);
    // Case research can enqueue more jobs than the interactive collector's two
    // slots. Wait here, before creating a session, while manual starts retain
    // their immediate capacity error. The check and start below are synchronous.
    while (this.activeSessionCount() >= LIMITS.activeSessions) {
      this.assertOpen();
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.off('changed', wake); options.signal?.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(options.signal?.reason || new Error('文章采集已取消。')); };
        const timer = setTimeout(wake, 100);
        this.once('changed', wake); options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
    this.assertOpen(); if (options.signal?.aborted) throw options.signal.reason || new Error('文章采集已取消。');
    const started = this.startArticle(payload, options);
    return this.session(started.id).articleWork;
  }
  async finishArticle(session, { signal, onProgress } = {}) {
    const notify = value => { if (value.id === session.value.id && typeof onProgress === 'function') { try { onProgress(value); } catch {} } };
    const abort = () => { if (!this.stopped && ACTIVE.has(session.value.status)) this.cancel(session.value.id); };
    this.on('changed', notify); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    notify(this.snapshot(session));
    try {
      await session.work;
      const terminal = session.value.status;
      const candidateIds = session.value.candidates.filter(item => session.files.has(item.id) && ['ready', 'duplicate'].includes(item.status)).map(item => item.id);
      if (!this.stopped && candidateIds.length && terminal !== 'cancelled' && !signal?.aborted) {
        this.save({ sessionId: session.value.id, candidateIds }); await session.work;
      }
      this.assertOpen(); this.assertScope(session.value.projectId, session.value.caseId);
      const saved = session.value.candidates.filter(item => item.savedAssetId), failed = session.value.candidates.filter(item => !item.savedAssetId);
      const assetIds = [...new Set(saved.map(item => item.savedAssetId))];
      const complete = terminal === 'ready' && !signal?.aborted && !session.value.truncated && !failed.length && !!session.page?.text?.trim() && !session.page.textTruncated;
      const articleId = `article_${crypto.createHash('sha256').update(JSON.stringify([session.value.projectId, session.value.caseId, session.value.sourceUrl])).digest('hex')}`;
      const status = signal?.aborted || terminal === 'cancelled' ? 'cancelled' : complete ? 'complete' : assetIds.length || session.page ? 'partial' : 'error';
      const article = { version: 1, articleId, sessionId: session.value.id, projectId: session.value.projectId, caseId: session.value.caseId,
        sourceUrl: session.value.sourceUrl, finalUrl: session.finalUrl || session.value.sourceUrl, title: session.value.title,
        text: session.page?.text || '', description: session.page?.description || '', textTruncated: session.page?.textTruncated || false,
        retrievedAt: session.page?.retrievedAt || new Date().toISOString(), archivedAt: new Date().toISOString(),
        status, complete, discoveredCount: session.value.candidates.length, savedCount: assetIds.length, failedCount: failed.length,
        truncated: !!session.value.truncated, assetIds, errors: [...session.value.errors],
        images: session.value.candidates.map(item => ({ sourceUrl: item.sourceUrl, sourcePageUrl: item.sourcePageUrl, finalUrl: session.files.get(item.id)?.finalUrl || '',
          assetId: item.savedAssetId || '', width: item.width, height: item.height, contentType: item.contentType, byteLength: item.byteLength,
          resolutionStatus: item.resolutionStatus || 'published', originalError: item.originalError || '', error: item.error || (!item.savedAssetId ? '图片未归档。' : '') })) };
      this.assertArticlesDirectory();
      const destination = path.join(this.articlesDir, `${articleId}.json`), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      let stored = article;
      if (fs.existsSync(destination)) {
        const previous = this.getArticle({ projectId: article.projectId, caseId: article.caseId || undefined, articleId });
        // A failed or incomplete re-read is an attempt, not permission to
        // destroy the last successful offline document and original mapping.
        if (!article.complete && (previous.complete || previous.text && !article.text || previous.assetIds?.some(id => !article.assetIds.includes(id)))) {
          stored = { ...previous, lastAttempt: { archivedAt: article.archivedAt, sessionId: article.sessionId, status: article.status,
            complete: article.complete, discoveredCount: article.discoveredCount, savedCount: article.savedCount, failedCount: article.failedCount, errors: article.errors,
            assetIds: article.assetIds, images: article.images } };
        }
      }
      const serialized = JSON.stringify(stored);
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('文章归档内容超过保存上限。');
      try { fs.writeFileSync(temporary, serialized, { flag: 'wx' }); fs.renameSync(temporary, destination); }
      finally { try { fs.unlinkSync(temporary); } catch {} }
      session.value.articleId = articleId; session.value.archiveStatus = status; session.value.preservedPrevious = stored !== article; session.value.availableSavedCount = stored.savedCount; this.changed(session);
      return { ...article, preservedPrevious: stored !== article, availableSavedCount: stored.savedCount, assets: this.assets.filter(item => item.projectId === article.projectId && stored.assetIds.includes(item.id)).map(item => this.publicAsset(item, article.caseId)) };
    } finally { this.off('changed', notify); signal?.removeEventListener('abort', abort); }
  }
  assertArticlesDirectory() {
    const stat = fs.lstatSync(this.articlesDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.articlesDir) !== this.articlesRealDir) throw new Error('文章归档目录无效。');
  }
  getArticle({ projectId, caseId, articleId } = {}) {
    this.assertOpen(); this.assertScope(projectId, caseId);
    this.assertArticlesDirectory();
    if (articleId !== undefined && !/^article_[a-f\d]{64}$/.test(articleId)) throw new Error('文章归档标识无效。');
    if (!articleId && !caseId) throw new Error('请选择需要读取的案例或文章。');
    const names = articleId ? [`${articleId}.json`] : fs.readdirSync(this.articlesDir).filter(name => /^article_[a-f\d]{64}\.json$/.test(name)).slice(0, LIMITS.assets);
    const articles = [];
    for (const name of names) {
      const file = path.join(this.articlesDir, name);
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('文章归档文件无效。');
      const article = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (article.version === 1 && article.articleId === name.slice(0, -5) && article.projectId === projectId && (!caseId || article.caseId === caseId)) articles.push(article);
    }
    const article = articles.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))[0];
    if (!article) throw new Error('该项目或案例尚无文章归档。');
    return copy(article);
  }
  addCandidates(session, images, generation) {
    if (!this.current(session, generation)) return;
    const list = Array.isArray(images) ? images : Array.isArray(images?.images) ? images.images : images ? [images] : [];
    for (const image of list.slice(0, LIMITS.candidates + 1)) {
      if (session.value.candidates.length >= LIMITS.candidates) { if (!session.value.truncated) session.value.errors.push(`候选图片已达到 ${LIMITS.candidates} 张上限。`); session.value.truncated = true; break; }
      try {
        const rawUrl = typeof image === 'string' ? image : image?.url || image?.sourceUrl;
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
        const sourceUrl = validatePublicUrl(new URL(rawUrl, session.finalUrl || session.value.sourceUrl).href).href;
        const sourcePageUrl = text(image?.sourcePageUrl, 8193) || session.value.sourceUrl; validatePublicUrl(sourcePageUrl);
        const sourceKey = `${sourceUrl}\0${sourcePageUrl}`;
        if (session.seenUrls.has(sourceKey)) continue;
        session.seenUrls.add(sourceKey);
        const fallbackUrls=[...new Set((Array.isArray(image?.fallbackUrls)?image.fallbackUrls:[]).slice(0,4).flatMap(value=>{try{return [validatePublicUrl(new URL(value,sourcePageUrl).href).href];}catch{return [];}}))].filter(value=>value!==sourceUrl);
        session.value.candidates.push({ id: identifier('candidate'), sourceUrl, sourcePageUrl, alt: text(image?.alt), fallbackUrls, declaredOriginal:image?.declaredOriginal===true,
          publisherMediaId:text(image?.publisherMediaId,12),publishedWidth:Math.max(0,Number(image?.publishedWidth)||0),publishedHeight:Math.max(0,Number(image?.publishedHeight)||0),width: 0, height: 0,
          contentType: '', byteLength: 0, thumbnailUrl: '', status: 'pending' });
      } catch { /* Unsafe or malformed references never become network targets. */ }
    }
    session.value.progress.total = session.value.candidates.length; this.changed(session);
  }
  scheduleCandidates(session, generation) {
    const pending = session.value.candidates.filter(candidate => candidate.status === 'pending' && !session.loadingIds.has(candidate.id));
    if (!pending.length || !this.current(session, generation)) return;
    for (const candidate of pending) session.loadingIds.add(candidate.id);
    const loads = session.loads;
    const work = this.loadCandidates(session, pending, generation).finally(() => loads.delete(work));
    loads.add(work);
  }
  async discover(session, generation) {
    const timer = this.timer(session, generation);
    try {
      const { sourceUrl, mode } = session.value;
      let capturing = true;
      const page = await abortable(session.page ? Promise.resolve(session.page) : mode === 'browser' ? this.capturePage(sourceUrl, { signal: session.controller.signal,
        onCandidates: images => { if (capturing) { this.addCandidates(session, images, generation); this.scheduleCandidates(session, generation); } } })
        : this.fetchPage(sourceUrl, { signal: session.controller.signal, timeoutMs: 15000, maxImages: LIMITS.candidates, includeSmallImages: true }), session.controller.signal);
      capturing = false;
      if (!this.current(session, generation)) return;
      session.finalUrl = validatePublicUrl(page.finalUrl || page.url || sourceUrl).href;
      if (new URL(session.finalUrl).hostname === 'mp.weixin.qq.com' && /\/mp\/(?:wappoc_appmsgcaptcha|verify|wapverify)(?:[/?]|$)/i.test(new URL(session.finalUrl).pathname)) {
        throw new Error('微信当前返回验证页，未读取到文章正文。请保存已打开的文章 HTML 后导入。');
      }
      session.value.title = text(page.title) || new URL(sourceUrl).hostname;
      session.page = { title: session.value.title, text: text(page.text, 512000), description: text(page.description, 4000),
        retrievedAt: text(page.retrievedAt, 100) || new Date().toISOString(), textTruncated: page.textTruncated === true || typeof page.text === 'string' && page.text.length > 512000 };
      if (page.imagesTruncated || page.limited) { session.value.truncated = true; session.value.errors.push('页面候选图片超过本次采集上限，已保留可读取部分。'); }
      this.addCandidates(session, page.images, generation);
      session.value.status = 'loading'; this.changed(session);
      this.scheduleCandidates(session, generation);
      while (this.current(session, generation) && session.loads.size) await Promise.all([...session.loads]);
      if (this.current(session, generation)) { session.value.status = 'ready'; this.changed(session); }
    } catch (cause) {
      if (this.current(session, generation)) {
        session.value.status = 'error'; session.value.errors.push(failure(cause));
        for (const candidate of session.value.candidates) if (candidate.status === 'pending') { candidate.status = 'error'; candidate.error = failure(cause); }
        session.controller.abort(cause); this.changed(session);
      }
    } finally { clearTimeout(timer); }
  }
  timer(session, generation) {
    return setTimeout(() => {
      if (!this.current(session, generation)) return;
      session.value.status = 'error'; session.value.errors.push('本次采集达到时限，已保留成功图片，可重试失败项。');
      for (const candidate of session.value.candidates) if (candidate.status === 'pending') { candidate.status = 'error'; candidate.error = '采集达到时限。'; }
      session.controller.abort(new Error('采集达到时限。')); this.changed(session);
    }, LIMITS.sessionTimeoutMs);
  }
  limited(work, signal) {
    return new Promise((resolve, reject) => { this.imageQueue.push({ work, signal, resolve, reject }); this.drainImages(); });
  }
  drainImages() {
    while (!this.stopped && this.activeImages < LIMITS.concurrency && this.imageQueue.length) {
      const entry = this.imageQueue.shift();
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      this.activeImages++;
      Promise.resolve().then(entry.work).then(entry.resolve, entry.reject).finally(() => { this.activeImages--; this.drainImages(); });
    }
  }
  async loadCandidates(session, candidates, generation) {
    let cursor = 0;
    const worker = async () => {
      while (this.current(session, generation) && cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try { await this.limited(() => this.loadOne(session, candidate, generation), session.controller.signal); }
        catch (cause) { if (this.current(session, generation)) { candidate.status = 'error'; candidate.error = failure(cause); } }
        if (this.current(session, generation)) { session.value.progress.done++; this.changed(session); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, candidates.length) }, worker));
  }
  async loadOne(session, candidate, generation) {
    if (!this.current(session, generation)) return;
    this.assertScope(session.value.projectId, session.value.caseId);
    if(session.autoArchive&&session.reuseSaved){
      const existing=this.assets.find(asset=>asset.projectId===session.value.projectId&&asset.sources.some(source=>source.sourceUrl===candidate.sourceUrl&&source.sourcePageUrl===candidate.sourcePageUrl&&source.caseId===session.value.caseId
        &&(['original-available','publisher-original'].includes(source.resolutionStatus)||originalImageUrl(candidate.sourceUrl,candidate)===candidate.sourceUrl&&!candidate.fallbackUrls?.length)));
      if(existing){try{const stored=this.safeFile(this.assetPath(existing),existing.byteLength,existing.hash),source=existing.sources.find(source=>source.sourceUrl===candidate.sourceUrl&&source.sourcePageUrl===candidate.sourcePageUrl&&source.caseId===session.value.caseId);
        session.files.set(candidate.id,{path:stored,hash:existing.hash,finalUrl:source.finalUrl||existing.finalUrl});Object.assign(candidate,{width:existing.width,height:existing.height,contentType:existing.contentType,byteLength:existing.byteLength,thumbnailUrl:existing.thumbnailUrl||'',status:'duplicate',duplicateOf:existing.id,existingAssetId:existing.id,resolutionStatus:source.resolutionStatus||'published',originalError:source.originalError||'',reused:true});return;
      }catch{/* An unavailable cached original is fetched again rather than claimed present. */}}
    }
    const options = { signal: session.controller.signal, maxBytes: LIMITS.imageBytes, timeoutMs: 10000, allowSmall: true, allowAnimation: true };
    let image;
    const read = async url => {
      let result;
      try { result = await abortable(session.fetchImage(url, options), options.signal); }
      catch (cause) {
        if (!this.current(session, generation) || !(cause?.statusCode === 403 || cause?.code === 'HTTP_ERROR' && /HTTP 403\b/.test(cause.message))) throw cause;
        result = await abortable(session.fetchImage(url, { ...options, referrer: candidate.sourcePageUrl, referrerPolicy: 'strict-origin-when-cross-origin' }), options.signal);
      }
      raster(result?.dataUrl, LIMITS.imageBytes, true, true); return result;
    };
    const preferred = originalImageUrl(candidate.sourceUrl,candidate), variants=[...new Set([preferred,candidate.sourceUrl,...(candidate.fallbackUrls||[])])];
    let lastError;
    for(const url of variants){
      try{
        const loaded=await read(url);let improved=true;
        if(url===preferred&&preferred!==candidate.sourceUrl&&candidate.publishedWidth&&candidate.publishedHeight){
          const decoded=raster(loaded.dataUrl,LIMITS.imageBytes,true,true),ratio=decoded.width/decoded.height,expected=candidate.publishedWidth/candidate.publishedHeight;
          if(decoded.width<candidate.publishedWidth||decoded.height<candidate.publishedHeight||Math.abs(ratio-expected)/expected>.08)throw new Error('原图候选尺寸与网页发布图不符，保留发布版本。');
          improved=decoded.width>candidate.publishedWidth||decoded.height>candidate.publishedHeight;
        }
        image=loaded;candidate.resolutionStatus=url!==preferred?'published-fallback':preferred!==candidate.sourceUrl&&improved?'original-available':candidate.declaredOriginal?'publisher-original':'published';break;
      }
      catch(cause){if(!this.current(session,generation))throw cause;lastError=cause;candidate.originalError ||= failure(cause);}
    }
    if(!image)throw lastError||new Error('图片原图与发布版本均无法读取。');
    if (!this.current(session, generation)) return;
    const decoded = raster(image?.dataUrl, LIMITS.imageBytes, true, true);
    if (decoded.width <= 2 || decoded.height <= 2) throw new Error('忽略跟踪像素。');
    if (image.contentType && image.contentType !== decoded.contentType) throw new Error('图片内容与声明格式不符。');
    const finalUrl = validatePublicUrl(image.finalUrl || candidate.sourceUrl).href;
    const hash = crypto.createHash('sha256').update(decoded.bytes).digest('hex');
    let thumb='';
    try{thumb=thumbnail(await abortable(this.makeThumbnail(image.dataUrl), options.signal));}
    catch(cause){if(options.signal.aborted)throw options.signal.reason||cause;if(decoded.contentType!=='image/gif')throw cause;candidate.thumbnailError=failure(cause);}
    if (!this.current(session, generation)) return;
    const previous = [...session.files.entries()].find(([, file]) => file.hash === hash);
    const existing = this.assets.find(asset => asset.projectId === session.value.projectId && asset.hash === hash);
    let filePath;
    if (previous) filePath = previous[1].path;
    else if (existing && fs.existsSync(this.assetPath(existing))) filePath = this.safeFile(this.assetPath(existing), decoded.bytes.length, hash);
    else {
      if (session.diskBytes + decoded.bytes.length > (session.autoArchive?LIMITS.articleSessionBytes:LIMITS.sessionBytes) || this.diskBytes(this.stagingDir) + decoded.bytes.length > LIMITS.stagingBytes) throw new Error('本次图片临时存储已达到容量上限，请先保存需要的图片。');
      filePath = path.join(session.directory, `${hash}.${MIME_EXTENSION[decoded.contentType]}`);
      fs.writeFileSync(filePath, decoded.bytes, { flag: 'wx' }); session.diskBytes += decoded.bytes.length;
    }
    session.files.set(candidate.id, { path: filePath, hash, finalUrl });
    Object.assign(candidate, { width: decoded.width, height: decoded.height, contentType: decoded.contentType, byteLength: decoded.bytes.length,
      thumbnailUrl: thumb, status: previous || existing ? 'duplicate' : 'ready' });
    delete candidate.error;
    if (previous || existing) candidate.duplicateOf = previous?.[0] || existing.id;
    // Existing content still needs an explicit save to attach this page/case
    // and its notes; it is not already archived in the current collection.
    if (existing) candidate.existingAssetId = existing.id;
  }
  cancel(id) {
    const session = this.session(id);
    if (!ACTIVE.has(session.value.status)) return this.snapshot(session);
    session.generation++; session.controller.abort(new Error('图片采集已取消。')); session.value.status = 'cancelled';
    for (const candidate of session.value.candidates) if (candidate.status === 'pending') { candidate.status = 'error'; candidate.error = '图片采集已取消，可重试。'; }
    this.changed(session); return this.snapshot(session);
  }
  retry({ sessionId, candidateIds } = {}) {
    const session = this.session(sessionId);
    if (ACTIVE.has(session.value.status)) throw new Error('采集任务仍在进行，请稍后重试。');
    if (candidateIds !== undefined && (!Array.isArray(candidateIds) || candidateIds.length > LIMITS.candidates)) throw new Error('重试图片清单无效。');
    const requested = candidateIds === undefined ? null : new Set(candidateIds);
    const candidates = session.value.candidates.filter(item => item.status === 'error' && (!requested || requested.has(item.id)));
    if (!candidates.length) throw new Error(session.value.candidates.length ? '没有可重试的失败图片。' : '没有图片候选，请重新采集该页面。');
    session.generation++; session.controller = new AbortController(); const generation = session.generation;
    for (const candidate of candidates) { candidate.status = 'pending'; delete candidate.error; }
    session.value.status = 'loading'; session.value.progress = { done: 0, total: candidates.length };
    session.work = Promise.resolve().then(async () => {
      const timer = this.timer(session, generation);
      try { await this.loadCandidates(session, candidates, generation); if (this.current(session, generation)) { session.value.status = 'ready'; this.changed(session); } }
      catch (cause) { if (this.current(session, generation)) { session.value.status = 'error'; session.value.errors.push(failure(cause)); this.changed(session); } }
      finally { clearTimeout(timer); }
    });
    if (session.autoArchive) this.archiveAfterWork(session, session.articleOptions);
    this.changed(session); return this.snapshot(session);
  }
  save({ sessionId, candidateIds, note = '' } = {}) {
    const session = this.session(sessionId);
    if (session.value.status === 'saving') return this.snapshot(session);
    if (!['ready', 'cancelled', 'error'].includes(session.value.status)) throw new Error('请等待图片读取完成后再保存。');
    if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > LIMITS.candidates || candidateIds.some(id => typeof id !== 'string')) throw new Error('请选择需要保存的图片。');
    if (typeof note !== 'string' || note.length > 4000) throw new Error('素材备注最多 4000 字。');
    const candidates = [...new Set(candidateIds)].map(id => session.value.candidates.find(item => item.id === id));
    if (candidates.some(candidate => !candidate || !session.files.has(candidate.id) || !['ready', 'duplicate'].includes(candidate.status))) throw new Error('所选图片尚未读取成功。');
    session.generation++; session.controller = new AbortController(); const generation = session.generation;
    session.value.status = 'saving'; session.value.progress = { done: 0, total: candidates.length };
    session.work = this.saveTail.then(() => this.saveCandidates(session, candidates, text(note, 4000), generation));
    this.saveTail = session.work.catch(() => {});
    this.changed(session); return this.snapshot(session);
  }
  async saveCandidates(session, candidates, note, generation) {
    try {
      for (const candidate of candidates) {
        if (!this.current(session, generation)) break;
        this.assertScope(session.value.projectId, session.value.caseId);
        try {
          const stored = session.files.get(candidate.id), now = new Date().toISOString();
          const file = this.safeFile(stored.path, candidate.byteLength);
          if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== stored.hash) throw new Error('临时原图已变化，请重新采集。');
          let asset = this.assets.find(item => item.projectId === session.value.projectId && item.hash === stored.hash);
          if (!asset && this.assets.length >= LIMITS.assets) throw new Error('本地图片素材数量已达到上限。');
          const destination = this.assetPath({ hash: stored.hash, contentType: candidate.contentType });
          if (!fs.existsSync(destination)) {
            if (this.diskBytes(this.originalsDir) + candidate.byteLength > LIMITS.assetBytes) throw new Error('本地原图素材库已达到容量上限。');
            const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
            try { fs.copyFileSync(file, temporary, fs.constants.COPYFILE_EXCL); fs.renameSync(temporary, destination); }
            finally { try { fs.unlinkSync(temporary); } catch {} }
          } else {
            this.safeFile(destination, candidate.byteLength);
            if (crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== stored.hash) throw new Error('已保存的原图内容校验失败。');
          }
          const previous = copy(this.assets);
          try {
            if (!asset) {
              asset = { id: identifier('image'), projectId: session.value.projectId, caseId: session.value.caseId, caseIds: [], hash: stored.hash,
                sourceUrl: candidate.sourceUrl, sourcePageUrl: candidate.sourcePageUrl, finalUrl: stored.finalUrl,
                name: candidate.alt || session.value.title || `图片 ${this.assets.length + 1}`, note, contentType: candidate.contentType,
                width: candidate.width, height: candidate.height, byteLength: candidate.byteLength, thumbnailUrl: candidate.thumbnailUrl,
                sources: [], createdAt: now, updatedAt: now };
              this.assets.unshift(asset);
            }
            // Selecting one canonical image must retain all discovered sources
            // of the same content, including hidden duplicate gallery rows.
            const related = session.value.candidates.filter(item => session.files.get(item.id)?.hash === stored.hash);
            for (const item of related) {
              const source = { sourceUrl: item.sourceUrl, sourcePageUrl: item.sourcePageUrl, finalUrl: session.files.get(item.id).finalUrl,
                pageFinalUrl: session.finalUrl || session.value.sourceUrl, title: session.value.title, alt: item.alt,
                caseId: session.value.caseId, mode: session.value.mode, collectedAt: now,resolutionStatus:item.resolutionStatus||'published',originalError:item.originalError||'' };
              if (!asset.sources.some(existing => existing.sourceUrl === source.sourceUrl && existing.sourcePageUrl === source.sourcePageUrl && existing.caseId === source.caseId)) {
                if (asset.sources.length >= 300) throw new Error('同一图片的来源记录已达到上限，未丢弃已有来源。');
                asset.sources.push(source);
              }
            }
            if (session.value.caseId && !asset.caseIds.includes(session.value.caseId)) asset.caseIds.push(session.value.caseId);
            if (note) asset.note = note;
            asset.updatedAt = now; this.persist();
          } catch (cause) { this.assets = previous; throw cause; }
          const staged = new Set();
          for (const item of session.value.candidates) {
            const related = session.files.get(item.id);
            if (related?.hash !== stored.hash) continue;
            item.savedAssetId = asset.id;
            if (path.dirname(related.path) === session.directory) staged.add(related.path);
            related.path = destination;
          }
          for (const temporary of staged) {
            try { const bytes = fs.lstatSync(temporary).size; fs.unlinkSync(temporary); session.diskBytes = Math.max(0, session.diskBytes - bytes); } catch {}
          }
          session.value.savedCount = new Set(session.value.candidates.map(item => item.savedAssetId).filter(Boolean)).size;
        } catch (cause) { session.value.errors.push(`${candidate.alt || '图片'}：${failure(cause)}`); }
        session.value.progress.done++; this.changed(session); await immediate();
      }
      if (this.current(session, generation)) { session.value.status = 'ready'; this.changed(session); }
    } catch (cause) { if (this.current(session, generation)) { session.value.status = 'error'; session.value.errors.push(failure(cause)); this.changed(session); } }
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    for (const session of this.sessions.values()) { session.generation++; session.controller.abort(new Error('图片素材服务已关闭。')); this.removeStaging(session.directory); }
    for (const entry of this.imageQueue) entry.reject(new Error('图片素材服务已关闭。'));
    this.imageQueue = []; this.removeAllListeners();
  }
}

module.exports = { ImageCollectionService, LIMITS };
