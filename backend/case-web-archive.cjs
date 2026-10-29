'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validatePublicUrl,parseImageSrcset, _testing: { decodeEntities } } = require('./public-page.cjs');

const MAX_HTML = 4 * 1024 * 1024;
const MAX_DOCUMENT = 8 * 1024 * 1024;
const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][a-z\d:-]*(?:\s+(?:[^'">]|"[^"]*"|'[^']*')*)?\s*\/?\s*>/gi;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ALLOWED = new Set(['article', 'main', 'section', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figure', 'figcaption', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'strong', 'b', 'em', 'i', 'u', 's', 'span', 'small', 'sup', 'sub', 'br', 'hr', 'pre', 'code', 'address']);
const RAW = new Set(['script', 'style', 'textarea', 'xmp', 'plaintext', 'iframe', 'object', 'template', 'noscript', 'svg', 'math']);
const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clean = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function attrs(token) {
  const result = Object.create(null), pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match; while ((match = pattern.exec(token))) result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  return result;
}
function publicUrl(value, base) { if(typeof value!=='string'||!value.trim())return '';try { return validatePublicUrl(new URL(value, base).href).href; } catch { return ''; } }
function excluded(name, attributes) {
  return ['nav', 'header', 'footer', 'aside', 'form', 'button'].includes(name) || /(?:^|[\s_-])(?:related|recommend(?:ed|ations?)?|sidebar|advert(?:isement)?|ads?|promo(?:tion)?|banner|social|share|comments?|copyright|logo|avatar|jobs?|recruit(?:ment|ing)?|offices|actions|side[\s_-]rail)(?:$|[\s_-])/i.test(`${attributes.id || ''} ${attributes.class || ''}`);
}
function rootWeight(name, attributes) {
  const label = `${attributes.id || ''} ${attributes.class || ''}`;
  if (/\bjs_content\b|rich_media_content|entry[\s_-]content|post[\s_-](?:content|body)|article[\s_-](?:content|body|text)/i.test(label)) return 50000;
  if (/project[\s_-](?:content|gallery)|\bcontent-main\b|\bmain-content\b/i.test(label)) return 20000;
  if (name === 'article') return 10000;
  if (name === 'main' || attributes.role === 'main') return 5000;
  if (/(?:^|[\s_-])(?:content|storyboard)(?:$|[\s_-])/i.test(label)) return 1000;
  if (name === 'body') return 1;
  return 0;
}
// Select a bounded article subtree, rather than keeping the publisher's page
// chrome, related projects, adverts, or executable application code.
function articleRoot(source) {
  const pattern = new RegExp(TOKEN.source, 'gi'), stack = [], candidates = []; let match;
  while ((match = pattern.exec(source))) {
    const opening = /^<\s*([a-z][a-z\d:-]*)/i.exec(match[0]), closing = /^<\s*\/\s*([a-z][a-z\d:-]*)/i.exec(match[0]);
    if (!opening && !closing) continue;
    const name = (opening?.[1] || closing[1]).toLowerCase();
    if (opening && RAW.has(name)) { const end = new RegExp(`</${name}\\s*>`, 'gi'); end.lastIndex = pattern.lastIndex; const found = end.exec(source); pattern.lastIndex = found ? end.lastIndex : source.length; continue; }
    if (closing) {
      const index = stack.findLastIndex(item => item.name === name);
      if (index < 0) continue;
      for (const entry of stack.splice(index)) if (entry.weight && !entry.excluded) candidates.push({ ...entry, end: match.index, length: match.index - entry.start });
    } else if (!VOID.has(name) && !/\/\s*>$/.test(match[0])) {
      const attributes = attrs(match[0]);
      stack.push({ name, start: pattern.lastIndex, weight: rootWeight(name, attributes), excluded: stack.some(item => item.excluded) || excluded(name, attributes) });
    }
  }
  for (const entry of stack) if (entry.weight && !entry.excluded) candidates.push({ ...entry, end: source.length, length: source.length - entry.start });
  const chosen = candidates.filter(item => item.length > 30).sort((a, b) => b.weight - a.weight || b.length - a.length)[0];
  return chosen ? source.slice(chosen.start, chosen.end) : source;
}
function imageUrls(attributes, base) {
  const values = [];
  for (const key of ['data-full', 'data-full-src', 'data-large', 'data-zoom-image', 'data-hires', 'data-original', 'data-original-src']) if (attributes[key]) values.push(attributes[key]);
  for (const key of ['data-srcset', 'data-lazy-srcset', 'srcset']) for(const image of parseImageSrcset(attributes[key]))values.push(image.url);
  for(const key of ['data-src','data-lazy-src','data-flickity-lazyload','data-lazy','src'])if(attributes[key])values.push(attributes[key]);
  return [...new Set(values.map(value => publicUrl(value, base)).filter(Boolean))];
}
// Nuxt's server-rendered media dictionary declares WordPress originals while
// the visible img may use a resized publication copy. Resolve only this inert
// media record shape; arbitrary app state and script instructions are ignored.
function publisherMedia(page) {
  const media=new Map(),source=typeof page.rawHtml==='string'?page.rawHtml:'';
  const scripts=/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;let match;
  while((match=scripts.exec(source))){
    const attributes=attrs(match[1]);if(attributes.id!=='__NUXT_DATA__'||attributes.type!=='application/json'||match[2].length>MAX_HTML)continue;
    let pool;try{pool=JSON.parse(match[2]);}catch{continue;}if(!Array.isArray(pool)||pool.length>150000)continue;
    const value=reference=>Number.isInteger(reference)&&reference>=0&&reference<pool.length?pool[reference]:undefined;
    for(const node of pool){
      if(!node||typeof node!=='object'||Array.isArray(node)||!Object.hasOwn(node,'source_url')||!Object.hasOwn(node,'id'))continue;
      const id=value(node.id),original=publicUrl(value(node.source_url),page.finalUrl||page.url);
      if(!Number.isInteger(id)||id<1||!original||!Object.hasOwn(node,'sizes'))continue;
      const sizes=value(node.sizes),variants=[];
      if(sizes&&typeof sizes==='object'&&!Array.isArray(sizes))for(const reference of Object.values(sizes)){
        const size=value(reference);if(!size||typeof size!=='object')continue;const url=publicUrl(value(size.source_url),page.finalUrl||page.url);if(url)variants.push({url,rank:(Number(value(size.width))||0)*(Number(value(size.height))||0)});
      }
      variants.sort((a,b)=>b.rank-a.rank);
      media.set(String(id),{original,urls:[...new Set([original,...variants.map(item=>item.url)])]});
    }
  }
  return media;
}
function safeStyle(value) {
  const declarations = [];
  for (const declaration of String(value || '').slice(0, 2000).split(';')) {
    const colon = declaration.indexOf(':'); if (colon < 0) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim().toLowerCase();
    if (key === 'text-align' && /^(left|right|center|justify)$/.test(value)
      || key === 'font-weight' && /^(normal|bold|[1-9]00)$/.test(value)
      || key === 'font-style' && /^(normal|italic)$/.test(value)
      || key === 'text-decoration' && /^(none|underline|line-through)$/.test(value)
      || ['color', 'background-color'].includes(key) && /^(#[a-f\d]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|black|white|gray|grey)$/.test(value)
      || key === 'font-size' && /^(1[0-9]|2[0-9]|3[0-6])px$/.test(value)) declarations.push(`${key}:${value}`);
  }
  return declarations.join(';');
}
function articleTemplate(page) {
  const source = typeof page.rawHtml === 'string' ? articleRoot(page.rawHtml.slice(0, MAX_HTML)) : '';
  if (!source) {
    const imageGroups = (Array.isArray(page.images) ? page.images : []).filter(item => item.contentScope !== 'excluded' && publicUrl(item.url, page.finalUrl || page.url)).map(item => ({ urls: [publicUrl(item.url, page.finalUrl || page.url)], alt: clean(item.alt, 500) }));
    return { fragment: String(page.text || '').split(/\n\s*\n/).map(part => `<p>${escape(part).replace(/\n/g, '<br>')}</p>`).join('') + imageGroups.map((_, index) => `<span data-adh-image="${index}"></span>`).join(''), imageGroups, links: [], layout: 'text' };
  }
  const output = [], links = [], imageGroups = [], declaredGallery = [], stack = [], pattern = new RegExp(TOKEN.source, 'gi'); let offset = 0, match;
  const media=publisherMedia(page);
  const blocked = () => stack.some(item => item.excluded);
  const base = page.finalUrl || page.url;
  while ((match = pattern.exec(source))) {
    if (!blocked()) output.push(escape(decodeEntities(source.slice(offset, match.index))));
    offset = pattern.lastIndex;
    const opening = /^<\s*([a-z][a-z\d:-]*)/i.exec(match[0]), closing = /^<\s*\/\s*([a-z][a-z\d:-]*)/i.exec(match[0]);
    if (!opening && !closing) continue;
    const name = (opening?.[1] || closing[1]).toLowerCase();
    if (opening && RAW.has(name)) { const end = new RegExp(`</${name}\\s*>`, 'gi'); end.lastIndex = offset; const found = end.exec(source); offset = found ? end.lastIndex : source.length; pattern.lastIndex = offset; continue; }
    if (closing) {
      const index = stack.findLastIndex(item => item.name === name);
      if (index >= 0) for (const entry of stack.splice(index).reverse()) if (entry.emitted) output.push(`</${entry.emitted}>`);
      continue;
    }
    const attributes = attrs(match[0]), omit = blocked() || excluded(name, attributes);
    if(!omit&&attributes['data-images']&&attributes['data-images'].length<1024*1024){try{const gallery=JSON.parse(attributes['data-images']);if(Array.isArray(gallery))for(const image of gallery.slice(0,600)){if(!image||typeof image!=='object')continue;const urls=['url_original','url_large','url_slideshow','url_medium'].map(key=>publicUrl(image[key],base)).filter(Boolean);if(urls.length)declaredGallery.push({urls,alt:clean(image.image_alt||image.caption,500)});}}catch{}}
    if(!omit&&attributes.style&&/background(?:-image)?\s*:/i.test(attributes.style)){const urls=[...attributes.style.matchAll(/url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'"\r\n]+))\s*\)/gi)].map(match=>publicUrl(match[1]||match[2]||match[3],base)).filter(Boolean);if(urls.length){const index=imageGroups.length;imageGroups.push({urls,alt:clean(attributes['aria-label']||attributes.title,500)});output.push(`<span data-adh-image="${index}"></span>`);}}
    if (name === 'img' && !omit) {
      const label = `${attributes.alt || ''} ${attributes.class || ''} ${attributes.id || ''}`;
      if (/(?:^|[\s_-])(?:logo|icon|avatar|tracking|pixel)(?:$|[\s_-])/i.test(label) || Number(attributes.width) <= 2 && Number(attributes.width) > 0 || Number(attributes.height) <= 2 && Number(attributes.height) > 0) continue;
      const urls = imageUrls(attributes, base), anchor = stack.findLast(item => item.name === 'a'), picture = stack.findLast(item => item.name === 'picture');
      if (picture?.urls) urls.unshift(...picture.urls);
      if (anchor?.imageUrl) urls.unshift(anchor.imageUrl);
      const declared=media.get(attributes['data-media-id']||anchor?.mediaId||/\bwp-image-(\d+)\b/.exec(attributes.class||'')?.[1]);
      if(declared){urls.unshift(...declared.urls.slice(0,2));urls.push(...declared.urls.slice(2));}
      if (urls.length) { const index = imageGroups.length; imageGroups.push({ urls: [...new Set(urls)], alt: clean(attributes.alt || attributes.title, 500),declaredOriginal:!!declared,
        publisherMediaId:attributes['data-media-id']||anchor?.mediaId||'',publishedWidth:Number.parseInt(attributes.width,10)||0,publishedHeight:Number.parseInt(attributes.height,10)||0 }); output.push(`<span data-adh-image="${index}"></span>`); }
      continue;
    }
    if (name === 'source' && !omit) {
      const urls = imageUrls(attributes, base); const picture = stack.findLast(item => item.name === 'picture'); if (picture) picture.urls = [...(picture.urls || []), ...urls];
      continue;
    }
    let emitted = null, imageUrl = '';
    if (!omit && name === 'a') {
      const href = publicUrl(attributes.href, base);
      if (href) { if (links.length < 1500 && !links.includes(href)) links.push(href); if (/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(href)){imageUrl = href;declaredGallery.push({urls:[href],alt:clean(attributes.title,500)});} }
      emitted = 'span'; output.push(`<span${href ? ` title="${escape(href)}" class="source-link"` : ''}>`);
    } else if (!omit && ALLOWED.has(name)) {
      emitted = name; const style = safeStyle(attributes.style), attributesOut = [];
      if (style) attributesOut.push(`style="${escape(style)}"`);
      for (const key of ['colspan', 'rowspan']) if (['td', 'th'].includes(name) && /^\d{1,2}$/.test(attributes[key]) && Number(attributes[key]) <= 40) attributesOut.push(`${key}="${attributes[key]}"`);
      output.push(`<${name}${attributesOut.length ? ` ${attributesOut.join(' ')}` : ''}>`);
    }
    if (!VOID.has(name) && !/\/\s*>$/.test(match[0])) stack.push({ name, excluded: omit, emitted, imageUrl,mediaId:attributes['data-media-id'] });
  }
  if (!blocked()) output.push(escape(decodeEntities(source.slice(offset))));
  for (const entry of stack.reverse()) if (entry.emitted) output.push(`</${entry.emitted}>`);
  // Sources in <picture> are resolution alternatives for the following img.
  // Images declared only in a publisher gallery still remain available below.
  const represented = new Set(imageGroups.flatMap(item => item.urls));
  for (const group of declaredGallery) if (!group.urls.some(url=>represented.has(url))) { const index = imageGroups.length; imageGroups.push(group); group.urls.forEach(url=>represented.add(url)); output.push(`<span data-adh-image="${index}"></span>`); }
  return { fragment: output.join(''), imageGroups, links, layout: 'article' };
}
function prepareArticlePage(page) {
  const template = articleTemplate(page), urls = new Set(template.imageGroups.flatMap(item => item.urls));
  const images = template.imageGroups.length ? [...new Map(template.imageGroups.map(group=>[group.urls[0],{url:group.urls[0],alt:group.alt,contentScope:'article',fallbackUrls:group.urls.slice(1,5),declaredOriginal:group.declaredOriginal===true,publisherMediaId:group.publisherMediaId,publishedWidth:group.publishedWidth,publishedHeight:group.publishedHeight}])).values()]
    : (Array.isArray(page.images) ? page.images : []).filter(item => item.contentScope !== 'excluded' && (template.layout === 'text' || !urls.size || urls.has(item.url)));
  const result = { ...page, images, imagesComplete: page.imagesComplete === true };
  Object.defineProperty(result, 'rawHtml', { value: page.rawHtml || '', enumerable: false });
  Object.defineProperty(result, 'articleTemplate', { value: template, enumerable: false });
  return result;
}
function renderDocument(page, mappings, template = articleTemplate(page)) {
  const map = new Map();
  for (const image of mappings) if (/^image_[a-f\d-]{36}$/.test(image.assetId || '')) for (const url of [image.sourceUrl, image.finalUrl]) if (url && (!map.has(url) || (image.width || 0) * (image.height || 0) > (map.get(url).width || 0) * (map.get(url).height || 0))) map.set(url, image);
  const used = new Set(), missing = [];
  const fragment = template.fragment.replace(/<span data-adh-image="(\d+)"><\/span>/g, (placeholder, number) => {
    const group = template.imageGroups[Number(number)], images = group.urls.map(url => map.get(url)).filter(Boolean).sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    const chosen = images[0];
    if (!chosen) { missing.push({ urls: group.urls, alt: group.alt }); return `<figure class="image-missing"><p>这张图片暂未保存，可重试补齐。</p>${group.alt ? `<figcaption>${escape(group.alt)}</figcaption>` : ''}</figure>`; }
    used.add(chosen.assetId);
    return `<figure><img src="images/${escape(chosen.assetId)}" alt="${escape(group.alt)}" loading="lazy" decoding="async"${chosen.width ? ` width="${Number(chosen.width)}"` : ''}${chosen.height ? ` height="${Number(chosen.height)}"` : ''}>${group.alt ? `<figcaption>${escape(group.alt)}</figcaption>` : ''}</figure>`;
  });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src adh-case:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'"><title>${escape(page.title)}</title><style>html{color-scheme:light;background:#fff;color:#242b39;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.85}body{margin:0;padding:22px clamp(16px,5vw,48px) 48px;overflow-wrap:anywhere}article{max-width:1040px;margin:auto}h1{font-size:clamp(22px,4vw,34px);line-height:1.4;margin:0 0 24px}h2,h3,h4{line-height:1.5;margin:1.6em 0 .7em}p{margin:.8em 0}img{display:block;max-width:100%;height:auto!important;margin:0 auto}figure{margin:24px 0}figure figure{margin:0}figcaption,small{color:#6c7481;font-size:.86em}figcaption{text-align:center;margin-top:7px}blockquote{border-left:3px solid #dce2eb;margin:20px 0;padding:0 18px;color:#596272}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}td,th{border:1px solid #dfe4ec;padding:7px 10px}pre{white-space:pre-wrap}ul,ol{padding-left:1.6em}.image-missing{padding:22px;border:1px dashed #d8dee8;background:#f8f9fb;color:#7a8290;text-align:center}.source-link{text-decoration:underline;text-decoration-color:#cbd4e2;text-underline-offset:3px}a{pointer-events:none}</style></head><body><article><h1>${escape(page.title)}</h1>${fragment}</article></body></html>`;
  return { html, assetIds: [...used], imageCount: template.imageGroups.length, missing, links: template.links, layout: template.layout };
}
class CaseWebArchive {
  constructor(root) { this.root = path.join(root, 'case-articles'); fs.mkdirSync(this.root, { recursive: true }); this.realRoot = fs.realpathSync(this.root); }
  paths(item) { const key = crypto.createHash('sha256').update(`${item.id}\0${item.sourceUrl}`).digest('hex'); return { metadata: path.join(this.root, `${key}.json`), document: path.join(this.root, `${key}.html`), source: path.join(this.root, `${key}.source.html`) }; }
  assertRoot() { if (fs.realpathSync(this.root) !== this.realRoot || fs.lstatSync(this.root).isSymbolicLink()) throw new Error('案例本地原文目录无效。'); }
  safeRead(file, max) { this.assertRoot(); const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('案例本地原文文件无效。'); return fs.readFileSync(file, 'utf8'); }
  read(item) { const files = this.paths(item); if (!fs.existsSync(files.metadata)) return null; const value = JSON.parse(this.safeRead(files.metadata, MAX_DOCUMENT)); if (value.caseId !== item.id || value.projectId !== item.projectId || value.sourceUrl !== item.sourceUrl || value.version !== 1) throw new Error('案例原文与当前项目不匹配。'); return value; }
  document(item) { const value = this.read(item); if (!value) return null; return { ...value, html: this.safeRead(this.paths(item).document, MAX_DOCUMENT) }; }
  writeFile(file, value) { this.assertRoot(); const temporary = `${file}.${crypto.randomUUID()}.tmp`; try { fs.writeFileSync(temporary, value, { flag: 'wx' }); fs.renameSync(temporary, file); } finally { try { fs.unlinkSync(temporary); } catch {} } }
  save(item, page, result = {}) {
    const previous = this.read(item), mappings = [...new Map([...(Array.isArray(previous?.images) ? previous.images : []), ...(Array.isArray(result.images) ? result.images : [])].filter(item => item.assetId).map(item => [`${item.sourceUrl}\0${item.assetId}`, item])).values()];
    const rendered = renderDocument(page, mappings, page.articleTemplate);
    const imageFailures=(Array.isArray(result.images)?result.images:[]).filter(image=>!image.assetId&&image.error).map(image=>({sourceUrl:image.sourceUrl,message:clean(image.error,600)}));
    const value = { version: 1, caseId: item.id, projectId: item.projectId, sourceUrl: item.sourceUrl, finalUrl: page.finalUrl || page.url || item.sourceUrl, title: page.title || item.name,
      retrievedAt: page.retrievedAt || new Date().toISOString(), archivedAt: new Date().toISOString(), status: result.status === 'complete' && !rendered.missing.length ? 'complete' : 'partial',
      complete: result.complete === true && !rendered.missing.length, imageCount: rendered.imageCount, assetCount: rendered.assetIds.length, assetIds: rendered.assetIds, missingCount: rendered.missing.length,
      failures: [...(Array.isArray(result.errors) ? result.errors : []),...imageFailures, ...rendered.missing.filter(item=>!item.urls.some(url=>imageFailures.some(failure=>failure.sourceUrl===url))).map(item => ({ sourceUrl: item.urls[0], message: '图片尚未保存到本地。' }))], links: [...new Set([item.sourceUrl, ...(rendered.links || [])])],
      layout: rendered.layout, textTruncated: page.textTruncated === true, truncated: result.truncated === true, images: mappings.filter(item => item.assetId) };
    if (Buffer.byteLength(rendered.html) > MAX_DOCUMENT || Buffer.byteLength(JSON.stringify(value)) > MAX_DOCUMENT) throw new Error('案例图文归档超过保存上限。');
    const files = this.paths(item);
    if (typeof page.rawHtml === 'string' && Buffer.byteLength(page.rawHtml) <= MAX_HTML) this.writeFile(files.source, page.rawHtml);
    // Keep the previous complete article when a later failed read contains less.
    if (previous?.complete && !value.complete && previous.assetCount > value.assetCount) { const preserved = { ...previous, lastAttempt: { status: value.status, failures: value.failures, archivedAt: value.archivedAt } }; this.writeFile(files.metadata, JSON.stringify(preserved)); return preserved; }
    this.writeFile(files.document, rendered.html); this.writeFile(files.metadata, JSON.stringify(value)); return value;
  }
}
module.exports = { CaseWebArchive, prepareArticlePage, articleTemplate, renderDocument };
