'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.ADH_EXPORT_PROOF_ROOT || '';
if (!/^adh-export-proof-/.test(path.basename(root))) throw new Error('Isolated export profile required.');
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const repo = path.resolve(__dirname, '../..');
  const ts = require(path.join(repo, 'Loomic-main/Loomic-main/node_modules/typescript'));
  const identity = require('../../assets/release-identity.json');
  const code = ts.transpileModule(fs.readFileSync(path.join(repo, 'Loomic-main/Loomic-main/apps/web/src/lib/export-provenance.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<html><body></body></html>');
  const result = await window.webContents.executeJavaScript(`(async()=>{
    const module={exports:{}},exports=module.exports,require=()=>(${JSON.stringify(identity)});
    ${code}
    const source=document.createElement('canvas');source.width=800;source.height=400;
    const context=source.getContext('2d');context.fillStyle='#336699';context.fillRect(0,0,800,400);
    const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
    const output=await exports.brandCanvasExport(blob),bitmap=await createImageBitmap(output);
    const check=document.createElement('canvas');check.width=bitmap.width;check.height=bitmap.height;
    const painter=check.getContext('2d');painter.drawImage(bitmap,0,0);bitmap.close();
    const bytes=new Uint8Array(await output.arrayBuffer());
    return {width:check.width,height:check.height,pixel:[...painter.getImageData(10,10,1,1).data],base64:btoa(String.fromCharCode(...bytes))};
  })()`);
  assert.equal(result.width, 800); assert(result.height > 400); assert.deepEqual(result.pixel, [51, 102, 153, 255]);
  const png = Buffer.from(result.base64, 'base64'); assert(png.includes(Buffer.from(identity.releaseId))); assert(png.includes(Buffer.from(identity.sourceCanary)));
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    if (type === 'tEXt') {
      let crc = 0xffffffff;
      for (const byte of png.subarray(at + 4, at + 8 + length)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
      assert.equal((crc ^ 0xffffffff) >>> 0, png.readUInt32BE(at + 8 + length));
    }
    at += length + 12;
  }
  fs.mkdirSync(path.join(repo, '.runtime/release-audit'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.runtime/release-audit/export-watermark.png'), png);
  console.info('EXPORT_PROOF_RESULT ' + JSON.stringify({ originalPixelsPreserved: true, versionMetadata: true, validPng: true, width: result.width, height: result.height }));
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
