'use strict';
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { createLoomicLocalService } = require('../../backend/loomic-local.cjs');
const root = path.resolve(process.env.ADH_IMAGE_RECOVERY_ROOT || '');
if (!/^adh-image-recovery-/.test(path.basename(root))) throw new Error('An isolated recovery profile is required.');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const hubId = 'image-recovery';
const scope = createHash('sha256').update(hubId).digest('hex').slice(0, 32);
const PNG = nativeImage.createFromBitmap(Buffer.from([210, 140, 70, 255]), { width: 1, height: 1 }).toPNG();
let window, service, canvasId, submissions = 0, externalRequests = 0;
const finishers = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async source => {
  const result = await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(error){return {ok:false,error:error.stack||error.message};}})()`, true);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const settleCanvas = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const workspace = async () => JSON.parse(await fs.readFile(path.join(root, 'data', 'ai-design-v1', 'projects', scope, 'workspace.json'), 'utf8'));
async function until(label, check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(80); }
  throw new Error(label + ': ' + await js('document.body.innerText.slice(-1200)'));
}
async function begin(prompt, count) {
  await settleCanvas();
  await until('Generator button ready', () => js(`(()=>{const button=document.querySelector('button[aria-label="AI 生成图片"]');if(!button)return false;button.click();return true;})()`));
  await until('Generator panel', () => js(`!!document.querySelector('textarea[placeholder="今天我们要创作什么"]')`));
  await js(`document.querySelector('textarea[placeholder="今天我们要创作什么"]').focus()`);
  await window.webContents.insertText(prompt);
  await until('Prompt committed', () => js(`document.querySelector('textarea[placeholder="今天我们要创作什么"]')?.value===${JSON.stringify(prompt)}`));
  await until('Generate button ready', () => js(`(()=>{const input=document.querySelector('textarea[placeholder="今天我们要创作什么"]');const button=input?.parentElement.querySelector('button.bg-primary.rounded-full');if(!button||button.disabled)return false;button.click();return true;})()`));
  await until('Provider submitted', () => submissions === count);
  await until('Pending placeholder saved', async () => (await workspace()).canvases[canvasId].content.elements.some(e => !e.isDeleted && e.customData?.status === 'generating' && e.customData.requestId));
}
app.whenReady().then(async () => {
  service = createLoomicLocalService({ dataDir: path.join(root, 'data'), staticRoot: path.resolve(__dirname, '../../Loomic-main/Loomic-main/apps/web/out'),
    getProject: id => id === hubId ? { id, name: '图片恢复隔离测试' } : null,
    provider: { status: () => ({ configured: true, profiles: [{ id: 'mock-image', name: '隔离图片模型', model: 'mock-image', configured: true }] }), generate: async () => { submissions++; return new Promise(resolve => finishers.push(() => resolve({ buffer: PNG, mime: 'image/png' }))); } },
  });
  const info = await service.start({ projectId: hubId, projectName: '图片恢复隔离测试' });
  const token = new URL(info.url).searchParams.get('cap');
  const project = await fetch(`${info.baseUrl}/api/projects`, { headers: { 'X-Loomic-Token': token, 'X-Loomic-Project': hubId } }).then(r => r.json());
  canvasId = project.projects[0].canvasId;
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true, partition: 'image-recovery-isolated' } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = new URL(details.url); const allowed = url.origin === info.baseUrl || url.origin === info.baseUrl.replace(/^http/, 'ws') || ['data:', 'blob:', 'devtools:'].includes(url.protocol);
    if (!allowed) externalRequests++;
    callback({ cancel: !allowed });
  });
  await window.loadURL(`${info.baseUrl}/canvas/?id=${canvasId}&hubProjectId=${hubId}#loomic-cap=${token}`);
  await until('Canvas loaded', () => js(`!!document.querySelector('.excalidraw canvas')&&!!document.querySelector('button[aria-label="AI 生成图片"]')`));
  await begin('关闭面板仍需完成的图片', 1);
  window.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 220, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 220, button: 'left', clickCount: 1 });
  await until('Panel deselected', () => js(`!document.querySelector('textarea[placeholder="今天我们要创作什么"]')`));
  finishers.shift()();
  await until('Closed panel completed image', async () => (await workspace()).canvases[canvasId].content.elements.filter(e => !e.isDeleted && e.type === 'image').length === 1);
  await begin('刷新后需要恢复的图片', 2);
  window.webContents.reload();
  await until('Canvas reloaded', () => js(`!!document.querySelector('.excalidraw canvas')&&!!document.querySelector('button[aria-label="AI 生成图片"]')`));
  finishers.shift()();
  await until('Refreshed page recovered image', async () => (await workspace()).canvases[canvasId].content.elements.filter(e => !e.isDeleted && e.type === 'image').length === 2);
  await pause(2400);
  const elements = (await workspace()).canvases[canvasId].content.elements.filter(e => !e.isDeleted);
  const checks = { panelClosed: true, refreshed: true, images: elements.filter(e => e.type === 'image').length, pending: elements.filter(e => e.customData?.status === 'generating').length, submissions, externalRequests };
  assert.equal(checks.images, 2); assert.equal(checks.pending, 0); assert.equal(submissions, 2);
  console.log('IMAGE_RECOVERY_RESULT ' + JSON.stringify(checks));
  window.destroy(); await service.stop(); app.quit();
}).catch(async error => { console.error(error.stack || error); if (window && !window.isDestroyed()) window.destroy(); await service?.stop().catch(() => {}); app.exit(1); });
