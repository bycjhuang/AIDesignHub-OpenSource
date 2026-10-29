"use strict";

// Implements Loomic's existing REST/WS contract against local documents. The
// upstream Supabase/LangGraph implementation remains untouched for cloud mode.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { validateRasterImage } = require("./public-page.cjs");

const now = () => new Date().toISOString();
const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v, fallback = 0) => Number.isFinite(v) && Math.abs(v) <= 1000000 ? v : fallback;
function elementBase(type) { return { id: randomUUID(), type, x: 0, y: 0, width: 100, height: 100, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: [], index: null, seed: Math.floor(Math.random() * 2000000000), version: 1, versionNonce: Math.floor(Math.random() * 2000000000), isDeleted: false, updated: Date.now(), link: null, locked: false }; }
const TOOLS = [
  { type: "function", function: { name: "inspect_canvas", description: "读取当前画布元素及文字、位置、尺寸；可按element_id或filter_type筛选。", parameters: { type: "object", properties: { detail_level: { type: "string", enum: ["summary", "full"] }, element_id: { type: "string" }, filter_type: { type: "array", items: { type: "string" } } } } } },
  { type: "function", function: { name: "manipulate_canvas", description: "编辑当前画布，操作支持move/resize/delete/update_style/add_text/add_shape/add_line/reorder/align/distribute/update_text。坐标、大小、样式直接作为操作字段。", parameters: { type: "object", required: ["operations"], properties: { operations: { type: "array", maxItems: 100, items: { type: "object", required: ["action"], properties: { action: { type: "string" }, element_id: { type: "string" }, element_ids: { type: "array", items: { type: "string" } }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, text: { type: "string" }, shape: { type: "string", enum: ["rectangle", "ellipse", "diamond"] }, fontSize: { type: "number" }, strokeColor: { type: "string" }, backgroundColor: { type: "string" }, opacity: { type: "number" }, strokeWidth: { type: "number" }, fillStyle: { type: "string" }, line_type: { type: "string", enum: ["line", "arrow"] }, points: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } }, label: { type: "object", properties: { text: { type: "string" }, fontSize: { type: "number" } } }, position: { type: "string", enum: ["front", "back"] }, alignment: { type: "string" }, direction: { type: "string" } } } } } } } },
  ...["generate_image", "edit_image"].map((name) => ({ type: "function", function: { name, description: name === "generate_image" ? "使用Hub统一配置生成一张图并放入当前画布。也可用referenceImageIds编辑现有图片。仅用户要求生成或编辑时调用。" : "编辑当前画布中已有图片；referenceImageIds必须引用当前画布image元素ID、fileId或本机素材ID。不会任意抓取URL。", parameters: { type: "object", required: name === "edit_image" ? ["prompt", "referenceImageIds"] : ["prompt"], properties: { prompt: { type: "string" }, title: { type: "string" }, model: { type: "string" }, profileId: { type: "string" }, referenceImageIds: { type: "array", maxItems: 4, items: { type: "string" } }, size: { type: "string" }, placementX: { type: "number" }, placementY: { type: "number" }, placementWidth: { type: "number" }, placementHeight: { type: "number" } } } } })),
  { type: "function", function: { name: "get_brand_kit", description: "查询当前项目绑定的风格套件（品牌套件），包含风格指南、颜色、字体、Logo与参考图资产。用户提到风格、品牌、设计规范，或需要保持视觉风格统一时使用。", parameters: { type: "object", properties: {} } } },
];

function createLoomicLocalAgent(context) {
  const { options, getScope, scopeForResource, mutate, requiredText, fail, json, readBody, requestHubId, generateLocal, generateVideoLocal, mediaUrl, hydrateMedia, authenticate, getBaseUrl } = context;
  const clients = new Set(); const activeRuns = new Map(); const eventBuffers = new Map(); let wss;

  async function chatStatus() {
    const state = options.chatProvider?.status ? await options.chatProvider.status() : {};
    const models = Array.isArray(state.models) ? state.models.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id, name: m.name || m.displayName || m.id, displayName: m.displayName || m.name || m.id, provider: m.provider || "hub" })) : [];
    return { configured: state.configured === true, defaultModel: typeof state.defaultModel === "string" ? state.defaultModel : models[0]?.id || "", models };
  }
  async function canvasScope(canvasId, hubId) {
    const scope = await scopeForResource(canvasId, "c", hubId);
    const canvas = scope.state.canvases[canvasId];
    if (!canvas || scope.state.projects.find((p) => p.canvasId === canvasId)?.archivedAt) fail(404, "canvas_not_found", "当前项目中没有此画布。");
    return scope;
  }
  async function sessionScope(sessionId, hubId) {
    const scope = await scopeForResource(sessionId, "s", hubId);
    const session = scope.state.chatSessions?.[sessionId];
    if (!session || session.deletedAt) fail(404, "session_not_found", "当前项目中没有此会话。");
    await canvasScope(session.canvasId, hubId); return scope;
  }
  function summary(session) { return { id: session.id, title: session.title, updatedAt: session.updatedAt }; }
  async function appendMessage(scope, sessionId, body) {
    if (!["user", "assistant"].includes(body.role) || typeof body.content !== "string" || body.content.length > 200000) fail(400, "invalid_request", "聊天消息格式无效。");
    if (body.contentBlocks != null && (!Array.isArray(body.contentBlocks) || body.contentBlocks.length > 100 || !body.contentBlocks.every(record))) fail(400, "invalid_request", "聊天内容块格式无效。");
    return mutate(scope, (state) => {
      const session = state.chatSessions[sessionId]; session.messages ??= [];
      const last = session.messages.at(-1);
      // Original ChatSidebar POSTs the user message concurrently with WS run.
      if (body.role === "user" && last?.role === "user" && last.sourceRunId && last.content === body.content && Date.now() - Date.parse(last.createdAt) < 10000) return last;
      const message = { id: randomUUID(), role: body.role, content: body.content, contentBlocks: body.contentBlocks || [{ type: "text", text: body.content }], ...(body.toolActivities ? { toolActivities: body.toolActivities } : {}), createdAt: now() };
      session.messages.push(message); session.updatedAt = now(); return message;
    });
  }
  async function readMultipart(request, max = 25 * 1024 * 1024) {
    if (!/^multipart\/form-data;.*boundary=/i.test(request.headers["content-type"] || "")) fail(415, "invalid_request", "需要multipart图片上传。");
    const parts = []; let size = 0;
    for await (const part of request) { size += part.length; if (size > max) fail(413, "upload_failed", "上传图片超过本机上限。"); parts.push(part); }
    let form; try { form = await new Response(Buffer.concat(parts), { headers: { "Content-Type": request.headers["content-type"] } }).formData(); } catch { fail(400, "upload_failed", "上传内容无效。"); }
    const file = form.get("file"); if (!file || typeof file.arrayBuffer !== "function") fail(400, "upload_failed", "请选择图片文件。");
    const buffer = Buffer.from(await file.arrayBuffer()); let info;
    try { info = validateRasterImage(buffer, file.type, { allowSmall: true }); } catch { fail(400, "upload_failed", "只接受有效的PNG、JPEG或静态WebP图片。"); }
    if (!["image/png", "image/jpeg", "image/webp"].includes(info.contentType)) fail(400, "upload_failed", "不支持此图片格式。");
    return { buffer, info, name: String(file.name || "图片").slice(0, 200), form };
  }
  async function storeUpload(scope, asset) {
    const digest = createHash("sha256").update(asset.buffer).digest("hex").slice(0, 32); const uid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    const id = `m-${scope.key}-${uid}`;
    if (scope.state.media?.[id]) return { id, url: mediaUrl(id, scope.state.hubProjectId), mimeType: asset.info.contentType };
    const file = path.join(scope.dir, "media", id); await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, asset.buffer, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; if ((await fs.lstat(file)).isSymbolicLink() || !(await fs.readFile(file)).equals(asset.buffer)) fail(409, "upload_failed", "本机素材路径存在冲突，原文件已保留。"); }
    try { await mutate(scope, (state) => { state.media ??= {}; state.media[id] = { mimeType: asset.info.contentType, name: asset.name, byteSize: asset.buffer.length, createdAt: now() }; }); }
    catch (error) { await fs.rm(file, { force: true }).catch(() => {}); throw error; }
    return { id, url: mediaUrl(id, scope.state.hubProjectId), mimeType: asset.info.contentType };
  }
  // --- Style kits (brand kits): local CRUD + automatic style referencing ---
  const KIT_ASSET_TYPES = new Set(["color", "font", "logo", "image"]);
  function optionalText(value, label, max) {
    if (value == null) return null;
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail(400, "invalid_request", `${label}格式无效。`);
    return value.trim();
  }
  function kitMetadata(value) {
    if (value == null) return {};
    if (!record(value)) fail(400, "invalid_request", "风格套件资产metadata格式无效。");
    const entries = Object.entries(value).filter(([key]) => !["__proto__", "prototype", "constructor"].includes(key)).slice(0, 20);
    if (Buffer.byteLength(JSON.stringify(entries)) > 4000) fail(400, "invalid_request", "风格套件资产metadata超过本机上限。");
    return Object.fromEntries(entries);
  }
  function kitAssetShape(asset) { return { id: asset.id, asset_type: asset.asset_type, display_name: asset.display_name, role: asset.role ?? null, sort_order: asset.sort_order ?? 0, text_content: asset.text_content ?? null, file_url: asset.file_url ?? null, metadata: asset.metadata ?? {}, created_at: asset.created_at, updated_at: asset.updated_at }; }
  function kitSummary(kit) {
    const counts = { color: 0, font: 0, logo: 0, image: 0 };
    for (const asset of kit.assets || []) counts[asset.asset_type] = (counts[asset.asset_type] || 0) + 1;
    return { id: kit.id, name: kit.name, is_default: kit.is_default === true, cover_url: kit.cover_url ?? null, asset_counts: counts, created_at: kit.created_at, updated_at: kit.updated_at };
  }
  function kitDetail(kit) { return { id: kit.id, name: kit.name, is_default: kit.is_default === true, guidance_text: kit.guidance_text ?? null, cover_url: kit.cover_url ?? null, assets: (kit.assets || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(kitAssetShape), created_at: kit.created_at, updated_at: kit.updated_at }; }
  function readKit(scope, kitId) { const kit = scope.state.brandKits?.[kitId]; if (!kit) fail(404, "brand_kit_not_found", "风格套件不存在。"); return kit; }
  function styleKitForCanvas(scope, canvasId) {
    const project = scope.state.projects.find((p) => p.canvasId === canvasId && !p.archivedAt);
    const kit = project?.brandKitId ? scope.state.brandKits?.[project.brandKitId] : null;
    if (!kit) return null;
    const assets = kit.assets || [];
    const mediaId = (url) => { const match = typeof url === "string" && url.match(/^\/api\/local\/media\/(m-[a-f0-9]{32}-[a-f0-9-]{36})$/); return match ? match[1] : null; };
    return {
      kit_name: kit.name,
      design_guidance: kit.guidance_text || "",
      colors: assets.filter((a) => a.asset_type === "color").map((a) => ({ name: a.display_name, hex: a.text_content, role: a.role ?? null })),
      fonts: assets.filter((a) => a.asset_type === "font").map((a) => ({ name: a.display_name, family: a.text_content, weight: a.metadata?.weight ?? "400", role: a.role ?? null })),
      logos: assets.filter((a) => a.asset_type === "logo").map((a) => ({ name: a.display_name, mediaId: mediaId(a.file_url), role: a.role ?? null })),
      images: assets.filter((a) => a.asset_type === "image").map((a) => ({ name: a.display_name, mediaId: mediaId(a.file_url) })),
    };
  }
  function styleKitPromptSuffix(kit) {
    if (!kit) return "";
    const parts = [];
    if (kit.design_guidance) parts.push(`风格指南：${kit.design_guidance}`);
    if (kit.colors.length) parts.push(`主色：${kit.colors.map((c) => `${c.name}${c.hex ? `(${c.hex})` : ""}${c.role ? `/${c.role}` : ""}`).join("、")}`);
    if (kit.fonts.length) parts.push(`字体：${kit.fonts.map((f) => `${f.name}${f.family ? `(${f.family})` : ""}`).join("、")}`);
    if (kit.logos.length || kit.images.length) parts.push("套件中的Logo/参考图可用其mediaId作为referenceImageIds引用，以保持风格统一。");
    return `\n\n风格套件「${kit.kit_name}」约束（设计与生图须遵循，保持视觉风格统一）：${parts.length ? parts.join("；") : "与项目既有视觉资产保持一致。"}`;
  }
  function send(client, message) { if (client.socket.readyState === 1) client.socket.send(JSON.stringify(hydrateMedia(message))); }
  async function publish(run, event) {
    await getScope(run.hubProjectId);
    const item = { runId: run.id, timestamp: now(), ...event };
    const entries = eventBuffers.get(run.canvasId) || []; entries.push(item); if (entries.length > 300) entries.shift(); eventBuffers.set(run.canvasId, entries);
    for (const client of clients) if (client.hubProjectId === run.hubProjectId && client.canvasId === run.canvasId) send(client, { type: "event", event: item });
    return item;
  }
  function applyOperations(content, operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 100) fail(400, "invalid_request", "画布操作必须包含1至100项。");
    const elements = content.elements; const changed = [];
    const find = (id) => { const el = elements.find((e) => e.id === id && !e.isDeleted); if (!el) fail(400, "tool_failed", "目标画布元素不存在。"); return el; };
    const bump = (el) => { el.version = (el.version || 0) + 1; el.versionNonce = Math.floor(Math.random() * 2000000000); el.updated = Date.now(); };
    const style = (el, op) => { for (const key of ["strokeColor", "backgroundColor", "fillStyle"]) if (typeof op[key] === "string" && op[key].length < 100) el[key] = op[key]; for (const key of ["opacity", "fontSize", "strokeWidth"]) if (Number.isFinite(op[key])) el[key] = Math.max(0, Math.min(key === "opacity" ? 100 : 1000, op[key])); };
    for (const op of operations) {
      if (!record(op)) fail(400, "tool_failed", "画布操作格式无效。");
      let el;
      if (["add_text", "add_shape", "add_line"].includes(op.action)) {
        const type = op.action === "add_text" ? "text" : op.action === "add_line" ? (op.line_type === "arrow" ? "arrow" : "line") : (["rectangle", "ellipse", "diamond"].includes(op.shape) ? op.shape : "rectangle");
        el = { ...elementBase(type), x: finite(op.x), y: finite(op.y), width: Math.max(1, finite(op.width, 200)), height: Math.max(1, finite(op.height, 120)) }; style(el, op);
        if (type === "text") { el.text = requiredText(op.text, "文字", 10000); el.originalText = el.text; el.fontSize = Math.max(8, Math.min(finite(op.fontSize, 24), 300)); el.fontFamily = 5; el.textAlign = "left"; el.verticalAlign = "top"; el.containerId = null; el.autoResize = true; el.lineHeight = 1.25; el.height = Math.max(1, el.text.split("\n").length * el.fontSize * el.lineHeight); el.width = Math.max(el.width, el.text.length * el.fontSize * 0.65); }
        if (["line", "arrow"].includes(type)) { el.points = Array.isArray(op.points) && op.points.length >= 2 ? op.points.slice(0, 100).map((p) => [finite(p.x), finite(p.y)]) : [[0, 0], [el.width, el.height]]; el.startBinding = null; el.endBinding = null; el.startArrowhead = null; el.endArrowhead = type === "arrow" ? "arrow" : null; }
        elements.push(el); changed.push(el.id);
        if (record(op.label) && typeof op.label.text === "string" && op.label.text.trim()) {
          const label = { ...elementBase("text"), x: el.x + 10, y: el.y + el.height / 2 - 12, width: Math.max(1, el.width - 20), height: 30, text: op.label.text.slice(0, 10000), originalText: op.label.text.slice(0, 10000), fontSize: finite(op.label.fontSize, 20), fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: el.id, autoResize: true, lineHeight: 1.25 };
          el.boundElements = [{ id: label.id, type: "text" }]; elements.push(label); changed.push(label.id);
        }
      } else if (["align", "distribute"].includes(op.action)) {
        if (!Array.isArray(op.element_ids) || op.element_ids.length < 2 || op.element_ids.length > 100) fail(400, "tool_failed", "对齐需要至少两个元素。");
        const selected = op.element_ids.map(find); const axis = op.direction === "vertical" ? "y" : "x"; const size = axis === "x" ? "width" : "height";
        if (op.action === "distribute") { selected.sort((a, b) => a[axis] - b[axis]); const first = selected[0][axis]; const last = selected.at(-1)[axis]; selected.forEach((e, i) => { e[axis] = first + (last - first) * i / (selected.length - 1); bump(e); }); }
        else { const minX = Math.min(...selected.map((e) => e.x)), maxX = Math.max(...selected.map((e) => e.x + e.width)), minY = Math.min(...selected.map((e) => e.y)), maxY = Math.max(...selected.map((e) => e.y + e.height)); for (const e of selected) { if (op.alignment === "left") e.x = minX; else if (op.alignment === "right") e.x = maxX - e.width; else if (op.alignment === "center") e.x = (minX + maxX - e.width) / 2; else if (op.alignment === "top") e.y = minY; else if (op.alignment === "bottom") e.y = maxY - e.height; else if (op.alignment === "middle") e.y = (minY + maxY - e.height) / 2; else fail(400, "tool_failed", "不支持的对齐方向。"); bump(e); } }
        changed.push(...selected.map((e) => e.id));
      } else {
        el = find(op.element_id);
        if (op.action === "move") { el.x = finite(op.x, el.x); el.y = finite(op.y, el.y); }
        else if (op.action === "resize") { el.width = Math.max(1, finite(op.width, el.width)); el.height = Math.max(1, finite(op.height, el.height)); }
        else if (op.action === "delete") { el.isDeleted = true; for (const other of elements) { if (other.containerId === el.id) { other.isDeleted = true; bump(other); } if (other.startBinding?.elementId === el.id) other.startBinding = null; if (other.endBinding?.elementId === el.id) other.endBinding = null; } }
        else if (op.action === "update_style") style(el, op);
        else if (op.action === "update_text" && el.type === "text") { el.text = requiredText(op.text, "文字", 10000); el.originalText = el.text; }
        else if (op.action === "reorder") { elements.splice(elements.indexOf(el), 1); if (op.position === "back") elements.unshift(el); else elements.push(el); }
        else fail(400, "tool_failed", "不支持的画布操作。");
        bump(el); changed.push(el.id);
      }
    }
    return { summary: `已完成${operations.length}项画布操作。`, elementIds: changed };
  }
  async function executeTool(run, name, args, suppliedId) {
    const id = suppliedId || randomUUID(); const fingerprint = JSON.stringify({ name, args });
    if (run.toolCalls.has(id)) { const previous = run.toolCalls.get(id); if (previous.fingerprint !== fingerprint) fail(409, "tool_failed", "工具请求ID已用于其他参数。"); return previous.promise; }
    const promise = executeToolOnce(run, name, args, id); run.toolCalls.set(id, { fingerprint, promise }); return promise;
  }
  async function executeToolOnce(run, name, args, suppliedId) {
    if (run.controller.signal.aborted) fail(409, "run_failed", "任务已停止。");
    const scope = await canvasScope(run.canvasId, run.hubProjectId); const toolCallId = suppliedId || randomUUID();
    if (!TOOLS.some((t) => t.function.name === name) || !record(args)) fail(400, "tool_failed", "不支持此画布工具。");
    await publish(run, { type: "tool.started", toolCallId, toolName: name, input: args });
    let result;
    try {
      if (name === "inspect_canvas") {
        let elements = scope.state.canvases[run.canvasId].content.elements.filter((el) => !el.isDeleted);
        if (args.element_id) elements = elements.filter((el) => el.id === args.element_id);
        if (Array.isArray(args.filter_type)) elements = elements.filter((el) => args.filter_type.includes(el.type));
        result = { summary: `当前画布有${elements.length}个匹配元素。`, elements: elements.slice(0, 200).map((el) => args.detail_level === "full" ? el : Object.fromEntries(["id", "type", "x", "y", "width", "height", "text", "fileId", "customData"].filter((key) => el[key] !== undefined).map((key) => [key, el[key]]))) };
      } else if (name === "manipulate_canvas") {
        result = await mutate(scope, (state) => { const output = applyOperations(state.canvases[run.canvasId].content, args.operations); state.projects.find((p) => p.canvasId === run.canvasId).updatedAt = now(); return output; });
      } else if (name === "get_brand_kit") {
        const kit = styleKitForCanvas(scope, run.canvasId);
        result = kit ? { bound: true, summary: `当前项目已绑定风格套件「${kit.kit_name}」。`, ...kit } : { bound: false, summary: "当前项目未绑定风格套件；可在风格套件页面创建并绑定。" };
      } else {
        const references = args.referenceImageIds || args.reference_image_ids || args.inputImages;
        if (name === "edit_image" && (!Array.isArray(references) || !references.length)) fail(400, "tool_failed", "编辑图片需要当前画布图片ID。");
        const preference = run.payload.imageGenerationPreference;
        const preferredModel = preference?.mode === "manual" ? preference.models?.[0] : null;
        const generated = await generateLocal(scope, { canvasId: run.canvasId, prompt: requiredText(args.prompt, "生图描述", 12000) + styleKitPromptSuffix(styleKitForCanvas(scope, run.canvasId)), requestId: `${run.id}-${toolCallId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), profileId: args.profileId || args.model || preferredModel || undefined, size: args.size, ...(references?.length ? { referenceImageIds: references } : {}) });
        await getScope(run.hubProjectId);
        const asset = generated.images[0]; const id = new URL(asset.url, getBaseUrl()).pathname.split("/").at(-1); const buffer = await fs.readFile(path.join(scope.dir, "media", id)); const info = validateRasterImage(buffer, asset.mimeType, { allowSmall: true });
        const fileId = randomUUID(); const elementId = randomUUID();
        const dataURL = `data:${asset.mimeType};base64,${buffer.toString("base64")}`;
        const visible = scope.state.canvases[run.canvasId].content.elements.filter((e) => !e.isDeleted); const nextX = visible.length ? Math.max(...visible.map((e) => finite(e.x) + finite(e.width))) + 40 : 0;
        const placement = { x: finite(args.placementX, nextX), y: finite(args.placementY), width: Math.max(1, finite(args.placementWidth, Math.min(info.width, 640))), height: Math.max(1, finite(args.placementHeight, Math.min(info.width, 640) * info.height / info.width)) };
        await mutate(scope, (state) => { const content = state.canvases[run.canvasId].content; content.files[fileId] = { id: fileId, dataURL, mimeType: asset.mimeType, created: Date.now() }; content.elements.push({ ...elementBase("image"), ...placement, id: elementId, fileId, status: "saved", scale: [1, 1], crop: null, customData: { title: args.title || "AI生成图片", prompt: args.prompt, originalWidth: info.width, originalHeight: info.height } }); state.projects.find((p) => p.canvasId === run.canvasId).updatedAt = now(); });
        result = { summary: "图片已保存到本机并放入画布。", elementId, imageUrl: mediaUrl(id, run.hubProjectId), mimeType: asset.mimeType, width: info.width, height: info.height, artifacts: [{ type: "image", title: args.title || "AI生成图片", url: mediaUrl(id, run.hubProjectId), mimeType: asset.mimeType, width: info.width, height: info.height, placement }] };
      }
      const block = { type: "tool", toolCallId, toolName: name, status: "completed", input: args, output: result, outputSummary: result.summary, ...(result.artifacts ? { artifacts: result.artifacts } : {}) }; run.blocks.push(block);
      await publish(run, { type: "tool.completed", toolCallId, toolName: name, output: result, outputSummary: result.summary, ...(result.artifacts ? { artifacts: result.artifacts } : {}) });
      if (name !== "inspect_canvas") await publish(run, { type: "canvas.sync" });
      return result;
    } catch (error) {
      const message = error?.statusCode ? error.message : "画布工具执行失败，系统不会自动重试模型调用。";
      const output = { error: message }; run.blocks.push({ type: "tool", toolCallId, toolName: name, status: "completed", input: args, output, outputSummary: message });
      await publish(run, { type: "tool.completed", toolCallId, toolName: name, output, outputSummary: message }); throw error;
    }
  }
  async function processRun(run) {
    let text = ""; let status = "completed"; let errorMessage = "";
    try {
      await publish(run, { type: "run.started", sessionId: run.sessionId, conversationId: run.canvasId });
      const available = await chatStatus();
      if (!available.configured || !options.chatProvider?.invoke) fail(503, "run_failed", "请先在Hub模型设置中配置文本模型；尚未调用模型。");
      if (run.payload.model && !available.models.some((m) => m.id === run.payload.model)) fail(400, "run_failed", "所选文本模型不在Hub当前配置中，请重新选择。");
      const scope = await sessionScope(run.sessionId, run.hubProjectId); const session = scope.state.chatSessions[run.sessionId];
      const selectedModel = run.payload.model || (available.models.some((m) => m.id === scope.state.agentDefaultModel) ? scope.state.agentDefaultModel : available.defaultModel);
      const result = await options.chatProvider.invoke({ prompt: run.payload.prompt, model: selectedModel, history: session.messages.slice(-30).map((m) => ({ role: m.role, content: m.content, contentBlocks: m.contentBlocks })), attachments: run.payload.attachments || [], canvas: structuredClone(scope.state.canvases[run.canvasId]), styleKit: styleKitForCanvas(scope, run.canvasId), hubProjectId: run.hubProjectId, sessionId: run.sessionId, signal: run.controller.signal, tools: structuredClone(TOOLS), executeTool: (name, args, id) => executeTool(run, name, args, id), onDelta: async (delta) => { if (run.controller.signal.aborted || typeof delta !== "string" || text.length + delta.length > 200000) return; text += delta; const last = run.blocks.at(-1); if (last?.type === "text") last.text += delta; else run.blocks.push({ type: "text", text: delta }); await publish(run, { type: "message.delta", messageId: run.messageId, delta }); }, onThinking: async (delta) => { if (!run.controller.signal.aborted && typeof delta === "string") await publish(run, { type: "thinking.delta", messageId: run.messageId, delta: delta.slice(0, 20000) }); } });
      if (run.controller.signal.aborted) throw new Error("aborted");
      if (!text && typeof result?.text === "string") { text = result.text.slice(0, 200000); run.blocks.push({ type: "text", text }); await publish(run, { type: "message.delta", messageId: run.messageId, delta: text }); }
      if (!text && !run.blocks.length) fail(502, "run_failed", "模型没有返回有效内容，系统未自动重试。");
    } catch (error) {
      status = run.controller.signal.aborted ? "canceled" : "failed";
      errorMessage = status === "canceled" ? "任务已停止。" : error?.statusCode && typeof error.message === "string" ? error.message : "模型请求未完成，请检查Hub模型配置及服务记录；系统不会自动重试。";
    }
    // Preserve an already-authorized run's result even if the user switches Hub
    // projects, but never publish to the no-longer-authorized socket.
    await mutate(run.scope, (state) => {
      const session = state.chatSessions[run.sessionId];
      if (session && !session.deletedAt) {
        const blocks = [...run.blocks, ...(errorMessage ? [{ type: "text", text: errorMessage }] : [])];
        session.messages.push({ id: run.messageId, role: "assistant", content: text || errorMessage, contentBlocks: blocks, createdAt: now(), runId: run.id, status }); session.updatedAt = now();
      }
      state.agentRuns[run.id].status = status; state.agentRuns[run.id].completedAt = now(); if (errorMessage) state.agentRuns[run.id].error = errorMessage;
    });
    try { await publish(run, status === "completed" ? { type: "run.completed" } : status === "canceled" ? { type: "run.canceled" } : { type: "run.failed", error: { code: "run_failed", message: errorMessage } }); } catch {}
    activeRuns.delete(run.canvasId);
  }
  async function startRun(client, payload) {
    if (!record(payload)) fail(400, "invalid_request", "任务格式无效。");
    const canvasId = requiredText(payload.canvasId || payload.conversationId, "画布ID", 200); const sessionId = requiredText(payload.sessionId, "会话ID", 200); const prompt = requiredText(payload.prompt, "输入内容", 12000);
    const scope = await canvasScope(canvasId, client.hubProjectId); await sessionScope(sessionId, client.hubProjectId);
    if (scope.state.chatSessions[sessionId].canvasId !== canvasId) fail(404, "session_not_found", "会话不属于当前画布。");
    if (activeRuns.has(canvasId)) fail(409, "run_conflict", "当前画布已有Agent任务运行。");
    const run = { id: randomUUID(), messageId: randomUUID(), hubProjectId: client.hubProjectId, canvasId, sessionId, payload: { ...payload, prompt }, scope, blocks: [], toolCalls: new Map(), controller: new AbortController() };
    activeRuns.set(canvasId, run); client.canvasId = canvasId;
    try {
      await mutate(scope, (state) => { state.agentRuns ??= {}; state.agentRuns[run.id] = { id: run.id, canvasId, sessionId, prompt, status: "accepted", createdAt: now() }; const session = state.chatSessions[sessionId]; const last = session.messages.at(-1); if (last?.role === "user" && last.content === prompt && !last.sourceRunId && Date.now() - Date.parse(last.createdAt) < 10000) last.sourceRunId = run.id; else session.messages.push({ id: randomUUID(), role: "user", content: prompt, contentBlocks: [{ type: "text", text: prompt }], sourceRunId: run.id, createdAt: now() }); session.updatedAt = now(); });
      send(client, { type: "command.ack", action: "agent.run", payload: { runId: run.id, sessionId, conversationId: canvasId, status: "accepted" } });
      run.promise = processRun(run).catch(async () => { activeRuns.delete(canvasId); try { await publish(run, { type: "run.failed", error: { code: "run_failed", message: "本机任务保存失败，请检查本机数据目录。" } }); } catch {} });
      return run;
    } catch (error) { activeRuns.delete(canvasId); throw error; }
  }
  async function wsCommand(client, message) {
    await getScope(client.hubProjectId);
    if (!record(message)) fail(400, "invalid_request", "消息格式无效。");
    if (message.type === "rpc.response") return;
    if (message.type !== "command" || !record(message.payload)) fail(400, "invalid_request", "命令格式无效。");
    if (message.action === "agent.run") return startRun(client, message.payload);
    if (message.action === "canvas.resume") {
      const canvasId = requiredText(message.payload.canvasId, "画布ID", 200); await canvasScope(canvasId, client.hubProjectId); client.canvasId = canvasId;
      const run = activeRuns.get(canvasId); const events = run ? (eventBuffers.get(canvasId) || []).filter((event) => event.runId === run.id) : [];
      send(client, { type: "command.ack", action: "canvas.resume", payload: { canvasId, latestSeq: events.length, activeRunId: run?.id || null, replayed: events.length } }); for (const event of events) send(client, { type: "event", event }); return;
    }
    if (message.action === "agent.cancel") { const run = [...activeRuns.values()].find((r) => r.id === message.payload.runId && r.hubProjectId === client.hubProjectId); if (!run) fail(404, "run_not_found", "任务不存在。"); run.controller.abort(); send(client, { type: "command.ack", action: "agent.cancel", payload: { runId: run.id, status: "canceling" } }); return; }
    fail(400, "invalid_request", "不支持此命令。");
  }
  function attach(server) {
    const { WebSocketServer } = require("ws"); wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024, perMessageDeflate: false });
    server.on("upgrade", (request, socket, head) => { (async () => {
      const baseUrl = getBaseUrl(); const url = new URL(request.url, baseUrl);
      if (url.pathname !== "/api/ws" || request.headers.host !== new URL(baseUrl).host || (request.headers.origin && request.headers.origin !== baseUrl)) fail(403, "unauthorized", "WebSocket来源无效。");
      authenticate(request, url.searchParams.get("token")); const hubProjectId = requiredText(url.searchParams.get("hubProjectId"), "Hub项目ID", 500); await getScope(hubProjectId);
      wss.handleUpgrade(request, socket, head, (ws) => {
        const client = { socket: ws, hubProjectId, canvasId: null }; clients.add(client);
        ws.on("message", (raw, binary) => {
          if (binary) { ws.close(1003, "Text JSON required"); return; }
          let message; try { message = JSON.parse(raw.toString("utf8")); } catch { send(client, { type: "error", message: "JSON消息无效。" }); return; }
          wsCommand(client, message).catch((error) => {
            send(client, { type: "error", code: error.code || "run_failed", message: error.statusCode ? error.message : "本机Agent请求失败。" });
            if (error.statusCode === 404) ws.close(4001, "Project scope changed");
          });
        });
        ws.on("error", () => {}); ws.on("close", () => clients.delete(client));
      });
    })().catch(() => { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); }); });
  }
  async function handleHttp(request, reply, url) {
    const route = url.pathname; const method = request.method; const hubId = requestHubId(request, url);
    const sessions = route.match(/^\/api\/canvases\/([^/]+)\/sessions$/);
    if (sessions) {
      const canvasId = sessions[1]; const scope = await canvasScope(canvasId, hubId);
      if (method === "GET") { json(reply, 200, { sessions: Object.values(scope.state.chatSessions || {}).filter((s) => s.canvasId === canvasId && !s.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) }); return true; }
      if (method === "POST") { const body = await readBody(request, 16000); const session = { id: `s-${scope.key}-${randomUUID()}`, canvasId, title: body.title ? requiredText(body.title, "会话标题", 200) : "新对话", updatedAt: now(), messages: [] }; await mutate(scope, (state) => { state.chatSessions ??= {}; state.chatSessions[session.id] = session; }); json(reply, 201, { session: summary(session) }); return true; }
    }
    const sessionMatch = route.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
    if (sessionMatch) {
      const id = sessionMatch[1]; const scope = await sessionScope(id, hubId);
      if (sessionMatch[2] && method === "GET") { json(reply, 200, { messages: scope.state.chatSessions[id].messages || [] }); return true; }
      if (sessionMatch[2] && method === "POST") { const body = await readBody(request, 10 * 1024 * 1024); json(reply, 201, { message: await appendMessage(scope, id, body) }); return true; }
      if (!sessionMatch[2] && method === "PATCH") { const body = await readBody(request, 16000); const title = requiredText(body.title, "会话标题", 200); await mutate(scope, (state) => { state.chatSessions[id].title = title; state.chatSessions[id].updatedAt = now(); }); json(reply, 200, { ok: true }); return true; }
      if (!sessionMatch[2] && method === "DELETE") { if (activeRuns.get(scope.state.chatSessions[id].canvasId)?.sessionId === id) fail(409, "run_conflict", "请先停止Agent任务再删除会话。"); await mutate(scope, (state) => { state.chatSessions[id].deletedAt = now(); }); json(reply, 200, { ok: true }); return true; }
    }
    if (route === "/api/models" && method === "GET") { const scope = await getScope(hubId); const status = await chatStatus(); json(reply, 200, { models: status.models, defaultModel: status.models.some((m) => m.id === scope.state.agentDefaultModel) ? scope.state.agentDefaultModel : status.defaultModel }); return true; }
    if (route === "/api/viewer" && method === "GET") { const scope = await getScope(hubId); json(reply, 200, { mode: "local", profile: { id: "hub-local", email: "local@localhost.invalid", displayName: "Hub 本机模式", avatarUrl: null }, workspace: { id: scope.state.hubProjectId, name: scope.state.hubProjectName, type: "personal", ownerUserId: "hub-local" }, membership: { workspaceId: scope.state.hubProjectId, userId: "hub-local", role: "owner" } }); return true; }
    if (route === "/api/workspace/settings") { const scope = await getScope(hubId); const status = await chatStatus(); if (method === "PUT") { const body = await readBody(request, 16000); if (!status.models.some((m) => m.id === body.defaultModel)) fail(400, "settings_update_failed", "此文本模型不在Hub当前配置中。"); await mutate(scope, (state) => { state.agentDefaultModel = body.defaultModel; }); } json(reply, 200, { settings: { defaultModel: status.models.some((m) => m.id === scope.state.agentDefaultModel) ? scope.state.agentDefaultModel : status.defaultModel || "hub-unconfigured" } }); return true; }
    if (route === "/api/video-models" && method === "GET") { await getScope(hubId); const snapshot = options.listMediaModels ? await options.listMediaModels() : {}; const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : []; json(reply, 200, { models: profiles.filter((p) => p.category === "video" && p.enabled && p.hasApiKey).map((p) => ({ id: p.id, displayName: p.name, name: p.name, description: `本机统一配置 · ${p.model}`, provider: "hub", accessible: true, capabilities: { textToVideo: true, imageToVideo: false, videoToVideo: false, audio: false }, limits: { maxDuration: 60, maxResolution: "2160p", maxInputImages: 0 } })) }); return true; }
    if (route === "/api/credits" && method === "GET") { await getScope(hubId); json(reply, 200, { balance: 999999, plan: "business", dailyClaimed: true, limits: { maxConcurrentJobs: 8, maxResolution: "2160p", monthlyCredits: 0, dailyCredits: 0 } }); return true; }
    if (route === "/api/credits/transactions" && method === "GET") { await getScope(hubId); json(reply, 200, { transactions: [] }); return true; }
    if (route === "/api/credits/claim-daily" && method === "POST") { await getScope(hubId); json(reply, 200, { success: true, message: "本机模式不消耗网站积分。" }); return true; }
    if (["/api/workspaces/skills", "/api/workspace/skills"].includes(route) && method === "GET") { await getScope(hubId); json(reply, 200, { skills: [] }); return true; }
    const kitMatch = route === "/api/brand-kits" ? { kitId: null, sub: null, assetId: null } : (() => { const m = route.match(/^\/api\/brand-kits\/([^/]+)(?:\/(duplicate|assets(?:\/([^/]+))?))?$/); return m ? { kitId: m[1], sub: (m[2] || "").split("/")[0] || null, assetId: m[3] || null } : null; })();
    if (kitMatch) {
      const scope = await getScope(hubId);
      if (!kitMatch.kitId) {
        if (method === "GET") { json(reply, 200, { brandKits: Object.values(scope.state.brandKits || {}).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(kitSummary) }); return true; }
        if (method === "POST") {
          const body = await readBody(request, 16000);
          const created = await mutate(scope, (state) => {
            state.brandKits ??= {}; const id = `k-${scope.key}-${randomUUID()}`; const stamp = now();
            const kit = { id, name: body.name != null ? requiredText(body.name, "套件名称", 100) : "未命名风格套件", is_default: false, guidance_text: null, cover_url: null, assets: [], created_at: stamp, updated_at: stamp };
            state.brandKits[id] = kit; return kitDetail(kit);
          });
          json(reply, 201, created); return true;
        }
        fail(405, "invalid_request", "不支持的风格套件请求。");
      }
      const kit = readKit(scope, kitMatch.kitId);
      if (!kitMatch.sub) {
        if (method === "GET") { json(reply, 200, kitDetail(kit)); return true; }
        if (method === "PATCH") {
          const body = await readBody(request, 32000);
          const updated = await mutate(scope, (state) => {
            const row = state.brandKits[kitMatch.kitId];
            if (body.name != null) row.name = requiredText(body.name, "套件名称", 100);
            if (body.guidance_text !== undefined) row.guidance_text = optionalText(body.guidance_text, "风格指南", 5000);
            if (body.is_default !== undefined) {
              if (typeof body.is_default !== "boolean") fail(400, "invalid_request", "is_default必须为布尔值。");
              if (body.is_default) for (const other of Object.values(state.brandKits)) other.is_default = false;
              row.is_default = body.is_default;
            }
            row.updated_at = now(); return kitDetail(row);
          });
          json(reply, 200, updated); return true;
        }
        if (method === "DELETE") {
          await mutate(scope, (state) => { delete state.brandKits[kitMatch.kitId]; for (const project of state.projects) if (project.brandKitId === kitMatch.kitId) project.brandKitId = null; });
          json(reply, 200, { ok: true }); return true;
        }
        fail(405, "invalid_request", "不支持的风格套件请求。");
      }
      if (kitMatch.sub === "duplicate" && method === "POST") {
        const copied = await mutate(scope, (state) => {
          const id = `k-${scope.key}-${randomUUID()}`; const stamp = now();
          const cloneKit = { ...structuredClone(kit), id, name: `${kit.name} 副本`.slice(0, 100), is_default: false, assets: (kit.assets || []).map((a) => ({ ...structuredClone(a), id: randomUUID(), created_at: stamp, updated_at: stamp })), created_at: stamp, updated_at: stamp };
          state.brandKits[id] = cloneKit; return kitDetail(cloneKit);
        });
        json(reply, 201, copied); return true;
      }
      if (kitMatch.sub === "assets" && !kitMatch.assetId && method === "POST") {
        const body = await readBody(request, 16000);
        if (!KIT_ASSET_TYPES.has(body.asset_type)) fail(400, "invalid_request", "风格套件资产类型无效。");
        const created = await mutate(scope, (state) => {
          const row = state.brandKits[kitMatch.kitId]; row.assets ??= [];
          const asset = { id: randomUUID(), asset_type: body.asset_type, display_name: requiredText(body.display_name, "资产名称", 100), role: optionalText(body.role, "资产角色", 100), sort_order: Number.isInteger(body.sort_order) ? body.sort_order : row.assets.length, text_content: body.text_content === undefined ? null : optionalText(body.text_content, "资产内容", 2000), file_url: null, metadata: kitMetadata(body.metadata), created_at: now(), updated_at: now() };
          row.assets.push(asset); row.updated_at = now(); return kitAssetShape(asset);
        });
        json(reply, 201, created); return true;
      }
      if (kitMatch.sub === "assets" && kitMatch.assetId === "upload" && method === "POST") {
        const upload = await readMultipart(request);
        const assetType = String(upload.form.get("asset_type") || "");
        if (!["logo", "image"].includes(assetType)) fail(400, "invalid_request", "上传风格套件资产仅支持logo或image。");
        const stored = await storeUpload(scope, upload);
        const created = await mutate(scope, (state) => {
          const row = state.brandKits[kitMatch.kitId]; row.assets ??= [];
          const asset = { id: randomUUID(), asset_type: assetType, display_name: upload.name.slice(0, 100) || "参考图", role: null, sort_order: row.assets.length, text_content: null, file_url: mediaUrl(stored.id), metadata: {}, created_at: now(), updated_at: now() };
          row.assets.push(asset); row.updated_at = now(); return kitAssetShape(asset);
        });
        json(reply, 201, created); return true;
      }
      if (kitMatch.sub === "assets" && kitMatch.assetId && kitMatch.assetId !== "upload") {
        const asset = (kit.assets || []).find((a) => a.id === kitMatch.assetId);
        if (!asset) fail(404, "brand_kit_asset_not_found", "风格套件资产不存在。");
        if (method === "PATCH") {
          const body = await readBody(request, 16000);
          const updated = await mutate(scope, (state) => {
            const row = state.brandKits[kitMatch.kitId]; const target = (row.assets || []).find((a) => a.id === kitMatch.assetId);
            if (body.display_name != null) target.display_name = requiredText(body.display_name, "资产名称", 100);
            if (body.text_content !== undefined) target.text_content = optionalText(body.text_content, "资产内容", 2000);
            if (body.role !== undefined) target.role = optionalText(body.role, "资产角色", 100);
            if (body.sort_order !== undefined) { if (!Number.isInteger(body.sort_order)) fail(400, "invalid_request", "sort_order必须为整数。"); target.sort_order = body.sort_order; }
            if (body.metadata !== undefined) target.metadata = kitMetadata(body.metadata);
            target.updated_at = now(); row.updated_at = now(); return kitAssetShape(target);
          });
          json(reply, 200, updated); return true;
        }
        if (method === "DELETE") {
          await mutate(scope, (state) => { const row = state.brandKits[kitMatch.kitId]; row.assets = (row.assets || []).filter((a) => a.id !== kitMatch.assetId); row.updated_at = now(); });
          json(reply, 200, { ok: true }); return true;
        }
        fail(405, "invalid_request", "不支持的风格套件请求。");
      }
      fail(405, "invalid_request", "不支持的风格套件请求。");
    }
    if (route === "/api/uploads" && method === "POST") { const scope = await getScope(hubId); const upload = await readMultipart(request); const projectId = upload.form.get("projectId"); if (projectId && !scope.state.projects.some((p) => p.id === projectId && !p.archivedAt)) fail(404, "project_not_found", "素材不属于当前项目。"); const asset = await storeUpload(scope, upload); json(reply, 201, { asset: { id: asset.id, bucket: "project-assets", objectPath: asset.id, mimeType: asset.mimeType, byteSize: upload.buffer.length, workspaceId: scope.state.hubProjectId, projectId: projectId || null, createdAt: now() }, url: asset.url }); return true; }
    const uploadMatch = route.match(/^\/api\/uploads\/([^/]+)(\/url)?$/);
    if (uploadMatch) { const scope = await scopeForResource(uploadMatch[1], "m", hubId); if (!scope.state.media?.[uploadMatch[1]]) fail(404, "asset_not_found", "本机素材不存在。"); if (method === "GET" && uploadMatch[2]) { json(reply, 200, { url: mediaUrl(uploadMatch[1], hubId) }); return true; } if (method === "DELETE") { await mutate(scope, (state) => { delete state.media[uploadMatch[1]]; }); json(reply, 200, { ok: true }); return true; } }
    const thumbnail = route.match(/^\/api\/projects\/([^/]+)\/thumbnail$/);
    if (thumbnail && method === "PUT") { const scope = await scopeForResource(thumbnail[1], "p", hubId); const upload = await readMultipart(request, 5 * 1024 * 1024); const asset = await storeUpload(scope, upload); await mutate(scope, (state) => { state.projects.find((p) => p.id === thumbnail[1]).thumbnailUrl = asset.url; }); json(reply, 200, { thumbnailUrl: asset.url, storage: "local" }); return true; }
    if (route === "/api/agent/generate-video" && method === "POST") {
      const body = await readBody(request, 64 * 1024);
      const scope = body.canvasId ? await canvasScope(body.canvasId, hubId) : await getScope(hubId);
      if (Array.isArray(body.inputImages) && body.inputImages.length) fail(400, "video_reference_unsupported", "当前本机视频接口暂不支持首尾帧参考图，请移除参考图后重试。");
      const base = body.resolution === "1080p" ? [1920, 1080] : body.resolution === "4k" ? [3840, 2160] : [1280, 720];
      const vertical = body.aspectRatio === "9:16";
      const size = vertical ? `${base[1]}x${base[0]}` : `${base[0]}x${base[1]}`;
      const seconds = Number.isInteger(body.duration) && body.duration >= 1 && body.duration <= 60 ? body.duration : null;
      const generated = await generateVideoLocal(scope, { prompt: body.prompt, profileId: body.model || body.profileId, requestId: body.requestId || randomUUID(), canvasId: body.canvasId, size, seconds });
      const item = generated.videos[0]; const id = new URL(item.url, getBaseUrl()).pathname.split("/").at(-1);
      json(reply, 200, { url: mediaUrl(id, hubId), assetId: id, prompt: body.prompt, mimeType: item.mimeType, width: vertical ? base[1] : base[0], height: vertical ? base[0] : base[1], durationSeconds: seconds ?? 5 });
      return true;
    }
    if (route === "/api/agent/generate-image" && method === "POST") {
      const body = await readBody(request, 64 * 1024);
      const qualities = { standard: "1K", hd: "2K", ultra: "4K" };
      if (body.quality != null && !Object.hasOwn(qualities, body.quality)) fail(400, "invalid_request", "不支持的图片分辨率。");
      const scope = body.canvasId ? await canvasScope(body.canvasId, hubId) : await getScope(hubId);
      const generated = await generateLocal(scope, { prompt: body.prompt + styleKitPromptSuffix(body.canvasId ? styleKitForCanvas(scope, body.canvasId) : null), profileId: body.model || body.profileId, requestId: body.requestId || randomUUID(), canvasId: body.canvasId, referenceImageIds: body.referenceImageIds || body.inputImages, ...(body.aspectRatio != null ? { aspectRatio: body.aspectRatio } : {}), ...(body.resolution != null || body.quality != null ? { resolution: body.resolution ?? qualities[body.quality] } : {}), size: body.size || (body.aspectRatio === "16:9" ? "1536x1024" : body.aspectRatio === "9:16" ? "1024x1536" : "1024x1024") });
      const item = generated.images[0]; const id = new URL(item.url, getBaseUrl()).pathname.split("/").at(-1);
      const info = validateRasterImage(await fs.readFile(path.join(scope.dir, "media", id)), item.mimeType, { allowSmall: true });
      json(reply, 200, { url: mediaUrl(id, hubId), prompt: body.prompt, mimeType: item.mimeType, width: info.width, height: info.height }); return true;
    }
    return false;
  }
  async function close() { for (const run of activeRuns.values()) run.controller.abort(); for (const client of clients) client.socket.terminate(); clients.clear(); if (wss) await new Promise((resolve) => wss.close(resolve)); }
  return { attach, handleHttp, chatStatus, close, tools: TOOLS };
}

module.exports = { createLoomicLocalAgent };
