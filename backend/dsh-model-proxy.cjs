'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

// Harness uses Node networking. Route only configured model calls through the
// Electron network stack, which shares the user's Windows proxy and DNS route.
// The sidecar receives a random loopback token, never the upstream API keys.
async function startDshModelProxy({ modelService, fetchImpl = globalThis.fetch } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const controllers = new Set();
  const server = http.createServer(async (request, reply) => {
    const reject = (status, message) => { reply.writeHead(status, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify({ error: { message } })); };
    if (request.headers.authorization !== `Bearer ${token}`) return reject(401, '本机模型通道未授权。');
    const responses = request.url === '/v1/responses';
    if (request.method !== 'POST' || !responses && request.url !== '/v1/chat/completions') return reject(404, '本机模型通道仅接受对话请求。');
    const controller = new AbortController(); controllers.add(controller);
    let timer;
    reply.on('close', () => { if (!reply.writableEnded) controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 4 * 1024 * 1024) return reject(413, '模型请求上下文过长。'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(400, '模型请求格式无效。'); }
      if (!body || typeof body.model !== 'string' || !Array.isArray(responses ? body.input : body.messages)) return reject(400, '请选择已配置的文本模型。');
      let config;
      try { config = modelService.getConnection(body.model); } catch { return reject(400, '所选文本模型未配置，请重新选择。'); }
      if (!config?.apiKey) return reject(503, '请在 Hub 设置中配置文本模型。');
      timer = setTimeout(() => controller.abort(), config.timeoutMs || 120000);
      body.model = config.model;
      const upstream = await fetchImpl(`${config.baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body),
      });
      if (upstream.redirected || upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return reject(502, '模型接口发生重定向，已停止请求。'); }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reject(upstream.status, `模型服务返回 HTTP ${upstream.status}，请核对模型权限、额度或服务状态。`);
      }
      reply.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
      if (upstream.body) for await (const chunk of upstream.body) {
        if (controller.signal.aborted) break;
        if (!reply.write(Buffer.from(chunk))) await new Promise(resolve => { reply.once('drain', resolve); reply.once('close', resolve); });
      }
      reply.end();
    } catch {
      if (!reply.headersSent && !reply.destroyed) reject(502, '模型网络请求未完成，请检查连接后重试。');
      else reply.destroy();
    } finally { clearTimeout(timer); controllers.delete(controller); }
  });
  server.requestTimeout = 150000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    token, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    stop() { for (const controller of controllers) controller.abort(); server.close(); server.closeAllConnections(); },
  };
}

module.exports = { startDshModelProxy };
