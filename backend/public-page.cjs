'use strict';

// A deliberately non-browser public-page reader. It never executes page code,
// reads cookies, authenticates, or follows instructions found in the document.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');

const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BYTES = 2 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const error = (code, message) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function ipv4Number(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}
function ipv4In(address, prefix, bits) {
  const n = ipv4Number(address), p = ipv4Number(prefix), size = 2 ** (32 - bits);
  return n !== null && Math.floor(n / size) === Math.floor(p / size);
}
function ipv6Number(address) {
  if (net.isIP(address) !== 6 || address.includes('%')) return null;
  // Convert a dotted IPv4 tail before expanding the compressed IPv6 groups.
  let canonical = address;
  if (canonical.includes('.')) {
    const end = canonical.lastIndexOf(':');
    const v4 = ipv4Number(canonical.slice(end + 1));
    if (v4 === null) return null;
    canonical = canonical.slice(0, end + 1) + Math.floor(v4 / 65536).toString(16) + ':' + (v4 % 65536).toString(16);
  }
  const halves = canonical.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}
function ipv6In(value, prefix, bits) {
  return (value >> BigInt(128 - bits)) === (ipv6Number(prefix) >> BigInt(128 - bits));
}
function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const denied = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
    // Azure's virtual platform address is globally shaped but host-internal.
    return address !== '168.63.129.16' && !denied.some(([prefix, bits]) => ipv4In(address, prefix, bits));
  }
  if (version === 6) {
    const value = ipv6Number(address);
    // Permit only global unicast, then remove special-purpose/tunnelling ranges.
    // This also rejects loopback, ULA, link-local, multicast, NAT64 and all mapped IPv4.
    return value !== null && ipv6In(value, '2000::', 3)
      && !ipv6In(value, '2001::', 23) && !ipv6In(value, '2001:db8::', 32)
      && !ipv6In(value, '2002::', 16) && !ipv6In(value, '3fff::', 20);
  }
  return false;
}

function validatePublicUrl(input) {
  const source = input instanceof URL ? input.href : input;
  if (typeof source !== 'string' || !source || source.length > 8192 || /[\x00-\x20\x7f]/.test(source)) {
    throw error('INVALID_URL', '请输入不含空白或控制字符的公开网页 HTTP(S) 地址。');
  }
  let url;
  try { url = new URL(source); } catch { throw error('INVALID_URL', '网页地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw error('INVALID_URL', '只允许不含内嵌凭据的 HTTP(S) 公开网页。');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const version = net.isIP(hostname);
  if (version ? !isPublicAddress(hostname) : (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|home\.arpa|test|invalid|onion)$/.test(hostname))) {
    throw error('PRIVATE_ADDRESS', '不允许访问本机、内网、保留地址或云元数据地址。');
  }
  // Fragments are browser-side state, never part of an HTTP request target.
  url.hash = '';
  return url;
}

function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function resolvePublic(url, resolve, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
  else {
    try { addresses = await waitFor(resolve(hostname, { all: true, verbatim: true }), signal); }
    catch (cause) { if (signal.aborted) throw signal.reason; throw error('DNS_FAILED', '公开网页域名解析失败。'); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || !isPublicAddress(item.address) || net.isIP(item.address) !== item.family)) {
    throw error('PRIVATE_ADDRESS', '域名解析包含私有、保留或不安全地址，已拒绝访问。');
  }
  // The request uses this exact resolved IP, not another hostname lookup. All
  // returned records were checked, so mixed public/private answers also fail.
  return addresses.find(item => item.family === 4) || addresses[0];
}

function readResponse(url, address, { request, signal, maxBytes, image = false, referrer = '' }) {
  return new Promise((resolve, reject) => {
    let settled = false, req, response, decoder;
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const fail = cause => {
      if (settled) return;
      settled = true; cleanup();
      response?.destroy(); if (decoder && decoder !== response) decoder.destroy(); req?.destroy();
      reject(cause);
    };
    const finish = value => { if (!settled) { settled = true; cleanup(); resolve(value); } };
    const aborted = () => fail(signal.reason || error('ABORTED', '网页读取已取消。'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      req = request({
        protocol: url.protocol, hostname: address.address, family: address.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'GET', agent: false,
        servername: net.isIP(hostname) ? '' : hostname, rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        headers: { Host: url.host, Accept: image ? 'image/jpeg, image/png, image/webp, image/gif' : 'text/html, application/xhtml+xml, text/plain;q=0.5',
          ...(image && referrer ? { Referer: referrer } : {}),
          'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'AIDesignHub-PublicPage/1.0' },
      }, res => {
        response = res;
        res.on('error', () => fail(error('NETWORK_ERROR', '网页响应被中断。')));
        res.on('aborted', () => fail(error('NETWORK_ERROR', '网页响应被中断。')));
        if (REDIRECTS.has(res.statusCode)) {
          const location = res.headers.location;
          if (typeof location !== 'string' || !location) { fail(error('BAD_REDIRECT', '网页重定向未提供有效地址。')); return; }
          finish({ redirect: location }); res.destroy(); return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          fail(Object.assign(error('HTTP_ERROR', `公开网页读取失败（HTTP ${res.statusCode}）；不会登录或绕过访问限制。`), { statusCode: res.statusCode })); return;
        }
        const contentType = String(res.headers['content-type'] || '');
        const allowedType = image ? /^(?:image\/jpeg|image\/png|image\/webp|image\/gif)(?:\s*;|\s*$)/i : /^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:\s*;|\s*$)/i;
        if (!allowedType.test(contentType)) {
          fail(error('CONTENT_TYPE', image ? '预览仅接受 PNG、JPEG 或静态 WebP 图片。' : '只允许 HTML 或纯文本网页，不下载其他类型文件。')); return;
        }
        if (Number(res.headers['content-length']) > maxBytes) { fail(error('BODY_LIMIT', '网页体积超过读取上限。')); return; }
        const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
        if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) { fail(error('CONTENT_ENCODING', '不支持该网页压缩格式。')); return; }
        decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate()
          : encoding === 'br' ? zlib.createBrotliDecompress() : res;
        let wireBytes = 0, decodedBytes = 0; const chunks = [];
        res.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > maxBytes) fail(error('BODY_LIMIT', '网页传输体积超过读取上限。')); });
        if (decoder !== res) decoder.on('error', () => fail(error('DECOMPRESSION_ERROR', '网页压缩数据无效。')));
        decoder.on('data', chunk => {
          if (settled) return;
          decodedBytes += chunk.length;
          if (decodedBytes > maxBytes) { fail(error('BODY_LIMIT', '网页解压后体积超过读取上限。')); return; }
          chunks.push(Buffer.from(chunk));
        });
        decoder.on('end', () => finish({ bytes: Buffer.concat(chunks), contentType }));
        if (decoder !== res) res.pipe(decoder);
      });
      req.on('error', () => fail(error('NETWORK_ERROR', '无法连接公开网页。')));
      req.end();
    } catch { fail(error('NETWORK_ERROR', '无法连接公开网页。')); }
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', middot: '·', bull: '•', hellip: '…', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', sup2: '²', sup3: '³',
  eacute: 'é', Eacute: 'É', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', aring: 'å', auml: 'ä',
  acirc: 'â', Acirc: 'Â', ecirc: 'ê', Ecirc: 'Ê', icirc: 'î', ocirc: 'ô', Ocirc: 'Ô', ucirc: 'û', ccedil: 'ç', ntilde: 'ñ' };
function decodeEntities(value) {
  return String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z\d]+);/gi, (original, entity) => {
    if (!entity.startsWith('#')) return Object.prototype.hasOwnProperty.call(ENTITIES, entity) ? ENTITIES[entity] : original;
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}
function cleanText(value) { return decodeEntities(value).replace(/[\t\r\f \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function attributes(tag) {
  const attrs = Object.create(null);
  const matcher = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = matcher.exec(tag))) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  return attrs;
}
// Keep every bounded srcset variant; callers can prefer larger descriptors
// without guessing CDN URL rewrites or discarding the original source URL.
function srcsetImages(value) {
  const result = []; let offset = 0;
  const source = String(value || '').slice(0, 65536);
  while (offset < source.length && result.length < 80) {
    while (/[\s,]/.test(source[offset] || '') && offset < source.length) offset++;
    const start = offset;
    while (offset < source.length && !/\s/.test(source[offset])) offset++;
    let url = source.slice(start, offset);
    if (!url) break;
    let descriptor = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else { const end = source.indexOf(',', offset); descriptor = source.slice(offset, end < 0 ? source.length : end).trim(); offset = end < 0 ? source.length : end + 1; }
    const match = /^(\d+(?:\.\d+)?)(w|x)$/.exec(descriptor);
    if (url && !/^data:/i.test(url)) result.push({ url, resolution: match ? Number(match[1]) * (match[2] === 'x' ? 10000 : 1) : 0 });
  }
  return result.sort((a, b) => b.resolution - a.resolution);
}
function backgroundImages(style) {
  const images = [], declarations = /(?:^|[;{}])\s*background(?:-image)?\s*:\s*([^;{}]+)/gi;
  let declaration;
  while ((declaration = declarations.exec(String(style || '').slice(0, 262144))) && images.length < 80) {
    const urls = /url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'"\r\n]+))\s*\)/gi; let match;
    while ((match = urls.exec(declaration[1])) && images.length < 80) images.push(match[1] || match[2] || match[3]);
  }
  return images;
}
function parseHtml(html, { includeSmallImages = false } = {}) {
  let title = '', description = '', openGraphTitle = '', h1 = '';
  const visible = [], structuredData = [], imageCandidates = []; let imagesTruncated = false;
  const tag = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][a-z\d:-]*(?:\s+(?:[^'">]|"[^"]*"|'[^']*')*)?\s*\/?\s*>/gi;
  const skipped = new Set(['head', 'script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'noscript', 'template', 'iframe', 'object']);
  const block = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'th', 'dt', 'dd', 'br', 'hr', 'address']);
  const stack = [], imageScopes = []; let offset = 0, titleDepth = 0, h1Depth = 0, pictureDepth = 0, match;
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const scopeFor = (name, attrs) => {
    const label = `${attrs.id || ''} ${attrs.class || ''} ${attrs.role || ''}`;
    const excluded = ['nav', 'header', 'footer', 'aside', 'form'].includes(name)
      || !['body', 'html'].includes(name) && (/(?:^|[\s_-])(?:related|recommended?|recommendations?|sidebar|advert(?:isement)?|ads?|promo(?:tion)?|banner|social|share|comments?|copyright|logo|avatar|jobs?|recruit(?:ment|ing)?|offices|actions|side[\s_-]rail)(?:$|[\s_-])/i.test(label)
      || /相关推荐|猜你喜欢|相关文章|广告|推广/.test(label));
    const portfolioStoryboard = ['block', 'storyboard', 'main'].every(value => (attrs.class || '').split(/\s+/).includes(value));
    const article = portfolioStoryboard || ['article', 'main'].includes(name) || /(?:^|[\s_-])(?:js_content|article(?:[\s_-](?:content|body|text|gallery))?|post[\s_-](?:content|body)|entry[\s_-]content|project[\s_-](?:content|gallery)|rich_media_content|gallery-items|afd-gal-items)(?:$|[\s_-])/i.test(label);
    return { name, excluded, article, label: label.trim().slice(0, 200) };
  };
  let candidateScope = { contentScope: 'unknown', context: '' };
  const addCandidate = (url, alt = '', priority = 2, resolution = 0) => {
    if (typeof url !== 'string' || !url) return;
    if (imageCandidates.length >= 2400) { imagesTruncated = true; return; }
    imageCandidates.push({ url, alt: cleanText(alt).slice(0, 500), priority, resolution, ...candidateScope });
  };
  while ((match = tag.exec(html))) {
    const token = match[0], opening = /^<\s*([a-z][a-z\d:-]*)/i.exec(token), closing = /^<\s*\/\s*([a-z][a-z\d:-]*)/i.exec(token);
    const chunk = html.slice(offset, match.index);
    if (titleDepth) title += chunk;
    if (h1Depth && !stack.length) h1 += chunk;
    if (!stack.length) visible.push(chunk);
    offset = tag.lastIndex;
    if (!opening && !closing) continue;
    const name = (opening?.[1] || closing[1]).toLowerCase();
    if (name === 'picture') pictureDepth = Math.max(0, pictureDepth + (opening ? 1 : -1));
    if (opening && name === 'script') {
      // Raw-text elements can contain arbitrary '<' and '>' characters. Locate
      // their closing tag instead of pretending their JS content is HTML.
      const end = /<\/script\s*>/gi; end.lastIndex = offset; const close = end.exec(html);
      const raw = html.slice(offset, close ? close.index : html.length);
      if ((attributes(token).type || '').toLowerCase() === 'application/ld+json') {
        try { structuredData.push(JSON.parse(raw)); } catch { /* Invalid JSON-LD is not evidence. */ }
      }
      offset = close ? end.lastIndex : html.length; tag.lastIndex = offset; continue;
    }
    if (opening && name === 'style') {
      const end = /<\/style\s*>/gi; end.lastIndex = offset; const close = end.exec(html);
      candidateScope = { contentScope: 'unknown', context: 'stylesheet' };
      backgroundImages(html.slice(offset, close ? close.index : html.length)).forEach(url => addCandidate(url, '', 3));
      offset = close ? end.lastIndex : html.length; tag.lastIndex = offset; continue;
    }
    if (closing) { const index = imageScopes.findLastIndex(item => item.name === name); if (index >= 0) imageScopes.splice(index); }
    const ownScope = opening ? scopeFor(name, attributes(token)) : null;
    const scopes = ownScope ? [...imageScopes, ownScope] : imageScopes;
    candidateScope = { contentScope: scopes.some(item => item.excluded) ? 'excluded' : scopes.some(item => item.article) ? 'article' : 'unknown',
      context: scopes.filter(item => item.excluded || item.article).map(item => `${item.name}${item.label ? ` ${item.label}` : ''}`).join(' > ').slice(-600) };
    if (opening && !voidTags.has(name) && !/\/\s*>$/.test(token) && imageScopes.length < 256) imageScopes.push(ownScope);
    if (opening && !stack.length) {
      const attrs = attributes(token);
      // Publisher gallery state is inert JSON. Read only declared public image
      // resources; never execute scripts or invent an original-size URL.
      if (attrs['data-images'] && attrs['data-images'].length <= 1024 * 1024) {
        try {
          const gallery = JSON.parse(attrs['data-images']);
          if (Array.isArray(gallery)) for (const item of gallery.slice(0, 600)) {
            if (!item || typeof item !== 'object') continue;
            const alt = item.image_alt || item.caption || '';
            for (const key of ['url_original', 'url_large']) addCandidate(item[key], alt, -1);
            for (const key of ['url_slideshow', 'url_medium']) addCandidate(item[key], alt, 2);
          }
        } catch { /* Malformed gallery state is not source evidence. */ }
      }
      if (attrs.style) backgroundImages(attrs.style).forEach(url => addCandidate(url, attrs['aria-label'] || attrs.title || '', 3));
      if (name === 'a' && attrs.href && /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(attrs.href)) addCandidate(attrs.href, attrs.title || '', -1);
      if (name === 'source' && pictureDepth) {
        for (const key of ['data-srcset', 'data-lazy-srcset', 'srcset']) for (const image of srcsetImages(attrs[key])) addCandidate(image.url, '', 2, image.resolution);
      }
    }
    if (opening && name === 'meta') {
      const attrs = attributes(token), key = (attrs.name || attrs.property || '').toLowerCase();
      if ((key === 'description' || (!description && key === 'og:description')) && attrs.content) description = attrs.content;
      if (key === 'og:title' && attrs.content) openGraphTitle = attrs.content;
      if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key) && attrs.content) addCandidate(attrs.content, '', 0);
    }
    if (opening && name === 'img' && !stack.length) {
      const attrs = attributes(token);
      const width = Number.parseInt(attrs.width, 10), height = Number.parseInt(attrs.height, 10);
      const label = `${attrs.alt || ''} ${attrs.class || ''} ${attrs.id || ''}`;
      const tiny = includeSmallImages ? width > 0 && width <= 2 || height > 0 && height <= 2 : (width > 0 && width < 160) || (height > 0 && height < 100);
      if (!tiny && !/(?:^|[\s_-])(?:logo|icon|avatar|tracking|pixel)(?:$|[\s_-])/i.test(label)) {
        // Lazy-loaded project galleries often provide their useful URL outside src.
        for (const key of ['data-full', 'data-full-src', 'data-large', 'data-zoom-image', 'data-hires']) addCandidate(attrs[key], attrs.alt || '', 1);
        for (const key of ['data-srcset', 'data-lazy-srcset', 'srcset']) for (const image of srcsetImages(attrs[key])) addCandidate(image.url, attrs.alt || '', 2, image.resolution);
        for (const key of ['data-src', 'data-original', 'data-original-src', 'data-lazy-src', 'data-flickity-lazyload', 'data-lazy', 'src']) addCandidate(attrs[key], attrs.alt || '', 2);
      }
    }
    if (name === 'title') titleDepth += opening ? 1 : -1;
    if (name === 'h1') h1Depth += opening ? 1 : -1;
    if (skipped.has(name)) {
      if (opening) stack.push(name);
      else { const index = stack.lastIndexOf(name); if (index >= 0) stack.splice(index); }
    }
    if (!stack.length && block.has(name)) visible.push('\n');
    else if (!stack.length && ['span', 'strong', 'b', 'label'].includes(name)) visible.push(' ');
  }
  if (!stack.length) visible.push(html.slice(offset));
  return { title: cleanText(title || openGraphTitle || h1), description: cleanText(description),
    text: cleanText(visible.join('')), structuredData, imageCandidates, imagesTruncated };
}

function previewImages(parsed, baseUrl, limit = 24) {
  const candidates = [...(parsed.imageCandidates || [])];
  let visited = 0;
  const addImage = image => {
    if (typeof image === 'string') candidates.push({ url: image, alt: '', priority: 1 });
    else if (Array.isArray(image)) image.slice(0, 12).forEach(addImage);
    else if (object(image)) {
      const url = image.contentUrl || image.url;
      if (typeof url === 'string') candidates.push({ url, alt: typeof image.caption === 'string' ? image.caption.slice(0, 500) : '', priority: 1 });
    }
  };
  const visit = (value, depth = 0) => {
    if (++visited > 1000 || depth > 20 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => visit(item, depth + 1)); return; }
    // Article and project images are useful, organization logos are not covers.
    if (value.image) addImage(value.image);
    for (const [key, child] of Object.entries(value)) if (!['image', 'logo', 'author', 'publisher'].includes(key)) visit(child, depth + 1);
  };
  visit(parsed.structuredData);
  // Some architecture publishers put sidebar/promotion images before the
  // project gallery (and occasionally reuse one as og:image). A descriptive
  // project filename/alt matching several title or URL words outranks these.
  let pageName = '';
  try { pageName = decodeURIComponent(new URL(baseUrl).pathname.split('/').pop()); } catch {}
  const ignored = new Set(['the', 'and', 'with', 'from', 'project', 'projects', 'architect', 'architects', 'architecture', 'design', 'com', 'html', 'htm']);
  const tokens = [...new Set(`${pageName} ${parsed.title || ''}`.toLowerCase().match(/[a-z]{3,}/g) || [])].filter(token => !ignored.has(token)).slice(0, 60);
  const relevance = candidate => {
    let name = `${candidate.url} ${candidate.alt}`.toLowerCase();
    try { name = decodeURIComponent(name); } catch {}
    const score = tokens.filter(token => new RegExp(`(?:^|[^a-z])${token}(?:$|[^a-z])`).test(name)).length;
    return score >= 2 ? score : 0;
  };
  const seen = new Map(), images = [];
  for (const candidate of candidates.sort((a, b) => relevance(b) - relevance(a) || a.priority - b.priority || (b.resolution || 0) - (a.resolution || 0))) {
    try {
      const url = validatePublicUrl(new URL(candidate.url, baseUrl).href).href;
      if (/(?:^|[\/_.-])(?:logo|favicon|avatar|tracking|pixel)(?:[\/_.-]|$)/i.test(new URL(url).pathname)) continue;
      if (seen.has(url)) {
        const existing = seen.get(url), weights = { excluded: 0, unknown: 1, article: 2 };
        if ((weights[candidate.contentScope] ?? 1) > weights[existing.contentScope]) Object.assign(existing, { contentScope: candidate.contentScope, context: candidate.context || '' });
        continue;
      }
      const image = { url, alt: candidate.alt || '', contentScope: candidate.contentScope || 'unknown', context: candidate.context || '' };
      seen.set(url, image); images.push(image);
      if (images.length >= limit) break;
    } catch { /* Private, credentialed and non-HTTP image references never become fetch targets. */ }
  }
  return images;
}

function rasterInfo(bytes, contentType, { allowSmall = false, allowAnimation = false } = {}) {
  let width = 0, height = 0, mime = '';
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') throw error('IMAGE_ANIMATED', '预览不加载动图。');
      if (length > bytes.length - offset - 12) throw error('IMAGE_INVALID', '图片结构不完整。');
      offset += length + 12;
      if (type === 'IEND') break;
    }
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg'; let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  } else if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    mime = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
    let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0, ended = false;
    const subBlocks = () => {
      while (offset < bytes.length) { const length = bytes[offset++]; if (!length) return; if (offset + length > bytes.length) break; offset += length; }
      throw error('IMAGE_INVALID', 'GIF 图片结构不完整。');
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) { ended = true; break; }
      if (marker === 0x21) { if (offset >= bytes.length) break; offset++; subBlocks(); continue; }
      if (marker !== 0x2c || offset + 9 > bytes.length) break;
      const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6), packed = bytes[offset + 8];
      if (!frameWidth || !frameHeight || frameWidth > width || frameHeight > height || ++frames > 500) throw error('IMAGE_INVALID', 'GIF 图片尺寸或帧数无效。');
      offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) break;
      offset++; subBlocks();
    }
    if (!ended || !frames) throw error('IMAGE_INVALID', 'GIF 图片结构不完整。');
    if (frames > 1 && !allowAnimation) throw error('IMAGE_ANIMATED', '预览不加载动图。');
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp';
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      if (bytes[20] & 2) throw error('IMAGE_ANIMATED', '预览不加载动图。');
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height || mime !== contentType.split(';')[0].trim().toLowerCase()) throw error('IMAGE_INVALID', '图片内容与格式声明不符。');
  if (width > 9000 || height > 9000 || width * height > 24000000) throw error('IMAGE_DIMENSIONS', '图片尺寸超过安全预览上限。');
  if (!allowSmall && (width < 160 || height < 100)) throw error('IMAGE_TOO_SMALL', '忽略小尺寸标志或跟踪图片。');
  return { width, height, contentType: mime };
}

function decodeHtml(bytes, contentType) {
  const declaration = /charset\s*=\s*["']?([^;\s"'>]+)/i.exec(contentType)
    || /<meta\b[^>]*charset\s*=\s*["']?([^\s"';/>]+)/i.exec(bytes.subarray(0, 8192).toString('latin1'));
  let charset = declaration?.[1] || 'utf-8';
  if (/^gb(?:2312|_2312-80)$/i.test(charset)) charset = 'gbk';
  try { return new TextDecoder(charset).decode(bytes); }
  catch { throw error('CHARSET', '网页声明了不支持的文字编码。'); }
}

function createFetcher({ resolve = (hostname, options) => dns.lookup(hostname, options), request } = {}, image = false) {
  return async function fetchPublicPage(input, options = {}) {
    const { signal: externalSignal, timeoutMs = 10000, maxBytes = image ? 1536 * 1024 : DEFAULT_BYTES } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
      throw error('INVALID_LIMIT', '网页读取时限或体积上限无效。');
    }
    const original = validatePublicUrl(input).href;
    const imageLimit = options.maxImages === undefined ? 24 : options.maxImages;
    if (!image && (!Number.isInteger(imageLimit) || imageLimit < 1 || imageLimit > 600)) throw error('INVALID_LIMIT', '图片候选数量上限无效。');
    // An explicit image-only fallback may send a public page referrer, never
    // credentials. It is checked independently and recomputed on every hop.
    const referrerPage = image && options.referrer ? validatePublicUrl(options.referrer) : null;
    const referrerPolicy = options.referrerPolicy || 'strict-origin-when-cross-origin';
    if (referrerPage && !['origin', 'strict-origin-when-cross-origin'].includes(referrerPolicy)) throw error('INVALID_REFERRER', '不支持该图片来源策略。');
    const controller = new AbortController();
    const abort = () => controller.abort(error('ABORTED', '网页读取已取消。'));
    if (externalSignal?.aborted) abort(); else externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(error('TIMEOUT', '公开网页读取超时。')), timeoutMs);
    try {
      if (referrerPage) await resolvePublic(referrerPage, resolve, controller.signal);
      let current = validatePublicUrl(original); const seen = new Set();
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (seen.has(current.href)) throw error('REDIRECT_LOOP', '网页重定向形成循环。');
        seen.add(current.href);
        const address = await resolvePublic(current, resolve, controller.signal);
        const send = request || (current.protocol === 'https:' ? https.request : http.request);
        const referrer = !referrerPage || referrerPage.protocol === 'https:' && current.protocol !== 'https:' ? ''
          : referrerPolicy === 'origin' || referrerPage.origin !== current.origin ? `${referrerPage.origin}/` : referrerPage.href;
        const result = await readResponse(current, address, { request: send, signal: controller.signal, maxBytes, image, referrer });
        if (result.redirect) {
          if (redirects === 5) throw error('REDIRECT_LIMIT', '网页重定向次数超过上限。');
          let next;try { next = new URL(result.redirect, current).href; } catch { throw error('BAD_REDIRECT', '网页重定向地址无效。'); }
          current = validatePublicUrl(next); continue;
        }
        if (image) {
          const info = rasterInfo(result.bytes, result.contentType, { allowSmall: options.allowSmall === true, allowAnimation: options.allowAnimation === true });
          return { sourceUrl: original, finalUrl: current.href, ...info, byteLength: result.bytes.length, dataUrl: `data:${info.contentType};base64,${result.bytes.toString('base64')}` };
        }
        const source = decodeHtml(result.bytes, result.contentType);
        const parsed = /^text\/plain/i.test(result.contentType) ? { title: '', description: '', text: cleanText(source), structuredData: [] } : parseHtml(source, { includeSmallImages: options.includeSmallImages === true });
        if (current.hostname === 'mp.weixin.qq.com' && (/\/(?:mp\/wappoc_appmsgcaptcha|mp\/verify|mp\/wapverify)(?:[/?]|$)/i.test(current.pathname)
          || !/\bid\s*=\s*["']js_content["']/i.test(source) && /(?:环境异常|完成验证|访问过于频繁|请在微信客户端打开|该内容已被发布者删除|内容已被删除|该内容因违规无法查看|此内容因违规无法查看)/.test(parsed.text))) {
          throw error('PAGE_VERIFICATION_REQUIRED', '微信文章当前需要验证、仅限客户端打开或已无法访问；没有读取到文章正文。请在系统浏览器打开并保存文章 HTML 后导入，受限页面不会被当成文章保存。');
        }
        const discovered = previewImages(parsed, current.href, imageLimit + 1);
        const page = { url: original, finalUrl: current.href, title: parsed.title, text: parsed.text,
          description: parsed.description, images: discovered.slice(0, imageLimit), imagesTruncated: parsed.imagesTruncated === true || discovered.length > imageLimit,
          imagesComplete: imageLimit === 600 && options.includeSmallImages === true, retrievedAt: new Date().toISOString() };
        // Internal parser evidence is available to extractCaseFacts without
        // exposing raw scripts as general page text or execution instructions.
        Object.defineProperty(page, 'structuredData', { value: parsed.structuredData, enumerable: false });
        Object.defineProperty(page, 'rawHtml', { value: /^text\/plain/i.test(result.contentType) ? '' : source, enumerable: false });
        return page;
      }
    } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
  };
}

function labeledValue(source, labels, max = 500) {
  const expression = new RegExp(`(?:^|[\\n；;])\\s*(${labels})(?:[ \\t]*[：:][ \\t]*|\\s+)([^\\n；;]{1,${max}})(?=$|[\\n；;])`, 'im');
  const match = expression.exec(source);
  return match ? { value: cleanText(match[2]), quote: cleanText(match[0]) } : null;
}
function schemaNodes(items) {
  const nodes = []; let count = 0;
  const visit = (value, depth) => {
    if (++count > 1000 || depth > 20 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    const types = [].concat(value['@type'] || []).map(type => String(type).replace(/^https?:\/\/schema\.org\//, ''));
    if (types.some(type => ['Place', 'Building', 'CivicStructure', 'ShoppingCenter', 'LandmarksOrHistoricalBuildings', 'TouristAttraction', 'Residence', 'LocalBusiness'].includes(type))) nodes.push(value);
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item, depth + 1);
  };
  visit(items, 0); return nodes;
}

function extractCaseFacts(page) {
  if (!object(page)) throw error('INVALID_PAGE', '需要已读取的网页。');
  const sourceUrl = typeof page.finalUrl === 'string' ? page.finalUrl : page.url;
  const source = typeof page.text === 'string' ? page.text : '';
  const facts = { name: null, area: null, typeLabel: null, location: null, openingDate: null, designer: null, summary: null, evidence: [] };
  const add = (field, value, quote) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const cleaned = cleanText(value);
    facts[field] = cleaned;
    facts.evidence.push({ field, value: cleaned, sourceUrl, quote: cleanText(quote || value), status: 'page-extracted' });
  };
  const labels = {
    name: '项目名称|建筑名称|案例名称|Project\\s+name|Building\\s+name',
    typeLabel: '项目类型|建筑类型|建筑功能|Project\\s+type|Building\\s+type|Typology|Programme|Program',
    location: '项目地址|项目地点|项目位置|所在地|建设地点|地址|Location|Project\\s+location|Address',
    designer: '建筑设计|设计单位|建筑师|设计团队|设计方|设计公司|Architects?|Architecture\\s+by|Designed\\s+by|Design\\s+architect|Design\\s+team',
    openingDate: '开业日期|开业时间|正式开业|Opening\\s+date|Date\\s+opened|Opened',
  };
  for (const [field, label] of Object.entries(labels)) {
    const found = labeledValue(source, label);
    if (!found) continue;
    if (field === 'openingDate' && (/(?:预计|计划|拟定|待定|将于|planned|expected|scheduled|proposed|TBC|TBD)/i.test(found.value) || !/\d/.test(found.value))) continue;
    add(field, found.value, found.quote);
  }
  const units = '(?:万\\s*)?(?:平方(?:米|英尺|公里)|平方米|平米|㎡|m[²2]|sq\\.?\\s*(?:m|ft)\\.?|sqm|sqft|square\\s+(?:met(?:er|re)s?|feet|foot)|ft[²2]|GSF|SF|SM|公顷|hectares?|acres?|ha|亩)';
  const areaPattern = new RegExp(`(总建筑面积|建筑总面积|总楼面面积|建筑面积|用地面积|占地面积|场地面积|基地面积|商业(?:建筑)?面积|可租赁面积|总面积|Gross\\s+floor\\s+area|Total\\s+floor\\s+area|Floor\\s+area|Site\\s+area|Land\\s+area|Commercial\\s+area|Retail\\s+area|Lettable\\s+area|Total\\s+area|GFA|GLA|Area|Size)\\s*(?:[（(][^）)\\n]{0,30}[）)]\\s*)?[：:]?\\s*([\\d][\\d,.\\s]*(?:万|亿)?\\s*${units})`, 'gi');
  const areas = []; let match;
  while ((match = areaPattern.exec(source))) {
    const label = cleanText(match[1]), quantity = cleanText(match[2]);
    const value = `${label}：${quantity}`;
    if (areas.includes(value)) continue;
    areas.push(value);
    facts.evidence.push({ field: 'area', value, sourceUrl, quote: cleanText(match[0]), status: 'page-extracted' });
    if (areas.length >= 12) break;
  }
  if (areas.length) facts.area = areas.join('；');
  const nodes = schemaNodes(page.structuredData || []);
  const matching = nodes.filter(node => typeof node.name === 'string' && (cleanText(node.name) === facts.name || String(page.title || '').includes(cleanText(node.name))));
  // Do not assemble one project out of unrelated Place records (such as related
  // projects in JSON-LD). Ambiguous structured records are ignored.
  const selected = matching.length === 1 ? matching : nodes.length === 1 ? nodes : [];
  for (const node of selected) {
    if (!facts.name && typeof node.name === 'string') add('name', node.name, JSON.stringify({ name: node.name }));
    if (!facts.location && node.address) {
      const address = typeof node.address === 'string' ? node.address : object(node.address)
        ? [node.address.addressCountry, node.address.addressRegion, node.address.addressLocality, node.address.streetAddress].filter(value => typeof value === 'string').join(' ') : '';
      if (address) add('location', address, JSON.stringify({ address: node.address }));
    }
    // Do not infer venue opening from Article.datePublished, foundingDate,
    // completionDate, copyrightYear, or a news article's author.
    const openingKey = node.openingDate ? 'openingDate' : 'dateOpened', opened = node[openingKey];
    if (!facts.openingDate && typeof opened === 'string' && /\d/.test(opened) && !/planned|expected|预计|计划/i.test(opened)) add('openingDate', opened, JSON.stringify({ [openingKey]: opened }));
    const designerKey = node.architect ? 'architect' : 'designer', designer = node[designerKey];
    if (!facts.designer && (typeof designer === 'string' || typeof designer?.name === 'string')) add('designer', typeof designer === 'string' ? designer : designer.name, JSON.stringify({ [designerKey]: designer }));
    if (!facts.typeLabel && typeof node.category === 'string') add('typeLabel', node.category, JSON.stringify({ category: node.category }));
  }
  if (!facts.name && typeof page.title === 'string' && page.title.trim()) add('name', page.title, page.title);
  const description = typeof page.description === 'string' && page.description.trim() ? page.description : source;
  if (description.trim()) add('summary', description.trim().slice(0, 1000), description.trim().slice(0, 1000));
  return facts;
}

// Parses a user-selected saved page as inert text. Scripts are never executed.
function parsePublicHtml(html, sourceUrl, { maxImages = 600, includeSmallImages = true } = {}) {
  const url = validatePublicUrl(sourceUrl).href;
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) throw error('BODY_LIMIT', '保存的 HTML 超过 4 MB 上限。');
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 600) throw error('INVALID_LIMIT', '图片候选数量上限无效。');
  const parsed = parseHtml(html, { includeSmallImages });
  if (new URL(url).hostname === 'mp.weixin.qq.com' && !/\bid\s*=\s*["']js_content["']/i.test(html) && /环境异常|完成验证|访问过于频繁|请在微信客户端打开|该内容已被发布者删除|内容已被删除|该内容因违规无法查看|此内容因违规无法查看/.test(parsed.text)) {
    throw error('PAGE_VERIFICATION_REQUIRED', '导入的是微信验证页，没有文章正文；请先在浏览器正常打开文章再保存。');
  }
  const discovered = previewImages(parsed, url, maxImages + 1);
  const page = { url, finalUrl: url, title: parsed.title, text: parsed.text, description: parsed.description,
    images: discovered.slice(0, maxImages), imagesTruncated: parsed.imagesTruncated === true || discovered.length > maxImages,
    imagesComplete: maxImages === 600 && includeSmallImages === true, retrievedAt: new Date().toISOString(), imported: true };
  Object.defineProperty(page, 'structuredData', { value: parsed.structuredData, enumerable: false });
  Object.defineProperty(page, 'rawHtml', { value: html, enumerable: false });
  return page;
}

const fetchPublicPage = createFetcher();
const fetchPublicImage = createFetcher({}, true);
module.exports = { validatePublicUrl, parsePublicHtml, fetchPublicPage, fetchPublicImage, extractCaseFacts, validateRasterImage: rasterInfo, isPublicAddress,parseImageSrcset:srcsetImages,
  // Dependency injection is deliberately separate from fetchPublicPage's public
  // options. Production IPC must only call fetchPublicPage, never this test hook.
  _testing: { createFetcher, createImageFetcher: deps => createFetcher(deps, true), isPublicAddress, parseHtml, decodeEntities, previewImages, rasterInfo } };
