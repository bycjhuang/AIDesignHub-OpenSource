'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const zlib = require('node:zlib');
const { createImageBrowserCapture, _testing } = require('../backend/image-browser.cjs');

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
function fakeRequest(specs, calls = []) {
  return (options, callback) => {
    calls.push(options); const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; req.response?.destroy(); };
    req.end = () => {
      const spec = specs.shift();
      if (!spec) { queueMicrotask(() => req.emit('error', new Error('No fixture'))); return; }
      if (spec.hang) return;
      queueMicrotask(() => {
        if (req.destroyed) return;
        const res = new PassThrough(); req.response = res; res.statusCode = spec.status || 200;
        res.headers = { 'content-type': 'text/html; charset=utf-8', ...spec.headers }; callback(res);
        if (spec.truncated) res.emit('aborted'); else res.end(spec.body || Buffer.from('<h1>Fixture</h1>'));
      });
    };
    return req;
  };
}

test('browser resource reader binds the validated public IP and keeps Host/TLS identity without credentials', async () => {
  const calls = [], read = _testing.createResourceReader({ resolve: publicResolve,
    request: fakeRequest([{ headers: { 'content-type': 'application/javascript' }, body: Buffer.from('window.ready=true') }], calls) });
  const result = await read('https://images.example.org:8443/client.js', { referer: 'https://page.example.org/project', accept: 'application/javascript' });
  assert.equal(result.status, 200); assert.equal(result.body.toString(), 'window.ready=true');
  assert.equal(calls[0].hostname, '93.184.216.34'); assert.equal(calls[0].headers.Host, 'images.example.org:8443');
  assert.equal(calls[0].servername, 'images.example.org'); assert.equal(calls[0].rejectUnauthorized, true);
  assert.equal(calls[0].agent, false); assert.equal(calls[0].headers.Cookie, undefined); assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers.Referer, 'https://page.example.org/project');
});

test('all subresource DNS records must be public; literal private URLs and rebinding fail before transport', async () => {
  const calls = []; let count = 0;
  const read = _testing.createResourceReader({ resolve: async () => ++count === 1 ? await publicResolve() : [{ address: '127.0.0.1', family: 4 }],
    request: fakeRequest([{}], calls) });
  await read('https://rebind.example.org/first');
  await assert.rejects(read('https://rebind.example.org/second'), cause => cause.code === 'PRIVATE_ADDRESS');
  for (const address of ['http://127.1/', 'http://169.254.169.254/', 'http://168.63.129.16/', 'http://[::ffff:127.0.0.1]/', 'file:///C:/secret']) await assert.rejects(read(address));
  assert.equal(calls.length, 1);
  const mixed = _testing.createResourceReader({ resolve: async () => [...await publicResolve(), { address: '10.0.0.5', family: 4 }], request: fakeRequest([], calls) });
  await assert.rejects(mixed('https://mixed.example.org/'), cause => cause.code === 'PRIVATE_ADDRESS');
  assert.equal(calls.length, 1);
});

test('redirects stay visible to Chromium and unsafe redirect destinations are rejected', async () => {
  const read = _testing.createResourceReader({ resolve: publicResolve, request: fakeRequest([
    { status: 302, headers: { location: '/moved' } }, { status: 302, headers: { location: 'http://10.0.0.1/private' } },
  ]) });
  assert.deepEqual(await read('https://page.example.org/start'), { status: 302, redirect: 'https://page.example.org/moved', body: Buffer.alloc(0), headers: {} });
  await assert.rejects(read('https://page.example.org/next'), cause => cause.code === 'PRIVATE_ADDRESS');
});

test('resource body, compression, types and time are bounded and abort stops transport', async () => {
  const encoded = zlib.gzipSync(Buffer.alloc(3000, 'x'));
  const read = _testing.createResourceReader({ resolve: publicResolve, maxBytes: 1024, request: fakeRequest([
    { body: Buffer.alloc(1025) }, { headers: { 'content-encoding': 'gzip' }, body: encoded },
    { headers: { 'content-type': 'application/octet-stream' } }, { truncated: true },
  ]) });
  await assert.rejects(read('https://page.example.org/large'), cause => cause.code === 'BODY_LIMIT');
  await assert.rejects(read('https://page.example.org/bomb'), cause => cause.code === 'BODY_LIMIT');
  await assert.rejects(read('https://page.example.org/program'), cause => cause.code === 'CONTENT_TYPE');
  await assert.rejects(read('https://page.example.org/broken'), cause => cause.code === 'RESOURCE_ERROR');
  const controller = new AbortController(); const calls = [];
  const pending = _testing.createResourceReader({ resolve: publicResolve, timeoutMs: 100, request: fakeRequest([{ hang: true }], calls) })('https://page.example.org/hang', { signal: controller.signal });
  controller.abort(Object.assign(new Error('Cancelled'), { code: 'ABORTED' }));
  await assert.rejects(pending, cause => cause.code === 'ABORTED');
  const timeout = _testing.createResourceReader({ resolve: publicResolve, timeoutMs: 10, request: fakeRequest([{ hang: true }]) });
  await assert.rejects(timeout('https://page.example.org/hang'), cause => cause.code === 'RESOURCE_TIMEOUT');
});

test('browser response excludes cookies, alternate connections and reporting headers', () => {
  const headers = _testing.responseHeaders({ 'content-type': 'image/png', 'set-cookie': 'session=secret',
    'alt-svc': 'h3=":443"', 'report-to': 'private', 'content-security-policy': "default-src 'self'", 'service-worker-allowed': '/' });
  assert.equal(headers.get('set-cookie'), null); assert.equal(headers.get('alt-svc'), null);
  assert.equal(headers.get('report-to'), null); assert.equal(headers.get('service-worker-allowed'), null);
  assert.match(headers.get('content-security-policy'), /default-src 'self'/); assert.match(headers.get('content-security-policy'), /form-action 'none'/);
  assert.equal(headers.get('cache-control'), 'no-store');
});

function fakeElectron(snapshot = {}) {
  let window, preferences, partition, proxy, handlers = {};
  const ses = new EventEmitter();
  Object.assign(ses, { setPermissionRequestHandler: fn => { ses.permission = fn; }, setPermissionCheckHandler: fn => { ses.permissionCheck = fn; },
    setDevicePermissionHandler: fn => { ses.device = fn; }, setDisplayMediaRequestHandler() {}, setPreloads() {},
    setProxy: async value => { proxy = value; }, closeAllConnections: async () => {}, clearStorageData: async () => {}, clearCache: async () => {},
    protocol: { handle: (name, fn) => { handlers[name] = fn; }, unhandle: name => { delete handlers[name]; } },
    webRequest: { onBeforeRequest: (_filter, fn) => { ses.beforeRequest = fn; } } });
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); window = this; preferences = options; this.destroyed = false; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setAudioMuted() {}, setWebRTCIPHandlingPolicy: policy => { this.policy = policy; },
        setWindowOpenHandler: fn => { this.openHandler = fn; }, isDestroyed: () => this.destroyed,
        executeJavaScriptInIsolatedWorld: async world => { assert.equal(world, 1001); return { title: 'Fixture', finalUrl: 'https://page.example.org/', images: [], done: true, ...snapshot }; } }); }
    setMenu() {} setTitle() {} isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadURL() { this.webContents.emit('dom-ready'); }
  }
  return { BrowserWindow, session: { fromPartition: (name, options) => { partition = name; assert.equal(options.cache, false); return ses; } },
    getState: () => ({ window, preferences, partition, proxy, ses, handlers }) };
}

test('capture uses a fresh sandbox session and denies permissions, native network and new windows', async () => {
  const electron = fakeElectron({ images: [{ url: 'https://images.example.org/a.png', alt: 'a', contentScope: 'article', context: 'article > figure' }, { url: 'http://127.0.0.1/secret' }] });
  const capture = createImageBrowserCapture(electron); const batches = [];
  const result = await capture('https://page.example.org/', { onCandidates: images => batches.push(...images) });
  const { window, preferences, partition, proxy, ses } = electron.getState();
  assert.equal(result.images.length, 1); assert.equal(batches.length, 1); assert.equal(window.destroyed, true);
  assert.equal(result.images[0].contentScope, 'article'); assert.equal(result.images[0].context, 'article > figure');
  assert.match(partition, /^aidesignhub-image-capture-/); assert.ok(!partition.startsWith('persist:'));
  assert.equal(preferences.show, true); assert.equal(preferences.webPreferences.sandbox, true); assert.equal(preferences.webPreferences.webSecurity, true);
  assert.equal(preferences.webPreferences.nodeIntegration, false); assert.equal(preferences.webPreferences.preload, undefined);
  assert.equal(window.policy, 'disable_non_proxied_udp'); assert.deepEqual(window.openHandler({}), { action: 'deny' });
  assert.equal(proxy.proxyBypassRules, '<-loopback>'); assert.ok(!proxy.proxyRules.includes('direct://'));
  assert.equal(ses.permissionCheck(), false); ses.permission(null, 'camera', allowed => assert.equal(allowed, false));
  for (const url of ['ws://page.example.org/socket', 'wss://page.example.org/socket', 'http://127.0.0.1/private', 'file:///C:/secret']) ses.beforeRequest({ url }, result => assert.equal(result.cancel, true));
  capture.dispose(); await assert.rejects(capture('https://page.example.org/'), cause => cause.code === 'DISPOSED');
});

test('capture cancellation closes its window; user closing returns partial candidates', async () => {
  const controller = new AbortController(), electron = fakeElectron({ done: false });
  const capture = createImageBrowserCapture({ ...electron, pollIntervalMs: 50 });
  const pending = capture('https://page.example.org/', { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(Object.assign(new Error('Cancelled'), { code: 'ABORTED' }));
  await assert.rejects(pending, cause => cause.code === 'ABORTED'); assert.equal(electron.getState().window.destroyed, true);
  const next = capture('https://page.example.org/');
  await new Promise(resolve => setTimeout(resolve, 20)); electron.getState().window.emit('close', { preventDefault() {} });
  assert.equal((await next).images.length, 0); assert.equal(electron.getState().window.destroyed, true);
});
