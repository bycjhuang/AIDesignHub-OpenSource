'use strict';

const { validatePublicUrl } = require('./public-page.cjs');

const LIMITS = Object.freeze({ sources: 30, candidatesPerSource: 80, images: 200, timeoutMs: 220000 });
const text = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const message = cause => String(cause?.message || cause || '图片采集失败。').slice(0, 500);
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const publicUrl = value => validatePublicUrl(value).href;
function publishedImageIdentity(value) {
  try {
    const url = new URL(value);
    if (url.hostname === 'images.adsttc.com') return `${url.origin}${url.pathname.replace(/\/(?:thumb_jpg|medium_jpg|large_jpg|newsletter|original)\//, '/published-variant/')}`;
    if (url.hostname === 'oss.gooood.cn') return `${url.origin}${url.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.[a-z]+$)/i, '')}`;
  } catch {}
  return value;
}
function publishedSizeRank(value) {
  return /\/(?:original|large_jpg)\//.test(value) ? 0 : /(?:-\d+x\d+\.[a-z]+|\/(?:thumb_jpg|medium_jpg)\/)/i.test(value) ? 2 : 1;
}
function trustedArticleImage(candidate, page, source) {
  if (candidate?.contentScope !== 'article') return false;
  const officialStoryboard = (candidate.context || '').split(' > ').some(part => ['block', 'storyboard', 'main'].every(value => part.split(/\s+/).includes(value)));
  if (officialStoryboard) {
    // Kokaistudios' portfolio embeds its project photographs as backgrounds
    // inside a narrowly named storyboard rather than article/img elements.
    try {
      const pageUrl = new URL(page.finalUrl || page.url || source.url), imageUrl = new URL(candidate.url || candidate.sourceUrl, pageUrl);
      const title = text(page.title, 500);
      return /^(?:www\.)?kokaistudios\.com$/.test(pageUrl.hostname) && /^\/portfolio\/[^/]+\.html$/.test(pageUrl.pathname)
        && imageUrl.hostname.replace(/^www\./, '') === pageUrl.hostname.replace(/^www\./, '') && /^\/upload\//.test(imageUrl.pathname)
        && title.length >= 4 && text(page.text, 512000).includes(title);
    } catch { return false; }
  }
  if (!/(?:gallery-items|afd-gal-items)/.test(candidate.context || '')) return true;
  // A generic div id is not project evidence. ArchDaily's declared gallery is
  // accepted only when its image caption repeats the current project title.
  let host;
  try { host = new URL(page.finalUrl || page.url || source.url).hostname; } catch { return false; }
  if (!/^(?:www\.)?archdaily\.(?:com|cn)$/.test(host)) return false;
  const normalize = value => text(value, 1000).toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const topic = normalize(text(page.title, 500).replace(/^(?:画廊|gallery(?:\s+of)?)\s*/i, '').split(/[\/|]/)[0].replace(/\s*-\s*\d+$/, ''));
  return topic.length >= 3 && normalize(candidate.alt).includes(topic);
}

// Structural relevance is conservative: a large advertisement is still an
// advertisement. Unknown containers require an Agent's explicit selection of a
// URL actually present on the page; no generated image URL becomes a fetch.
function selectResearchImages(page, source, limit = 40) {
  const selected = new Set();
  for (const value of (Array.isArray(source.imageUrls) ? source.imageUrls : []).slice(0, 600)) {
    try { selected.add(publicUrl(new URL(typeof value === 'string' ? value : value?.url, page.finalUrl || source.url).href)); } catch {}
  }
  const candidates = (Array.isArray(page.images) ? page.images : []).slice(0, 600);
  const articleIdentities = new Set(candidates.filter(item => trustedArticleImage(item, page, source)).map(item => {
    try { return publishedImageIdentity(publicUrl(new URL(item.url || item.sourceUrl, page.finalUrl || source.url).href)); } catch { return ''; }
  }).filter(Boolean));
  const images = [], rejected = [], seen = new Set();
  for (const candidate of [...candidates].sort((a, b) => publishedSizeRank(a?.url || a) - publishedSizeRank(b?.url || b))) {
    const raw = typeof candidate === 'string' ? { url: candidate } : candidate || {};
    let url;
    try { url = publicUrl(new URL(raw.url || raw.sourceUrl, page.finalUrl || source.url).href); }
    catch { rejected.push({ url: text(raw.url || raw.sourceUrl), reason: 'invalid-url' }); continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const label = `${raw.alt || ''} ${raw.context || ''} ${new URL(url).pathname}`;
    if (raw.contentScope === 'excluded' || /(?:^|[\s/_.-])(?:logo|favicon|avatar|tracking|pixel|advertisement|sidebar|recommended?|spacer|loader|placeholder)(?:$|[\s/_.-])/i.test(label)) {
      rejected.push({ url, reason: 'unrelated-page-region' }); continue;
    }
    const trustedArticle = trustedArticleImage(raw, page, source), articleVariant = articleIdentities.has(publishedImageIdentity(url));
    if (!trustedArticle && !articleVariant && !selected.has(url)) {
      rejected.push({ url, reason: 'relevance-needs-review' }); continue;
    }
    if (images.length >= limit) { rejected.push({ url, reason: 'source-limit' }); continue; }
    images.push({ url, alt: text(raw.alt, 500), sourcePageUrl: source.url,
      contentScope: raw.contentScope || 'agent-selected', context: text(raw.context, 600),
      relevanceMethod: trustedArticle ? 'article-container' : articleVariant ? 'published-variant-of-article-image' : 'agent-selected-published-url' });
  }
  for (const url of selected) if (!seen.has(url)) rejected.push({ url, reason: 'not-found-on-page' });
  return { images, rejected };
}

function awaitSession(collection, sessionId, signal, timeoutMs = LIMITS.timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer, interval;
    const cleanup = () => { clearTimeout(timer); clearInterval(interval); collection.off('changed', check); signal?.removeEventListener('abort', abort); };
    const fail = cause => { cleanup(); reject(cause); };
    const abort = () => { cleanup(); try { collection.cancel(sessionId); } catch {} reject(signal?.reason || new Error('调研图片采集已取消。')); };
    const check = () => {
      try { const value = collection.get(sessionId); if (!['discovering', 'loading', 'saving'].includes(value.status)) { cleanup(); resolve(value); } }
      catch (cause) { fail(cause); }
    };
    collection.on('changed', check); signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      try { collection.cancel(sessionId); } catch {}
      reject(new Error('调研图片采集达到时限。'));
    }, timeoutMs);
    interval = setInterval(check, 250);
    if (signal?.aborted) abort(); else check();
  });
}

class ResearchImageService {
  constructor({ collection, fetchPage, sessionTimeoutMs = LIMITS.timeoutMs } = {}) {
    if (!collection || typeof collection.start !== 'function' || typeof collection.getAsset !== 'function') throw new Error('调研图片服务需要本地图片素材服务。');
    this.collection = collection; this.fetchPage = fetchPage || collection.fetchPage;
    this.sessionTimeoutMs = bounded(sessionTimeoutMs, LIMITS.timeoutMs, LIMITS.timeoutMs);
  }
  async archiveSources(payload = {}) {
    const { projectId, caseId, signal } = payload;
    this.collection.assertScope(projectId, caseId);
    if (!Array.isArray(payload.sources) || !payload.sources.length) throw new Error('请提供需要调研的来源链接。');
    const minLongEdge = bounded(payload.minLongEdge, 1600, 16000), minShortEdge = bounded(payload.minShortEdge, 600, 16000);
    const maxPerSource = bounded(payload.maxPerSource, 40, LIMITS.candidatesPerSource), maxImages = bounded(payload.maxImages, 120, LIMITS.images);
    const result = { status: 'error', images: [], assetIds: [], sources: [], rejected: [], errors: [],
      policy: { minLongEdge, minShortEdge, maxPerSource, maxImages, relevance: 'article-container-or-agent-selected-published-url',
        originalGuarantee: 'published-resource-only', imageUnderstanding: false } };
    const assetIds = new Set(), hashes = new Set();
    let limited = payload.sources.length > LIMITS.sources;
    if (limited) result.errors.push(`来源超过 ${LIMITS.sources} 个，本次只处理前 ${LIMITS.sources} 个。`);
    const notify = () => { if (typeof payload.onProgress === 'function') { try { payload.onProgress(JSON.parse(JSON.stringify(result))); } catch {} } };
    for (const rawSource of payload.sources.slice(0, LIMITS.sources)) {
      if (signal?.aborted) break;
      const source = typeof rawSource === 'string' ? { url: rawSource } : rawSource || {};
      const report = { url: text(source.url, 8192), title: text(source.title, 500), status: 'collecting', discoveredCount: 0, selectedCount: 0, savedCount: 0, rejectedCount: 0, pendingReviewCount: 0, downloads: [], errors: [] };
      let sessionId = '';
      result.sources.push(report); notify();
      try {
        const url = publicUrl(source.url), scopeCaseId = source.caseId || caseId;
        this.collection.assertScope(projectId, scopeCaseId);
        report.caseId = scopeCaseId || null;
        const page = source.page || await (source.mode === 'browser' && this.collection.capturePage
          ? this.collection.capturePage(url, { signal }) : this.fetchPage(url, { signal, timeoutMs: 15000, maxImages: 600, includeSmallImages: true }));
        if (signal?.aborted) throw signal.reason || new Error('调研图片采集已取消。');
        publicUrl(page.finalUrl || page.url || url);
        if (!text(page.text, 512000)) throw new Error('来源没有可核验的正文，图片未自动归档。');
        report.finalUrl = page.finalUrl || page.url || url; report.title = text(page.title, 500) || report.title;
        report.discoveredCount = Array.isArray(page.images) ? page.images.length : 0;
        const selection = selectResearchImages(page, { ...source, url }, maxPerSource);
        result.rejected.push(...selection.rejected.map(item => ({ ...item, sourcePageUrl: url })));
        report.rejectedCount = selection.rejected.length; report.selectedCount = selection.images.length;
        report.pendingReviewCount = selection.rejected.filter(item => ['relevance-needs-review', 'not-found-on-page'].includes(item.reason)).length;
        if (page.imagesTruncated || page.textTruncated || page.limited || selection.rejected.some(item => item.reason === 'source-limit')) limited = true;
        if (!selection.images.length) { report.status = 'partial'; report.errors.push('没有可确认属于正文的项目图片；未知区域图片保留待人工核对。'); notify(); continue; }
        // Only the trusted backend supplies this filtered page. The collector
        // validates raster bytes and measures actual decoded dimensions.
        const started = this.collection.start({ projectId, caseId: scopeCaseId, sourceUrl: url },
          { page: { ...page, images: selection.images, imagesComplete: true } });
        sessionId = started.id;
        let session = await awaitSession(this.collection, started.id, signal, this.sessionTimeoutMs);
        if (signal?.aborted) throw signal.reason || new Error('调研图片采集已取消。');
        if (session.status === 'cancelled') throw new Error('图片采集会话已取消，保留已保存部分。');
        const captureFailed = session.status !== 'ready';
        const selectedIds = [];
        for (const candidate of session.candidates) {
          let reason = '';
          if (!['ready', 'duplicate'].includes(candidate.status)) reason = 'download-failed';
          else if (Math.max(candidate.width, candidate.height) < minLongEdge || Math.min(candidate.width, candidate.height) < minShortEdge) reason = 'below-resolution-threshold';
          else {
            const image = this.collection.getCandidate(started.id, candidate.id);
            if (!hashes.has(image.hash) && hashes.size >= maxImages) { reason = 'research-limit'; limited = true; }
            else { hashes.add(image.hash); selectedIds.push(candidate.id); }
          }
          if (reason) { result.rejected.push({ url: candidate.sourceUrl, sourcePageUrl: url, reason, width: candidate.width, height: candidate.height, error: candidate.error || '' }); report.rejectedCount++; }
        }
        if (selectedIds.length) {
          this.collection.save({ sessionId: started.id, candidateIds: selectedIds, note: text(payload.query || '项目案例调研：已核验图片尺寸，保留原始来源。', 4000) });
          session = await awaitSession(this.collection, started.id, signal, this.sessionTimeoutMs);
        }
        const savedIds = new Set(session.candidates.map(item => item.savedAssetId).filter(Boolean));
        savedIds.forEach(id => assetIds.add(id)); report.savedCount = savedIds.size; report.sessionId = started.id;
        report.downloads = session.candidates.map(item => ({ sourceUrl: item.sourceUrl, sourcePageUrl: url, caseId: scopeCaseId || null,
          assetId: item.savedAssetId || '', width: item.width, height: item.height, resolutionStatus: item.resolutionStatus || '',
          originalError: item.originalError || '', error: item.error || '', relevanceMethod: selection.images.find(image => image.url === item.sourceUrl)?.relevanceMethod || '' }));
        report.errors.push(...session.errors);
        const failed = session.candidates.some(item => item.status === 'error') || selectedIds.some(id => !session.candidates.find(item => item.id === id)?.savedAssetId);
        report.status = savedIds.size && !failed && !captureFailed && session.status === 'ready' && !report.pendingReviewCount && !page.imagesTruncated && !page.textTruncated && !page.limited ? 'complete' : 'partial';
        if (!savedIds.size) report.errors.push(`未保存达到 ${minLongEdge} × ${minShortEdge} 长短边门槛的项目图片。`);
      } catch (cause) {
        // Cancellation/timeout may arrive between individual atomic saves.
        // Keep those successful originals visible without claiming completion.
        if (sessionId) {
          try {
            const partial = this.collection.get(sessionId), saved = partial.candidates.filter(item => item.savedAssetId);
            const savedIds = new Set(saved.map(item => item.savedAssetId)); savedIds.forEach(id => assetIds.add(id));
            report.savedCount = savedIds.size; report.sessionId = sessionId;
            report.downloads = saved.map(item => ({ sourceUrl: item.sourceUrl, sourcePageUrl: report.url, caseId: report.caseId,
              assetId: item.savedAssetId, width: item.width, height: item.height, resolutionStatus: item.resolutionStatus || '' }));
          } catch { /* An expired/closed session cannot add unverifiable assets. */ }
        }
        report.status = signal?.aborted ? 'cancelled' : 'error'; report.errors.push(message(cause));
      }
      notify();
    }
    for (const id of assetIds) {
      try {
        const asset = this.collection.getAsset(id);
        const { path: ignoredPath, hash: ignoredHash, ...publicAsset } = asset;
        result.images.push({ ...publicAsset, assetId: id, downloadUrl: asset.finalUrl, resolutionStatus: 'downloaded-high-resolution' });
      } catch (cause) { result.errors.push(message(cause)); }
    }
    result.assetIds = result.images.map(image => image.assetId);
    result.status = signal?.aborted ? 'cancelled' : result.images.length ? !limited && !result.errors.length && result.sources.every(item => item.status === 'complete') ? 'complete' : 'partial' : 'error';
    notify(); return result;
  }
}

module.exports = { ResearchImageService, selectResearchImages, LIMITS };
