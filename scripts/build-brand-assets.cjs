'use strict';
// One-off brand asset builder: crops the D-mark out of the root LOGO.png lockup
// and regenerates every brand surface (sidebar png, favicon, DSH plugin logo,
// packaging ico, transparent titlebar icon). Run with:
//   .runtime/electron.exe scripts/build-brand-assets.cjs
const fs = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'LOGO.png');

function markCropBox(image) {
  const { width, height } = image.getSize();
  const rgba = image.toBitmap(); // RGBA, top-down
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const yLimit = Math.floor(height * 0.62); // wordmark/tagline live below this
  for (let y = 0; y < yLimit; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
      if (a < 200) continue;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (spread < 60) continue; // keep only the saturated gradient mark
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('未能在 LOGO.png 中检测到渐变标记');
  // Square the box around its centre so the mark keeps its proportions.
  const cx = Math.round((minX + maxX) / 2);
  const cy = Math.round((minY + maxY) / 2);
  const side = Math.max(maxX - minX, maxY - minY) + 8;
  const half = Math.ceil(side / 2);
  const x = Math.min(Math.max(cx - half, 0), width - side);
  const y = Math.min(Math.max(cy - half, 0), height - side);
  return { x, y, width: side, height: side };
}

function writeIco(filePath, pngFrames) {
  const count = pngFrames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + entries.length;
  pngFrames.forEach(({ size, png }, index) => {
    const e = entries.subarray(index * 16, index * 16 + 16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
  });
  fs.writeFileSync(filePath, Buffer.concat([header, entries, ...pngFrames.map((f) => f.png)]));
}

function main() {
  const source = nativeImage.createFromPath(SOURCE);
  if (source.isEmpty()) throw new Error(`读取失败：${SOURCE}`);
  const box = markCropBox(source);
  const mark = source.crop(box);

  const sizes = { 512: 'assets/adh-brand-mark.png', 256: 'assets/aidesignhub-icon.png' };
  for (const [size, rel] of Object.entries(sizes)) {
    fs.writeFileSync(path.join(ROOT, rel), mark.resize({ width: Number(size), height: Number(size) }).toPNG());
  }
  fs.writeFileSync(path.join(ROOT, 'backend', 'dsh-plugins', 'adh-brand', 'assets', 'LOGO.png'), mark.resize({ width: 256, height: 256 }).toPNG());

  writeIco(path.join(ROOT, 'assets', 'aidesignhub-icon.ico'), [256, 48, 32, 16].map((size) => ({
    size,
    png: mark.resize({ width: size, height: size }).toPNG(),
  })));

  // Transparent frame: the OS titlebar then shows only the window title text.
  const blank = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 0), { width: 64, height: 64 });
  fs.writeFileSync(path.join(ROOT, 'assets', 'aidesignhub-titlebar-blank.png'), blank.toPNG());

  console.info(JSON.stringify({ source: source.getSize(), crop: box }, null, 2));
}

main();
process.exit(0);
