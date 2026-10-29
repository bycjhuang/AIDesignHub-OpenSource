"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { createLoomicLocalService } = require("../backend/loomic-local.cjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p0AAAAASUVORK5CYII=", "base64");
async function fixture(t, provider, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adh-loomic-test-"));
  const staticRoot = path.join(root, "out");
  await fs.mkdir(path.join(staticRoot, "hub"), { recursive: true });
  await fs.writeFile(path.join(staticRoot, "hub", "index.html"), "<!doctype html><title>本机画布</title>");
  let service; let info; let token;
  const start = async (projectId = "hub-a") => {
    service = createLoomicLocalService({ dataDir: root, staticRoot, provider, ...options });
    info = await service.start({ projectId, projectName: `名称 ${projectId}` });
    const response = await fetch(info.url, { redirect: "manual" });
    assert.equal(response.status, 302);
    token = new URLSearchParams(new URL(response.headers.get("location"), info.baseUrl).hash.slice(1)).get("loomic-cap");
    return { response, info };
  };
  await start();
  t.after(async () => { await service.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const api = (route, { method = "GET", body, hubId = "hub-a", headers = {} } = {}) => fetch(`${info.baseUrl}${route}`, { method, headers: { "X-Loomic-Token": token, "X-Loomic-Project": hubId, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { root, staticRoot, api, start, get service() { return service; }, get info() { return info; } };
}

test("canvas documents persist binary data and isolate each Hub project", async (t) => {
  const f = await fixture(t);
  let list = await (await f.api("/api/projects")).json();
  assert.equal(list.projects.length, 1);
  const canvasId = list.projects[0].canvasId;
  const content = { elements: [{ id: "rect-1", type: "rectangle", x: 123 }], appState: { viewBackgroundColor: "#fff" }, files: { asset: { dataURL: `data:image/png;base64,${PNG.toString("base64")}`, mimeType: "image/png" } } };
  assert.equal((await f.api(`/api/canvases/${canvasId}`, { method: "PUT", body: { content } })).status, 200);
  assert.equal((await f.api(`/api/canvases/${canvasId}`, { method: "GET", hubId: "hub-b" })).status, 404);
  await f.service.open({ projectId: "hub-b", projectName: "项目B" });
  const listB = await (await f.api("/api/projects", { hubId: "hub-b" })).json();
  assert.notEqual(listB.projects[0].canvasId, canvasId);
  await f.service.stop();
  await f.start();
  const restored = await (await f.api(`/api/canvases/${canvasId}`)).json();
  assert.deepEqual(restored.canvas.content, content);
  const invalid = await f.api(`/api/canvases/${canvasId}`, { method: "PUT", body: { content: { elements: null, appState: {} } } });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await (await f.api(`/api/canvases/${canvasId}`)).json()).canvas.content, content);
});

test("private API rejects missing credentials, external origins and forged Host", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.info.baseUrl}/api/projects`)).status, 401);
  assert.equal((await f.api("/api/projects", { headers: { Origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await f.api("/api/projects", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const denied = await new Promise((resolve, reject) => { const req = http.get(`${f.info.baseUrl}/api/projects`, { headers: { Host: "attacker.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); });
  assert.equal(denied, 403);
  const page = await fetch(`${f.info.baseUrl}/hub/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal((await f.api("/api/payments/checkout", { method: "POST", body: {} })).status, 503);
});

test("corrupt local state is preserved without silent reset", async (t) => {
  const f = await fixture(t);
  await f.service.stop();
  const dir = path.join(f.root, "ai-design-v1", "projects", createHash("sha256").update("hub-a").digest("hex").slice(0, 32));
  const file = path.join(dir, "workspace.json");
  await fs.writeFile(file, "broken original file");
  await assert.rejects(f.start(), /原文件已保留/);
  assert.equal(await fs.readFile(file, "utf8"), "broken original file");
});

test("provider is explicit, secrets are not returned, generated media stays local", async (t) => {
  let calls = 0; let config;
  const provider = { status: async () => ({ configured: true, baseUrl: "https://provider.invalid/v1", model: "image-local", apiKey: "private-key" }), saveConfig: async (value) => { config = value; }, generate: async () => { calls++; return { buffer: PNG, mime: "image/png", model: "image-local" }; } };
  const f = await fixture(t, provider);
  const status = await (await f.api("/api/local/provider")).json();
  assert.equal(status.configured, true); assert.equal(status.apiKey, undefined); assert.equal(JSON.stringify(status).includes("private-key"), false);
  assert.equal((await f.api("/api/local/provider", { method: "PUT", body: { baseUrl: "https://provider.invalid/v1", model: "image-local", apiKey: "new-private-key" } })).status, 200);
  assert.equal(config.apiKey, "new-private-key");
  const body = { prompt: "一棵树", requestId: "req-image-1", size: "1024x1024" };
  const generated = await (await f.api("/api/local/generate", { method: "POST", body })).json();
  assert.match(generated.images[0].url, /^\/api\/local\/media\//);
  assert.equal(calls, 1);
  assert.equal((await fetch(`${f.info.baseUrl}${generated.images[0].url.split("?")[0]}`)).status, 401);
  assert.equal((await fetch(`${f.info.baseUrl}${generated.images[0].url}`)).status, 200, "media URL itself carries an explicit session capability");
  const image = await f.api(generated.images[0].url);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  await f.api("/api/local/generate", { method: "POST", body });
  assert.equal(calls, 1);
  await f.service.stop(); await f.start();
  await f.api("/api/local/generate", { method: "POST", body });
  assert.equal(calls, 1, "persisted request ID prevents paid replay across restarts");
  assert.equal((await f.api("/api/local/generate", { method: "POST", body: { ...body, prompt: "另一棵树" } })).status, 409);
});

test("uncertain provider failures never retry or expose raw error secrets", async (t) => {
  let calls = 0;
  const f = await fixture(t, { status: async () => ({ configured: true }), generate: async () => { calls++; throw new Error("secret-api-key-at-provider"); } });
  const body = { prompt: "一棵树", requestId: "req-uncertain" };
  for (let i = 0; i < 2; i++) {
    const response = await f.api("/api/local/generate", { method: "POST", body });
    assert.equal(response.status, 502); const text = await response.text(); assert.equal(text.includes("secret-api-key"), false); assert.match(text, /不会自动重试/);
  }
  assert.equal(calls, 1);
  await f.service.stop(); await f.start();
  assert.equal((await f.api("/api/local/generate", { method: "POST", body })).status, 502);
  assert.equal(calls, 1);
});

test("unconfigured generation is unavailable and never calls a provider", async (t) => {
  const f = await fixture(t);
  const context = await (await f.api("/api/local/context")).json();
  assert.equal(context.capabilities.imageGeneration, false);
  assert.equal((await f.api("/api/local/generate", { method: "POST", body: { prompt: "一棵树", requestId: "request-unconfigured" } })).status, 503);
});

test("configured profile selection is forwarded while unknown profiles never submit", async (t) => {
  const received = [];
  const f = await fixture(t, { status: async () => ({ configured: true, defaultProfileId: "image-a", profiles: [{ id: "image-a", name: "图片A", model: "a", configured: true, apiKey: "hidden-key" }, { id: "image-b", name: "图片B", model: "b", configured: true }] }), generate: async (payload) => { received.push(payload); return { buffer: PNG, mime: "image/png", model: "b" }; } });
  const status = await (await f.api("/api/local/provider")).json();
  assert.equal(status.defaultProfileId, "image-a"); assert.equal(status.profiles.length, 2); assert.equal(JSON.stringify(status).includes("hidden-key"), false);
  const body = { prompt: "树", profileId: "unknown", requestId: "profile-1" };
  assert.equal((await f.api("/api/local/generate", { method: "POST", body })).status, 503); assert.equal(received.length, 0);
  assert.equal((await f.api("/api/local/generate", { method: "POST", body: { ...body, profileId: "image-b" } })).status, 200);
  assert.equal(received[0].profileId, "image-b"); assert.equal(received.length, 1);
});

test("pending generation journal survives a crash without resubmitting", async (t) => {
  let calls = 0;
  const f = await fixture(t, { status: async () => ({ configured: true }), generate: async () => { calls++; return { buffer: PNG, mime: "image/png" }; } });
  const body = { prompt: "树", requestId: "crash-journal" };
  assert.equal((await f.api("/api/local/generate", { method: "POST", body })).status, 200);
  await f.service.stop();
  const file = path.join(f.root, "ai-design-v1", "projects", createHash("sha256").update("hub-a").digest("hex").slice(0, 32), "workspace.json");
  const state = JSON.parse(await fs.readFile(file, "utf8")); delete state.generationRequests[body.requestId].result;
  await fs.writeFile(file, JSON.stringify(state)); await f.start();
  const response = await f.api("/api/local/generate", { method: "POST", body });
  assert.equal(response.status, 409); assert.match(await response.text(), /不会重复提交/); assert.equal(calls, 1);
});

test("concurrent double submission shares one provider request", async (t) => {
  let calls = 0; let finish; let submitted;
  const entered = new Promise((resolve) => { submitted = resolve; });
  const providerResult = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { status: async () => ({ configured: true }), generate: async () => { calls++; submitted(); return providerResult; } });
  const body = { prompt: "树", requestId: "double-submit" };
  const first = f.api("/api/local/generate", { method: "POST", body }); await entered;
  const second = f.api("/api/local/generate", { method: "POST", body });
  const other = await f.api("/api/local/generate", { method: "POST", body: { ...body, requestId: "second-request" } });
  assert.equal(other.status, 409);
  finish({ buffer: PNG, mime: "image/png" });
  assert.deepEqual(await (await first).json(), await (await second).json()); assert.equal(calls, 1);
});

test("switching the host project revokes cached canvas, media and generation access", async (t) => {
  let activeProjectId = "hub-a"; let calls = 0;
  const f = await fixture(t, { status: async () => ({ configured: true }), generate: async () => { calls++; return { buffer: PNG, mime: "image/png" }; } }, { getProject: (id) => id === activeProjectId ? { name: `当前项目 ${id}` } : null });
  const { projects } = await (await f.api("/api/projects")).json(); const canvasId = projects[0].canvasId;
  const content = { elements: [{ id: "saved-in-a", type: "rectangle" }], appState: {}, files: {} };
  assert.equal((await f.api(`/api/canvases/${canvasId}`, { method: "PUT", body: { content } })).status, 200);
  const image = await (await f.api("/api/local/generate", { method: "POST", body: { canvasId, prompt: "项目A图片", requestId: "before-switch" } })).json();
  assert.equal((await f.api(image.images[0].url)).status, 200);
  const projectDir = path.join(f.root, "ai-design-v1", "projects", createHash("sha256").update("hub-a").digest("hex").slice(0, 32));
  const file = path.join(projectDir, "workspace.json"); const before = await fs.readFile(file); const mediaDir = path.join(projectDir, "media"); const mediaFile = path.join(mediaDir, (await fs.readdir(mediaDir))[0]); const beforeImage = await fs.readFile(mediaFile);
  activeProjectId = "hub-b"; await f.service.open({ projectId: "hub-b", projectName: "项目B" });
  assert.equal((await f.api("/api/projects")).status, 404);
  assert.equal((await f.api(`/api/canvases/${canvasId}`)).status, 404);
  assert.equal((await f.api(`/api/canvases/${canvasId}`, { method: "PUT", body: { content: { ...content, elements: [] } } })).status, 404);
  assert.equal((await f.api(image.images[0].url)).status, 404);
  assert.equal((await f.api("/api/local/generate", { method: "POST", body: { canvasId, prompt: "旧页面不能再次提交", requestId: "after-switch" } })).status, 404);
  assert.equal((await f.api("/api/local/generate", { method: "POST", body: { prompt: "无canvasID也不能绕过", requestId: "after-switch-no-canvas" } })).status, 404);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(mediaFile), beforeImage);
  assert.equal((await f.api("/api/projects", { hubId: "hub-b" })).status, 200);
});
