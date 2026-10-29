'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { validatePublicUrl, isPublicAddress } = require('./public-page.cjs');
const { collectorSource } = require('./image-browser-extract.js');

const failure = (code, message) => Object.assign(new Error(message), { code });
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const TITLE = 'AIDesignHub · 网页图片采集（关闭结束）';
const clamp = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
const abortReason = signal => signal.reason instanceof Error ? signal.reason : failure('ABORTED', '网页图片采集已取消。');

function browserPublicUrl(input) {
  const url = validatePublicUrl(input);
  // The public HTTP reader deliberately strips fragments. Chromium must keep
  // them so hash-routed project galleries render the requested view.
  url.hash = new URL(input instanceof URL ? input.href : input).hash;
  return url.href;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Every HTTP(S) request, including scripts, styles, API responses, frames and
// redirects, uses this reader. Validation followed by Chromium DNS would leave
// a rebinding gap; instead Node connects to the exact validated numeric IP.
function createResourceReader({ resolve = dns.lookup, request, maxBytes = 8 * 1024 * 1024, timeoutMs = 8000 } = {}) {
  return async (input, { signal, accept = '*/*', referer = '' } = {}) => {
    const url = validatePublicUrl(input);
    const controller = new AbortController();
    const externalAbort = () => controller.abort(abortReason(signal));
    if (signal?.aborted) externalAbort(); else signal?.addEventListener('abort', externalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('RESOURCE_TIMEOUT', '网页资源读取超时。')), timeoutMs);
    try {
      const activeSignal = controller.signal;
      const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }]
        : await abortable(resolve(hostname, { all: true, verbatim: true }), activeSignal);
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || !isPublicAddress(item.address) || net.isIP(item.address) !== item.family)) {
        throw failure('PRIVATE_ADDRESS', '资源域名解析包含私有、保留或不安全地址，已拒绝访问。');
      }
      const address = addresses.find(item => item.family === 4) || addresses[0];
      const headers = { Host: url.host, Accept: String(accept).replace(/[\r\n]/g, '').slice(0, 512),
        'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'AIDesignHub-ImageCapture/1.0' };
      if (referer) { try { headers.Referer = validatePublicUrl(referer).href; } catch { /* No unsafe referrers. */ } }
      const performRequest = request || (url.protocol === 'https:' ? https.request : http.request);
      return await new Promise((resolveResponse, reject) => {
        let settled = false, req, response, decoder;
        const cleanup = () => activeSignal.removeEventListener('abort', abort);
        const fail = cause => {
          if (settled) return; settled = true; cleanup();
          response?.destroy(); if (decoder !== response) decoder?.destroy(); req?.destroy(); reject(cause);
        };
        const finish = value => { if (!settled) { settled = true; cleanup(); resolveResponse(value); } };
        const abort = () => fail(abortReason(activeSignal));
        activeSignal.addEventListener('abort', abort, { once: true });
        if (activeSignal.aborted) { abort(); return; }
        try {
          req = performRequest({ protocol: url.protocol, hostname: address.address, family: address.family,
            port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search,
            method: 'GET', agent: false, servername: net.isIP(hostname) ? '' : hostname,
            rejectUnauthorized: true, maxHeaderSize: 16 * 1024, headers }, res => {
            response = res;
            res.on('error', () => fail(failure('RESOURCE_ERROR', '网页资源响应被中断。')));
            res.on('aborted', () => fail(failure('RESOURCE_ERROR', '网页资源响应被中断。')));
            const responseHeaders = res.headers || {};
            if (REDIRECT.has(res.statusCode)) {
              try {
                const location = validatePublicUrl(new URL(String(responseHeaders.location || ''), url));
                if (!responseHeaders.location) throw new Error('No redirect target');
                finish({ status: res.statusCode, redirect: location.href, body: Buffer.alloc(0), headers: {} }); res.destroy();
              } catch { fail(failure('PRIVATE_ADDRESS', '网页重定向不安全，已拒绝访问。')); }
              return;
            }
            if (res.statusCode < 200 || res.statusCode >= 400) { fail(failure('HTTP_ERROR', `网页资源读取失败（HTTP ${res.statusCode}）。`)); return; }
            const type = String(responseHeaders['content-type'] || '').toLowerCase();
            // This browser is for inspecting pages, never arbitrary downloads,
            // executables, media streams or browser authentication handshakes.
            if (!/^(?:text\/(?:html|css|plain|javascript)|application\/(?:javascript|x-javascript|json|ld\+json|xml|xhtml\+xml)|image\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+|application\/(?:font-woff|vnd\.ms-fontobject|x-font-ttf))(?:\s*;|\s*$)/i.test(type)) {
              fail(failure('CONTENT_TYPE', '采集窗口不读取该类型的资源。')); return;
            }
            if (Number(responseHeaders['content-length']) > maxBytes) { fail(failure('BODY_LIMIT', '网页资源超过读取上限。')); return; }
            const encoding = String(responseHeaders['content-encoding'] || 'identity').trim().toLowerCase();
            if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) { fail(failure('CONTENT_ENCODING', '不支持该资源压缩格式。')); return; }
            decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate()
              : encoding === 'br' ? zlib.createBrotliDecompress() : res;
            let wireBytes = 0, bytes = 0; const chunks = [];
            res.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > maxBytes) fail(failure('BODY_LIMIT', '网页资源传输超过上限。')); });
            if (decoder !== res) decoder.on('error', () => fail(failure('RESOURCE_ERROR', '网页资源压缩数据无效。')));
            decoder.on('data', chunk => {
              if (settled) return; bytes += chunk.length;
              if (bytes > maxBytes) { fail(failure('BODY_LIMIT', '网页资源解压后超过上限。')); return; }
              chunks.push(Buffer.from(chunk));
            });
            decoder.on('end', () => finish({ status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks), url: url.href }));
            if (decoder !== res) res.pipe(decoder);
          });
          req.on('error', () => fail(failure('RESOURCE_ERROR', '无法连接网页资源。'))); req.end();
        } catch { fail(failure('RESOURCE_ERROR', '无法连接网页资源。')); }
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); }
  };
}

function responseHeaders(original = {}) {
  const headers = new Headers();
  // No Set-Cookie, credentials, Alt-Svc, reporting, client-hint delegation or
  // service-worker privilege headers are copied out of the isolated reader.
  for (const key of ['content-type', 'content-security-policy', 'x-content-type-options', 'x-frame-options',
    'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
    'cross-origin-resource-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']) {
    if (typeof original[key] === 'string') headers.set(key, original[key]);
  }
  headers.append('content-security-policy', "connect-src http: https:; object-src 'none'; form-action 'none'");
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), display-capture=()');
  headers.set('cache-control', 'no-store');
  return headers;
}

function makeCapture({ BrowserWindow, session, durationMs = 18000, maxCandidates = 600, maxScrollSteps = 14,
  scrollIntervalMs = 650, pollIntervalMs = 300, resourceBytes = 8 * 1024 * 1024 } = {}, testDependencies) {
  if (typeof BrowserWindow !== 'function' || typeof session?.fromPartition !== 'function') throw new TypeError('BrowserWindow and session are required.');
  const limits = { durationMs: clamp(durationMs, 18000, 1500, 45000), maxCandidates: clamp(maxCandidates, 600, 1, 1500),
    maxScrollSteps: clamp(maxScrollSteps, 14, 0, 30), scrollIntervalMs: clamp(scrollIntervalMs, 650, 100, 3000),
    maxElements: 6000 };
  const readResource = createResourceReader({ ...testDependencies, maxBytes: clamp(resourceBytes, 8 * 1024 * 1024, 1024, 16 * 1024 * 1024) });
  const active = new Set(); let disposed = false;
  const capturePage = async (input, { signal, onCandidates } = {}) => {
    const original = browserPublicUrl(input), mainRequestUrl = validatePublicUrl(input).href;
    if (disposed) throw failure('DISPOSED', '网页图片采集服务已关闭。');
    if (signal?.aborted) throw abortReason(signal);
    if (active.size) throw failure('CAPTURE_BUSY', '已有网页图片采集窗口，请先结束当前采集。');
    const controller = new AbortController(), resourceController = new AbortController();
    let win, ses, timer, pollTimer, closed = false, settled = false, loaded = false, busy = false, requestCount = 0, totalBytes = 0, inFlight = 0;
    let finalUrl = original, title = '', started = Date.now(), lastCandidate = started, lastSnapshot, loadFailure;
    const resourceWaiters = [];
    const images = new Map(), pendingNotifications = []; const listeners = [];
    let notifyTimer;
    const flush = () => {
      clearTimeout(notifyTimer); notifyTimer = undefined;
      if (pendingNotifications.length && typeof onCandidates === 'function') {
        const batch = pendingNotifications.splice(0);
        try { const notified = onCandidates(batch); notified?.catch?.(() => {}); } catch { /* Progress consumers cannot affect capture policy. */ }
      }
    };
    const add = candidates => {
      if (settled || !Array.isArray(candidates)) return;
      for (const item of candidates.slice(0, limits.maxCandidates)) {
        if (!item || typeof item.url !== 'string') continue;
        let url, sourcePageUrl;
        try { url = validatePublicUrl(item.url).href; sourcePageUrl = browserPublicUrl(item.sourcePageUrl || finalUrl); } catch { continue; }
        const existing = images.get(url), alt = typeof item.alt === 'string' ? item.alt.slice(0, 500) : '';
        const contentScope = ['article', 'excluded'].includes(item.contentScope) ? item.contentScope : 'unknown';
        const context = typeof item.context === 'string' ? item.context.slice(0, 600) : '';
        if (existing) { if (!existing.alt && alt) existing.alt = alt; if (contentScope === 'article' || existing.contentScope === 'unknown' && contentScope === 'excluded') Object.assign(existing, { contentScope, context }); continue; }
        if (images.size >= limits.maxCandidates) break;
        const image = { url, alt, sourcePageUrl, contentScope, context }; images.set(url, image); pendingNotifications.push(image); lastCandidate = Date.now();
      }
      if (pendingNotifications.length && !notifyTimer) notifyTimer = setTimeout(flush, 100);
    };
    const listen = (emitter, event, handler) => { emitter.on(event, handler); listeners.push(() => emitter.removeListener(event, handler)); };
    const externalAbort = () => controller.abort(abortReason(signal));
    const stop = () => controller.abort(failure('DISPOSED', '网页图片采集服务已关闭。'));
    active.add(stop);
    signal?.addEventListener('abort', externalAbort, { once: true });
    const cleanup = async () => {
      clearTimeout(timer); clearTimeout(pollTimer); clearTimeout(notifyTimer); flush();
      resourceController.abort(failure('ABORTED', '采集窗口已结束。'));
      resourceWaiters.splice(0).forEach(wake => wake());
      signal?.removeEventListener('abort', externalAbort);
      listeners.forEach(remove => remove()); active.delete(stop);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* Already closed. */ }
      if (ses) {
        for (const scheme of ['http', 'https']) { try { ses.protocol.unhandle(scheme); } catch { /* Setup may have failed before registration. */ } }
        try { await ses.closeAllConnections(); await ses.clearStorageData(); await ses.clearCache(); } catch { /* Fresh in-memory partition is not reused. */ }
      }
    };
    try {
      ses = session.fromPartition(`aidesignhub-image-capture-${randomUUID()}`, { cache: false });
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      listen(ses, 'will-download', event => event.preventDefault());
      // Native Chromium networking has no DIRECT fallback. HTTP(S) is served
      // only by the protocol handlers below. This also prevents WebRTC TCP and
      // any unhandled native network path from reaching an internal endpoint.
      await abortable(ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://192.0.2.1:9', proxyBypassRules: '<-loopback>' }), controller.signal);
      await ses.closeAllConnections();
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        let cancel = !/^https?:/.test(details.url);
        if (!cancel) { try { validatePublicUrl(details.url); } catch { cancel = true; } }
        callback({ cancel });
      });
      const handler = async request => {
        if (settled || resourceController.signal.aborted || request.method !== 'GET' || ++requestCount > 240 || totalBytes > 48 * 1024 * 1024) return new Response('Resource blocked', { status: 403 });
        let url;
        try { url = validatePublicUrl(request.url); } catch { return new Response('Address blocked', { status: 403 }); }
        while (inFlight >= 8 && !resourceController.signal.aborted) await new Promise(wake => resourceWaiters.push(wake));
        if (resourceController.signal.aborted || settled) return new Response('Capture ended', { status: 403 });
        inFlight++;
        try {
          const result = await readResource(url, { signal: resourceController.signal, accept: request.headers?.get?.('accept') || '*/*', referer: request.referrer || finalUrl });
          if (result.redirect) return Response.redirect(result.redirect, result.status);
          totalBytes += result.body.length;
          if (/^image\//i.test(String(result.headers['content-type'] || ''))) add([{ url: url.href, sourcePageUrl: request.referrer || finalUrl }]);
          return new Response(result.status === 204 || result.status === 304 ? null : result.body,
            { status: result.status, headers: responseHeaders(result.headers) });
        } catch (cause) {
          // A failed resource never falls back to Chromium's network stack.
          if (url.href === mainRequestUrl && !loaded) loadFailure = cause;
          return new Response('Resource unavailable', { status: 502, headers: { 'content-type': 'text/plain' } });
        } finally { inFlight--; resourceWaiters.shift()?.(); }
      };
      ses.protocol.handle('http', handler); ses.protocol.handle('https', handler);
      win = new BrowserWindow({ width: 1180, height: 820, minWidth: 700, minHeight: 500, show: true,
        title: TITLE, autoHideMenuBar: true, backgroundColor: '#f7f8fa',
        webPreferences: { session: ses, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
          allowRunningInsecureContent: false, webviewTag: false, plugins: false, experimentalFeatures: false,
          navigateOnDragDrop: false, spellcheck: false, devTools: false, backgroundThrottling: false } });
      win.setMenu(null); const contents = win.webContents;
      contents.setAudioMuted(true); contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guardNavigation = (event, target) => {
        try { validatePublicUrl(typeof target === 'string' ? target : (target?.url || event.url)); } catch { event.preventDefault(); }
      };
      listen(contents, 'will-navigate', guardNavigation);
      listen(contents, 'will-frame-navigate', (event, details) => guardNavigation(event, details));
      listen(contents, 'will-redirect', guardNavigation);
      listen(contents, 'will-attach-webview', event => event.preventDefault());
      listen(contents, 'login', (event, _details, _auth, callback) => { event.preventDefault(); callback?.(); });
      listen(contents, 'certificate-error', (event, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
      listen(contents, 'page-title-updated', event => { event.preventDefault(); win.setTitle(TITLE); });
      listen(contents, 'did-navigate', (_event, url) => { try { finalUrl = browserPublicUrl(url); } catch { /* Guard rejects unsafe navigation. */ } });
      const source = collectorSource(limits);
      return await new Promise((resolveCapture, reject) => {
        const finish = (cause, userClosed = false) => {
          if (settled) return; settled = true;
          if (cause) reject(cause);
          else if (loadFailure && !images.size && !userClosed) reject(loadFailure);
          else resolveCapture({ title, finalUrl, images: [...images.values()],
            text: typeof lastSnapshot?.text === 'string' ? lastSnapshot.text.slice(0, 512000) : '',
            description: typeof lastSnapshot?.description === 'string' ? lastSnapshot.description.slice(0, 4000) : '',
            textTruncated: lastSnapshot?.textTruncated === true, limited: lastSnapshot?.limited === true });
        };
        const aborted = () => finish(abortReason(controller.signal));
        controller.signal.addEventListener('abort', aborted, { once: true });
        listeners.push(() => controller.signal.removeEventListener('abort', aborted));
        listen(win, 'close', event => { event.preventDefault(); closed = true; finish(null, true); });
        listen(win, 'closed', () => { closed = true; finish(null, true); });
        listen(contents, 'render-process-gone', () => finish(failure('BROWSER_CRASHED', '采集网页进程已退出。')));
        const poll = async () => {
          if (settled || closed) return;
          if (!busy && loaded && !contents.isDestroyed()) {
            busy = true;
            try {
              const snapshot = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: source }]);
              if (snapshot && typeof snapshot === 'object') {
                lastSnapshot = snapshot; title = typeof snapshot.title === 'string' ? snapshot.title.slice(0, 500) : title;
                try { finalUrl = browserPublicUrl(snapshot.finalUrl); } catch { /* Keep last safe URL. */ }
                add(snapshot.images);
                const idle = Date.now() - Math.max(snapshot.lastNew || started, lastCandidate) >= 1800;
                if (snapshot.done || (Date.now() - started >= 5000 && idle && !snapshot.paused &&
                  (snapshot.atBottom || snapshot.scrollSteps >= limits.maxScrollSteps) && !inFlight)) { finish(); return; }
              }
            } catch { /* Navigation can destroy an isolated execution context. */ }
            finally { busy = false; }
          }
          pollTimer = setTimeout(poll, clamp(pollIntervalMs, 300, 50, 1500));
        };
        listen(contents, 'dom-ready', () => { loaded = true; });
        timer = setTimeout(() => finish(), limits.durationMs);
        if (controller.signal.aborted) { aborted(); return; }
        win.loadURL(original).then(() => { loaded = true; }).catch(cause => {
          if (!settled && !closed && !lastSnapshot) finish(loadFailure || failure('BROWSER_LOAD', '采集网页未能加载。'));
        });
        poll();
      });
    } finally { await cleanup(); }
  };
  capturePage.dispose = () => { disposed = true; for (const stop of [...active]) stop(); };
  return capturePage;
}

function createImageBrowserCapture(options) { return makeCapture(options); }

module.exports = { createImageBrowserCapture,
  // No IPC/public capture option can swap validators, DNS or transports. These
  // hooks only serve offline fixtures and deterministic transport safety tests.
  _testing: { createResourceReader, responseHeaders, createImageBrowserCapture: (options, dependencies) => makeCapture(options, dependencies) } };
