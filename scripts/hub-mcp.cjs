#!/usr/bin/env node
'use strict';

// One stdio bridge per client; all bridges use the SAME running Hub service.
// Never open a database or start a second business-state writer here.
const MAX_LINE_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function connectionFromEnv(env = process.env) {
  let url;
  try { url = new URL(env.AIDESIGNHUB_URL || ''); } catch { throw new Error('AIDESIGNHUB_URL must be a local Hub HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AIDESIGNHUB_URL must be a local Hub HTTP URL without credentials or a path');
  }
  const token = env.AIDESIGNHUB_TOKEN || '';
  if (!token || /\s/.test(token)) throw new Error('AIDESIGNHUB_TOKEN is required');
  return { url: url.origin, token };
}

async function serviceRequest(connection, path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${connection.token}`, Accept: path === '/mcp' ? 'application/json, text/event-stream' : 'application/json' };
  if (path === '/mcp' && connection.protocolVersion) headers['MCP-Protocol-Version'] = connection.protocolVersion;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(connection.url + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error('Hub service is unavailable'); }
  if (response.status === 202 || response.status === 204) return undefined;
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Hub returned an invalid JSON response'); }
  if (!response.ok && !(object(payload) && payload.jsonrpc === '2.0' && object(payload.error))) {
    throw new Error(response.status === 401 ? 'Hub credential is invalid or expired' : `Hub request failed (HTTP ${response.status})`);
  }
  return payload;
}

async function main() {
  let connection;
  try { connection = connectionFromEnv(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; return; }
  let buffer = '';
  let discard = false;
  let chain = Promise.resolve();
  const write = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);
  const handle = async line => {
    let message;
    try { message = JSON.parse(line); }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    try {
      const result = await serviceRequest(connection, '/mcp', { method: 'POST', body: message });
      if (object(message) && message.method === 'initialize' && result?.result?.protocolVersion) {
        connection.protocolVersion = result.result.protocolVersion;
      }
      if (result !== undefined) write(result);
    } catch (error) {
      const id = object(message) && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;
      if (id !== null) write({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
      else process.stderr.write(`${error.message}\n`);
    }
  };
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    for (const fragment of chunk.split(/(?<=\n)/)) {
      const complete = fragment.endsWith('\n');
      if (!discard) buffer += fragment;
      if (!discard && Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        buffer = '';
        discard = true;
        chain = chain.then(() => write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message exceeds 1 MiB' } }));
      }
      if (complete) {
        const line = buffer.trim();
        buffer = '';
        if (!discard && line) chain = chain.then(() => handle(line));
        discard = false;
      }
    }
  }
  if (!discard && buffer.trim()) chain = chain.then(() => handle(buffer.trim()));
  await chain;
}

if (require.main === module) main().catch(() => { process.stderr.write('MCP bridge failed\n'); process.exitCode = 1; });
module.exports = { connectionFromEnv, serviceRequest };
