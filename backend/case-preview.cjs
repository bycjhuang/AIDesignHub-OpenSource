'use strict';

// Read-only case previews live beside (not inside) the project database. All
// page/image traffic uses the pinned-public-DNS reader; HTML is never executed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchPublicPage, fetchPublicImage, validatePublicUrl } = require('./public-page.cjs');
const MAX_IMAGES = 4;
const MAX_GALLERY = 24;
const MAX_GALLERY_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1536 * 1024;
const MAX_TEXT = 100000;
const CACHE_MAX_BYTES = 18 * 1024 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

class CasePreviewService {
  constructor({ dataDir, findCase, fetchPage = fetchPublicPage, fetchImage = fetchPublicImage }) {
    this.cacheDir = path.join(dataDir, 'case-previews');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.findCase = findCase; this.fetchPage = fetchPage; this.fetchImage = fetchImage;
    this.pending = new Map(); this.queue = []; this.active = 0; this.stopped = false;
  }
  cachePath(id, sourceUrl) {
    const key = crypto.createHash('sha256').update(`${id}\0${sourceUrl}`).digest('hex');
    return path.join(this.cacheDir, `${key}.json`);
  }
  read(id, sourceUrl) {
    try {
      const file = this.cachePath(id, sourceUrl);
      if (fs.statSync(file).size > CACHE_MAX_BYTES) return null;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value.version === 1 && value.caseId === id && value.sourceUrl === sourceUrl && Array.isArray(value.images) ? value : null;
    } catch { return null; }
  }
  save(value) {
    if (this.stopped || !this.findCase(value.caseId)) return;
    const file = this.cachePath(value.caseId, value.sourceUrl);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    // Optional cache failure must not fail a useful preview or change case data.
    try { fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); }
    catch { try { fs.unlinkSync(temporary); } catch {} }
  }
  base(item) {
    return { version: 1, caseId: item.id, status: 'unavailable', title: text(item.name, 500),
      description: text(item.notes, 5000), text: '', sourceUrl: text(item.sourceUrl, 8192), finalUrl: '',
      retrievedAt: null, cachedAt: Date.now(), images: [], error: null, warnings: [], loaded: false, candidates: [] };
  }
  seed(id, page) {
    const item = this.findCase(id);
    if (!item || this.stopped) return;
    const value = this.fromPage(item, page);
    this.save(value);
  }
  fromPage(item, page) {
    const value = this.base(item);
    value.title = text(page.title, 500) || value.title;
    value.description = text(page.description, 5000) || value.description;
    value.text = text(page.text, MAX_TEXT);
    value.textTruncated = typeof page.text === 'string' && page.text.length > MAX_TEXT;
    value.finalUrl = text(page.finalUrl || page.url || item.sourceUrl, 8192);
    value.retrievedAt = page.retrievedAt || new Date().toISOString();
    value.candidates = (Array.isArray(page.images) ? page.images : []).slice(0, MAX_GALLERY).flatMap(image => {
      try { return [{ url: validatePublicUrl(image.url).href, alt: text(image.alt, 500) }]; } catch { return []; }
    });
    value.status = value.text || value.description ? 'partial' : 'unavailable';
    return value;
  }
  publicValue(value) {
    const result = copy(value);
    result.imageCandidateCount = value.candidates.length;
    result.hasMoreImages = (value.nextCandidate || 0) < value.candidates.length && !value.galleryLimitReached;
    delete result.version; delete result.candidates; delete result.loaded;
    delete result.nextCandidate;
    result.cached = true;
    result.stale = Date.now() - value.cachedAt > 7 * 24 * 60 * 60 * 1000;
    return result;
  }
  async preview(id, { refresh = false, moreImages = false } = {}) {
    if (typeof id !== 'string' || !this.findCase(id)) throw new Error('案例不存在。');
    if (this.stopped) throw new Error('工作台预览服务已关闭。');
    if (!refresh && this.localPreview) { const local = await this.localPreview(copy(this.findCase(id))); if (local) return local; }
    if (this.pending.has(id)) return this.pending.get(id).work;
    const item = copy(this.findCase(id));
    const cached = refresh ? null : this.read(id, item.sourceUrl || '');
    if (cached?.loaded && (!moreImages || !this.publicValue(cached).hasMoreImages)) return this.publicValue(cached);
    const controller = new AbortController();
    let resolve, reject;
    const work = new Promise((done, fail) => { resolve = done; reject = fail; }).finally(() => this.pending.delete(id));
    this.pending.set(id, { controller, work });
    this.queue.push({ item, cached, controller, resolve, reject }); this.drain();
    return work;
  }
  drain() {
    while (!this.stopped && this.active < 3 && this.queue.length) {
      const entry = this.queue.shift(); this.active++;
      this.load(entry.item, entry.cached, entry.controller).then(entry.resolve, entry.reject).finally(() => { this.active--; this.drain(); });
    }
  }
  async load(item, cached, controller) {
    let value = cached || this.base(item);
    const timer = setTimeout(() => controller.abort(), 22000);
    try {
      if (!item.sourceUrl) { value.error = '此案例未记录原始网页链接，暂无原文和图片预览。'; return this.finish(value); }
      validatePublicUrl(item.sourceUrl);
      if (!cached) value = this.fromPage(item, await this.fetchPage(item.sourceUrl, { signal: controller.signal, timeoutMs: 12000 }));
      // Load at most four images per explicit request, with a bounded gallery.
      const nextCandidate = value.nextCandidate || 0;
      const candidates = (value.candidates || []).slice(nextCandidate, nextCandidate + MAX_IMAGES);
      const results = new Array(candidates.length);
      let cursor = 0, accepted = 0;
      const worker = async () => {
        while (!controller.signal.aborted && accepted < MAX_IMAGES) {
          const index = cursor++;
          if (index >= candidates.length) break;
          const candidate = candidates[index];
          try {
            const image = await this.fetchImage(candidate.url, { signal: controller.signal, timeoutMs: 6000, maxBytes: MAX_IMAGE_BYTES });
            if (controller.signal.aborted) break;
            // Keep the bridge contract bounded even with a custom trusted test reader.
            if (typeof image.dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(image.dataUrl)
              || image.dataUrl.length > MAX_IMAGE_BYTES * 4 / 3 + 100) throw new Error('图片预览格式或大小无效。');
            results[index] = { dataUrl: image.dataUrl, sourceUrl: candidate.url, finalUrl: image.finalUrl || candidate.url,
              alt: candidate.alt || value.title, width: image.width, height: image.height };
            accepted++;
          } catch (cause) {
            if (!controller.signal.aborted) value.warnings.push({ sourceUrl: candidate.url, message: String(cause.message || '图片暂时无法加载。').slice(0, 300) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
      let galleryBytes = value.images.reduce((total, image) => total + image.dataUrl.length, 0);
      for (const image of results.filter(Boolean)) {
        if (galleryBytes + image.dataUrl.length > MAX_GALLERY_BYTES || value.images.length >= MAX_GALLERY) { value.galleryLimitReached = true; break; }
        value.images.push(image); galleryBytes += image.dataUrl.length;
      }
      value.nextCandidate = nextCandidate + candidates.length;
      value.error = null;
      value.status = value.images.length ? 'ready' : value.text || value.description ? 'partial' : 'unavailable';
      if (controller.signal.aborted) value.error = '预览读取达到时限；已保留成功读取的内容，可手动刷新或打开原始网页。';
      else if (!value.images.length) value.error = candidates.length ? '来源图片暂时无法加载，文字内容仍可查看。' : '来源网页未提供可用的项目图片，已保留可读取的文字内容。';
    } catch (cause) {
      value.status = value.text || value.description ? 'partial' : 'unavailable';
      value.error = String(cause.message || '项目原文暂时无法读取。').slice(0, 600);
    } finally { clearTimeout(timer); }
    return this.finish(value);
  }
  finish(value) {
    value.loaded = true; value.cachedAt = Date.now(); this.save(value);
    return this.publicValue(value);
  }
  dispose() {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    for (const entry of this.queue) entry.reject(new Error('工作台预览服务已关闭。'));
    this.queue = [];
  }
}

module.exports = { CasePreviewService };
