import identity from './release-identity.json';

/** Stamp downloads only. Imported originals, thumbnails and model input remain untouched. */
export async function brandCanvasExport(blob: Blob): Promise<Blob> {
  const image = await createImageBitmap(blob);
  try {
    const band = Math.max(36, Math.round(image.width * 0.022));
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height + band;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建带来源标识的导出图片。');
    context.drawImage(image, 0, 0);
    context.fillStyle = '#f7f7fb'; context.fillRect(0, image.height, canvas.width, band);
    const text = `Powered by AIDesignHub · v${identity.version} · ${identity.releaseId.slice(-12)}`;
    let size = Math.max(10, Math.round(band * 0.34));
    context.font = `${size}px Arial`;
    while (size > 6 && context.measureText(text).width > canvas.width - 16) context.font = `${--size}px Arial`;
    context.fillStyle = '#555b72'; context.textAlign = 'right'; context.textBaseline = 'middle';
    context.fillText(text, canvas.width - 8, image.height + band / 2, Math.max(1, canvas.width - 16));
    const output = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('导出图片编码失败。')), 'image/png'));
    const png = new Uint8Array(await output.arrayBuffer());
    const payload = new TextEncoder().encode(`tEXtAIDesignHub\0${identity.releaseId}|${identity.sourceCanary}`);
    const chunk = new Uint8Array(payload.length + 8), view = new DataView(chunk.buffer);
    view.setUint32(0, payload.length - 4); chunk.set(payload, 4);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
    return new Blob([png.slice(0, -12), chunk, png.slice(-12)], { type: 'image/png' });
  } finally { image.close(); }
}

export async function downloadBrandedCanvas(canvas: HTMLCanvasElement): Promise<void> {
  const original = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('导出图片编码失败。')), 'image/png'));
  const blob = await brandCanvasExport(original);
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `AI-Design-${identity.version}.png`; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
