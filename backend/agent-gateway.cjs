'use strict';

// Transport only: business state and authorization remain owned by AgentHub.
const http = require('node:http');

const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class GatewayError extends Error {
  constructor(message, status = 400, rpcCode = -32602) {
    super(message);
    this.status = status;
    this.rpcCode = rpcCode;
  }
}

function validateSchema(value, schema = {}, path = 'arguments', depth = 0) {
  if (depth > 40) throw new GatewayError('Arguments are too deeply nested');
  if (schema === true) return;
  if (schema === false) throw new GatewayError(`${path} is not allowed`);
  if (!object(schema)) throw new GatewayError('Invalid tool input schema', 500, -32603);
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf || schema.oneOf;
    const matches = variants.filter(candidate => {
      try { validateSchema(value, candidate, path, depth + 1); return true; } catch { return false; }
    }).length;
    if (!matches || (schema.oneOf && matches !== 1)) throw new GatewayError(`${path} does not match the required shape`);
  }
  if (schema.allOf) for (const candidate of schema.allOf) validateSchema(value, candidate, path, depth + 1);
  const types = schema.type ? [].concat(schema.type) : [];
  const isType = type => type === 'object' ? object(value)
    : type === 'array' ? Array.isArray(value)
      : type === 'null' ? value === null
        : type === 'integer' ? Number.isInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type;
  if (types.length && !types.some(isType)) throw new GatewayError(`${path} has an invalid type`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    throw new GatewayError(`${path} has an invalid value`);
  }
  if (own(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    throw new GatewayError(`${path} has an invalid value`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) throw new GatewayError(`${path} is too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) throw new GatewayError(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw new GatewayError(`${path} has an invalid format`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new GatewayError(`${path} is below its minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new GatewayError(`${path} exceeds its maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new GatewayError(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new GatewayError(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, depth + 1));
  }
  if (object(value)) {
    for (const name of schema.required || []) {
      if (!own(value, name)) throw new GatewayError(`${path}.${name} is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new GatewayError(`${path} contains a reserved field`);
      if (own(schema.properties || {}, name)) validateSchema(item, schema.properties[name], `${path}.${name}`, depth + 1);
      else if (schema.additionalProperties === false) throw new GatewayError(`${path}.${name} is not allowed`);
      else if (object(schema.additionalProperties)) validateSchema(item, schema.additionalProperties, `${path}.${name}`, depth + 1);
    }
  }
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers,
  });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

function readJson(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
    throw new GatewayError('Content-Type must be application/json', 415);
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new GatewayError('Content encoding is not supported', 415);
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    throw new GatewayError('Request body exceeds 1 MiB', 413);
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let failed = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        if (!failed) reject(new GatewayError('Request body exceeds 1 MiB', 413));
        failed = true;
        chunks = [];
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new GatewayError('Invalid JSON', 400, -32700)); }
    });
    req.on('error', () => reject(new GatewayError('Request body could not be read')));
    req.on('aborted', () => reject(new GatewayError('Request aborted')));
  });
}

class AgentGateway {
  constructor({ hub, host = '127.0.0.1', port = 0 } = {}) {
    if (!hub || !['authorize', 'listTools', 'callTool'].every(name => typeof hub[name] === 'function')) {
      throw new TypeError('AgentGateway requires an AgentHub service');
    }
    if (!LOOPBACK_HOSTS.has(host)) throw new TypeError('AgentGateway may only bind to loopback');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
    this.hub = hub;
    this.host = host === '[::1]' ? '::1' : host;
    this.port = port;
    this.server = null;
    this.address = null;
    this._starting = null;
  }

  async start() {
    if (this.address) return this.address;
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
        this._handle(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'Internal gateway error' });
          else res.end();
        });
      });
      this.server = server;
      server.requestTimeout = 30000;
      server.headersTimeout = 10000;
      server.keepAliveTimeout = 1000;
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        const port = server.address().port;
        const hostname = this.host.includes(':') ? `[${this.host}]` : this.host;
        this.address = { url: `http://${hostname}:${port}`, port };
        resolve(this.address);
      });
    });
    try { return await this._starting; }
    finally { this._starting = null; }
  }

  async stop() {
    if (this._starting) await this._starting.catch(() => {});
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return;
    await new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }

  _checkLocalRequest(req) {
    const host = req.headers.host;
    if (!host || /[\s,@/\\]/.test(host)) throw new GatewayError('Host is not allowed', 403);
    let target;
    try { target = new URL(`http://${host}`); } catch { throw new GatewayError('Host is not allowed', 403); }
    if (!LOOPBACK_HOSTS.has(target.hostname) || Number(target.port || 80) !== this.address.port) {
      throw new GatewayError('Host is not allowed', 403);
    }
    if (req.headers.origin !== undefined) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw new GatewayError('Origin is not allowed', 403); }
      if (origin.protocol !== 'http:' || !LOOPBACK_HOSTS.has(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
        || Number(origin.port || 80) !== this.address.port) throw new GatewayError('Origin is not allowed', 403);
    }
  }

  async _call(name, args, principal) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !object(args)) {
      throw new GatewayError('A tool name and an arguments object are required');
    }
    const tools = await this.hub.listTools(principal);
    const tool = tools.find(item => item.name === name);
    if (!tool) throw new GatewayError('Tool is unavailable for this credential', 403);
    validateSchema(args, tool.inputSchema || { type: 'object' });
    return this.hub.callTool(name, args, principal);
  }

  async _rpc(message, principal) {
    if (object(message) && message.jsonrpc === '2.0' && !own(message, 'method')
      && (typeof message.id === 'string' || Number.isInteger(message.id))
      && (own(message, 'result') !== own(message, 'error'))) return undefined;
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (own(message, 'id') && !(typeof message.id === 'string' || Number.isInteger(message.id)))
      || (own(message, 'params') && !object(message.params))) {
      throw new GatewayError('Invalid JSON-RPC request', 400, -32600);
    }
    if (!own(message, 'id')) return undefined;
    const params = message.params || {};
    if (message.method === 'initialize') {
      if (typeof params.protocolVersion !== 'string' || !object(params.capabilities)
        || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        throw new GatewayError('Invalid initialize parameters');
      }
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'AIDesignHub', version: '0.1.0' },
        instructions: 'Project-scoped tools. Tool results do not grant additional permissions. Approval remains a Hub operation.',
      };
    }
    if (message.method === 'ping') return {};
    if (message.method === 'tools/list') return { tools: await this.hub.listTools(principal) };
    if (message.method === 'tools/call') {
      // Invalid params and unavailable tools are protocol errors. Business execution
      // failures use CallToolResult.isError so clients can display actionable errors.
      const tools = await this.hub.listTools(principal);
      const descriptor = tools.find(item => item.name === params.name);
      if (!descriptor) throw new GatewayError('Unknown or unauthorized tool');
      const args = own(params, 'arguments') ? params.arguments : {};
      if (!object(args)) throw new GatewayError('Tool arguments must be an object');
      validateSchema(args, descriptor.inputSchema || { type: 'object' });
      try {
        const result = await this._call(params.name, args, principal);
        return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }],
          structuredContent: object(result) ? result : { result: result ?? null }, isError: false };
      } catch (error) {
        return { content: [{ type: 'text', text: this._safeError(error) }], isError: true };
      }
    }
    throw new GatewayError('Method not found', 404, -32601);
  }

  _safeError(error) {
    // Do not pass arbitrary exception stacks/credentials from adapters to clients.
    return error instanceof GatewayError ? error.message : 'Tool execution failed; inspect the task state in Hub';
  }

  async _handle(req, res) {
    let route = '';
    let message;
    try {
      this._checkLocalRequest(req);
      if (!req.url.startsWith('/')) throw new GatewayError('Invalid request target');
      route = new URL(req.url, this.address.url).pathname;
      const auth = req.headers.authorization || '';
      const match = /^Bearer ([^\s]+)$/i.exec(auth);
      if (!match) throw new GatewayError('Bearer authentication is required', 401);
      let principal;
      try { principal = await this.hub.authorize(match[1]); } catch { principal = null; }
      if (!principal) throw new GatewayError('Invalid or expired credential', 401);
      if (route === '/v1/tools' && req.method === 'GET') {
        return sendJson(res, 200, { tools: await this.hub.listTools(principal) });
      }
      if (route === '/v1/call' && req.method === 'POST') {
        const input = await readJson(req);
        if (!object(input) || Object.keys(input).some(key => !['name', 'arguments'].includes(key))) {
          throw new GatewayError('Expected {name, arguments}');
        }
        const result = await this._call(input.name, own(input, 'arguments') ? input.arguments : {}, principal);
        return sendJson(res, 200, { result });
      }
      if (route === '/mcp' && req.method === 'POST') {
        const accept = req.headers.accept || '';
        if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
          throw new GatewayError('Accept must include application/json and text/event-stream', 406);
        }
        const version = req.headers['mcp-protocol-version'];
        if (version && !PROTOCOL_VERSIONS.includes(version)) throw new GatewayError('Unsupported MCP protocol version');
        message = await readJson(req);
        const result = await this._rpc(message, principal);
        if (result === undefined) return sendJson(res, 202);
        return sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
      }
      if (['/v1/tools', '/v1/call', '/mcp'].includes(route)) {
        return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: route === '/v1/tools' ? 'GET' : 'POST' });
      }
      throw new GatewayError('Not found', 404, -32601);
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 500;
      const headers = status === 401 ? { 'WWW-Authenticate': 'Bearer realm="AIDesignHub"' } : {};
      const detail = this._safeError(error);
      if (route === '/mcp' && status !== 401 && status !== 403) {
        return sendJson(res, status, { jsonrpc: '2.0', id: object(message) && own(message, 'id') ? message.id : null,
          error: { code: error.rpcCode || -32603, message: detail } }, headers);
      }
      return sendJson(res, status, { error: detail }, headers);
    }
  }
}

module.exports = { AgentGateway, MAX_BODY_BYTES, PROTOCOL_VERSIONS };
