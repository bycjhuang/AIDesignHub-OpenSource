"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { fetchPublicImage, validateRasterImage } = require("./public-page.cjs");

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 36 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const CATEGORIES = new Set(["image", "video"]);
const API_TYPES = new Set(["openai-compatible", "apimart"]);
// APIMart aspect ratios accepted by kling-style video models, mapped from the canvas pixel sizes.
const APIMART_VIDEO_ASPECTS = { "1280x720": "16:9", "1920x1080": "16:9", "3840x2160": "16:9", "720x1280": "9:16", "1080x1920": "9:16", "2160x3840": "9:16" };
const SIZES = new Set(["auto", "256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"]);
const IMAGE_ASPECT_RATIOS = new Set(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"]);
const IMAGE_RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const PIXEL_ASPECTS = { auto: "auto", "256x256": "1:1", "512x512": "1:1", "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3", "1792x1024": "16:9", "1024x1792": "9:16" };
const VIDEO_SIZES = new Set(["1280x720", "720x1280", "1920x1080", "1080x1920", "3840x2160", "2160x3840"]);
class MediaModelServiceError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
function fail(code, message, status) { throw new MediaModelServiceError(code, message, status); }
function record(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value, label, max, optional = false, allowLines = false) {
  if (optional && value == null) return "";
  if (typeof value !== "string" || value.length > max || (allowLines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value) || (!optional && !value.trim())) fail("MEDIA_INVALID_CONFIG", `${label}格式无效。`);
  return value.trim();
}
function normalizeBaseUrl(value) {
  const source = text(value, "Base URL", 2000);
  if (/[\\?#\s]/.test(source)) fail("MEDIA_INVALID_URL", "Base URL不能包含空白、查询参数或锚点。");
  let url; try { url = new URL(source); } catch { fail("MEDIA_INVALID_URL", "请输入有效的模型Base URL。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) fail("MEDIA_INVALID_URL", "远程服务需要HTTPS；HTTP仅支持本机回环地址，地址不能含账号密码。");
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (hostname === "bycjdesign.com" || hostname.endsWith(".bycjdesign.com")) fail("MEDIA_WEBSITE_FORBIDDEN", "此处使用独立模型服务，不连接BYCJ网站后端或使用网站积分。");
  if (/\/(?:images|videos)\/(?:generations|edits)\/?$/i.test(url.pathname)) fail("MEDIA_INVALID_URL", "请填写Base URL，不要包含末尾的图片或视频生成接口路径。");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}
function assertSafePath(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("MEDIA_STORAGE_UNSAFE", "媒体模型配置路径不可访问。", 500);
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail("MEDIA_STORAGE_UNSAFE", "媒体模型配置不能通过符号链接访问。", 500); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function decodeDataURL(value) {
  const match = typeof value === "string" && value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) fail("MEDIA_INVALID_IMAGE", "模型没有返回有效的图片数据。", 502);
  return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
}
function validateImage(buffer, declaredMime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) fail("MEDIA_IMAGE_LIMIT", "图片为空或超过25MB上限。", 502);
  let mime = declaredMime;
  if (!mime) {
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
    else if (buffer[0] === 255 && buffer[1] === 216) mime = "image/jpeg";
    else if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") mime = "image/webp";
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) fail("MEDIA_INVALID_IMAGE", "只接受PNG、JPEG或静态WebP图片。", 502);
  try { validateRasterImage(buffer, mime, { allowSmall: true }); } catch { fail("MEDIA_INVALID_IMAGE", "模型返回的图片格式或尺寸无效。", 502); }
  return { buffer, mime };
}
async function boundedJson(response, signal) {
  if (Number(response.headers?.get?.("content-length")) > MAX_JSON_BYTES) fail("MEDIA_RESPONSE_LIMIT", "模型响应超过本机读取上限。", 502);
  if (!response.body?.getReader) {
    const source = await response.text();
    if (Buffer.byteLength(source) > MAX_JSON_BYTES) fail("MEDIA_RESPONSE_LIMIT", "模型响应超过本机读取上限。", 502);
    try { return JSON.parse(source); } catch { fail("MEDIA_INVALID_RESPONSE", "模型服务未返回有效JSON。", 502); }
  }
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_JSON_BYTES) { await reader.cancel().catch(() => {}); fail("MEDIA_RESPONSE_LIMIT", "模型响应超过本机读取上限。", 502); }
      parts.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { fail("MEDIA_INVALID_RESPONSE", "模型服务未返回有效JSON。", 502); }
  } finally { reader.releaseLock(); }
}

async function boundedBuffer(response, maxBytes, signal) {
  if (Number(response.headers?.get?.("content-length")) > maxBytes) fail("MEDIA_RESPONSE_LIMIT", "视频结果超过本机读取上限。", 502);
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) fail("MEDIA_RESPONSE_LIMIT", "视频结果超过本机读取上限。", 502);
    return buffer;
  }
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) { await reader.cancel().catch(() => {}); fail("MEDIA_RESPONSE_LIMIT", "视频结果超过本机读取上限。", 502); }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  } finally { reader.releaseLock(); }
}
function videoMime(buffer, declared) {
  if (Buffer.isBuffer(buffer) && buffer.length >= 12) {
    if (buffer.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  }
  if (declared === "video/mp4" || declared === "video/webm") return declared;
  return null;
}

function apimartTaskId(data) {
  if (Array.isArray(data?.data) && record(data.data[0]) && typeof data.data[0].task_id === "string" && data.data[0].task_id) return data.data[0].task_id;
  if (record(data?.data) && typeof data.data.task_id === "string" && data.data.task_id) return data.data.task_id;
  return "";
}
function apimartResultUrl(list) {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (!record(item)) continue;
    if (Array.isArray(item.url)) { const first = item.url.find((v) => typeof v === "string" && v.trim()); if (first) return first; }
    if (typeof item.url === "string" && item.url.trim()) return item.url;
    if (typeof item.video_url === "string" && item.video_url.trim()) return item.video_url;
  }
  return "";
}

class MediaModelService {
  constructor({ dataDir, protectSecret, unprotectSecret, fetchImpl = globalThis.fetch, imageFetcher = fetchPublicImage, timeoutMs = 180000, videoTimeoutMs = 330000, videoPollIntervalMs = 3000 } = {}) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("MediaModelService requires an absolute device dataDir.");
    this.root = path.resolve(dataDir);
    this.file = path.join(this.root, "media-private", "profiles-v1.json");
    this.protectSecret = protectSecret; this.unprotectSecret = unprotectSecret; this.fetchImpl = fetchImpl; this.imageFetcher = imageFetcher;
    this.timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000 ? timeoutMs : 180000;
    // The local canvas server answers within six minutes; video polling stays below it.
    this.videoTimeoutMs = Number.isInteger(videoTimeoutMs) && videoTimeoutMs > 0 && videoTimeoutMs <= 330000 ? videoTimeoutMs : 330000;
    this.videoPollIntervalMs = Number.isInteger(videoPollIntervalMs) && videoPollIntervalMs > 0 ? videoPollIntervalMs : 3000;
    this.state = this.readState();
  }
  readState() {
    assertSafePath(this.root, this.file);
    let source;
    try { const stat = fs.statSync(this.file); if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) fail("MEDIA_CONFIG_INVALID", "本机媒体模型配置无效，原文件已保留。", 500); source = fs.readFileSync(this.file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { version: 1, profiles: [], defaults: { image: "", video: "" } }; throw error; }
    try {
      const state = JSON.parse(source);
      if (state.version !== 1 || !Array.isArray(state.profiles) || state.profiles.length > 100 || !record(state.defaults)) throw new Error();
      const ids = new Set();
      for (const profile of state.profiles) {
        if (!record(profile) || !CATEGORIES.has(profile.category) || !/^[a-zA-Z0-9_-]{1,100}$/.test(profile.id) || ids.has(profile.id) || !API_TYPES.has(profile.apiType) || typeof profile.encryptedApiKey !== "string" || typeof profile.enabled !== "boolean") throw new Error();
        ids.add(profile.id); text(profile.name, "配置名称", 100); text(profile.model, "模型名称", 200); normalizeBaseUrl(profile.baseUrl);
      }
      for (const category of CATEGORIES) if (state.defaults[category] && !state.profiles.some((p) => p.id === state.defaults[category] && p.category === category)) throw new Error();
      return state;
    } catch { fail("MEDIA_CONFIG_INVALID", "本机媒体模型配置读取失败，原文件已保留。", 500); }
  }
  snapshot() {
    return { profiles: this.state.profiles.map(({ id, category, name, apiType, baseUrl, model, enabled, encryptedApiKey }) => ({ id, category, name, apiType, baseUrl, model, enabled, hasApiKey: !!encryptedApiKey })), defaults: { ...this.state.defaults } };
  }
  persist(next) {
    assertSafePath(this.root, this.file);
    const source = JSON.stringify(next);
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) fail("MEDIA_CONFIG_LIMIT", "媒体模型配置超过本机保存上限，旧配置未修改。");
    const dir = path.dirname(this.file); let temp;
    try {
      fs.mkdirSync(dir, { recursive: true }); assertSafePath(this.root, this.file);
      temp = path.join(dir, `.profiles-${randomUUID()}.tmp`);
      fs.writeFileSync(temp, source, { mode: 0o600, flag: "wx" });
      assertSafePath(this.root, this.file); fs.renameSync(temp, this.file);
      this.state = next;
    } catch (error) {
      if (error instanceof MediaModelServiceError) throw error;
      fail("MEDIA_SAVE_FAILED", "本机媒体模型配置保存失败，旧配置未修改。", 500);
    } finally { if (temp) { try { fs.rmSync(temp, { force: true }); } catch {} } }
    return this.snapshot();
  }
  encrypt(key) {
    if (typeof this.protectSecret !== "function" || typeof this.unprotectSecret !== "function") fail("MEDIA_ENCRYPTION_UNAVAILABLE", "系统加密不可用，无法保存模型密钥。不会以明文保存。", 503);
    try {
      const result = this.protectSecret(key);
      const encrypted = Buffer.isBuffer(result) ? result.toString("base64") : result;
      if (typeof encrypted !== "string" || !encrypted.length || encrypted === key || this.unprotectSecret(encrypted) !== key) throw new Error();
      return encrypted;
    } catch { fail("MEDIA_ENCRYPTION_UNAVAILABLE", "系统加密不可用，无法保存模型密钥。不会以明文保存。", 503); }
  }
  save(payload) {
    if (!record(payload)) fail("MEDIA_INVALID_CONFIG", "媒体模型配置格式无效。");
    const next = structuredClone(this.state);
    if (payload.defaults && !payload.category && !payload.id) {
      if (!record(payload.defaults)) fail("MEDIA_INVALID_CONFIG", "默认模型配置无效。");
      for (const category of CATEGORIES) {
        if (!(category in payload.defaults)) continue;
        const id = payload.defaults[category];
        if (id !== "" && !next.profiles.some((p) => p.id === id && p.category === category && p.enabled)) fail("MEDIA_INVALID_DEFAULT", "请选择该分类中已启用的模型配置。");
        next.defaults[category] = id;
      }
      return this.persist(next);
    }
    const id = payload.id ? text(payload.id, "配置ID", 100) : randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail("MEDIA_INVALID_CONFIG", "配置ID格式无效。");
    const existing = next.profiles.find((p) => p.id === id);
    if (payload.id && !existing) fail("MEDIA_PROFILE_NOT_FOUND", "媒体模型配置不存在。", 404);
    const category = payload.category ?? existing?.category;
    if (!CATEGORIES.has(category)) fail("MEDIA_INVALID_CONFIG", "请选择图片或视频模型分类。");
    const apiType = payload.apiType ?? existing?.apiType ?? "openai-compatible";
    if (!API_TYPES.has(apiType)) fail("MEDIA_API_UNSUPPORTED", "目前仅支持OpenAI兼容接口与APIMart任务接口。");
    const name = text(payload.name ?? existing?.name, "配置名称", 100);
    const baseUrl = normalizeBaseUrl(payload.baseUrl ?? existing?.baseUrl);
    const model = text(payload.model ?? existing?.model, "模型名称", 200);
    const apiKey = text(payload.apiKey, "API Key", 8192, true);
    const donor = !apiKey ? next.profiles.find((p) => p.id !== id && p.apiType === apiType && p.baseUrl === baseUrl && p.encryptedApiKey) : null;
    if ((!existing || baseUrl !== existing.baseUrl) && !apiKey && !donor) fail("MEDIA_NEW_KEY_REQUIRED", "新增配置或更换服务地址时，请填写该服务的API Key；同一接口与地址已保存过密钥时可留空复用。");
    if (payload.enabled != null && typeof payload.enabled !== "boolean") fail("MEDIA_INVALID_CONFIG", "启用状态格式无效。");
    const profile = { id, category, name, apiType, baseUrl, model, enabled: payload.enabled ?? existing?.enabled ?? true, encryptedApiKey: apiKey ? this.encrypt(apiKey) : existing?.encryptedApiKey || donor?.encryptedApiKey || "" };
    if (existing) next.profiles[next.profiles.findIndex((p) => p.id === id)] = profile;
    else { if (next.profiles.length >= 100) fail("MEDIA_CONFIG_LIMIT", "最多保存100条媒体模型配置。"); next.profiles.push(profile); }
    if (existing && existing.category !== category && next.defaults[existing.category] === id) next.defaults[existing.category] = next.profiles.find((p) => p.category === existing.category && p.enabled)?.id || "";
    if ((payload.isDefault === true || payload.default === true || !next.defaults[category]) && profile.enabled) next.defaults[category] = id;
    if (!profile.enabled && next.defaults[category] === id) next.defaults[category] = next.profiles.find((p) => p.category === category && p.enabled)?.id || "";
    return this.persist(next);
  }
  remove(payload) {
    const id = text(payload?.id, "配置ID", 100); const next = structuredClone(this.state);
    const existing = next.profiles.find((p) => p.id === id);
    if (!existing) fail("MEDIA_PROFILE_NOT_FOUND", "媒体模型配置不存在。", 404);
    next.profiles = next.profiles.filter((p) => p.id !== id);
    if (next.defaults[existing.category] === id) next.defaults[existing.category] = next.profiles.find((p) => p.category === existing.category && p.enabled)?.id || "";
    return this.persist(next);
  }
  getSecret(profile) {
    try { const key = this.unprotectSecret?.(profile.encryptedApiKey); if (typeof key !== "string" || !key.trim()) throw new Error(); return key; }
    catch { fail("MEDIA_KEY_UNAVAILABLE", "此配置的本机密钥无法解密，请在统一设置中重新保存API Key。", 503); }
  }
  // APIMart answers with a task id first; the same tasks endpoint serves every
  // category, so submission stays category-specific and polling stays shared.
  async apimartSubmitAndPoll({ baseUrl, key, submitPath, body, signal, deadline, pollIntervalMs }) {
    const submit = await this.fetchImpl(`${baseUrl}${submitPath}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body), redirect: "error", credentials: "omit", signal });
    if (!submit.ok) {
      await submit.body?.cancel?.().catch(() => {});
      fail("MEDIA_PROVIDER_REJECTED", `模型服务返回错误（HTTP ${Number.isInteger(submit.status) ? submit.status : "未知"}）。请检查模型、额度及服务记录；系统不会自动重试。`, 502);
    }
    const taskId = apimartTaskId(await boundedJson(submit, signal));
    if (!taskId) fail("MEDIA_INVALID_RESPONSE", "模型服务没有返回有效的生成任务。", 502);
    const sleep = (ms) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const wait = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(wait); reject(signal.reason); }, { once: true });
    });
    while (true) {
      if (Date.now() + pollIntervalMs > deadline) fail("MEDIA_GENERATION_TIMEOUT", "生成等待超时，任务可能仍在服务端进行。请检查服务记录；系统不会自动重试。", 504);
      await sleep(pollIntervalMs);
      const poll = await this.fetchImpl(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", credentials: "omit", signal });
      if (!poll.ok) {
        await poll.body?.cancel?.().catch(() => {});
        fail("MEDIA_PROVIDER_REJECTED", `模型任务查询返回错误（HTTP ${Number.isInteger(poll.status) ? poll.status : "未知"}）。请检查服务记录；系统不会自动重试。`, 502);
      }
      const task = (await boundedJson(poll, signal))?.data;
      if (!record(task) || typeof task.status !== "string") fail("MEDIA_INVALID_RESPONSE", "模型服务返回了无效的任务状态。", 502);
      if (task.status === "completed") return task;
      if (task.status === "failed" || task.status === "cancelled") fail("MEDIA_GENERATION_FAILED", "模型服务报告生成失败。请检查提示词与服务记录；系统不会自动重试。", 502);
    }
  }
  imageStatus() {
    const profiles = this.state.profiles.filter((p) => p.category === "image").map((p) => {
      let configured = p.enabled && !!p.encryptedApiKey;
      if (configured) { try { this.getSecret(p); } catch { configured = false; } }
      return { id: p.id, name: p.name, model: p.model, configured, enabled: p.enabled };
    });
    const selected = this.state.profiles.find((p) => p.id === this.state.defaults.image && p.category === "image");
    return { configured: !!profiles.find((p) => p.id === selected?.id)?.configured, defaultProfileId: this.state.defaults.image, model: selected?.model || "", baseUrl: selected?.baseUrl || "", profiles, storage: "local" };
  }
  getImageProvider() {
    return { status: () => this.imageStatus(), saveConfig: () => fail("MEDIA_UNIFIED_SETTINGS_REQUIRED", "请在工作台统一设置的“图片/视频模型”中管理服务与密钥。", 409), generate: (payload) => this.generateImage(payload) };
  }
  videoStatus() {
    const profiles = this.state.profiles.filter((p) => p.category === "video").map((p) => {
      let configured = p.enabled && !!p.encryptedApiKey;
      if (configured) { try { this.getSecret(p); } catch { configured = false; } }
      return { id: p.id, name: p.name, model: p.model, configured, enabled: p.enabled };
    });
    const selected = this.state.profiles.find((p) => p.id === this.state.defaults.video && p.category === "video");
    return { configured: !!profiles.find((p) => p.id === selected?.id)?.configured, defaultProfileId: this.state.defaults.video, model: selected?.model || "", baseUrl: selected?.baseUrl || "", profiles, storage: "local" };
  }
  getVideoProvider() {
    return { status: () => this.videoStatus(), generate: (payload) => this.generateVideo(payload) };
  }
  async generateImage(payload) {
    if (!record(payload)) fail("MEDIA_INVALID_REQUEST", "生图请求格式无效。");
    const prompt = text(payload.prompt, "生图描述", 12000, false, true);
    const profileId = payload.profileId || this.state.defaults.image;
    const profile = this.state.profiles.find((p) => p.id === profileId && p.category === "image" && p.enabled);
    if (!profile) fail("MEDIA_IMAGE_UNCONFIGURED", "请先在统一设置中启用并选择图片模型。", 503);
    if (payload.size != null && !SIZES.has(payload.size)) fail("MEDIA_INVALID_REQUEST", "图片尺寸不受支持。");
    if (payload.aspectRatio != null && !IMAGE_ASPECT_RATIOS.has(payload.aspectRatio)) fail("MEDIA_INVALID_REQUEST", "图片画幅不受支持。");
    if (payload.resolution != null && !IMAGE_RESOLUTIONS.has(payload.resolution)) fail("MEDIA_INVALID_REQUEST", "图片分辨率不受支持。");
    const references = payload.referenceImages ?? [];
    if (!Array.isArray(references) || references.length > 4) fail("MEDIA_INVALID_REFERENCE", "一次图片编辑最多使用4张参考图片。");
    let referenceBytes = 0;
    const validatedReferences = references.map((reference) => {
      const dataUrl = typeof reference === "string" ? reference : reference?.dataUrl;
      if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 150) fail("MEDIA_INVALID_REFERENCE", "参考图片无效或超过25MB上限。");
      const decoded = decodeDataURL(dataUrl); const image = validateImage(decoded.buffer, decoded.mime);
      referenceBytes += image.buffer.length;
      if (referenceBytes > 50 * 1024 * 1024) fail("MEDIA_INVALID_REFERENCE", "参考图片总量超过50MB上限。");
      return image;
    });
    const key = this.getSecret(profile);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (profile.apiType === "apimart") {
        // Gemini accepts aspect ratios, not OpenAI pixel sizes. Keep the canvas
        // resolution separate; GPT Image 2 requires lowercase resolution tiers.
        const size = payload.aspectRatio || (/^(?:gemini-|nano-banana)/i.test(profile.model) ? PIXEL_ASPECTS[payload.size] : payload.size);
        const resolution = /^gpt-image-2(?:-|$)/i.test(profile.model) ? payload.resolution?.toLowerCase() : payload.resolution;
        const task = await this.apimartSubmitAndPoll({ baseUrl: profile.baseUrl, key, submitPath: "/images/generations", body: { model: profile.model, prompt, n: 1, ...(size ? { size } : {}), ...(resolution ? { resolution } : {}), ...(validatedReferences.length ? { image_urls: validatedReferences.map((reference) => `data:${reference.mime};base64,${reference.buffer.toString("base64")}`) } : {}) }, signal: controller.signal, deadline: Date.now() + this.timeoutMs, pollIntervalMs: this.videoPollIntervalMs });
        const url = apimartResultUrl(task.result?.images);
        if (!url) fail("MEDIA_INVALID_RESPONSE", "图片服务没有返回图片，请检查服务记录。", 502);
        const asset = await this.imageFetcher(url, { allowSmall: true, maxBytes: 8 * 1024 * 1024, timeoutMs: 60000, signal: controller.signal });
        const decoded = decodeDataURL(asset.dataUrl); const image = validateImage(decoded.buffer, decoded.mime);
        return { ...image, model: profile.model };
      }
      const parameters = { model: profile.model, prompt, n: 1, ...(payload.size ? { size: payload.size } : {}), ...(/^gpt-image(?:-|$)/i.test(profile.model) ? {} : { response_format: "b64_json" }) };
      let body, contentHeaders;
      if (validatedReferences.length) {
        const form = new FormData();
        for (const [name, value] of Object.entries(parameters)) form.set(name, String(value));
        validatedReferences.forEach((reference, index) => {
          const extension = reference.mime === "image/jpeg" ? "jpg" : reference.mime === "image/webp" ? "webp" : "png";
          const field = /^dall-e(?:-|$)/i.test(profile.model) && validatedReferences.length === 1 ? "image" : "image[]";
          form.append(field, new Blob([reference.buffer], { type: reference.mime }), `reference-${index}.${extension}`);
        });
        body = form; contentHeaders = {};
      } else { body = JSON.stringify(parameters); contentHeaders = { "Content-Type": "application/json" }; }
      const endpoint = validatedReferences.length ? "edits" : "generations";
      const response = await this.fetchImpl(`${profile.baseUrl}/images/${endpoint}`, { method: "POST", headers: { ...contentHeaders, Authorization: `Bearer ${key}` }, body, redirect: "error", credentials: "omit", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        fail("MEDIA_PROVIDER_REJECTED", `图片服务返回错误（HTTP ${Number.isInteger(response.status) ? response.status : "未知"}）。请检查模型、额度及服务记录；系统不会自动重试。`, 502);
      }
      const data = await boundedJson(response, controller.signal);
      if (!Array.isArray(data?.data) || !data.data.length || !record(data.data[0])) fail("MEDIA_INVALID_RESPONSE", "图片服务没有返回图片，请检查服务记录。", 502);
      const image = data.data[0]; let result;
      if (typeof image.b64_json === "string") {
        if (image.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) fail("MEDIA_INVALID_IMAGE", "图片数据无效或超过25MB上限。", 502);
        result = validateImage(Buffer.from(image.b64_json, "base64"));
      } else if (typeof image.url === "string") {
        // Existing public image reader pins checked DNS addresses at every hop,
        // sends no cookies/Authorization, validates MIME/dimensions and bounds data.
        const asset = await this.imageFetcher(image.url, { allowSmall: true, maxBytes: 8 * 1024 * 1024, timeoutMs: 60000, signal: controller.signal });
        const decoded = decodeDataURL(asset.dataUrl); result = validateImage(decoded.buffer, decoded.mime);
      } else fail("MEDIA_INVALID_RESPONSE", "图片服务未返回受支持的base64或公开图片URL。", 502);
      return { ...result, model: profile.model };
    } catch (error) {
      if (error instanceof MediaModelServiceError) throw error;
      if (controller.signal.aborted) fail("MEDIA_GENERATION_TIMEOUT", "图片请求超时，可能已提交。请先检查服务记录；系统不会自动重试。", 504);
      if (/TIMEOUT|TIMED_OUT|ERR_(?:CONNECTION|NAME_NOT_RESOLVED|PROXY|TUNNEL)|ENOTFOUND|ECONNRESET|ECONNREFUSED/.test(`${error?.cause?.code || error?.code || ""} ${error?.message || ""}`)) fail("MEDIA_NETWORK_UNAVAILABLE", "无法连接图片服务，请检查网络与代理设置。如请求已提交，请先检查服务记录；系统不会自动重试。", 502);
      fail("MEDIA_GENERATION_FAILED", "图片请求未完成，可能已提交。请检查网络及服务记录后再决定是否新建请求；系统不会自动重试。", 502);
    } finally { clearTimeout(timer); }
  }
  async generateVideo(payload) {
    if (!record(payload)) fail("MEDIA_INVALID_REQUEST", "视频生成请求格式无效。");
    const prompt = text(payload.prompt, "视频描述", 12000, false, true);
    const profileId = payload.profileId || this.state.defaults.video;
    const profile = this.state.profiles.find((p) => p.id === profileId && p.category === "video" && p.enabled);
    if (!profile) fail("MEDIA_VIDEO_UNCONFIGURED", "请先在统一设置中启用并选择视频模型。", 503);
    if (payload.size != null && !VIDEO_SIZES.has(payload.size)) fail("MEDIA_INVALID_REQUEST", "视频尺寸不受支持。");
    if (payload.seconds != null && (!Number.isInteger(payload.seconds) || payload.seconds < 1 || payload.seconds > 60)) fail("MEDIA_INVALID_REQUEST", "视频时长不受支持。");
    const references = payload.referenceImages ?? payload.inputImages ?? [];
    if (!Array.isArray(references)) fail("MEDIA_INVALID_REFERENCE", "视频参考帧格式无效。");
    if (references.length) fail("MEDIA_VIDEO_REFERENCE_UNSUPPORTED", "当前OpenAI兼容视频接口不支持首尾帧参考图，请移除参考图后重试。");
    const key = this.getSecret(profile);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.videoTimeoutMs);
    const deadline = Date.now() + this.videoTimeoutMs;
    const sleep = (ms) => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(controller.signal.reason); return; }
      const wait = setTimeout(resolve, ms);
      controller.signal.addEventListener("abort", () => { clearTimeout(wait); reject(controller.signal.reason); }, { once: true });
    });
    try {
      if (profile.apiType === "apimart") {
        const task = await this.apimartSubmitAndPoll({ baseUrl: profile.baseUrl, key, submitPath: "/videos/generations", body: { model: profile.model, prompt, ...(payload.seconds ? { duration: payload.seconds } : {}), ...(APIMART_VIDEO_ASPECTS[payload.size] ? { aspect_ratio: APIMART_VIDEO_ASPECTS[payload.size] } : {}) }, signal: controller.signal, deadline, pollIntervalMs: this.videoPollIntervalMs });
        const url = apimartResultUrl(task.result?.videos);
        if (!url) fail("MEDIA_INVALID_RESPONSE", "视频服务没有返回视频，请检查服务记录。", 502);
        // Result URLs are public file links; the model key is never forwarded to them.
        const contentResponse = await this.fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal });
        if (!contentResponse.ok) {
          await contentResponse.body?.cancel?.().catch(() => {});
          fail("MEDIA_PROVIDER_REJECTED", `视频结果下载返回错误（HTTP ${Number.isInteger(contentResponse.status) ? contentResponse.status : "未知"}）。请检查服务记录；系统不会自动重试。`, 502);
        }
        const videoBuffer = await boundedBuffer(contentResponse, MAX_VIDEO_BYTES, controller.signal);
        const mime = videoMime(videoBuffer, contentResponse.headers?.get?.("content-type"));
        if (!mime) fail("MEDIA_INVALID_RESPONSE", "视频服务没有返回有效的MP4或WebM视频。", 502);
        return { buffer: videoBuffer, mime, model: profile.model };
      }
      const createResponse = await this.fetchImpl(`${profile.baseUrl}/videos`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: profile.model, prompt, ...(payload.size ? { size: payload.size } : {}), ...(payload.seconds ? { seconds: String(payload.seconds) } : {}) }), redirect: "error", credentials: "omit", signal: controller.signal });
      if (!createResponse.ok) {
        await createResponse.body?.cancel?.().catch(() => {});
        fail("MEDIA_PROVIDER_REJECTED", `视频服务返回错误（HTTP ${Number.isInteger(createResponse.status) ? createResponse.status : "未知"}）。请检查模型、额度及服务记录；系统不会自动重试。`, 502);
      }
      let job = await boundedJson(createResponse, controller.signal);
      if (typeof job?.id !== "string" || !job.id || typeof job.status !== "string") fail("MEDIA_INVALID_RESPONSE", "视频服务没有返回有效的生成任务。", 502);
      while (job.status !== "completed" && job.status !== "failed") {
        if (Date.now() + this.videoPollIntervalMs > deadline) fail("MEDIA_GENERATION_TIMEOUT", "视频生成等待超时，任务可能仍在服务端进行。请检查服务记录；系统不会自动重试。", 504);
        await sleep(this.videoPollIntervalMs);
        const pollResponse = await this.fetchImpl(`${profile.baseUrl}/videos/${encodeURIComponent(job.id)}`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", credentials: "omit", signal: controller.signal });
        if (!pollResponse.ok) {
          await pollResponse.body?.cancel?.().catch(() => {});
          fail("MEDIA_PROVIDER_REJECTED", `视频任务查询返回错误（HTTP ${Number.isInteger(pollResponse.status) ? pollResponse.status : "未知"}）。请检查服务记录；系统不会自动重试。`, 502);
        }
        job = await boundedJson(pollResponse, controller.signal);
        if (typeof job?.status !== "string") fail("MEDIA_INVALID_RESPONSE", "视频服务返回了无效的任务状态。", 502);
      }
      if (job.status === "failed") fail("MEDIA_GENERATION_FAILED", "视频服务报告生成失败。请检查提示词与服务记录；系统不会自动重试。", 502);
      const contentResponse = await this.fetchImpl(`${profile.baseUrl}/videos/${encodeURIComponent(job.id)}/content`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", credentials: "omit", signal: controller.signal });
      if (!contentResponse.ok) {
        await contentResponse.body?.cancel?.().catch(() => {});
        fail("MEDIA_PROVIDER_REJECTED", `视频结果下载返回错误（HTTP ${Number.isInteger(contentResponse.status) ? contentResponse.status : "未知"}）。请检查服务记录；系统不会自动重试。`, 502);
      }
      const buffer = await boundedBuffer(contentResponse, MAX_VIDEO_BYTES, controller.signal);
      const mime = videoMime(buffer, contentResponse.headers?.get?.("content-type"));
      if (!mime) fail("MEDIA_INVALID_RESPONSE", "视频服务没有返回有效的MP4或WebM视频。", 502);
      return { buffer, mime, model: profile.model };
    } catch (error) {
      if (error instanceof MediaModelServiceError) throw error;
      if (controller.signal.aborted) fail("MEDIA_GENERATION_TIMEOUT", "视频请求超时，可能已提交。请先检查服务记录；系统不会自动重试。", 504);
      fail("MEDIA_GENERATION_FAILED", "视频请求未完成，可能已提交。请检查网络及服务记录后再决定是否新建请求；系统不会自动重试。", 502);
    } finally { clearTimeout(timer); }
  }
}

module.exports = { MediaModelService, MediaModelServiceError, IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS };
