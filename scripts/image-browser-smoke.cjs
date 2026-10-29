'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

if (!process.versions.electron) {
  const executable = path.resolve(__dirname, '../.runtime/electron.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(executable, [__filename], { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true });
  child.on('error', cause => { console.error(cause); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = require('electron');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-image-browser-'));
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const page = fs.readFileSync(path.resolve(__dirname, '../tests/fixtures/image-browser-page.html'));
  const calls = [], resolved = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZGQAAAAASUVORK5CYII=', 'base64');
  const request = (options, callback) => {
    calls.push(options); const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; req.response?.destroy(); };
    req.end = () => queueMicrotask(() => {
      if (req.destroyed) return;
      const res = new PassThrough(); req.response = res; res.statusCode = 200;
      res.headers = { 'content-type': 'image/png' };
      let body = png;
      if (options.path === '/start') { res.statusCode = 302; res.headers = { location: '/fixture' }; body = Buffer.alloc(0); }
      else if (options.path === '/fixture') { res.headers = { 'content-type': 'text/html; charset=utf-8' }; body = page; }
      else if (options.path === '/frame.html') {
        res.headers = { 'content-type': 'text/html; charset=utf-8' };
        body = Buffer.from(`<html><body><img src="/images/${options.headers.Host.startsWith('cross-') ? 'cross-frame' : 'same-frame'}.png" alt="frame"><img data-src="/images/frame-dom-only.png"></body></html>`);
      } else if (options.path === '/unsafe-redirect') { res.statusCode = 302; res.headers = { location: 'http://169.254.169.254/latest/meta-data' }; body = Buffer.alloc(0); }
      callback(res); if (!res.destroyed) res.end(body);
    });
    return req;
  };
  let capture;
  app.whenReady().then(async () => {
    let screenshotPromise, observedWindow, isolation;
    try {
      const { _testing } = require('../backend/image-browser.cjs');
      class ObservedBrowserWindow extends BrowserWindow {
        constructor(options) {
          super(options); observedWindow = this;
          assert.equal(options.show, true); assert.equal(options.webPreferences.preload, undefined);
          this.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
              if (this.isDestroyed()) return;
              isolation = await this.webContents.executeJavaScript('window.fixtureIsolation');
              await this.webContents.executeJavaScript('window.scrollTo(0,0)');
              screenshotPromise = this.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, 'capture-window.png'), image.toPNG()));
            }, 1000);
          });
        }
      }
      capture = _testing.createImageBrowserCapture({ BrowserWindow: ObservedBrowserWindow, session, durationMs: 10000,
        maxScrollSteps: 10, scrollIntervalMs: 250, pollIntervalMs: 100 }, { request, resolve: async hostname => {
        resolved.push(hostname); return [{ address: hostname === 'rebind.example.org' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
      } });
      const progress = [];
      const result = await capture('https://capture-fixture.example.org/start', { onCandidates: batch => progress.push(...batch) });
      await screenshotPromise;
      const paths = result.images.map(item => new URL(item.url).pathname);
      for (const expected of ['static', 'picture-small', 'picture-large', 'picture-fallback', 'density-1', 'density-2', 'density-fallback',
        'background', 'pseudo', 'original', 'lazy-attribute', 'same-frame', 'frame-dom-only', 'cross-frame', 'shadow', 'network-only', 'dynamic', 'after-scroll', 'native-lazy']) {
        assert.ok(paths.includes(`/images/${expected}.png`), `Missing candidate ${expected}`);
      }
      assert.equal(result.finalUrl, 'https://capture-fixture.example.org/fixture');
      assert.deepEqual(isolation, { require: 'undefined', process: 'undefined', bridge: 'undefined' });
      assert.ok(progress.length >= 19); assert.equal(observedWindow.isDestroyed(), true);
      assert.ok(!calls.some(call => ['127.0.0.1', '169.254.169.254'].includes(call.hostname)));
      assert.ok(!calls.some(call => ['/private', '/private.png', '/forbidden-post', '/must-not-follow'].includes(call.path)));
      assert.ok(!calls.some(call => call.headers.Host === 'popup.example.org'));
      assert.ok(calls.every(call => call.hostname === '93.184.216.34' && call.rejectUnauthorized === true && !call.headers.Cookie && !call.headers.Authorization));
      capture.dispose();
      const report = { ok: true, output, candidateCount: result.images.length, fixturePaths: paths, finalUrl: result.finalUrl, isolation,
        requests: calls.length, resolvedHosts: [...new Set(resolved)], rawTransport: 'injected local fixture only; no real website traffic',
        nativeProxy: 'reserved-address fixed proxy, no DIRECT fallback', coverage: 'real Electron DOM + CSS + srcset + picture + mutations + scroll + frames + network + rejected private/redirect/POST/popup' };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2)); app.quit();
    } catch (cause) {
      const diagnostic = { error: cause.stack, calls: calls.map(call => ({ host: call.headers.Host, path: call.path, ip: call.hostname })), resolved };
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(diagnostic, null, 2));
      console.error(cause.stack); console.error(`Artifacts: ${output}`); capture?.dispose(); app.exit(1);
    }
  });
  const watchdog = setTimeout(() => { console.error(`Smoke timed out. Artifacts: ${output}`); capture?.dispose(); app.exit(1); }, 20000);
  watchdog.unref();
}
