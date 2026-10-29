'use strict';
const fs = require('node:fs');
const path = require('node:path');
const input = process.argv[2], output = process.argv[3];
if (!path.isAbsolute(input || '') || !path.isAbsolute(output || '')) throw new Error('请提供分析 HTML 与截图 PNG 的绝对路径。');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
  const child = require('node:child_process').spawn(fs.existsSync(bundled) ? bundled : require('electron'), [__filename, input, output], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'); app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1580, height: 1180, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await win.loadFile(input);
      await win.webContents.executeJavaScript('Promise.all([...document.images].map(image=>image.decode().catch(()=>{})))');
      const size = await win.webContents.executeJavaScript('({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,images:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length})');
      win.setSize(Math.min(2000, size.width), Math.min(7000, size.height));
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, input, output, ...size })); win.destroy(); app.quit();
    } catch (error) { console.error(error.message); app.exit(1); }
  });
}
