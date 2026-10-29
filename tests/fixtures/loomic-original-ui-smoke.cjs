'use strict';
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createLoomicLocalService } = require('../../backend/loomic-local.cjs');
process.stdout.write('Original UI smoke: fixture loaded\n');

const root = path.resolve(process.env.ADH_LOOMIC_UI_TEST_ROOT || '');
if (!/^adh-loomic-original-ui-/.test(path.basename(root))) throw new Error('An isolated original UI test directory is required.');
const repo = path.resolve(__dirname, '..', '..');
const artifacts = path.resolve(process.env.ADH_LOOMIC_UI_ARTIFACTS || path.join(root, 'screenshots'));
const staticRoot = path.resolve(process.env.ADH_LOOMIC_UI_STATIC_ROOT || path.join(repo, 'Loomic-main', 'Loomic-main', 'apps', 'web', 'out'));
const hubProjectId = 'original-ui-isolated-project';
// A solid blue 1px PNG makes actual canvas/media rendering visible in evidence.
const PNG = nativeImage.createFromBitmap(Buffer.from([210, 140, 70, 255]), { width: 1, height: 1 }).toPNG();
const chatCalls = [], imageCalls = [], frames = [], consoleErrors = [], blockedRequests = [], completedExternalRequests = [];
let window, service;
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stage = message => process.stdout.write(`Original UI smoke: ${message}\n`);
const js = source => window.webContents.executeJavaScript(source, true);
async function waitFor(label, predicate, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await pause(80); }
  const state = await js(`({url:location.pathname,text:document.body.innerText.slice(-7000),buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,title:b.title,disabled:b.disabled})).slice(-25)})`).catch(() => ({}));
  throw new Error(`${label} did not settle: ${JSON.stringify(state)}; console: ${consoleErrors.slice(-5).join(' | ')}`);
}
async function screenshot(name) {
  // React and Framer Motion can settle before Chromium has composited the next
  // frame in a hidden window. Capture the painted UI rather than its prior frame.
  await pause(450);
  window.webContents.invalidate();
  await pause(60);
  const target = path.join(artifacts, name + '.png');
  await fs.writeFile(target, (await window.webContents.capturePage()).toPNG()); return target;
}
async function workspace() {
  const scope = createHash('sha256').update(hubProjectId).digest('hex').slice(0, 32);
  return JSON.parse(await fs.readFile(path.join(root, 'data', 'ai-design-v1', 'projects', scope, 'workspace.json'), 'utf8'));
}
async function input(text) {
  await js(`document.querySelector('textarea[data-chat-input]').focus()`);
  await window.webContents.insertText(text);
}
async function send() {
  await waitFor('Original send button enabled', () => js(`(()=>{const t=document.querySelector('textarea[data-chat-input]');return t&&[...t.parentElement.querySelectorAll('button')].at(-1)?.disabled===false;})()`));
  // This is the original ChatInput send button, rather than a direct API/WS call.
  await js(`(()=>{const t=document.querySelector('textarea[data-chat-input]');[...t.parentElement.querySelectorAll('button')].at(-1).click();})()`);
}

app.whenReady().then(async () => {
  stage('isolated Electron ready');
  await fs.mkdir(artifacts, { recursive: true });
  await fs.rm(path.join(artifacts, 'failure.json'), { force: true });
  await fs.rm(path.join(artifacts, 'failure.png'), { force: true });
  service = createLoomicLocalService({
    dataDir: path.join(root, 'data'), staticRoot,
    getProject: id => id === hubProjectId ? { id, name: '江湾原版界面测试（隔离）' } : null,
    listMediaModels: () => ({ profiles: [] }),
    provider: {
      status: () => ({ configured: true, defaultProfileId: 'mock-image', profiles: [{ id: 'mock-image', name: '隔离图片 Mock', model: 'mock-image', configured: true }] }),
      generate: async payload => { imageCalls.push(structuredClone(payload)); return { buffer: PNG, mime: 'image/png', model: 'mock-image' }; },
    },
    chatProvider: {
      status: () => ({ configured: true, defaultModel: 'mock-text', models: [{ id: 'mock-text', name: '隔离文本 Mock', provider: 'mock' }] }),
      invoke: async request => {
        chatCalls.push({ prompt: request.prompt, attachments: structuredClone(request.attachments), canvasId: request.canvas.id, hubProjectId: request.hubProjectId, model: request.model });
        assert.equal(request.hubProjectId, hubProjectId);
        if (chatCalls.length === 1) {
          await request.onDelta('正在为江湾项目生成概念图。\n');
          await request.executeTool('generate_image', { prompt: request.prompt, profileId: 'mock-image', title: '江湾概念图', placementWidth: 240, placementHeight: 240 }, 'mock-generate-1');
          return { text: '江湾概念图已生成。' };
        }
        assert.equal(chatCalls.length, 2, 'Refresh/reconnect must not invoke the mock model again.');
        assert.equal(request.attachments.length, 1, 'The original @ image picker must send one image reference.');
        const referenceId = request.attachments[0].assetId;
        assert(request.canvas.content.elements.some(el => el.type === 'image' && el.id === referenceId), 'The selected reference must exist in this actual canvas.');
        await request.executeTool('edit_image', { prompt: request.prompt, profileId: 'mock-image', referenceImageIds: [referenceId], title: '江湾暖色编辑图', placementWidth: 240, placementHeight: 240 }, 'mock-edit-2');
        return { text: '已依据选中的江湾概念图完成暖色编辑。' };
      },
    },
  });
  const info = await service.start({ projectId: hubProjectId, projectName: '江湾原版界面测试（隔离）' });
  stage('local mock service started');
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true, partition: 'loomic-original-ui-isolated' } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) consoleErrors.push(message); });
  window.webContents.on('render-process-gone', (_event, details) => consoleErrors.push(`Renderer stopped: ${details.reason}`));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = new URL(details.url);
    const local = url.origin === info.baseUrl || url.origin === info.baseUrl.replace(/^http/, 'ws') || ['data:', 'blob:', 'devtools:'].includes(url.protocol);
    if (!local) blockedRequests.push({ origin: url.origin, pathname: url.pathname });
    callback({ cancel: !local });
  });
  window.webContents.session.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, details => {
    if (new URL(details.url).origin !== info.baseUrl) completedExternalRequests.push(new URL(details.url).origin);
  });
  stage('loading original Home');
  await Promise.race([window.loadURL(info.url), pause(18000).then(() => { throw new Error('The original static page load timed out.'); })]);
  await waitFor('Original Home', () => js(`location.pathname.startsWith('/home')&&document.body.innerText.includes('让创意设计更简单')&&[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='新建项目'&&!b.disabled)`), 18000);
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Network.enable');
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
    try { const frame = JSON.parse(params.response.payloadData); frames.push({ direction: method.endsWith('Sent') ? 'sent' : 'received', type: frame.type, action: frame.action, eventType: frame.event?.type }); } catch {}
  });
  const checks = await js(`({originalHome:!!document.querySelector('h1')&&document.body.innerText.includes('最近项目')&&!!document.querySelector('textarea'),homeBrand:[...document.querySelectorAll('span')].some(el=>el.innerText==='AI Design Hub')&&!!document.querySelector('svg image[href="/ai-design-hub-icon.png"]'),homeText:document.body.innerText})`);
  checks.screenshots = [await screenshot('01-original-home')];
  const before = (await workspace()).projects.length;
  await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='新建项目').click()`);
  await waitFor('Original Excalidraw and Agent sidebar', () => js(`location.pathname.startsWith('/canvas')&&!!document.querySelector('.excalidraw canvas')&&!!document.querySelector('textarea[data-chat-input]')`), 18000);
  checks.newProject = (await workspace()).projects.length === before + 1;
  const canvasDom = await js(`({originalExcalidraw:!!document.querySelector('.excalidraw canvas'),originalAgentSidebar:!!document.querySelector('textarea[data-chat-input]')&&!!document.querySelector('button[title="收起面板"]')})`);
  Object.assign(checks, canvasDom);
  checks.screenshots.push(await screenshot('02-original-canvas'));
  await input('请为江湾文化商业中心生成一张滨水商业概念图。'); await send();
  await waitFor('Original Agent image card', () => js(`(()=>{const img=document.querySelector('img[alt="江湾概念图"]');return !!img&&img.complete&&img.naturalWidth>0;})()`), 16000);
  await waitFor('First image saved to local canvas', async () => Object.values((await workspace()).canvases).some(c => c.content.elements.some(e => e.type === 'image' && e.customData?.title === '江湾概念图')));
  checks.imageCard = true; checks.localCanvasSaved = true;
  checks.screenshots.push(await screenshot('03-original-agent-image'));
  await waitFor('Original Agent run finished', () => js(`!!document.querySelector('textarea[data-chat-input]')&&!document.querySelector('button[title="Stop generating"]')`));
  await input('@');
  await waitFor('Original @ canvas image picker', () => js(`document.body.innerText.includes('当前项目')&&[...document.querySelectorAll('button')].some(b=>b.querySelector('img[alt="江湾概念图"]'))`));
  await js(`[...document.querySelectorAll('button')].find(b=>b.querySelector('img[alt="江湾概念图"]')).click()`);
  checks.referencePicker = true;
  await input('请基于这张图改成暖色夜景，保留滨水空间。'); await send();
  await waitFor('Reference edit returned to the original conversation', () => js(`document.body.innerText.includes('已依据选中的江湾概念图完成暖色编辑。')`), 16000);
  checks.referenceImages = imageCalls.length === 2 && imageCalls[1].referenceImages?.length === 1 && imageCalls[1].referenceImages[0].dataUrl === `data:image/png;base64,${PNG.toString('base64')}`;
  const saved = await workspace();
  const canvasId = chatCalls[0].canvasId;
  assert.equal(saved.canvases[canvasId].content.elements.filter(e => e.type === 'image' && !e.isDeleted).length, 2, 'Each Agent image tool must persist exactly one canvas image.');
  assert.equal(Object.keys(saved.canvases[canvasId].content.files).length, 2);
  checks.screenshots.push(await screenshot('04-original-reference-edit'));
  const currentUrl = await js('location.href');
  assert(!new URL(currentUrl).searchParams.has('prompt'), 'The original route must clear auto-send prompts.');
  await window.webContents.reload();
  await waitFor('Original conversation restored after refresh', () => js(`!!document.querySelector('.excalidraw canvas')&&document.body.innerText.includes('已依据选中的江湾概念图完成暖色编辑。')&&!!document.querySelector('img[alt="江湾概念图"]')`), 18000);
  await pause(1400);
  checks.refreshRestored = (await workspace()).canvases[canvasId].content.elements.filter(e => e.type === 'image' && !e.isDeleted).length === 2;
  checks.noRepeatedProviderCalls = chatCalls.length === 2 && imageCalls.length === 2;
  checks.webSocketFlow = frames.filter(f => f.direction === 'sent' && f.action === 'agent.run').length === 2 && frames.filter(f => f.direction === 'sent' && f.action === 'canvas.resume').length >= 2 && frames.some(f => f.eventType === 'tool.completed') && frames.some(f => f.eventType === 'canvas.sync');
  checks.chatCalls = chatCalls.length; checks.imageCalls = imageCalls.length; checks.realNetworkRequests = completedExternalRequests.length;
  checks.blockedExternalRequests = blockedRequests;
  checks.screenshots.push(await screenshot('05-original-refreshed'));
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ ...checks, frames, consoleErrors }, null, 2));
  process.stdout.write(`ADH_LOOMIC_ORIGINAL_UI_RESULT ${JSON.stringify(checks)}\n`);
  window.destroy(); await service.stop(); app.quit();
}).catch(async error => {
  if (window && !window.isDestroyed()) {
    await screenshot('failure').catch(() => {});
    await fs.writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ error: String(error.stack || error), consoleErrors, frames, blockedRequests }, null, 2)).catch(() => {});
    window.destroy();
  }
  await service?.stop().catch(() => {});
  process.stderr.write(String(error.stack || error)); app.exit(1);
});
