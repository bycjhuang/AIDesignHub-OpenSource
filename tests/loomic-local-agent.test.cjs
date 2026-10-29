"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const WebSocket = require("ws");
const { createLoomicLocalService } = require("../backend/loomic-local.cjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p0AAAAASUVORK5CYII=", "base64");
const chatStatus = () => ({ configured: true, models: [{ id: "hub-text", name: "Hub文本模型", provider: "mock" }], defaultModel: "hub-text" });

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adh-loomic-agent-test-")); let service; let info; let token; const sockets = [];
  const start = async () => { service = createLoomicLocalService({ dataDir: root, ...options }); info = await service.start({ projectId: "hub-a", projectName: "Hub项目A" }); token = new URL(info.url).searchParams.get("cap"); return info; };
  await start();
  const api = (route, { method = "GET", body, hubId = "hub-a", form } = {}) => fetch(`${info.baseUrl}${route}`, { method, headers: { "X-Loomic-Token": token, "X-Loomic-Project": hubId, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : form ? { body: form } : {}) });
  async function connect({ capability = token, origin = info.baseUrl, hubId = "hub-a" } = {}) {
    const socket = new WebSocket(`${info.baseUrl.replace(/^http/, "ws")}/api/ws?${new URLSearchParams({ token: capability, hubProjectId: hubId, connectionId: "test-client" })}`, { origin }); sockets.push(socket);
    const messages = []; const listeners = new Set(); socket.on("message", (raw) => { let value; try { value = JSON.parse(raw.toString()); } catch { return; } messages.push(value); for (const listener of listeners) listener(); });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const until = (predicate) => new Promise((resolve, reject) => { const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`Expected WS event; got ${JSON.stringify(messages).slice(0, 500)}`)); }, 3000); function check() { const value = messages.find(predicate); if (value) { clearTimeout(timeout); listeners.delete(check); resolve(value); } } listeners.add(check); check(); });
    return { socket, messages, until, send: (action, payload) => socket.send(JSON.stringify({ type: "command", action, payload })) };
  }
  async function session() { const { projects } = await (await api("/api/projects")).json(); const canvasId = projects[0].canvasId; const created = await (await api(`/api/canvases/${canvasId}/sessions`, { method: "POST", body: {} })).json(); return { canvasId, sessionId: created.session.id }; }
  t.after(async () => { for (const socket of sockets) socket.terminate(); await service.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { api, connect, session, start, root, get service() { return service; }, get info() { return info; }, get token() { return token; } };
}

test("original WS ack/events drive real canvas tools and durable chat history", async (t) => {
  let invokes = 0; let received;
  const f = await fixture(t, { chatProvider: { status: chatStatus, invoke: async (request) => { invokes++; received = request; await request.onDelta("正在检查画布。\n"); await request.executeTool("inspect_canvas", {}, "inspect-1"); await request.executeTool("manipulate_canvas", { operations: [{ action: "add_text", text: "真实保存的测试标题", x: 20, y: 40 }] }, "modify-1"); await request.onDelta("测试标题已加入画布。"); return {}; } } });
  const ids = await f.session(); const ws = await f.connect();
  ws.send("agent.run", { ...ids, conversationId: ids.canvasId, prompt: "请在画布加标题", model: "hub-text" });
  const ack = await ws.until((m) => m.type === "command.ack" && m.action === "agent.run"); assert.equal(ack.payload.status, "accepted");
  await ws.until((m) => m.event?.type === "run.completed");
  assert.equal(ws.messages[0].type, "command.ack"); assert.ok(ws.messages.some((m) => m.event?.type === "tool.started")); assert.ok(ws.messages.some((m) => m.event?.type === "canvas.sync"));
  assert.equal(invokes, 1); assert.equal(received.hubProjectId, "hub-a"); assert.ok(received.tools.some((tool) => tool.function.name === "edit_image"));
  const canvas = await (await f.api(`/api/canvases/${ids.canvasId}`)).json(); assert.equal(canvas.canvas.content.elements[0].text, "真实保存的测试标题");
  const messages = await (await f.api(`/api/sessions/${ids.sessionId}/messages`)).json(); assert.equal(messages.messages.length, 2); assert.equal(messages.messages[0].content, "请在画布加标题"); assert.match(messages.messages[1].content, /测试标题已加入/);
  ws.socket.terminate(); await f.service.stop(); await f.start();
  const restored = await (await f.api(`/api/sessions/${ids.sessionId}/messages`)).json(); assert.deepEqual(restored, messages);
});

test("WS validates capability, Origin, JSON text frames and current Hub scope", async (t) => {
  let active = "hub-a"; let calls = 0;
  const f = await fixture(t, { getProject: (id) => id === active ? { name: id } : null, chatProvider: { status: chatStatus, invoke: async () => { calls++; return { text: "unused" }; } } });
  const ids = await f.session();
  await assert.rejects(f.connect({ capability: "wrong-token" }), /401/); await assert.rejects(f.connect({ origin: "https://external.example" }), /401/);
  const ws = await f.connect(); ws.socket.send("not-json"); await ws.until((m) => m.type === "error"); assert.equal(calls, 0);
  ws.socket.send(Buffer.from("binary")); const closed = await new Promise((resolve) => ws.socket.once("close", (code) => resolve(code))); assert.equal(closed, 1003);
  const old = await f.connect(); active = "hub-b"; await f.service.open({ projectId: "hub-b", projectName: "B" });
  old.send("agent.run", { ...ids, prompt: "旧项目页面不可提交" });
  await old.until((m) => m.type === "error"); assert.equal(calls, 0);
  assert.equal((await f.api(`/api/sessions/${ids.sessionId}/messages`)).status, 404);
});

test("missing or failing text provider emits truthful failed status and preserves input", async (t) => {
  const f = await fixture(t); const ids = await f.session(); const ws = await f.connect();
  ws.send("agent.run", { ...ids, prompt: "保留我的原始需求" });
  const failed = await ws.until((m) => m.event?.type === "run.failed"); assert.match(failed.event.error.message, /尚未调用模型/);
  const history = await (await f.api(`/api/sessions/${ids.sessionId}/messages`)).json(); assert.equal(history.messages[0].content, "保留我的原始需求"); assert.equal(history.messages[1].status, "failed");
  const g = await fixture(t, { chatProvider: { status: chatStatus, invoke: async () => { throw new Error("sk-provider-secret"); } } });
  const next = await g.session(); const connection = await g.connect(); connection.send("agent.run", { ...next, prompt: "失败输入" });
  const error = await connection.until((m) => m.event?.type === "run.failed"); assert.equal(JSON.stringify(error).includes("sk-provider-secret"), false); assert.match(error.event.error.message, /不会自动重试/);
});

test("Agent reference edit stays scoped, deduplicates tool calls and persists fresh media references", async (t) => {
  let generated = 0; let referenceImages;
  const f = await fixture(t, { provider: { status: () => ({ configured: true, defaultProfileId: "image-a", profiles: [{ id: "image-a", name: "图片", model: "image", configured: true }] }), generate: async (payload) => { generated++; referenceImages = payload.referenceImages; return { buffer: PNG, mime: "image/png", model: "image" }; } }, chatProvider: { status: chatStatus, invoke: async (request) => { const args = { prompt: "变成暖色", profileId: "image-a", referenceImageIds: ["reference-element"] }; const first = await request.executeTool("edit_image", args, "edit-once"); const second = await request.executeTool("edit_image", args, "edit-once"); assert.equal(first.elementId, second.elementId); return { text: "已处理参考图片。" }; } } });
  const ids = await f.session(); const content = { elements: [{ id: "reference-element", type: "image", fileId: "original-file", x: 0, y: 0, width: 100, height: 100 }], appState: {}, files: { "original-file": { id: "original-file", dataURL: `data:image/png;base64,${PNG.toString("base64")}`, mimeType: "image/png", created: 1 } } };
  await f.api(`/api/canvases/${ids.canvasId}`, { method: "PUT", body: { content } });
  const ws = await f.connect(); ws.send("agent.run", { ...ids, prompt: "把选中的图改成暖色" }); await ws.until((m) => m.event?.type === "run.completed");
  assert.equal(generated, 1); assert.equal(referenceImages.length, 1); assert.equal(referenceImages[0].dataUrl, content.files["original-file"].dataURL);
  const canvas = await (await f.api(`/api/canvases/${ids.canvasId}`)).json(); assert.equal(canvas.canvas.content.elements.length, 2);
  const event = ws.messages.find((m) => m.event?.type === "tool.completed" && m.event.toolName === "edit_image"); assert.ok(event.event.output.elementId); assert.match(event.event.artifacts[0].url, /\?cap=/);
  const mediaResponse = await fetch(`${f.info.baseUrl}${event.event.artifacts[0].url}`); assert.equal(mediaResponse.status, 200);
  const file = path.join(f.root, "ai-design-v1", "projects", createHash("sha256").update("hub-a").digest("hex").slice(0, 32), "workspace.json"); const source = await fs.readFile(file, "utf8"); assert.equal(source.includes("?cap="), false); assert.equal(source.includes(f.token), false);
  const oldToken = f.token; ws.socket.terminate(); await f.service.stop(); await f.start();
  const history = await (await f.api(`/api/sessions/${ids.sessionId}/messages`)).json(); const artifact = history.messages[1].contentBlocks.find((block) => block.type === "tool").artifacts[0]; assert.match(artifact.url, new RegExp(f.token)); assert.equal(artifact.url.includes(oldToken), false);
});

test("original multipart uploads and image generation reject foreign references", async (t) => {
  const received = [];
  const f = await fixture(t, { provider: { status: () => ({ configured: true, defaultProfileId: "image-a", profiles: [{ id: "image-a", name: "图片", model: "image", configured: true }] }), generate: async (body) => { received.push(body); return { buffer: PNG, mime: "image/png", model: "image" }; } } });
  const { canvasId } = await f.session(); const form = new FormData(); form.set("file", new Blob([PNG], { type: "image/png" }), "reference.png");
  const uploaded = await (await f.api("/api/uploads", { method: "POST", form })).json(); assert.ok(uploaded.asset.id);
  const generated = await f.api("/api/agent/generate-image", { method: "POST", body: { prompt: "参考图编辑", canvasId, model: "image-a", referenceImageIds: [uploaded.asset.id], requestId: "direct-edit" } });
  assert.equal(generated.status, 200); assert.equal(received.length, 1); assert.equal(received[0].referenceImages.length, 1);
  const denied = await f.api("/api/agent/generate-image", { method: "POST", body: { prompt: "不能读取外部路径", canvasId, model: "image-a", referenceImageIds: ["http://169.254.169.254/latest"], requestId: "foreign-reference" } }); assert.equal(denied.status, 404); assert.equal(received.length, 1);
});

test("direct image controls reach the provider and request IDs include ratio and resolution", async (t) => {
  const received = [];
  const f = await fixture(t, { provider: { status: () => ({ configured: true, profiles: [{ id: "image-a", configured: true }] }), generate: async payload => { received.push(payload); return { buffer: PNG, mime: "image/png" }; } } });
  const { canvasId } = await f.session();
  const body = { prompt: "购物中心立面", canvasId, model: "image-a", requestId: "canvas-2k-wide", aspectRatio: "16:9", quality: "hd" };
  const first = await f.api("/api/agent/generate-image", { method: "POST", body });
  assert.equal(first.status, 200);
  assert.equal(received[0].aspectRatio, "16:9"); assert.equal(received[0].resolution, "2K");
  assert.equal((await f.api("/api/agent/generate-image", { method: "POST", body })).status, 200);
  for (const change of [{ quality: "ultra" }, { aspectRatio: "4:3" }]) {
    const conflict = await f.api("/api/agent/generate-image", { method: "POST", body: { ...body, ...change } });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "request_conflict");
  }
  await f.service.stop(); await f.start();
  assert.equal((await f.api("/api/agent/generate-image", { method: "POST", body })).status, 200);
  assert.equal(received.length, 1, "retries and restart replay the recorded result");
  for (const change of [{ quality: "8K" }, { aspectRatio: "17:9" }, { resolution: "8K" }]) {
    assert.equal((await f.api("/api/agent/generate-image", { method: "POST", body: { ...body, requestId: "invalid-controls", ...change } })).status, 400);
  }
  assert.equal(received.length, 1, "invalid controls never reach a model");
});

test("local image receipts recover completed results across refresh and restart without resubmitting", async (t) => {
  let finish, entered; let calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { provider: { status: () => ({ configured: true, profiles: [{ id: "image-a", configured: true }] }), generate: async () => { calls++; entered(); return new Promise(resolve => { finish = resolve; }); } } });
  const { canvasId } = await f.session();
  const request = f.api("/api/agent/generate-image", { method: "POST", body: { prompt: "别墅", canvasId, model: "image-a", requestId: "recover-villa" } });
  await started;
  const route = `/api/canvases/${canvasId}/image-generations`;
  let receipt = (await (await f.api(route)).json()).generations[0];
  assert.equal(receipt.status, "generating"); assert.equal(receipt.requestId, "recover-villa");
  finish({ buffer: PNG, mime: "image/png" }); assert.equal((await request).status, 200);
  await f.service.stop(); await f.start();
  receipt = (await (await f.api(route)).json()).generations[0];
  assert.equal(receipt.status, "completed"); assert.equal(receipt.prompt, "别墅"); assert.equal(receipt.profileId, "image-a");
  assert.ok(receipt.images[0].url.startsWith("/api/local/media/"));
  assert.equal((await f.api(receipt.images[0].url)).status, 200);
  assert.equal((await f.api(route, { hubId: "hub-b" })).status, 404);
  assert.equal(calls, 1, "receipt reads and restart never call the model again");
  await f.service.stop();
  const scope = createHash("sha256").update("hub-a").digest("hex").slice(0, 32);
  const file = path.join(f.root, "ai-design-v1", "projects", scope, "workspace.json");
  const state = JSON.parse(await fs.readFile(file, "utf8")); delete state.generationRequests["recover-villa"].result; await fs.writeFile(file, JSON.stringify(state));
  await f.start();
  assert.equal((await (await f.api(route)).json()).generations[0].status, "unknown");
  assert.equal(calls, 1);
});

test("reconnect resumes an active original WS stream and cancellation persists", async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { chatProvider: { status: chatStatus, invoke: async ({ signal, onDelta }) => { await onDelta("这是一条待取消的模拟流。"); entered(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } } });
  const ids = await f.session(); const first = await f.connect(); first.send("agent.run", { ...ids, prompt: "测试恢复连接" }); await started;
  const second = await f.connect(); second.send("canvas.resume", { canvasId: ids.canvasId, lastSeq: 0 });
  const resumed = await second.until((m) => m.type === "command.ack" && m.action === "canvas.resume"); assert.ok(resumed.payload.activeRunId); assert.ok(resumed.payload.replayed >= 2); assert.equal(second.messages[0].type, "command.ack");
  await second.until((m) => m.event?.type === "message.delta"); second.send("agent.cancel", { runId: resumed.payload.activeRunId }); await second.until((m) => m.event?.type === "run.canceled");
  const history = await (await f.api(`/api/sessions/${ids.sessionId}/messages`)).json(); assert.equal(history.messages[1].status, "canceled"); assert.match(history.messages[1].contentBlocks.at(-1).text, /已停止/);
});

test("model catalogs expose actual configured IDs and map image model names without fallback", async (t) => {
  let textModel = "configured-text-a"; const generated = [];
  const f = await fixture(t, { chatProvider: { status: () => ({ configured: true, defaultModel: textModel, models: [{ id: textModel, name: "当前实际文本模型", provider: "hub" }] }), invoke: async () => ({ text: "未使用" }) }, listMediaModels: () => ({ profiles: [{ id: "video-one", category: "video", name: "已保存视频", model: "actual-video-model", enabled: true, hasApiKey: true }] }), provider: { status: () => ({ configured: true, defaultProfileId: "image-id", profiles: [{ id: "image-id", name: "实际图片", model: "configured-image-model", configured: true }] }), generate: async (body) => { generated.push(body); return { buffer: PNG, mime: "image/png", model: "configured-image-model" }; } } });
  const first = await (await f.api("/api/models")).json(); assert.deepEqual(first.models.map((m) => m.id), ["configured-text-a"]); assert.equal(first.defaultModel, "configured-text-a");
  assert.equal((await f.api("/api/workspace/settings", { method: "PUT", body: { defaultModel: "configured-text-a" } })).status, 200);
  textModel = "configured-text-b"; const settings = await (await f.api("/api/workspace/settings")).json(); assert.equal(settings.settings.defaultModel, "configured-text-b");
  const videos = await (await f.api("/api/video-models")).json(); assert.equal(videos.models[0].id, "video-one"); assert.equal(videos.models[0].accessible, true); assert.equal(videos.models[0].capabilities.textToVideo, true); assert.match(videos.models[0].description, /本机统一配置/);
  const result = await f.api("/api/agent/generate-image", { method: "POST", body: { prompt: "按真实模型名称选择", model: "configured-image-model", requestId: "name-mapping" } }); assert.equal(result.status, 200); assert.equal(generated[0].profileId, "image-id");
  const rejected = await f.api("/api/agent/generate-image", { method: "POST", body: { prompt: "不应fallback", model: "unconfigured-model", requestId: "unknown-model" } }); assert.equal(rejected.status, 503); assert.equal(generated.length, 1);
});

test("local video generation stores MP4 media, maps sizes and rejects reference frames", async (t) => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(16)]);
  const calls = [];
  const videoProvider = { status: () => ({ configured: true, defaultProfileId: "video-id", profiles: [{ id: "video-id", name: "视频", model: "video-model", configured: true }] }), generate: async (payload) => { calls.push(payload); return { buffer: MP4, mime: "video/mp4", model: "video-model" }; } };
  const f = await fixture(t, { videoProvider });
  const context = await (await f.api("/api/local/context")).json(); assert.equal(context.capabilities.videoGeneration, true);
  const { canvasId } = await f.session();
  const ok = await f.api("/api/agent/generate-video", { method: "POST", body: { prompt: "清晨的空间漫游", canvasId, model: "video-id", duration: 6, resolution: "1080p", aspectRatio: "16:9", requestId: "video-1" } });
  assert.equal(ok.status, 200); const result = await ok.json();
  assert.equal(result.width, 1920); assert.equal(result.height, 1080); assert.equal(result.durationSeconds, 6); assert.equal(result.mimeType, "video/mp4"); assert.match(result.url, /^\/api\/local\/media\/m-/); assert.ok(result.assetId);
  assert.equal(calls.length, 1); assert.equal(calls[0].size, "1920x1080"); assert.equal(calls[0].seconds, 6); assert.equal(calls[0].profileId, "video-id");
  const media = await fetch(`${f.info.baseUrl}${result.url}`); assert.equal(media.status, 200); assert.equal(media.headers.get("content-type"), "video/mp4");
  const vertical = await f.api("/api/agent/generate-video", { method: "POST", body: { prompt: "竖屏空间", canvasId, resolution: "720p", aspectRatio: "9:16", requestId: "video-2" } });
  assert.equal(vertical.status, 200); const verticalResult = await vertical.json(); assert.equal(verticalResult.width, 720); assert.equal(verticalResult.height, 1280); assert.equal(calls[1].size, "720x1280");
  const withFrames = await f.api("/api/agent/generate-video", { method: "POST", body: { prompt: "带首帧", canvasId, inputImages: ["data:image/png;base64,QUJD"], requestId: "video-3" } });
  assert.equal(withFrames.status, 400); assert.match((await withFrames.json()).error.message, /参考图/); assert.equal(calls.length, 2);
  const deduped = await f.api("/api/agent/generate-video", { method: "POST", body: { prompt: "清晨的空间漫游", canvasId, model: "video-id", duration: 6, resolution: "1080p", aspectRatio: "16:9", requestId: "video-1" } });
  assert.equal(deduped.status, 200); assert.deepEqual(await deduped.json(), result); assert.equal(calls.length, 2);
  const unconfigured = await fixture(t, {});
  const missing = await unconfigured.api("/api/agent/generate-video", { method: "POST", body: { prompt: "无配置", requestId: "video-x" } });
  assert.equal(missing.status, 503); assert.match((await missing.json()).error.message, /统一设置/);
  const missingContext = await (await unconfigured.api("/api/local/context")).json(); assert.equal(missingContext.capabilities.videoGeneration, false);
  const credits = await (await f.api("/api/credits")).json(); assert.equal(credits.plan, "business"); assert.ok(credits.balance > 0);
  assert.equal((await f.api("/api/credits/claim-daily", { method: "POST" })).status, 200);
});

test("style kits support local CRUD, project binding and automatic style referencing", async (t) => {
  const generated = []; let received;
  const f = await fixture(t, { provider: { status: () => ({ configured: true, defaultProfileId: "image-a", profiles: [{ id: "image-a", name: "图片", model: "image", configured: true }] }), generate: async (body) => { generated.push(body); return { buffer: PNG, mime: "image/png", model: "image" }; } }, chatProvider: { status: chatStatus, invoke: async (request) => { received = request; const kit = await request.executeTool("get_brand_kit", {}, "kit-lookup"); assert.equal(kit.bound, true); assert.equal(kit.kit_name, "暖木风格"); return { text: "已按风格套件回答。" }; } } });
  assert.deepEqual((await (await f.api("/api/brand-kits")).json()).brandKits, []);
  const created = await f.api("/api/brand-kits", { method: "POST", body: { name: "暖木风格" } }); assert.equal(created.status, 201);
  const kit = await created.json(); assert.equal(kit.name, "暖木风格"); assert.deepEqual(kit.assets, []);
  assert.equal((await f.api(`/api/brand-kits/${kit.id}`, { method: "PATCH", body: { guidance_text: "以暖木色与留白为主，空间设计保持材质统一。" } })).status, 200);
  const color = await (await f.api(`/api/brand-kits/${kit.id}/assets`, { method: "POST", body: { asset_type: "color", display_name: "主木色", text_content: "#8B5A2B", role: "primary" } })).json(); assert.equal(color.asset_type, "color");
  const form = new FormData(); form.set("asset_type", "logo"); form.set("file", new Blob([PNG], { type: "image/png" }), "logo.png");
  const logo = await (await f.api(`/api/brand-kits/${kit.id}/assets/upload`, { method: "POST", form })).json(); assert.match(logo.file_url, /^\/api\/local\/media\/m-/);
  const badAsset = await f.api(`/api/brand-kits/${kit.id}/assets`, { method: "POST", body: { asset_type: "video", display_name: "无效" } }); assert.equal(badAsset.status, 400);
  const list = await (await f.api("/api/brand-kits")).json(); assert.deepEqual(list.brandKits[0].asset_counts, { color: 1, font: 0, logo: 1, image: 0 });
  const copied = await (await f.api(`/api/brand-kits/${kit.id}/duplicate`, { method: "POST" })).json(); assert.equal(copied.assets.length, 2); assert.match(copied.name, /副本/);
  assert.equal((await f.api(`/api/brand-kits/${copied.id}/assets/${copied.assets[0].id}`, { method: "PATCH", body: { display_name: "改名" } })).status, 200);
  assert.equal((await f.api(`/api/brand-kits/${copied.id}`, { method: "DELETE" })).status, 200);
  const { projects } = await (await f.api("/api/projects")).json(); const projectId = projects[0].id; const canvasId = projects[0].canvasId;
  assert.equal((await f.api(`/api/projects/${projectId}`, { method: "PATCH", body: { brand_kit_id: kit.id } })).status, 200);
  assert.equal((await (await f.api(`/api/projects/${projectId}`)).json()).project.brand_kit_id, kit.id);
  assert.equal((await f.api(`/api/projects/${projectId}`, { method: "PATCH", body: { brand_kit_id: "k-missing" } })).status, 404);
  const direct = await f.api("/api/agent/generate-image", { method: "POST", body: { prompt: "客厅效果图", canvasId, model: "image-a", requestId: "style-kit-direct" } }); assert.equal(direct.status, 200);
  assert.match(generated.at(-1).prompt, /风格套件「暖木风格」约束/); assert.match(generated.at(-1).prompt, /#8B5A2B/);
  const ids = await f.session(); const ws = await f.connect();
  ws.send("agent.run", { ...ids, prompt: "按项目风格出方案" });
  await ws.until((m) => m.event?.type === "run.completed");
  assert.equal(received.styleKit.kit_name, "暖木风格"); assert.equal(received.styleKit.colors[0].hex, "#8B5A2B"); assert.ok(received.styleKit.logos[0].mediaId);
  const toolEvent = ws.messages.find((m) => m.event?.type === "tool.completed" && m.event.toolName === "get_brand_kit"); assert.equal(toolEvent.event.output.bound, true);
  assert.equal((await f.api(`/api/brand-kits/${kit.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await (await f.api(`/api/projects/${projectId}`)).json()).project.brand_kit_id, null);
  ws.socket.terminate();
});
