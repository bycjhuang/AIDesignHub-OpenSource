'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const DEFAULT_PORT = 47831, MAX_CONTENT_BYTES = 512 * 1024, MAX_LIBRARY_BYTES = 32 * 1024 * 1024, MAX_ITEMS = 1000;
const ID = /^shared_[a-f0-9-]{36}$/, SKILL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const LAYERS = new Set(['modeling', 'office', 'video', 'design', 'writing', 'general']);
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

function privateAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  if (value === '::1' || value === 'localhost') return true;
  if (!net.isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
}
function connectionUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入局域网主机地址，例如 http://192.168.1.8:47831。'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !privateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('团队技能仅支持局域网 HTTP 主机地址，不能包含账号、路径或查询参数。');
  }
  return url.origin;
}
function tokenEqual(expected, received) {
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function writePrivate(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  try { fs.chmodSync(file, 0o600); } catch { /* safeStorage protects secrets on Windows. */ }
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  if (fs.statSync(file).size > MAX_LIBRARY_BYTES) throw new Error('团队技能文件过大，无法读取；原文件已保留。');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('团队技能文件无法读取；原文件已保留，请恢复备份后重试。'); }
}
function contentOf(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('技能说明为空，无法分享。');
  if (Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES) throw new Error('技能说明超过 512 KB，无法分享。');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\/-]{20,}/i.test(value)) {
    throw new Error('技能说明包含疑似密钥，请移除后再分享。');
  }
  return value;
}

/** Shared instruction snapshots, with no paths, installation, or execution API. */
class TeamSkillLibrary {
  constructor({ dataDir, getIdentity, protectSecret, unprotectSecret } = {}) {
    if (!dataDir || typeof getIdentity !== 'function') throw new TypeError('团队技能需要本机数据目录和身份读取器。');
    this.root = path.join(dataDir, 'team-skill-library-v1');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.libraryFile = path.join(this.root, 'shared-skills.json');
    this.configFile = path.join(this.root, 'connection-private.json');
    Object.assign(this, { getIdentity, protectSecret, unprotectSecret });
    const library = readJson(this.libraryFile, { version: 1, skills: [] });
    if (library.version !== 1 || !Array.isArray(library.skills) || library.skills.length > MAX_ITEMS) throw new Error('团队技能格式不受支持；原文件已保留。');
    this.skills = library.skills.map(item => this.normalizeStored(item));
    this.config = readJson(this.configFile, { version: 1, enabled: false, port: DEFAULT_PORT, token: null, remote: null });
    if (this.config.version !== 1) throw new Error('团队技能连接配置格式不受支持。');
    this.token = this.config.token ? this.decodeSecret(this.config.token) : crypto.randomBytes(24).toString('base64url');
    this.remote = this.config.remote ? { url: connectionUrl(this.config.remote.url), token: this.decodeSecret(this.config.remote.token) } : null;
    this.server = null; this.port = null; this.host = null; this.lastError = null; this.starting = null;
  }
  identity() {
    const identity = this.getIdentity() || {};
    if (typeof identity.id !== 'string' || !identity.id || typeof identity.name !== 'string' || !identity.name.trim()) throw new Error('请先选择当前设计师身份再使用团队共享。');
    return { id: text(identity.id, 200), name: text(identity.name, 100), role: text(identity.role, 100) };
  }
  encodeSecret(secret) {
    return this.protectSecret ? { protected: true, value: this.protectSecret(secret) } : { protected: false, value: secret };
  }
  decodeSecret(secret) {
    if (!secret || typeof secret.value !== 'string') throw new Error('团队技能连接密钥无法读取。');
    if (!secret.protected) return secret.value;
    if (!this.unprotectSecret) throw new Error('团队技能连接密钥需要本机安全存储，请使用原 Windows 账号。');
    try { return this.unprotectSecret(secret.value); }
    catch { throw new Error('团队技能连接密钥无法解密，请重新设置连接。'); }
  }
  saveConfig() {
    writePrivate(this.configFile, { version: 1, enabled: this.config.enabled === true,
      port: this.config.port || DEFAULT_PORT, token: this.encodeSecret(this.token),
      remote: this.remote ? { url: this.remote.url, token: this.encodeSecret(this.remote.token) } : null });
  }
  normalizeStored(item) {
    if (!item || !ID.test(item.id) || !SKILL_ID.test(item.skillId) || typeof item.author?.id !== 'string' || !item.author.id || typeof item.author.name !== 'string' || !item.author.name) throw new Error('团队技能记录格式无效；原文件已保留。');
    return { id: item.id, skillId: item.skillId, displayName: text(item.displayName, 128) || item.skillId,
      description: text(item.description, 4000), layer: LAYERS.has(item.layer) ? item.layer : 'general',
      author: { id: text(item.author.id, 200), name: text(item.author.name, 100), role: text(item.author.role, 100) },
      sharedAt: Number(item.sharedAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now(), content: contentOf(item.content) };
  }
  summary(item, owned = false) {
    const { content, ...summary } = item;
    return { ...summary, source: 'team', sourceLabel: '团队共享', owned, canUnshare: owned,
      authorId: item.author.id, authorName: item.author.name, authorRole: item.author.role };
  }
  list() {
    const identity = this.identity();
    return this.skills.map(item => this.summary(item, item.author.id === identity.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id) {
    if (!ID.test(id || '')) throw new Error('团队技能标识无效。');
    const item = this.skills.find(skill => skill.id === id);
    if (!item) throw new Error('此技能已取消分享，请刷新团队共享。');
    return { ...this.summary(item, item.author.id === this.identity().id), content: item.content };
  }
  share({ skill } = {}) {
    const identity = this.identity();
    if (!skill || !SKILL_ID.test(skill.id || '')) throw new Error('技能名称无效，请从本机技能列表选择。');
    const previous = this.skills.find(item => item.skillId === skill.id && item.author.id === identity.id);
    const record = this.normalizeStored({ id: previous?.id || 'shared_' + crypto.randomUUID(), skillId: skill.id,
      displayName: skill.displayName, description: skill.description, layer: skill.layer, content: skill.content,
      author: identity, sharedAt: previous?.sharedAt || Date.now(), updatedAt: Date.now() });
    const skills = previous ? this.skills.map(item => item.id === previous.id ? record : item) : [...this.skills, record];
    if (skills.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(skills), 'utf8') > MAX_LIBRARY_BYTES - 1000) throw new Error('团队技能库已达容量限制，请先取消不再需要的分享。');
    writePrivate(this.libraryFile, { version: 1, skills }); this.skills = skills;
    return this.summary(record, true);
  }
  unshare(id) {
    if (!this.get(id).canUnshare) throw new Error('只有分享者可以取消此技能的分享。');
    const skills = this.skills.filter(item => item.id !== id);
    writePrivate(this.libraryFile, { version: 1, skills }); this.skills = skills;
    return { id, removed: true };
  }
  status() {
    const urls = !this.server?.listening ? [] : this.host === '127.0.0.1' ? ['http://127.0.0.1:' + this.port]
      : [...new Set(Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal && privateAddress(item.address)).map(item => 'http://' + item.address + ':' + this.port))];
    return { server: { running: Boolean(this.server?.listening), urls, port: this.port || this.config.port || DEFAULT_PORT, token: this.token, lastError: this.lastError },
      remote: { connected: Boolean(this.remote), url: this.remote?.url || null }, identity: this.identity() };
  }
  async restore() {
    if (this.config.enabled === true) await this.start({ port: this.config.port || DEFAULT_PORT });
    return this.status();
  }
  start(options = {}) {
    if (this.starting) return this.starting;
    this.starting = this.startListening(options).finally(() => { this.starting = null; });
    return this.starting;
  }
  async startListening({ port = DEFAULT_PORT, host = '0.0.0.0' } = {}) {
    if (this.server?.listening) return this.status();
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !['0.0.0.0', '127.0.0.1'].includes(host)) throw new Error('团队技能服务端口无效。');
    const server = http.createServer((request, response) => this.serve(request, response));
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 30;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      this.server = server; this.port = server.address().port; this.host = host; this.lastError = null;
      this.config.enabled = true; this.config.port = this.port; this.saveConfig();
      return this.status();
    } catch (error) {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      this.server = null; this.port = null;
      this.lastError = error.code === 'EADDRINUSE' ? '端口 ' + port + ' 已被占用，请修改端口后重试。' : '团队技能服务未能开启，请检查本机网络设置。';
      throw new Error(this.lastError);
    }
  }
  serve(request, response) {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    if (!privateAddress(request.socket.remoteAddress) || request.headers.origin) return send(403, { ok: false, error: '仅允许团队客户端从局域网读取技能。' });
    if (request.method !== 'GET') return send(405, { ok: false, error: '团队技能服务只提供读取。' });
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { return send(400, { ok: false, error: '技能查询地址无效。' }); }
    if (url.pathname === '/health' && !url.search) return send(200, { ok: true, service: 'AIDesignHub Team Skills', version: 1 });
    const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenEqual(this.token, bearer)) return send(401, { ok: false, error: '连接码无效，请向技能分享者确认。' });
    if (url.search) return send(400, { ok: false, error: '技能查询参数无效。' });
    if (url.pathname === '/api/team-skills') return send(200, { ok: true, data: this.skills.map(item => this.summary(item)) });
    const id = url.pathname.slice('/api/team-skills/'.length);
    if (url.pathname.startsWith('/api/team-skills/') && ID.test(id)) {
      const item = this.skills.find(skill => skill.id === id);
      return item ? send(200, { ok: true, data: { ...this.summary(item), content: item.content } }) : send(404, { ok: false, error: '此技能已取消分享，请刷新团队共享。' });
    }
    return send(404, { ok: false, error: '技能接口不存在。' });
  }
  async stop({ preserveEnabled = false } = {}) {
    if (this.starting) { try { await this.starting; } catch { /* Stop remains available after failed startup. */ } }
    if (this.server) {
      const server = this.server; this.server = null; this.port = null;
      server.closeIdleConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    if (!preserveEnabled) { this.config.enabled = false; this.lastError = null; this.saveConfig(); }
    return this.status();
  }
  async remoteRequest(remote, pathname, maxBytes = MAX_LIBRARY_BYTES) {
    let response;
    try { response = await fetch(remote.url + pathname, { headers: { authorization: 'Bearer ' + remote.token }, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
    catch { throw new Error('无法连接团队技能主机，请检查地址、主机在线状态及局域网连接。'); }
    let payload;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength; if (bytes > maxBytes) throw new Error('too large'); chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('团队技能主机响应格式无效或内容过大。'); }
    if (!response.ok || payload.ok !== true) throw new Error(response.status === 401 ? '连接码无效，请向技能分享者确认。' : '团队技能暂不可读取，请刷新或重新连接。');
    return payload.data ?? payload;
  }
  async connect({ url, token } = {}) {
    const remote = { url: connectionUrl(url), token: String(token || '').trim() };
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(remote.token)) throw new Error('请输入完整的团队技能连接码。');
    const health = await this.remoteRequest(remote, '/health', 4096);
    if (health.service !== 'AIDesignHub Team Skills' || health.version !== 1) throw new Error('此地址不是受支持的 AIDesignHub 团队技能主机。');
    this.validateRemoteList(await this.remoteRequest(remote, '/api/team-skills'));
    const previous = this.remote; this.remote = remote;
    try { this.saveConfig(); } catch (error) { this.remote = previous; throw error; }
    return this.status();
  }
  disconnect() { this.remote = null; this.saveConfig(); return this.status(); }
  validateRemoteList(skills) {
    if (!Array.isArray(skills) || skills.length > MAX_ITEMS) throw new Error('团队技能主机返回的技能列表无效。');
    return skills.map(item => this.summary(this.normalizeStored({ ...item, content: '共享说明预览' }), false));
  }
  async listRemote() {
    if (!this.remote) return [];
    return this.validateRemoteList(await this.remoteRequest(this.remote, '/api/team-skills'));
  }
  async getRemote(id) {
    if (!ID.test(id || '')) throw new Error('团队技能标识无效。');
    if (!this.remote) throw new Error('请先连接团队技能主机。');
    const record = this.normalizeStored(await this.remoteRequest(this.remote, '/api/team-skills/' + id, MAX_CONTENT_BYTES * 6 + 32000));
    if (record.id !== id) throw new Error('团队技能主机返回了错误的技能。');
    return { ...this.summary(record, false), content: record.content };
  }
}

module.exports = { TeamSkillLibrary, DEFAULT_PORT, MAX_CONTENT_BYTES, connectionUrl };

