"use strict";

// The upstream cloud server is deliberately not loaded here. This adapter owns
// only local canvas documents and calls a host-injected provider on submission.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { MediaModelServiceError, IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS } = require("./media-model-service.cjs");
const { createLoomicLocalAgent } = require("./loomic-local-agent.cjs");
const { Readable } = require("node:stream");

const JSON_LIMIT = 50 * 1024 * 1024;
const MEDIA_LIMIT = 25 * 1024 * 1024;
const VIDEO_LIMIT = 100 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const VIDEO_SIZES = new Set(["1280x720", "720x1280", "1920x1080", "1080x1920", "3840x2160", "2160x3840"]);
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };

class LoomicLocalError extends Error {
  constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; }
}
const fail = (status, code, message) => { throw new LoomicLocalError(status, code, message); };
const clone = (value) => structuredClone(value);
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function requiredText(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail(400, "invalid_request", `${name}格式无效。`);
  return value.trim();
}
function safeEqual(a, b) {
  if (typeof a !== "string") return false;
  const candidate = Buffer.from(a); const expected = Buffer.from(b);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function scopeHash(id) { return createHash("sha256").update(id).digest("hex").slice(0, 32); }
function inside(root, target) { const rel = path.relative(root, target); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
async function readBody(request, limit = JSON_LIMIT) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) fail(415, "invalid_request", "请发送 JSON 请求。");
  if (Number(request.headers["content-length"]) > limit) fail(413, "request_too_large", "内容超过本机保存上限。");
  const parts = []; let size = 0;
  for await (const part of request) { size += part.length; if (size > limit) fail(413, "request_too_large", "内容超过本机保存上限。"); parts.push(part); }
  try { const body = JSON.parse(Buffer.concat(parts).toString("utf8")); if (!isRecord(body)) throw new Error(); return body; }
  catch { fail(400, "invalid_request", "JSON 内容无效。"); }
}
function validateContent(content) {
  if (!isRecord(content) || !Array.isArray(content.elements) || !content.elements.every(isRecord) || !isRecord(content.appState) || !isRecord(content.files ?? {})) fail(400, "invalid_request", "画布内容格式无效，原文件未修改。");
  return { elements: content.elements, appState: content.appState, files: content.files ?? {} };
}
function sanitizeProvider(status = {}) {
  return { configured: status.configured === true, canGenerate: status.canGenerate === true || status.configured === true, baseUrl: typeof status.baseUrl === "string" ? status.baseUrl : "", model: typeof status.model === "string" ? status.model : "", defaultProfileId: typeof status.defaultProfileId === "string" ? status.defaultProfileId : "", profiles: Array.isArray(status.profiles) ? status.profiles.map((p) => ({ id: p.id, name: p.name, model: p.model, configured: p.configured === true, enabled: p.enabled !== false })) : [], storage: "local" };
}
function imageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
function videoMime(buffer, declared) {
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  if (declared === "video/mp4" || declared === "video/webm") return declared;
  return null;
}

function createLoomicLocalService(options = {}) {
  if (!options.dataDir) throw new Error("Loomic local dataDir is required.");
  const dataRoot = path.resolve(options.dataDir, "ai-design-v1");
  const staticRoot = options.staticRoot ? path.resolve(options.staticRoot) : null;
  const token = randomBytes(32).toString("hex");
  const cookieName = `loomic_${randomBytes(8).toString("hex")}`;
  const scopes = new Map();
  const scopeLoads = new Map();
  const generationRequests = new Map();
  const generatingScopes = new Set();
  const generatingVideoScopes = new Set();
  let server = null; let baseUrl = ""; let activeHubId = "local-workspace"; let activeHubName = "AI Design 本机空间";

  // Durable references contain only local media IDs. Session capabilities are
  // attached at serialization time and never written into project/chat files.
  function hydrateMedia(value) {
    if (typeof value === "string") {
      const match = value.match(/^\/api\/local\/media\/(m-([a-f0-9]{32})-[a-f0-9-]{36})$/);
      if (!match) return value;
      const scope = [...scopes.values()].find((s) => s.key === match[2]);
      return scope ? `${value}?${new URLSearchParams({ cap: token, hubProjectId: scope.state.hubProjectId })}` : value;
    }
    if (Array.isArray(value)) return value.map(hydrateMedia);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrateMedia(item)]));
    return value;
  }
  const mediaUrl = (id) => `/api/local/media/${id}`;
  function canonicalMedia(value) {
    if (typeof value === "string") { const match = value.match(/^(?:http:\/\/127\.0\.0\.1:\d+)?(\/api\/local\/media\/m-[a-f0-9]{32}-[a-f0-9-]{36})(?:\?[^\s]*)?$/); return match ? match[1] : value; }
    if (Array.isArray(value)) return value.map(canonicalMedia);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalMedia(item)]));
    return value;
  }
  async function generateLocal(scope, body) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.headers = { "content-type": "application/json", "x-loomic-project": scope.state.hubProjectId };
    let status; let payload;
    await generate(request, { writeHead(code) { status = code; }, end(source) { payload = JSON.parse(source); } });
    if (status >= 400) fail(status, payload.error.code, payload.error.message);
    return payload;
  }
  async function generateVideoLocal(scope, body) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.headers = { "content-type": "application/json", "x-loomic-project": scope.state.hubProjectId };
    let status; let payload;
    await generateVideo(request, { writeHead(code) { status = code; }, end(source) { payload = JSON.parse(source); } });
    if (status >= 400) fail(status, payload.error.code, payload.error.message);
    return payload;
  }
  const agent = createLoomicLocalAgent({ options, getScope, scopeForResource, mutate, requiredText, fail, json, readBody, requestHubId, generateLocal, generateVideoLocal, mediaUrl, hydrateMedia, authenticate, getBaseUrl: () => baseUrl });

  async function getScope(hubId = activeHubId, hubName) {
    hubId = requiredText(hubId, "Hub项目ID");
    // The host's active project can change while this service and its capability
    // remain alive. Cached documents never bypass current host authorization.
    if (options.getProject) {
      const hubProject = await options.getProject(hubId);
      if (!hubProject) fail(404, "project_not_found", "Hub项目不存在或已不在当前项目范围内。");
      hubName = hubProject.name || hubName;
    }
    if (scopes.has(hubId)) return scopes.get(hubId);
    if (scopeLoads.has(hubId)) return scopeLoads.get(hubId);
    const pending = loadScope(hubId, hubName);
    scopeLoads.set(hubId, pending);
    try { return await pending; } finally { scopeLoads.delete(hubId); }
  }
  async function loadScope(hubId, hubName) {
    const key = scopeHash(hubId); const dir = path.join(dataRoot, "projects", key); const file = path.join(dir, "workspace.json");
    let state;
    try {
      state = JSON.parse(await fs.readFile(file, "utf8"));
      if (state.version !== 1 || state.hubProjectId !== hubId || !Array.isArray(state.projects) || !isRecord(state.canvases)) throw new Error("invalid state");
    } catch (error) {
      if (error.code !== "ENOENT") fail(500, "local_data_invalid", "本机画布数据读取失败。原文件已保留，请先备份后检查。");
      state = { version: 1, hubProjectId: hubId, hubProjectName: hubName || activeHubName, projects: [], canvases: {}, media: {} };
    }
    const scope = { key, dir, file, state, tail: Promise.resolve() }; scopes.set(hubId, scope); return scope;
  }
  async function mutate(scope, fn) {
    const task = scope.tail.then(async () => {
      const next = clone(scope.state); const result = await fn(next); const durable = canonicalMedia(next); await atomicJson(scope.file, durable); scope.state = durable; return canonicalMedia(result);
    });
    scope.tail = task.catch(() => {}); return task;
  }
  function projectShape(project) {
    return { ...project, canvasId: project.canvasId, defaultCanvasId: project.canvasId, slug: project.id, description: null, brand_kit_id: project.brandKitId ?? null, workspace: { id: "local", name: "本机工作空间", type: "personal", ownerUserId: "local-user" }, primaryCanvas: { id: project.canvasId, name: project.name, isPrimary: true } };
  }
  async function createProject(scope, input) {
    const name = requiredText(input.name, "画布名称", 100); const now = new Date().toISOString();
    const id = `p-${scope.key}-${randomUUID()}`; const canvasId = `c-${scope.key}-${randomUUID()}`;
    const project = { id, name, canvasId, createdAt: now, updatedAt: now };
    await mutate(scope, (state) => { state.projects.push(project); state.canvases[canvasId] = { id: canvasId, name, projectId: id, content: { elements: [], appState: {}, files: {} } }; });
    return { project: projectShape(project), canvas: { id: canvasId, name, projectId: id } };
  }
  async function scopeForResource(id, prefix, hubId = activeHubId) {
    const match = typeof id === "string" && id.match(new RegExp(`^${prefix}-([a-f0-9]{32})-[a-f0-9-]{36}$`));
    if (!match) fail(404, "project_not_found", "本机画布不存在。");
    if (scopeHash(requiredText(hubId, "Hub项目ID")) !== match[1]) fail(404, "project_not_found", "此画布不属于当前Hub项目。");
    const scope = await getScope(hubId);
    if (scope.key === match[1]) return scope;
    // A resource is accessible only after the host opens its Hub project.
    fail(404, "project_not_found", "请从对应的Hub项目打开本机画布。");
  }
  async function providerStatus() { return sanitizeProvider(options.provider ? await options.provider.status() : {}); }
  async function videoProviderStatus() { return sanitizeProvider(options.videoProvider ? await options.videoProvider.status() : {}); }
  function json(reply, status, value) {
    reply.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); reply.end(JSON.stringify(hydrateMedia(value)));
  }
  function authenticate(request, explicitCapability) {
    const cookie = String(request.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`));
    const candidate = explicitCapability || request.headers["x-loomic-token"] || (cookie ? cookie.slice(cookieName.length + 1) : "");
    if (!safeEqual(candidate, token)) fail(401, "unauthorized", "请从Hub重新打开AI Design。");
  }
  function requestHubId(request, url) { return request.headers["x-loomic-project"] || url.searchParams.get("hubProjectId") || url.searchParams.get("projectId") || activeHubId; }
  async function serveStatic(request, reply, url) {
    if (!staticRoot) fail(503, "canvas_not_built", "Loomic本机画布尚未构建，请先运行构建脚本。");
    let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { fail(400, "invalid_request", "路径无效。"); }
    if (decoded.includes("\0") || decoded.includes("\\")) fail(400, "invalid_request", "路径无效。");
    const target = path.resolve(staticRoot, `.${decoded === "/" ? "/hub/" : decoded}`);
    if (!inside(staticRoot, target)) fail(403, "forbidden", "路径不可访问。");
    const candidates = path.extname(target) ? [target] : [path.join(target, "index.html"), `${target}.html`];
    for (const candidate of candidates) {
      try {
        const actual = await fs.realpath(candidate); const actualRoot = await fs.realpath(staticRoot);
        if (!inside(actualRoot, actual)) fail(403, "forbidden", "路径不可访问。");
        const stat = await fs.stat(actual); if (!stat.isFile()) continue;
        reply.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(actual).toLowerCase()] || "application/octet-stream", "Cache-Control": path.extname(actual) === ".html" ? "no-store" : "public, max-age=3600" });
        reply.end(request.method === "HEAD" ? undefined : await fs.readFile(actual)); return;
      } catch (error) { if (error instanceof LoomicLocalError) throw error; if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    }
    fail(404, "not_found", "本机页面不存在。");
  }
  async function generate(request, reply) {
    const body = await readBody(request, 64 * 1024);
    const prompt = requiredText(body.prompt, "生图描述", 12000);
    const requestId = requiredText(body.requestId, "请求ID", 120);
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail(400, "invalid_request", "请求ID格式无效。");
    const scope = body.canvasId ? await scopeForResource(body.canvasId, "c", request.headers["x-loomic-project"] || activeHubId) : await getScope(request.headers["x-loomic-project"] || activeHubId);
    if (body.canvasId && !scope.state.canvases[body.canvasId]) fail(404, "canvas_not_found", "画布不存在。");
    const dedupeKey = `${scope.key}:${requestId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({ prompt, profileId: body.profileId, model: body.model, size: body.size, canvasId: body.canvasId, referenceImageIds: body.referenceImageIds, aspectRatio: body.aspectRatio, resolution: body.resolution })).digest("hex");
    if (generationRequests.has(dedupeKey)) {
      const previous = generationRequests.get(dedupeKey);
      if (previous.fingerprint !== fingerprint) fail(409, "request_conflict", "此请求ID已使用，请发起新的请求。");
      const result = await previous.promise; return json(reply, result.status, result.body);
    }
    const persisted = scope.state.generationRequests?.[requestId];
    if (persisted) {
      if (persisted.fingerprint !== fingerprint) fail(409, "request_conflict", "此请求ID已使用，请发起新的请求。");
      if (persisted.result) return json(reply, persisted.result.status, persisted.result.body);
      fail(409, "generation_outcome_unknown", "此请求曾提交，结果尚未确认。请先检查模型服务记录；系统不会重复提交。");
    }
    const providerState = await providerStatus();
    const requestedModel = body.profileId || body.model;
    const selectedProfile = requestedModel ? providerState.profiles.find((p) => p.id === requestedModel && p.configured) || providerState.profiles.find((p) => p.model === requestedModel && p.configured && p.id === providerState.defaultProfileId) || providerState.profiles.find((p) => p.model === requestedModel && p.configured) : null;
    if (!options.provider || (requestedModel ? !selectedProfile : !providerState.configured)) fail(503, "provider_not_configured", requestedModel ? "所选图片模型没有对应的已启用本机配置，请在统一设置中核对。没有调用其他模型。" : "请先在统一设置中配置并启用图片模型。此操作不会使用网站积分。");
    if (generatingScopes.has(scope.key)) fail(409, "generation_in_progress", "当前项目已有生图请求处理中，请等待结果。");
    if (generationRequests.size >= 1000) fail(429, "session_request_limit", "本次本机服务已达请求记录上限，请重新打开工作台后再试。");
    if (body.model != null) requiredText(body.model, "模型", 200);
    if (body.profileId != null) requiredText(body.profileId, "模型配置ID", 100);
    let referenceImages;
    if (body.referenceImageIds != null) {
      if (!Array.isArray(body.referenceImageIds) || body.referenceImageIds.length < 1 || body.referenceImageIds.length > 4) fail(400, "invalid_request", "图片编辑需要1至4张当前画布或本机素材图片。");
      referenceImages = []; let totalBytes = 0;
      for (const reference of body.referenceImageIds) {
        const id = requiredText(reference, "参考图片ID", 200);
        const content = body.canvasId ? scope.state.canvases[body.canvasId].content : null;
        const element = content?.elements.find((e) => e.id === id && e.type === "image" && !e.isDeleted);
        const file = content?.files[element?.fileId || id];
        let dataUrl; let mime;
        if (file && typeof file.dataURL === "string") { dataUrl = file.dataURL; mime = file.mimeType; }
        else if (/^m-[a-f0-9]{32}-[a-f0-9-]{36}$/.test(id) && id.startsWith(`m-${scope.key}-`) && scope.state.media?.[id]) { mime = scope.state.media[id].mimeType; const mediaRoot = await fs.realpath(path.join(scope.dir, "media")); const file = await fs.realpath(path.join(mediaRoot, id)); if (!inside(mediaRoot, file)) fail(403, "forbidden", "参考图片路径不可访问。"); const bytes = await fs.readFile(file); dataUrl = `data:${mime};base64,${bytes.toString("base64")}`; }
        else fail(404, "asset_not_found", "参考图片不在当前画布或项目本机素材中。");
        const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) fail(400, "invalid_request", "参考图片格式无效。");
        const bytes = Buffer.from(match[2], "base64"); totalBytes += bytes.length;
        if (bytes.length > MEDIA_LIMIT || totalBytes > 50 * 1024 * 1024 || imageMime(bytes) !== match[1]) fail(413, "request_too_large", "参考图片每张最多25MB、合计最多50MB，且必须是有效图片。");
        referenceImages.push({ dataUrl, mime: mime || match[1] });
      }
    }
    if (body.size != null && !["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "512x512", "256x256"].includes(body.size)) fail(400, "invalid_request", "不支持的图像尺寸。");
    if (body.aspectRatio != null && !IMAGE_ASPECT_RATIOS.has(body.aspectRatio)) fail(400, "invalid_request", "不支持的图片画幅。");
    if (body.resolution != null && !IMAGE_RESOLUTIONS.has(body.resolution)) fail(400, "invalid_request", "不支持的图片分辨率。");
    const operation = (async () => {
      generatingScopes.add(scope.key);
      try {
        // Journal before submitting. A process crash must not turn a retry into
        // a second billable call with the same request ID.
        await mutate(scope, (state) => { state.generationRequests ??= {}; state.generationRequests[requestId] = { fingerprint, input: { prompt, profileId: body.profileId || "", model: body.model || "", size: body.size || "", canvasId: body.canvasId || "", ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}), ...(body.resolution ? { resolution: body.resolution } : {}) }, status: "submitted", createdAt: new Date().toISOString() }; });
        const result = await options.provider.generate({ prompt, ...(selectedProfile ? { profileId: selectedProfile.id } : {}), ...(body.model ? { model: body.model } : {}), ...(body.size ? { size: body.size } : {}), ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}), ...(body.resolution ? { resolution: body.resolution } : {}), ...(referenceImages ? { referenceImages } : {}), n: 1 });
        const buffer = result.buffer; const mime = result.mime || result.mimeType;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MEDIA_LIMIT || !IMAGE_TYPES.has(mime) || imageMime(buffer) !== mime) fail(502, "generation_failed", "生图服务未返回有效的PNG、JPEG或WebP图片，请检查服务记录。不会自动重试。");
        const mediaId = `m-${scope.key}-${randomUUID()}`; const file = path.join(scope.dir, "media", mediaId);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, buffer, { mode: 0o600, flag: "wx" });
        try { await mutate(scope, (state) => { state.media ??= {}; state.media[mediaId] = { mimeType: mime, model: result.model || body.model || "", createdAt: new Date().toISOString() }; }); }
        catch (error) { await fs.rm(file, { force: true }).catch(() => {}); throw error; }
        return { status: 200, body: { requestId, images: [{ url: `/api/local/media/${mediaId}`, mimeType: mime, model: result.model || body.model || "" }] } };
      } catch (error) {
        // Keep failed request IDs: retrying the same request never repeats a paid call.
        const status = error instanceof LoomicLocalError ? error.statusCode : Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 502;
        const known = error instanceof LoomicLocalError || error instanceof MediaModelServiceError;
        return { status, body: { requestId, error: { code: known ? error.code : "generation_failed", message: known ? error.message : "生图请求未完成，可能已提交到模型服务。请检查服务记录后再决定是否新建请求；系统不会自动重试。" } } };
      } finally { generatingScopes.delete(scope.key); }
    })();
    generationRequests.set(dedupeKey, { fingerprint, promise: operation });
    const result = await operation;
    await mutate(scope, (state) => { if (state.generationRequests?.[requestId]) state.generationRequests[requestId].result = result; });
    return json(reply, result.status, result.body);
  }
  async function generateVideo(request, reply) {
    const body = await readBody(request, 64 * 1024);
    const prompt = requiredText(body.prompt, "视频描述", 12000);
    const requestId = requiredText(body.requestId, "请求ID", 120);
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail(400, "invalid_request", "请求ID格式无效。");
    const scope = body.canvasId ? await scopeForResource(body.canvasId, "c", request.headers["x-loomic-project"] || activeHubId) : await getScope(request.headers["x-loomic-project"] || activeHubId);
    if (body.canvasId && !scope.state.canvases[body.canvasId]) fail(404, "canvas_not_found", "画布不存在。");
    const dedupeKey = `video:${scope.key}:${requestId}`;
    const journalKey = `video:${requestId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({ kind: "video", prompt, profileId: body.profileId, model: body.model, size: body.size, seconds: body.seconds, canvasId: body.canvasId })).digest("hex");
    if (generationRequests.has(dedupeKey)) {
      const previous = generationRequests.get(dedupeKey);
      if (previous.fingerprint !== fingerprint) fail(409, "request_conflict", "此请求ID已使用，请发起新的请求。");
      const result = await previous.promise; return json(reply, result.status, result.body);
    }
    const persisted = scope.state.generationRequests?.[journalKey];
    if (persisted) {
      if (persisted.fingerprint !== fingerprint) fail(409, "request_conflict", "此请求ID已使用，请发起新的请求。");
      if (persisted.result) return json(reply, persisted.result.status, persisted.result.body);
      fail(409, "generation_outcome_unknown", "此请求曾提交，结果尚未确认。请先检查模型服务记录；系统不会重复提交。");
    }
    const videoState = await videoProviderStatus();
    const requestedModel = body.profileId || body.model;
    if (requestedModel != null) requiredText(requestedModel, "模型配置", 200);
    const selectedProfile = requestedModel ? videoState.profiles.find((p) => p.id === requestedModel && p.configured) || videoState.profiles.find((p) => p.model === requestedModel && p.configured && p.id === videoState.defaultProfileId) || videoState.profiles.find((p) => p.model === requestedModel && p.configured) : null;
    if (!options.videoProvider || (requestedModel ? !selectedProfile : !videoState.configured)) fail(503, "provider_not_configured", requestedModel ? "所选视频模型没有对应的已启用本机配置，请在Hub统一设置中核对。没有调用其他模型。" : "请先在Hub统一设置中配置并启用视频模型。此操作不会使用网站积分。");
    if (generatingVideoScopes.has(scope.key)) fail(409, "generation_in_progress", "当前项目已有视频生成请求处理中，请等待结果。");
    if (generationRequests.size >= 1000) fail(429, "session_request_limit", "本次本机服务已达请求记录上限，请重新打开工作台后再试。");
    if (body.size != null && !VIDEO_SIZES.has(body.size)) fail(400, "invalid_request", "不支持的视频尺寸。");
    if (body.seconds != null && (!Number.isInteger(body.seconds) || body.seconds < 1 || body.seconds > 60)) fail(400, "invalid_request", "视频时长需为1至60秒的整数。");
    const operation = (async () => {
      generatingVideoScopes.add(scope.key);
      try {
        // Journal before submitting, same guarantee as image generation.
        await mutate(scope, (state) => { state.generationRequests ??= {}; state.generationRequests[journalKey] = { fingerprint, input: { kind: "video", prompt, profileId: body.profileId || "", model: body.model || "", size: body.size || "", seconds: body.seconds ?? null, canvasId: body.canvasId || "" }, status: "submitted", createdAt: new Date().toISOString() }; });
        const result = await options.videoProvider.generate({ prompt, ...(selectedProfile ? { profileId: selectedProfile.id } : {}), ...(body.size ? { size: body.size } : {}), ...(body.seconds != null ? { seconds: body.seconds } : {}) });
        const buffer = result.buffer; const mime = result.mime || result.mimeType;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > VIDEO_LIMIT || !VIDEO_TYPES.has(mime) || videoMime(buffer, mime) !== mime) fail(502, "generation_failed", "视频服务未返回有效的MP4或WebM视频，请检查服务记录。不会自动重试。");
        const mediaId = `m-${scope.key}-${randomUUID()}`; const file = path.join(scope.dir, "media", mediaId);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, buffer, { mode: 0o600, flag: "wx" });
        try { await mutate(scope, (state) => { state.media ??= {}; state.media[mediaId] = { mimeType: mime, kind: "video", model: result.model || body.model || "", createdAt: new Date().toISOString() }; }); }
        catch (error) { await fs.rm(file, { force: true }).catch(() => {}); throw error; }
        return { status: 200, body: { requestId, videos: [{ url: `/api/local/media/${mediaId}`, mimeType: mime, model: result.model || body.model || "" }] } };
      } catch (error) {
        const status = error instanceof LoomicLocalError ? error.statusCode : Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 502;
        const known = error instanceof LoomicLocalError || error instanceof MediaModelServiceError;
        return { status, body: { requestId, error: { code: known ? error.code : "generation_failed", message: known ? error.message : "视频生成请求未完成，可能已提交到模型服务。请检查服务记录后再决定是否新建请求；系统不会自动重试。" } } };
      } finally { generatingVideoScopes.delete(scope.key); }
    })();
    generationRequests.set(dedupeKey, { fingerprint, promise: operation });
    const result = await operation;
    await mutate(scope, (state) => { if (state.generationRequests?.[journalKey]) state.generationRequests[journalKey].result = result; });
    return json(reply, result.status, result.body);
  }
  async function handle(request, reply) {
    reply.setHeader("X-Content-Type-Options", "nosniff"); reply.setHeader("Referrer-Policy", "no-referrer");
    reply.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self' ${baseUrl.replace(/^http/, "ws")}; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'`);
    const origin = new URL(baseUrl); if (request.headers.host !== origin.host) fail(403, "forbidden", "只允许本机地址访问。");
    if (request.headers.origin && request.headers.origin !== baseUrl) fail(403, "forbidden", "只允许本机画布页面请求。");
    if (request.headers["sec-fetch-site"] === "cross-site" && request.url.startsWith("/api/")) fail(403, "forbidden", "外部页面不可读取本机画布。");
    const url = new URL(request.url, baseUrl); const route = url.pathname; const method = request.method;
    if (route === "/__hub/open" && method === "GET") {
      if (!safeEqual(url.searchParams.get("cap"), token)) fail(401, "unauthorized", "打开凭据无效。");
      const hubId = url.searchParams.get("projectId") || activeHubId; await getScope(hubId, url.searchParams.get("projectName"));
      const params = new URLSearchParams({ projectId: hubId, projectName: url.searchParams.get("projectName") || activeHubName });
      params.set("v", Date.now().toString(36));
      reply.writeHead(302, { "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: `/hub/?${params}#loomic-cap=${token}`, "Cache-Control": "no-store" }); reply.end(); return;
    }
    if (!route.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(method)) fail(405, "method_not_allowed", "不支持此方法。");
      return serveStatic(request, reply, url);
    }
    authenticate(request, route.startsWith("/api/local/media/") ? url.searchParams.get("cap") : undefined);
    if (await agent.handleHttp(request, reply, url)) return;
    if (route === "/api/local/context" && method === "GET") {
      const scope = await getScope(requestHubId(request, url)); const status = await providerStatus(); const text = await agent.chatStatus(); const video = await videoProviderStatus();
      return json(reply, 200, { projectId: scope.state.hubProjectId, projectName: scope.state.hubProjectName, storage: "local", mode: "local", capabilities: { canvas: true, textGeneration: text.configured, imageGeneration: status.configured, imageEditing: status.configured, videoGeneration: video.configured }, models: text.models, notice: "画布与素材保存在本机。AI使用Hub统一模型配置，不连接BYCJ网站或消耗网站积分。" });
    }
    if (route === "/api/local/provider") {
      if (method === "GET") return json(reply, 200, await providerStatus());
      if (["PUT", "POST"].includes(method)) {
        if (!options.provider?.saveConfig) fail(503, "provider_not_configured", "当前宿主未接入生图服务配置。");
        const body = await readBody(request, 32 * 1024); await options.provider.saveConfig(body); return json(reply, 200, await providerStatus());
      }
    }
    if (route === "/api/local/generate" && method === "POST") return generate(request, reply);
    if (route === "/api/local/generate-video" && method === "POST") return generateVideo(request, reply);
    if (route.startsWith("/api/local/media/") && method === "GET") {
      const id = route.slice("/api/local/media/".length); const scope = await scopeForResource(id, "m", requestHubId(request, url)); const media = scope.state.media?.[id];
      if (!media) fail(404, "asset_not_found", "本机素材不存在。");
      const file = path.join(scope.dir, "media", id); const actual = await fs.realpath(file); if (!inside(await fs.realpath(path.join(scope.dir, "media")), actual)) fail(403, "forbidden", "素材路径不可访问。");
      reply.writeHead(200, { "Content-Type": media.mimeType, "Cache-Control": "private, max-age=3600" }); reply.end(await fs.readFile(actual)); return;
    }
    if (route === "/api/projects") {
      const body = method === "POST" ? await readBody(request, 16 * 1024) : null;
      const scope = await getScope(body?.hubProjectId || requestHubId(request, url));
      if (method === "GET") return json(reply, 200, { projects: scope.state.projects.filter((p) => !p.archivedAt).map(projectShape) });
      if (method === "POST") return json(reply, 201, await createProject(scope, body));
    }
    const projectMatch = route.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const id = projectMatch[1]; const scope = await scopeForResource(id, "p", requestHubId(request, url)); const project = scope.state.projects.find((p) => p.id === id && !p.archivedAt);
      if (!project) fail(404, "project_not_found", "本机设计画布不存在。");
      if (method === "GET") return json(reply, 200, { project: projectShape(project) });
      if (method === "PATCH") {
        const body = await readBody(request, 16 * 1024);
        if (body.name == null && body.brand_kit_id === undefined) fail(400, "invalid_request", "请提供要更新的画布字段。");
        await mutate(scope, (state) => {
          const row = state.projects.find((p) => p.id === id);
          if (body.name != null) { row.name = requiredText(body.name, "画布名称", 100); state.canvases[row.canvasId].name = row.name; }
          if (body.brand_kit_id !== undefined) {
            if (body.brand_kit_id != null && typeof body.brand_kit_id !== "string") fail(400, "invalid_request", "风格套件ID格式无效。");
            if (body.brand_kit_id && !state.brandKits?.[body.brand_kit_id]) fail(404, "brand_kit_not_found", "风格套件不存在。");
            row.brandKitId = body.brand_kit_id || null;
          }
          row.updatedAt = new Date().toISOString();
        });
        return json(reply, 200, { ok: true });
      }
      if (method === "DELETE") { await mutate(scope, (state) => { state.projects.find((p) => p.id === id).archivedAt = new Date().toISOString(); }); reply.writeHead(204); reply.end(); return; }
    }
    const imageGenerationsMatch = route.match(/^\/api\/canvases\/([^/]+)\/image-generations$/);
    if (imageGenerationsMatch && method === "GET") {
      const id = imageGenerationsMatch[1]; const scope = await scopeForResource(id, "c", requestHubId(request, url));
      if (!scope.state.canvases[id] || scope.state.projects.find(p => p.canvasId === id)?.archivedAt) fail(404, "canvas_not_found", "本机画布不存在。");
      const generations = Object.entries(scope.state.generationRequests || {}).filter(([key, entry]) => !key.startsWith("video:") && entry.input?.canvasId === id).slice(-100).map(([requestId, entry]) => ({
        requestId, prompt: entry.input.prompt, profileId: entry.input.profileId, createdAt: entry.createdAt,
        status: entry.result ? (entry.result.status === 200 ? "completed" : "failed") : generationRequests.has(`${scope.key}:${requestId}`) ? "generating" : "unknown",
        ...(entry.result?.status === 200 ? { images: entry.result.body.images } : {}),
        ...(entry.result?.body?.error ? { error: entry.result.body.error } : {}),
      }));
      return json(reply, 200, { generations });
    }
    const canvasMatch = route.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasMatch) {
      const id = canvasMatch[1]; const scope = await scopeForResource(id, "c", requestHubId(request, url)); const canvas = scope.state.canvases[id];
      if (!canvas || scope.state.projects.find((p) => p.canvasId === id)?.archivedAt) fail(404, "canvas_not_found", "本机画布不存在。");
      if (method === "GET") return json(reply, 200, { canvas });
      if (method === "PUT") {
        const body = await readBody(request); const content = validateContent(body.content);
        await mutate(scope, (state) => { state.canvases[id].content = content; state.projects.find((p) => p.id === canvas.projectId).updatedAt = new Date().toISOString(); });
        return json(reply, 200, { ok: true });
      }
    }
    if (route === "/api/health" && method === "GET") return json(reply, 200, { ok: true, service: "loomic-local", storage: "local" });
    if (route === "/api/image-models" && method === "GET") { await getScope(requestHubId(request, url)); const status = await providerStatus(); return json(reply, 200, { models: status.profiles.filter((p) => p.configured).map((p) => ({ id: p.id, name: p.name, displayName: p.name, description: `本机统一配置 · ${p.model}`, provider: "hub", accessible: true })) }); }
    if (route.startsWith("/api/payments") || route.startsWith("/api/credits") || route.startsWith("/api/agent") || route.startsWith("/api/generate")) fail(503, "cloud_feature_disabled", "本机版未启用云账号、网站积分或云端Agent。");
    fail(404, "not_found", "本机接口不存在。");
  }
  function getStatus() { return { running: !!server?.listening, baseUrl, dataDir: dataRoot, storage: "local", mode: "local" }; }
  async function open(input = {}) {
    if (!server?.listening) throw new Error("Loomic local service is not started.");
    activeHubId = requiredText(input.projectId || activeHubId, "Hub项目ID"); activeHubName = input.projectName || activeHubName;
    const scope = await getScope(activeHubId, activeHubName);
    if (!scope.state.projects.some((p) => !p.archivedAt)) await createProject(scope, { name: "未命名设计" });
    const params = new URLSearchParams({ cap: token, projectId: activeHubId, projectName: scope.state.hubProjectName });
    return { ...getStatus(), url: `${baseUrl}/__hub/open?${params}`, projectId: activeHubId };
  }
  async function start(input = {}) {
    if (!server) {
      server = http.createServer((request, reply) => { handle(request, reply).catch((error) => {
        if (reply.headersSent) { reply.destroy(); return; }
        const known = error instanceof LoomicLocalError || error instanceof MediaModelServiceError;
        json(reply, known ? error.statusCode : 500, { error: { code: known ? error.code : "local_error", message: known ? error.message : "本机操作失败，原画布文件已保留。" } });
      }); });
      server.requestTimeout = 6 * 60 * 1000; server.headersTimeout = 15000;
      agent.attach(server);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: input.port ?? 0 }, () => { server.removeListener("error", reject); resolve(); }); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    }
    return open(input);
  }
  async function stop() { if (!server) return; const current = server; server = null; await agent.close(); await new Promise((resolve) => { current.close(resolve); current.closeIdleConnections(); }); baseUrl = ""; }
  return { start, open, stop, getStatus };
}

module.exports = { createLoomicLocalService, LoomicLocalError };
