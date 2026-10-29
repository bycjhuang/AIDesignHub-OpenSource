'use strict';

// Serialized into a separate Chromium world. No Node or Hub bridge is available
// there; all values read from the page remain untrusted image candidates.
function browserImageCollector(options) {
  const key = '__aidesignhubImageCollector';
  if (!globalThis[key]) {
    const found = new Map(), observed = new WeakSet(), roots = new Set();
    const state = { done: false, paused: false, steps: 0, bottom: 0, limited: false, lastNew: Date.now(), nextScroll: 0 };
    const pending = []; let status, pauseButton;
    const add = (value, element, doc) => {
      if (typeof value !== 'string' || !value || found.size >= options.maxCandidates) return;
      try {
        const url = new URL(value, doc.baseURI);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 8192) return;
        url.hash = '';
        const alt = String(element?.getAttribute?.('alt') || element?.getAttribute?.('title') || '').slice(0, 500);
        let article = false, excluded = false; const context = [];
        for (let current = element, depth = 0; current && depth++ < 64; current = current.parentElement) {
          const name = current.localName, label = `${current.id || ''} ${current.getAttribute?.('class') || ''} ${current.getAttribute?.('role') || ''}`;
          const blocked = ['nav', 'header', 'footer', 'aside', 'form'].includes(name)
            || !['body', 'html'].includes(name) && (/(?:^|[\s_-])(?:related|recommended?|recommendations?|sidebar|advert(?:isement)?|ads?|promo(?:tion)?|banner|social|share|comments?|copyright|logo|avatar)(?:$|[\s_-])/i.test(label)
            || /相关推荐|猜你喜欢|相关文章|广告|推广/.test(label));
          const portfolioStoryboard = ['block', 'storyboard', 'main'].every(value => (current.getAttribute?.('class') || '').split(/\s+/).includes(value));
          const body = portfolioStoryboard || ['article', 'main'].includes(name) || /(?:^|[\s_-])(?:js_content|article(?:[\s_-](?:content|body|text|gallery))?|post[\s_-](?:content|body)|entry[\s_-]content|project[\s_-](?:content|gallery)|rich_media_content|gallery-items|afd-gal-items)(?:$|[\s_-])/i.test(label);
          article ||= body; excluded ||= blocked;
          if (blocked || body) context.push(`${name} ${label}`.trim().slice(0, 160));
        }
        const scope = { contentScope: excluded ? 'excluded' : article ? 'article' : 'unknown', context: context.reverse().join(' > ').slice(-600) };
        const item = found.get(url.href);
        if (item) { if (!item.alt && alt) item.alt = alt; if (scope.contentScope === 'article') Object.assign(item, scope); return; }
        found.set(url.href, { url: url.href, alt, sourcePageUrl: /^https?:/.test(doc.URL) ? doc.URL : doc.baseURI, ...scope });
        state.lastNew = Date.now();
      } catch { /* Invalid URLs are not candidates. */ }
    };
    const srcset = (value, element, doc) => {
      // Follow the HTML srcset token boundaries, including data-URL commas and
      // parenthesized descriptors. Relative URLs and both w/x forms are kept.
      let i = 0;
      while (i < value.length && i < 65536) {
        while (i < value.length && /[\s,]/.test(value[i])) i++;
        const start = i;
        while (i < value.length && !/\s/.test(value[i])) i++;
        let url = value.slice(start, i), ended = /,$/.test(url);
        url = url.replace(/,+$/, '');
        if (url) add(url, element, doc);
        if (ended) continue;
        let nesting = 0;
        while (i < value.length) {
          const c = value[i++];
          if (c === '(') nesting++;
          else if (c === ')') nesting = Math.max(0, nesting - 1);
          else if (c === ',' && !nesting) break;
        }
      }
    };
    const cssUrls = (value, element, doc) => {
      if (typeof value !== 'string' || !value.includes('url(')) return;
      const re = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)]*))\s*\)/gi;
      let match;
      while ((match = re.exec(value))) add((match[1] ?? match[2] ?? match[3]).trim().replace(/\\([()'"\\ ])/g, '$1'), element, doc);
    };
    const inspect = element => {
      if (!element || element.nodeType !== 1) return;
      const doc = element.ownerDocument, name = element.localName;
      if (element === globalThis[key]?.host) return;
      if (name === 'img') {
        add(element.currentSrc, element, doc); add(element.getAttribute('src'), element, doc);
      }
      if (name === 'img' || name === 'source') {
        for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) srcset(element.getAttribute(attr) || '', element, doc);
      }
      for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-image', 'data-original-src', 'data-zoom-image', 'data-large', 'data-full']) {
        add(element.getAttribute(attr), element, doc);
      }
      if (name === 'a') {
        const href = element.getAttribute('href') || '';
        if (/\.(?:jpe?g|png|webp|gif|avif|svg|bmp|tiff?)(?:[?#]|$)/i.test(href)) add(href, element, doc);
      }
      if (name === 'meta' && /^(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/i.test(element.getAttribute('property') || element.getAttribute('name') || '')) add(element.getAttribute('content'), element, doc);
      if (name === 'link' && element.getAttribute('as') === 'image') {
        add(element.getAttribute('href'), element, doc); srcset(element.getAttribute('imagesrcset') || '', element, doc);
      }
      if (name === 'video') add(element.getAttribute('poster'), element, doc);
      try {
        const view = doc.defaultView;
        cssUrls(view.getComputedStyle(element).backgroundImage, element, doc);
        for (const pseudo of ['::before', '::after']) {
          const style = view.getComputedStyle(element, pseudo);
          if (style.content !== 'none' && style.content !== 'normal') {
            cssUrls(style.backgroundImage, element, doc); cssUrls(style.content, element, doc);
          }
        }
      } catch { /* Cross-origin/removed documents remain outside DOM scope. */ }
      if (element.shadowRoot) observe(element.shadowRoot);
      if (name === 'iframe' || name === 'frame') {
        try { if (element.contentDocument) observe(element.contentDocument); } catch { /* Network discovery still sees cross-origin image requests. */ }
      }
    };
    const enqueue = root => {
      if (!root) return;
      if (pending.length > options.maxElements) { state.limited = true; return; }
      if (root.nodeType === 1) pending.push(root);
      if (root.querySelectorAll) {
        const nodes = root.querySelectorAll('*');
        for (let i = 0; i < nodes.length && pending.length < options.maxElements; i++) pending.push(nodes[i]);
        if (nodes.length > options.maxElements) state.limited = true;
      }
    };
    const observe = root => {
      if (observed.has(root)) return;
      observed.add(root); roots.add(root); enqueue(root);
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') enqueue(record.target);
          else for (const node of record.addedNodes) enqueue(node);
        }
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['src', 'srcset', 'style', 'class', 'href', 'data-src', 'data-original', 'data-srcset', 'data-lazy-src', 'data-lazy-srcset', 'data-zoom-image'] });
      root.addEventListener?.('load', event => { inspect(event.target); }, true);
      state.observers.push(observer);
    };
    state.observers = [];
    const host = document.createElement('aside');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:14px 14px auto auto!important;z-index:2147483647!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const panel = document.createElement('div');
    panel.style.cssText = 'font:13px/1.6 system-ui,sans-serif;color:#f6f7fb;background:#172234;border:1px solid #52647d;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px #0005;max-width:290px';
    const heading = document.createElement('strong'); heading.textContent = 'AIDesignHub · 网页图片采集'; panel.appendChild(heading);
    status = document.createElement('div'); panel.appendChild(status);
    const hint = document.createElement('div'); hint.textContent = '自动滚动有限页数；关闭窗口即结束。'; hint.style.cssText = 'font-size:11px;color:#c3d0df;margin:4px 0 8px'; panel.appendChild(hint);
    for (const [label, action] of [['暂停滚动', () => { state.paused = !state.paused; pauseButton.textContent = state.paused ? '继续滚动' : '暂停滚动'; }], ['结束采集', () => { state.done = true; }]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.style.cssText = 'font:12px system-ui;color:#172234;background:#eff4fb;border:0;border-radius:5px;padding:6px 10px;margin-right:7px;cursor:pointer';
      button.addEventListener('click', event => { if (event.isTrusted) action(); }); panel.appendChild(button);
      if (!pauseButton) pauseButton = button;
    }
    shadow.appendChild(panel); (document.body || document.documentElement).appendChild(host);
    globalThis[key] = { host, state, found, inspect, enqueue, roots, pending, status, scanned: 0 };
    observe(document);
  }
  const collector = globalThis[key];
  const { state, found, inspect, enqueue, roots, pending, status } = collector;
  // Re-scan responsive sources and iframe documents periodically; mutations and
  // img load events supply intermediate updates without executing page helpers.
  if (!state.lastScan || Date.now() - state.lastScan > 1200) {
    for (const root of roots) enqueue(root);
    state.lastScan = Date.now();
  }
  let work = 0;
  while (pending.length && work++ < options.maxElements) { inspect(pending.shift()); collector.scanned++; }
  if (!state.done && !state.paused && state.steps < options.maxScrollSteps && Date.now() >= state.nextScroll) {
    const before = window.scrollY, height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    window.scrollBy({ top: Math.max(400, window.innerHeight * 0.8), behavior: 'instant' });
    state.steps++; state.nextScroll = Date.now() + options.scrollIntervalMs;
    state.bottom = before + window.innerHeight >= height - 4 ? state.bottom + 1 : 0;
  }
  status.textContent = `发现 ${found.size} 张候选图片 · 滚动 ${state.steps}/${options.maxScrollSteps}`;
  // Read rendered article text in the same isolated world as image discovery.
  // Hiding our own overlay for this synchronous read prevents UI instructions
  // being mistaken for source material when a page has no article container.
  const article = document.querySelector('#js_content') || document.querySelector('article') || document.querySelector('main') || document.body;
  let articleText = '';
  const overlayDisplay = collector.host.style.display;
  try { collector.host.style.setProperty('display', 'none', 'important'); articleText = String(article?.innerText || ''); }
  finally { collector.host.style.setProperty('display', overlayDisplay || 'block', 'important'); }
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
    || document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
  return { title: document.title.slice(0, 500), finalUrl: location.href, images: [...found.values()],
    text: articleText.slice(0, 512000), textTruncated: articleText.length > 512000, description: String(description).slice(0, 4000),
    done: state.done, paused: state.paused, scrollSteps: state.steps, atBottom: state.bottom >= 2,
    lastNew: state.lastNew, limited: state.limited || found.size >= options.maxCandidates, scannedElements: collector.scanned };
}

function collectorSource(options) {
  return `(${browserImageCollector.toString()})(${JSON.stringify(options)})`;
}

module.exports = { collectorSource };
