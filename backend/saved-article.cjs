'use strict';

// The native picker authorizes one saved HTML page and its conventional
// companion directory. No renderer-supplied path reaches this reader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parsePublicHtml, fetchPublicImage, validateRasterImage } = require('./public-page.cjs');
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const IMAGE_BYTES = 8 * 1024 * 1024;

function readSavedArticle(file, sourceUrl) {
  const stat = fs.lstatSync(file);
  if (!/\.html?$/i.test(file) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('请选择 4 MB 以内的 HTML 网页文件。');
  const html = fs.readFileSync(file, 'utf8');
  const page = parsePublicHtml(html, sourceUrl);
  const parent = path.dirname(file), stem = path.basename(file, path.extname(file));
  const local = new Map(), aliases = new Map();
  const fingerprint = crypto.createHash('sha256').update(html).digest('hex').slice(0, 20);
  for (const match of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const reference = match[1] || match[2] || '';
    if (!reference || /^(?:[a-z]+:|\/|\\)/i.test(reference)) continue;
    let relative;
    try { relative = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { continue; }
    const segments = relative.split('/');
    if (!segments.length || segments.some(part => !part || part === '..' || part === '.' || /[\\:\x00-\x1f]/.test(part))) continue;
    if (![`${stem}_files`, `${stem}.files`].some(name => name.toLowerCase() === segments[0].toLowerCase())) continue;
    let current = parent, valid = true;
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      try {
        const entry = fs.lstatSync(current);
        if (entry.isSymbolicLink() || (index < segments.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.size > IMAGE_BYTES)) { valid = false; break; }
      } catch { valid = false; break; }
    }
    if (!valid || !TYPES[path.extname(current).toLowerCase()]) continue;
    const discovered = new URL(reference, sourceUrl).href;
    const alias = `https://saved-article.aidesignhub.example/${fingerprint}/${encodeURIComponent(relative)}`;
    aliases.set(discovered, alias); local.set(alias, { imageFile: current, segments });
  }
  page.images = page.images.map(image => aliases.has(image.url) ? { ...image, url: aliases.get(image.url), alt: image.alt || '浏览器保存的文章图片' } : image);
  page.localImageCount = page.images.filter(image => local.has(image.url)).length;
  return { page, fetchImage: async (url, options = {}) => {
    if (!local.has(url)) return fetchPublicImage(url, options);
    if (options.signal?.aborted) throw new Error('图片采集已取消。');
    const { imageFile, segments } = local.get(url);
    let checked = parent;
    for (const segment of segments) { checked = path.join(checked, segment); if (fs.lstatSync(checked).isSymbolicLink()) throw new Error('保存的文章图片路径已改变。'); }
    const imageStat = fs.lstatSync(imageFile);
    if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size > IMAGE_BYTES) throw new Error('保存的文章图片状态无效。');
    const bytes = fs.readFileSync(imageFile);
    const info = validateRasterImage(bytes, TYPES[path.extname(imageFile).toLowerCase()], { allowSmall: true, allowAnimation: true });
    return { ...info, finalUrl: url, byteLength: bytes.length, dataUrl: `data:${info.contentType};base64,${bytes.toString('base64')}` };
  } };
}

module.exports = { readSavedArticle };
