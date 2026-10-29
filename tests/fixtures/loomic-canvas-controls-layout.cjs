'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createLoomicLocalService } = require('../../backend/loomic-local.cjs');

const root = path.resolve(process.env.ADH_LOOMIC_CONTROLS_TEST_ROOT || '');
if (!/^adh-loomic-controls-ui-/.test(path.basename(root))) throw new Error('An isolated controls test directory is required.');
const repo = path.resolve(__dirname, '..', '..');
const artifacts = path.resolve(process.env.ADH_LOOMIC_CONTROLS_ARTIFACTS || path.join(root, 'screenshots'));
const staticRoot = path.resolve(process.env.ADH_LOOMIC_CONTROLS_STATIC_ROOT || path.join(repo, 'Loomic-main', 'Loomic-main', 'apps', 'web', 'out'));
let window, service, chatCalls = 0, imageCalls = 0, completedExternalRequests = 0;
const measurements = [], screenshots = [];
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => window.webContents.executeJavaScript(source, true);
async function waitFor(label, predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(70); }
  throw new Error(`${label} did not settle: ${await js('document.body.innerText.slice(-2500)')}`);
}
async function screenshot(name) {
  window.webContents.invalidate(); await pause(60);
  const file = path.join(artifacts, name + '.png');
  await fs.writeFile(file, (await window.webContents.capturePage()).toPNG()); screenshots.push(file);
}
async function setChatOpen(open) {
  await js(`(()=>{const desired=${open};const collapse=document.querySelector('button[title="收起面板"]');if(desired&&!collapse)[...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='对话')?.click();else if(!desired&&collapse)collapse.click();})()`);
  await waitFor('Chat panel state', () => js(`Boolean(document.querySelector('button[title="收起面板"]'))===${open}`));
  await pause(300); // Wait for the actual Framer Motion overlay transition.
}
async function measure(width, chatOpen) {
  return js(`(()=>{
    const api=[...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='API 直连');
    const chat=${chatOpen} ? document.querySelector('button[title="收起面板"]') : [...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='对话');
    if(!api||!chat)throw new Error('The original controls are missing.');
    const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const a=rect(api),b=rect(chat);
    const hit=element=>{const r=element.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!hit&&(hit===element||element.contains(hit));};
    return {width:${width},innerWidth:innerWidth,chatOpen:${chatOpen},api:a,chat:b,intersects:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,controlOnScreen:a.width>0&&b.width>0&&a.left>=0&&b.left>=0&&a.right<=innerWidth&&b.right<=innerWidth&&a.top>=0&&b.top>=0,apiHit:hit(api),chatHit:hit(chat)};
  })()`);
}

app.whenReady().then(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  service = createLoomicLocalService({
    dataDir: path.join(root, 'data'), staticRoot,
    getProject: id => id === 'controls-isolated' ? { id, name: '控件布局隔离测试' } : null,
    listMediaModels: () => ({ profiles: [] }),
    chatProvider: { status: () => ({ configured: false, models: [] }), invoke: async () => { chatCalls++; throw new Error('Real or mock model execution is forbidden in this layout test.'); } },
    provider: { status: () => ({ configured: false, profiles: [] }), generate: async () => { imageCalls++; throw new Error('Image execution is forbidden in this layout test.'); } },
  });
  const info = await service.start({ projectId: 'controls-isolated', projectName: '控件布局隔离测试' });
  window = new BrowserWindow({ show: false, width: 1600, height: 950, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false, partition: 'loomic-controls-isolated' } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: ![info.baseUrl, info.baseUrl.replace(/^http/, 'ws')].includes(url.origin) && !['data:', 'blob:', 'devtools:'].includes(url.protocol) });
  });
  window.webContents.session.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, details => { if (new URL(details.url).origin !== info.baseUrl) completedExternalRequests++; });
  await window.loadURL(info.url);
  await waitFor('Original Home', () => js(`location.pathname.startsWith('/home')&&[...document.querySelectorAll('button')].some(button=>button.innerText.trim()==='新建项目'&&!button.disabled)`));
  await js(`[...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='新建项目').click()`);
  await waitFor('Original canvas', () => js(`location.pathname.startsWith('/canvas')&&!!document.querySelector('.excalidraw canvas')&&!!document.querySelector('button[title="收起面板"]')`));
  for (const width of [1600, 1024, 760]) {
    window.setContentSize(width, 900);
    await waitFor('Viewport resize', () => js(`innerWidth===${width}`));
    await pause(160);
    for (const chatOpen of [true, false]) {
      await setChatOpen(chatOpen);
      measurements.push(await measure(width, chatOpen));
      await screenshot(`${width}-${chatOpen ? 'open' : 'closed'}`);
    }
  }
  const result = { measurements, screenshots, chatCalls, imageCalls, completedExternalRequests };
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`ADH_LOOMIC_CONTROLS_RESULT ${JSON.stringify(result)}\n`);
  window.destroy(); await service.stop(); app.quit();
}).catch(async error => {
  if (window && !window.isDestroyed()) { await screenshot('failure').catch(() => {}); window.destroy(); }
  await service?.stop().catch(() => {});
  process.stderr.write(String(error.stack || error)); app.exit(1);
});
