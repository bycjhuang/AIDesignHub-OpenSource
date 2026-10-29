'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const zlib = require('node:zlib');
const { validatePublicUrl, extractCaseFacts, _testing } = require('../backend/public-page.cjs');

const PUBLIC_IP = '93.184.216.34';
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures/case-page.html'));
const publicResolve = async () => [{ address: PUBLIC_IP, family: 4 }];

function fakeRequest(responses, calls = []) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; req.response?.destroy(); };
    req.end = () => {
      const spec = responses.shift();
      if (!spec) { queueMicrotask(() => req.emit('error', new Error('No test response'))); return; }
      if (spec.hang) return;
      queueMicrotask(() => {
        if (req.destroyed) return;
        const res = new PassThrough(); req.response = res;
        res.statusCode = spec.status || 200;
        res.headers = { 'content-type': 'text/html; charset=utf-8', ...spec.headers };
        callback(res);
        if (spec.truncated) { res.emit('aborted'); return; }
        if (spec.chunks) { for (const chunk of spec.chunks) res.write(chunk); res.end(); }
        else res.end(spec.body || Buffer.from('<html><title>Public Project</title><p>Project</p></html>'));
      });
    };
    return req;
  };
}

function fetcher(responses, { resolve = publicResolve, calls = [] } = {}) {
  return _testing.createFetcher({ resolve, request: fakeRequest(responses, calls) });
}

test('URL validation rejects local, private, mapped, reserved and metadata addresses', () => {
  for (const target of ['http://localhost/', 'http://localhost./', 'http://host.local/', 'http://metadata.google.internal/',
    'http://a.home.arpa/', 'http://singlelabel/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://10.20.30.40/', 'http://172.31.255.254/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://100.100.100.200/', 'http://168.63.129.16/', 'http://0.0.0.0/', 'http://198.18.0.1/',
    'http://192.0.2.1/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:8.8.8.8]/', 'http://[fc00::1]/',
    'http://[fe80::1]/', 'http://[64:ff9b::a00:1]/', 'http://[2002:7f00:1::]/', 'http://[2001:db8::1]/', 'http://[3fff::1]/']) {
    assert.throws(() => validatePublicUrl(target), error => error.code === 'PRIVATE_ADDRESS', target);
  }
  for (const target of ['file:///C:/secret', 'ftp://example.com/', 'https://user:password@example.com/', 'https://example.com/\nsecret']) {
    assert.throws(() => validatePublicUrl(target), error => error.code === 'INVALID_URL');
  }
});

test('URL validation preserves public paths/query and correctly classifies public IPs', () => {
  assert.equal(validatePublicUrl('https://example.com/中文?q=design#part').href, 'https://example.com/%E4%B8%AD%E6%96%87?q=design');
  assert.equal(validatePublicUrl('https://8.8.8.8/').hostname, '8.8.8.8');
  assert.equal(validatePublicUrl('https://[2606:4700:4700::1111]/').hostname, '[2606:4700:4700::1111]');
  assert.equal(_testing.isPublicAddress('2001:4860:4860::8888'), true);
  assert.equal(_testing.isPublicAddress('not-an-ip'), false);
});

test('DNS requires ALL returned records to be public before making a request', async () => {
  for (const addresses of [[{ address: '10.0.0.1', family: 4 }],
    [{ address: PUBLIC_IP, family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: PUBLIC_IP, family: 4 }, { address: 'fd00::1', family: 6 }],
    [{ address: PUBLIC_IP, family: 6 }], []]) {
    const calls = []; const fetch = fetcher([], { resolve: async () => addresses, calls });
    await assert.rejects(fetch('https://public.example.org/'), error => error.code === 'PRIVATE_ADDRESS');
    assert.equal(calls.length, 0);
  }
});

test('requests bind the validated IP while retaining original Host/TLS identity and no cookies', async () => {
  const calls = []; let lookups = 0;
  const fetch = fetcher([{ body: fixtureHtml }], { calls, resolve: async (_name, options) => {
    lookups++; assert.equal(options.all, true); return [{ address: PUBLIC_IP, family: 4 }];
  } });
  const page = await fetch('https://architecture.example.org:8443/projects/a?view=full');
  assert.equal(lookups, 1);assert.equal(calls[0].hostname, PUBLIC_IP);assert.equal(calls[0].headers.Host, 'architecture.example.org:8443');
  assert.equal(calls[0].servername, 'architecture.example.org');assert.equal(calls[0].rejectUnauthorized, true);
  assert.equal(calls[0].path, '/projects/a?view=full');assert.equal(calls[0].headers.Cookie, undefined);assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].agent, false);assert.equal(page.finalUrl, page.url);assert.match(page.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('every redirect is revalidated including fresh DNS; no cookies flow across origins', async () => {
  const calls = []; const resolved = [];
  const fetch = fetcher([{ status: 302, headers: { location: 'https://other.example.org/project', 'set-cookie': 'private=value' } }, { body: fixtureHtml }], {
    calls, resolve: async name => { resolved.push(name); return [{ address: PUBLIC_IP, family: 4 }]; },
  });
  const page = await fetch('https://first.example.org/start');
  assert.equal(page.url, 'https://first.example.org/start');assert.equal(page.finalUrl, 'https://other.example.org/project');
  assert.deepEqual(resolved, ['first.example.org', 'other.example.org']);assert.equal(calls[1].headers.Cookie, undefined);
  const internal = fetcher([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }]);
  await assert.rejects(internal('https://first.example.org/'), error => error.code === 'PRIVATE_ADDRESS');
  let count = 0; const reboundCalls = [];
  const rebound = fetcher([{ status: 302, headers: { location: '/redirected' } }], { calls: reboundCalls,
    resolve: async () => [{ address: ++count === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }],
  });
  await assert.rejects(rebound('https://rebind.example.org/start'), error => error.code === 'PRIVATE_ADDRESS');assert.equal(reboundCalls.length, 1);
});

test('redirect loops, excess redirects, non-HTTP redirects and credentials fail closed', async () => {
  await assert.rejects(fetcher([{ status: 302, headers: { location: '/a' } }])('https://example.org/a'), error => error.code === 'REDIRECT_LOOP');
  await assert.rejects(fetcher(Array.from({ length: 6 }, (_, index) => ({ status: 302, headers: { location: `/step${index + 1}` } })))('https://example.org/step0'), error => error.code === 'REDIRECT_LIMIT');
  for (const location of ['file:///etc/passwd', 'https://user:secret@example.org/']) {
    await assert.rejects(fetcher([{ status: 302, headers: { location } }])('https://example.org/'), error => error.code === 'INVALID_URL');
  }
});

test('only public HTML/text responses are accepted; no login or download fallback', async () => {
  for (const status of [401, 403, 404, 429, 500]) await assert.rejects(fetcher([{ status }])('https://example.org/'), error => error.code === 'HTTP_ERROR');
  for (const type of ['image/png', 'application/pdf', 'application/json', 'application/octet-stream', '']) {
    await assert.rejects(fetcher([{ headers: { 'content-type': type } }])('https://example.org/'), error => error.code === 'CONTENT_TYPE');
  }
  await assert.rejects(fetcher([{ headers: { 'content-encoding': 'zstd' } }])('https://example.org/'), error => error.code === 'CONTENT_ENCODING');
});

test('wire limits apply with and without Content-Length; compressed bombs use the decoded limit', async () => {
  for (const headers of [{}, { 'content-length': '10000' }]) {
    await assert.rejects(fetcher([{ body: Buffer.alloc(10000, 65), headers }])('https://example.org/', { maxBytes: 1024 }), error => error.code === 'BODY_LIMIT');
  }
  for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
    const body = compress(Buffer.from('<p>' + 'A'.repeat(100000) + '</p>'));
    assert(body.length < 1024);
    await assert.rejects(fetcher([{ body, headers: { 'content-encoding': encoding } }])('https://example.org/', { maxBytes: 1024 }), error => error.code === 'BODY_LIMIT');
  }
  await assert.rejects(fetcher([{ body: Buffer.from('not-gzip'), headers: { 'content-encoding': 'gzip' } }])('https://example.org/'), error => error.code === 'DECOMPRESSION_ERROR');
});

test('overall timeout covers both DNS and HTTP, and caller cancellation is honored', async () => {
  const neverResolve = fetcher([], { resolve: () => new Promise(() => {}) });
  await assert.rejects(neverResolve('https://example.org/', { timeoutMs: 10 }), error => error.code === 'TIMEOUT');
  await assert.rejects(fetcher([{ hang: true }])('https://example.org/', { timeoutMs: 10 }), error => error.code === 'TIMEOUT');
  const controller = new AbortController();controller.abort();
  await assert.rejects(fetcher([])('https://example.org/', { signal: controller.signal }), error => error.code === 'ABORTED');
  const active = new AbortController(); const fetching = fetcher([{ hang: true }])('https://example.org/', { signal: active.signal });active.abort();
  await assert.rejects(fetching, error => error.code === 'ABORTED');
  await assert.rejects(fetcher([{ truncated: true }])('https://example.org/'), error => error.code === 'NETWORK_ERROR');
});

test('HTML decoding retains Chinese/entities and discards navigation and executable source', async () => {
  const fetch = fetcher([{ body: zlib.gzipSync(fixtureHtml), headers: { 'content-encoding': 'gzip' } }]);
  const page = await fetch('https://design.example.org/project');
  assert.equal(page.title, '江湾文化商业中心 & Public Space');assert.match(page.description, /商业 & 文化/);
  assert.match(page.text, /128,000 m²/);assert.match(page.text, /Example & Partners/);
  for (const excluded of ['导航', '1900年', 'window.evil', '伪造面积', '不同项目', '版权与隐私', '.hidden']) assert(!page.text.includes(excluded), excluded);
  assert.equal(Object.keys(page).includes('structuredData'), false);
  assert.equal(globalThis.evil, undefined);
});

test('fact extraction preserves separate area bases and precise evidence', async () => {
  const page = await fetcher([{ body: fixtureHtml }])('https://design.example.org/project');const facts = extractCaseFacts(page);
  assert.equal(facts.name, '江湾文化商业中心');assert.equal(facts.typeLabel, '文化商业综合体');assert.equal(facts.location, '中国，上海市杨浦区');
  assert.equal(facts.designer, 'Example & Partners');assert.equal(facts.openingDate, '2024年9月28日');
  assert.match(facts.area, /总建筑面积：128,000 m²/);assert.match(facts.area, /用地面积：46,800 平方米/);assert.match(facts.area, /商业面积：5.8万㎡/);
  assert.equal(facts.evidence.filter(item => item.field === 'area').length, 3);
  assert(facts.evidence.every(item => item.status === 'page-extracted' && item.sourceUrl === page.finalUrl && item.quote));
});

test('publication, completion and organization founding dates are never venue opening dates', async () => {
  const html = `<html><title>Published project</title><script type="application/ld+json">{"@type":"Article","datePublished":"2025-07-01","author":{"name":"Journalist"}}</script><script type="application/ld+json">{"@type":"Place","name":"Published project","foundingDate":"1990-01-01","completionDate":"2024-01-01"}</script><p>Published: 2025-07-01</p><p>Completion date: 2024-01-01</p><p>计划开业：2027年</p></html>`;
  const facts = extractCaseFacts(await fetcher([{ body: Buffer.from(html) }])('https://example.org/'));
  assert.equal(facts.openingDate, null);assert.equal(facts.designer, null);assert.equal(facts.area, null);
  assert.equal(facts.location, null);assert.equal(facts.typeLabel, null);
  assert.equal(extractCaseFacts({ text: 'Opening date: Expected 2027', title: '', finalUrl: 'https://example.org/' }).openingDate, null);
});

test('explicit English labels work without confusing footprint or gross floor area', () => {
  const facts = extractCaseFacts({ finalUrl: 'https://example.org/project', title: 'Project Page', description: 'Original description.',
    text: 'Project name: Public Library\nTypology: Library\nLocation: Helsinki, Finland\nArchitect: Example Studio\nOpening date: December 5, 2018\nGross floor area: 17,250 sqm\nSite area: 8.6 hectares\nRetail area: 20,000 sq. ft.' });
  assert.equal(facts.name, 'Public Library');assert.equal(facts.designer, 'Example Studio');assert.equal(facts.openingDate, 'December 5, 2018');
  assert.match(facts.area, /Gross floor area：17,250 sqm/);assert.match(facts.area, /Site area：8.6 hectares/);assert.match(facts.area, /Retail area：20,000 sq. ft./);
});

test('JSON-LD is parsed as data only, never fetched or evaluated, and unrelated records are not merged', async () => {
  const html = `<html><title>Known Museum</title><script type="application/ld+json">{"@context":"http://127.0.0.1/secret","@graph":[{"@type":"Place","name":"Known Museum","address":{"addressCountry":"中国","addressLocality":"上海","streetAddress":"临港大道"},"dateOpened":"2021-07-18","architect":{"name":"Example Studio"}}]}</script><script>throw new Error('do not execute')</script><p>Public description.</p></html>`;
  const calls = [];const facts = extractCaseFacts(await fetcher([{ body: Buffer.from(html) }], { calls })('https://example.org/'));
  assert.equal(calls.length, 1);assert.equal(facts.location, '中国 上海 临港大道');assert.equal(facts.openingDate, '2021-07-18');assert.equal(facts.designer, 'Example Studio');
  const ambiguous = extractCaseFacts({ finalUrl: 'https://example.org/', title: 'Collection', text: '', structuredData: [
    { '@type': 'Place', name: 'One', address: 'A' }, { '@type': 'Place', name: 'Two', architect: 'B' },
  ] });
  assert.equal(ambiguous.location, null);assert.equal(ambiguous.designer, null);
});

test('script raw text and quoted HTML attributes cannot masquerade as visible page facts', () => {
  const parsed = _testing.parseHtml(`<html><head><title>Title &amp; &#20013;&#25991;</title><meta name="description" content="A > B &amp; C"></head><body><script>const s = '<p>开业日期：1900</p>'; if (a > b) {}</script><nav><div>地址：Internal</div></nav><p>项目名称：真项目</p></body></html>`);
  assert.equal(parsed.title, 'Title & 中文');assert.equal(parsed.description, 'A > B & C');assert.equal(parsed.text, '项目名称：真项目');
});

test('public fetch options do not accept injected DNS/request dependencies', async () => {
  const calls = [];const fetch = fetcher([{ body: fixtureHtml }], { calls });
  const page = await fetch('https://example.org/', { request: () => { throw new Error('must not run'); }, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(calls.length, 1);assert(page.text.includes('江湾'));
});

test('architect project-details labels without colons and GSF preserve source meaning', async () => {
  const html = '<html><title>Museum - Studio</title><main><div><span>Year</span>2021</div><div><span>Location</span>Shanghai, China</div><div><span>Size</span>420,000 GSF</div><div><strong>Program</strong>Permanent Exhibit Galleries, Digital Sky Theater</div></main></html>';
  const facts = extractCaseFacts(await fetcher([{ body: Buffer.from(html) }])('https://example.org/project'));
  assert.equal(facts.location, 'Shanghai, China');assert.equal(facts.area, 'Size：420,000 GSF');
  assert.equal(facts.typeLabel, 'Permanent Exhibit Galleries, Digital Sky Theater');assert.equal(facts.openingDate, null);
});

test('facts are not silently truncated into partial words', () => {
  const value = 'Exhibition galleries, '.repeat(11) + 'Observatory';
  const facts = extractCaseFacts({ finalUrl: 'https://example.org/', text: `Program ${value}` });
  assert.equal(facts.typeLabel, value);
  assert.equal(extractCaseFacts({ finalUrl: 'https://example.org/', text: 'Program ' + 'x'.repeat(501) }).typeLabel, null);
});

test('preview image metadata uses public project images, deduplicates and excludes unsafe URLs/logos', async () => {
  const html = `<html><head><meta property="og:image" content="/gallery/cover.png"><meta name="twitter:image" content="https://img.example.org/twitter.jpg"><meta property="og:image" content="http://127.0.0.1/secret.png"></head>
    <body><header><img src="/header-banner.png"></header><main><img src="/gallery/cover.png"><img data-src="//img.example.org/interior.jpg" alt="Interior &amp; courtyard"><img src="/logo.png"><img width="20" height="20" src="/tracking.gif"><img src="data:image/png;base64,AA"><img src="/small.png" width="50"><script type="application/ld+json">{"@type":"Place","image":{"contentUrl":"/gallery/plan.png","caption":"Plan"},"publisher":{"logo":"/publisher.png"}}</script></main></body></html>`;
  const page = await fetcher([{ body: Buffer.from(html) }])('https://projects.example.org/project');
  assert.deepEqual(page.images.map(item => item.url), ['https://projects.example.org/gallery/cover.png', 'https://img.example.org/twitter.jpg', 'https://projects.example.org/gallery/plan.png', 'https://img.example.org/interior.jpg']);
  assert.equal(page.images[3].alt, 'Interior & courtyard');
});

test('image requests use pinned public DNS and validate PNG dimensions without credentials or SVG', async () => {
  const { imageDataUrl } = require('./fixtures/smoke-case.cjs');
  const png = Buffer.from(imageDataUrl.split(',')[1], 'base64'); const calls = [];
  const imageFetch = _testing.createImageFetcher({ resolve: publicResolve, request: fakeRequest([{ headers: { 'content-type': 'image/png' }, body: png }], calls) });
  const image = await imageFetch('https://images.example.org/cover.png');
  assert.equal(image.width, 400); assert.equal(image.height, 240); assert.equal(image.dataUrl, imageDataUrl);
  assert.equal(calls[0].hostname, PUBLIC_IP); assert.equal(calls[0].servername, 'images.example.org');
  assert.equal(calls[0].headers.Cookie, undefined); assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].headers.Referer, undefined);
  for (const type of ['image/svg+xml', 'text/html']) {
    const fetch = _testing.createImageFetcher({ resolve: publicResolve, request: fakeRequest([{ headers: { 'content-type': type }, body: png }]) });
    await assert.rejects(fetch('https://images.example.org/a'), cause => cause.code === 'CONTENT_TYPE');
  }
  const spoofed = _testing.createImageFetcher({ resolve: publicResolve, request: fakeRequest([{ headers: { 'content-type': 'image/png' }, body: Buffer.from('<svg onload="evil()"/>') }]) });
  await assert.rejects(spoofed('https://images.example.org/a'), cause => cause.code === 'IMAGE_INVALID');
});

test('WeChat verification redirects and unavailable-content pages never become successful article extraction', async () => {
  await assert.rejects(fetcher([
    { status: 302, headers: { location: '/mp/wappoc_appmsgcaptcha?target_url=original' } },
    { body: Buffer.from('<html><title>验证</title><p>环境异常，请完成验证</p></html>') },
  ])('https://mp.weixin.qq.com/s/article'), cause => cause.code === 'PAGE_VERIFICATION_REQUIRED');
  await assert.rejects(fetcher([{ body: Buffer.from('<html><p>该内容已被发布者删除</p></html>') }])('https://mp.weixin.qq.com/s/article'), cause => cause.code === 'PAGE_VERIFICATION_REQUIRED');
  const article = await fetcher([{ body: Buffer.from('<html><title>实际文章</title><div id="js_content">这是正文：环境异常是本文讨论的主题<img data-src="https://mmbiz.qpic.cn/mmbiz_png/fixture/640?wx_fmt=png"><img width="80" height="40" src="https://img.example.org/detail.png"></div></html>') }])('https://mp.weixin.qq.com/s/article', { maxImages: 600, includeSmallImages: true });
  assert.equal(article.images.length, 2); assert.equal(article.imagesComplete, true); assert.equal(article.imagesTruncated, false);
  assert.match(article.text, /这是正文/);
});

test('full collection reports truncation after 600 candidates instead of silently stopping at preview count', async () => {
  const html = `<html><body>${Array.from({ length: 605 }, (_, index) => `<img data-src="/article/${index}.png">`).join('')}</body></html>`;
  const article = await fetcher([{ body: Buffer.from(html) }])('https://articles.example.org/a', { maxImages: 600, includeSmallImages: true });
  assert.equal(article.images.length, 600); assert.equal(article.imagesTruncated, true);
});

test('GIF structure is validated and animation requires an explicit archive option', async () => {
  const original = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const gif = Buffer.from(original); gif.writeUInt16LE(400, 6); gif.writeUInt16LE(240, 8);
  const info = _testing.rasterInfo(gif, 'image/gif'); assert.equal(info.width, 400); assert.equal(info.height, 240);
  const frameStart = gif.indexOf(0x2c), frame = gif.subarray(frameStart, gif.length - 1);
  const animated = Buffer.concat([gif.subarray(0, -1), frame, Buffer.from([0x3b])]);
  assert.throws(() => _testing.rasterInfo(animated, 'image/gif'), cause => cause.code === 'IMAGE_ANIMATED');
  assert.equal(_testing.rasterInfo(animated, 'image/gif', { allowAnimation: true }).contentType, 'image/gif');
  assert.throws(() => _testing.rasterInfo(gif.subarray(0, -2), 'image/gif', { allowAnimation: true }), cause => cause.code === 'IMAGE_INVALID');
  assert.throws(() => _testing.rasterInfo(gif, 'image/png'), cause => cause.code === 'IMAGE_INVALID');
});

test('project gallery filenames outrank unrelated publisher/sidebar promotion images', async () => {
  const html = `<html><head><title>Hidden Spa Water Hope / IDEE Architects</title><meta property="og:image" content="https://img.example.org/gooood-interview-Yang-Dingliang.png"><meta name="description" content="B&acirc;t Tr&agrave;ng"></head><body><img src="https://img.example.org/promotion.png"><img src="https://img.example.org/002-Hidden-Spa-Water-Hope-by-IDEE-Architects-960x674.jpg"><img src="https://img.example.org/003-Hidden-Spa-Water-Hope-by-IDEE-Architects.jpg"></body></html>`;
  const page = await fetcher([{ body: Buffer.from(html) }])('https://projects.example.org/hidden-spa-water-hope-by-idee-architects.htm');
  assert.match(page.images[0].url, /002-Hidden-Spa/); assert.match(page.images[1].url, /003-Hidden-Spa/);
  assert.equal(page.description, 'Bât Tràng');
});

test('image redirects, DNS rebinding, size limits and decoded dimensions fail closed', async () => {
  const { imageDataUrl } = require('./fixtures/smoke-case.cjs'); const png = Buffer.from(imageDataUrl.split(',')[1], 'base64');
  const imageFetch = responses => _testing.createImageFetcher({ resolve: publicResolve, request: fakeRequest(responses) });
  await assert.rejects(imageFetch([{ status: 302, headers: { location: 'http://169.254.169.254/cover.png' } }])('https://images.example.org/a'), cause => cause.code === 'PRIVATE_ADDRESS');
  const privateDns = _testing.createImageFetcher({ resolve: async () => [{ address: '10.0.0.1', family: 4 }], request: fakeRequest([]) });
  await assert.rejects(privateDns('https://images.example.org/a'), cause => cause.code === 'PRIVATE_ADDRESS');
  await assert.rejects(imageFetch([{ headers: { 'content-type': 'image/png' }, body: png }])('https://images.example.org/a', { maxBytes: 100 }), cause => cause.code === 'BODY_LIMIT');
  const oversized = Buffer.from(png); oversized.writeUInt32BE(20000, 16);
  await assert.rejects(imageFetch([{ headers: { 'content-type': 'image/png' }, body: oversized }])('https://images.example.org/a'), cause => cause.code === 'IMAGE_DIMENSIONS');
  const tiny = Buffer.from(png); tiny.writeUInt32BE(1, 16);
  await assert.rejects(imageFetch([{ headers: { 'content-type': 'image/png' }, body: tiny }])('https://images.example.org/a'), cause => cause.code === 'IMAGE_TOO_SMALL');
});

test('static image discovery keeps complete srcset and picture variants, lazy originals, backgrounds and direct full-size links', async () => {
  const html = `<html><head><style>.hero{background-image:url('/css-hero.webp')}@font-face{src:url('/font.woff2')}</style></head><body><main>
    <picture><source srcset="/gallery/source-small.webp 400w, /gallery/source-large.webp 1600w"><img src="/gallery/fallback.jpg" srcset="/gallery/small.jpg 320w, /gallery/large.jpg 1920w" data-srcset="/gallery/retina.jpg 2x" data-original-src="/gallery/original.png" alt="主立面"></picture>
    <a href="/gallery/full-resolution.jpg?download=1"><img src="/gallery/thumb.jpg" width="50" height="30"></a>
    <div style="background:url('//img.example.org/courtyard.png') center/cover"></div>
    <img data-full="/gallery/full.png" data-lazy-src="/gallery/lazy.jpg" src="/gallery/placeholder.jpg">
    <div style="background-image:url('file:///C:/private.png'),url('http://127.0.0.1/private.png')"></div></main></body></html>`;
  const page = await fetcher([{ body: Buffer.from(html) }])('https://projects.example.org/a', { maxImages: 120 });
  const urls = page.images.map(image => image.url);
  for (const name of ['source-small.webp', 'source-large.webp', 'fallback.jpg', 'small.jpg', 'large.jpg', 'retina.jpg', 'original.png', 'full-resolution.jpg?download=1', 'full.png', 'lazy.jpg', 'placeholder.jpg']) assert(urls.includes(`https://projects.example.org/gallery/${name}`), name);
  assert(urls.includes('https://projects.example.org/css-hero.webp')); assert(urls.includes('https://img.example.org/courtyard.png'));
  assert(urls.indexOf('https://projects.example.org/gallery/large.jpg') < urls.indexOf('https://projects.example.org/gallery/small.jpg'));
  assert(urls.indexOf('https://projects.example.org/gallery/source-large.webp') < urls.indexOf('https://projects.example.org/gallery/source-small.webp'));
  assert(!urls.some(url => /thumb\.jpg|font\.woff2|127\.0\.0\.1|file:/.test(url)));
});

test('legacy page previews retain the 24-image contract while explicit collection discovery can request 120', async () => {
  const html = `<html><body>${Array.from({ length: 150 }, (_, index) => `<img src="/gallery/${index}.jpg">`).join('')}</body></html>`;
  const legacy = await fetcher([{ body: Buffer.from(html) }])('https://projects.example.org/a'); assert.equal(legacy.images.length, 24);
  const collected = await fetcher([{ body: Buffer.from(html) }])('https://projects.example.org/a', { maxImages: 120 }); assert.equal(collected.images.length, 120);
  await assert.rejects(fetcher([])('https://projects.example.org/a', { maxImages: 100000 }), cause => cause.code === 'INVALID_LIMIT');
});

test('optional public image referrer is origin-limited cross-origin, stripped on downgrade and never carries cookies or credentials', async () => {
  const png = Buffer.from(require('./fixtures/smoke-case.cjs').imageDataUrl.split(',')[1], 'base64'); const calls = [];
  const image = _testing.createImageFetcher({ resolve: publicResolve, request: fakeRequest([
    { status: 302, headers: { location: 'https://images.example.org/cover.png' } },
    { status: 302, headers: { location: 'http://images.example.org/final.png' } },
    { headers: { 'content-type': 'image/png' }, body: png }], calls) });
  await image('https://projects.example.org/image.png', { referrer: 'https://projects.example.org/project?private=query#section' });
  assert.equal(calls[0].headers.Referer, 'https://projects.example.org/project?private=query');
  assert.equal(calls[1].headers.Referer, 'https://projects.example.org/'); assert.equal(calls[2].headers.Referer, undefined);
  assert(calls.every(call => call.headers.Cookie === undefined && call.headers.Authorization === undefined));
  for (const referrer of ['http://127.0.0.1/page', 'https://user:secret@example.org/page', 'file:///C:/page']) await assert.rejects(image('https://images.example.org/a', { referrer }));
  const privateDns = _testing.createImageFetcher({ resolve: async host => host === 'page.example.org' ? [{ address: '10.0.0.1', family: 4 }] : publicResolve(), request: fakeRequest([]) });
  await assert.rejects(privateDns('https://images.example.org/a', { referrer: 'https://page.example.org/' }), cause => cause.code === 'PRIVATE_ADDRESS');
});
