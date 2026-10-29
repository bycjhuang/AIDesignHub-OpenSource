"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { MediaModelService } = require("../backend/media-model-service.cjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p0AAAAASUVORK5CYII=", "base64");
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adh-media-model-test-"));
  const key = crypto.randomBytes(32);
  const secrets = {
    protectSecret(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const content = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), content]).toString("base64"); },
    unprotectSecret(value) { const buffer = Buffer.from(value, "base64"); const decipher = crypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8"); },
  };
  const config = { dataDir, ...secrets, fetchImpl: async () => { throw new Error("Unexpected network call"); }, ...options };
  const service = new MediaModelService(config);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { service, config, dataDir, file: path.join(dataDir, "media-private", "profiles-v1.json") };
}
function saveImage(service, override = {}) { return service.save({ category: "image", name: "图片模型", apiType: "openai-compatible", baseUrl: "https://image-provider.example/v1", model: "gpt-image-1.5", apiKey: "test-private-secret", enabled: true, ...override }); }

test("editing sends scoped reference pixels once through multipart images/edits", async (t) => {
  const calls = [];
  const { service } = fixture(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { headers: { "content-type": "application/json" } }); } });
  saveImage(service);
  const result = await service.getImageProvider().generate({ prompt: "将这张图改为暖色调", referenceImages: [{ dataUrl: `data:image/png;base64,${PNG.toString("base64")}` }] });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://image-provider.example/v1/images/edits");
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.headers["Content-Type"], undefined);
  assert.equal(calls[0].options.body.get("n"), "1"); assert.equal(calls[0].options.body.get("response_format"), null);
  assert.deepEqual(Buffer.from(await calls[0].options.body.get("image[]").arrayBuffer()), PNG);
  assert.deepEqual(result.buffer, PNG);
});

test("invalid or excessive editing references do not reach a provider", async (t) => {
  let calls = 0;
  const { service } = fixture(t, { fetchImpl: async () => { calls++; throw new Error("unexpected call"); } });
  saveImage(service);
  await assert.rejects(service.generateImage({ prompt: "编辑", referenceImages: ["https://example.com/private.png"] }), /图片/);
  await assert.rejects(service.generateImage({ prompt: "编辑", referenceImages: Array(5).fill(`data:image/png;base64,${PNG.toString("base64")}`) }), /4张/);
  assert.equal(calls, 0);
});

test("image/video profiles are encrypted and shared through one device snapshot", (t) => {
  const f = fixture(t);
  const first = saveImage(f.service); const imageId = first.profiles[0].id;
  const all = f.service.save({ category: "video", name: "视频模型", baseUrl: "https://video-provider.example/v1", model: "video-test", apiKey: "video-private-secret" });
  assert.equal(all.profiles.length, 2); assert.equal(all.defaults.image, imageId); assert.ok(all.defaults.video);
  assert.equal(all.profiles[0].hasApiKey, true);
  const source = fs.readFileSync(f.file, "utf8"); assert.equal(source.includes("test-private-secret"), false); assert.equal(source.includes("video-private-secret"), false);
  assert.equal(JSON.stringify(all).includes("encryptedApiKey"), false);
  assert.deepEqual(new MediaModelService(f.config).snapshot(), all);
  const provider = f.service.getImageProvider(); const status = provider.status();
  assert.equal(status.configured, true); assert.equal(status.defaultProfileId, imageId); assert.equal(status.profiles[0].configured, true);
  assert.throws(() => provider.saveConfig({}), /统一设置/);
});

test("blank key preserves ciphertext but changing endpoint requires an explicit new key", (t) => {
  const f = fixture(t); const first = saveImage(f.service); const id = first.profiles[0].id;
  const cipher = JSON.parse(fs.readFileSync(f.file, "utf8")).profiles[0].encryptedApiKey;
  f.service.save({ id, name: "改名", model: "another-image-model", apiKey: "" });
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).profiles[0].encryptedApiKey, cipher);
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => f.service.save({ id, baseUrl: "https://other-provider.example/v1", apiKey: "" }), /更换服务地址/);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.throws(() => f.service.save({ id, baseUrl: "https://api.bycjdesign.com/v1", apiKey: "new-key" }), /不连接BYCJ网站/);
  assert.throws(() => f.service.save({ id, baseUrl: "https://user:pass@provider.example/v1", apiKey: "new-key" }), /不能含账号密码/);
});

test("new profile on a provider with a saved key reuses it without retyping", (t) => {
  const f = fixture(t); saveImage(f.service);
  const second = f.service.save({ category: "image", name: "同服务第二个模型", apiType: "openai-compatible", baseUrl: "https://image-provider.example/v1", model: "another-model" });
  assert.equal(second.profiles.length, 2); assert.equal(second.profiles[1].hasApiKey, true);
  const source = fs.readFileSync(f.file, "utf8"); assert.equal(source.includes("test-private-secret"), false);
  assert.throws(() => f.service.save({ category: "image", name: "陌生地址", baseUrl: "https://unknown-provider.example/v1", model: "x" }), /API Key/);
});

test("unavailable encryption refuses keys without plaintext fallback", (t) => {
  const f = fixture(t, { protectSecret: undefined, unprotectSecret: undefined });
  assert.throws(() => saveImage(f.service), /不会以明文保存/);
  assert.equal(fs.existsSync(f.file), false); assert.equal(f.service.snapshot().profiles.length, 0);
  const g = fixture(t); saveImage(g.service);
  const locked = new MediaModelService({ ...g.config, unprotectSecret: () => { throw new Error("locked"); } });
  assert.equal(locked.getImageProvider().status().configured, false);
});

test("atomic write failure leaves disk and live configuration unchanged", (t) => {
  const f = fixture(t); const snapshot = saveImage(f.service); const before = fs.readFileSync(f.file, "utf8");
  t.mock.method(fs, "renameSync", () => { throw new Error("simulated disk failure"); });
  assert.throws(() => f.service.save({ id: snapshot.profiles[0].id, name: "保存失败的改名" }), /旧配置未修改/);
  assert.deepEqual(f.service.snapshot(), snapshot); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(fs.readdirSync(path.dirname(f.file)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("default selection and removal stay within each model category", (t) => {
  const f = fixture(t); const first = saveImage(f.service); const a = first.profiles[0].id;
  const second = saveImage(f.service, { name: "第二个图片模型", isDefault: true }); const b = second.profiles[1].id;
  assert.equal(second.defaults.image, b);
  assert.equal(f.service.save({ defaults: { image: a } }).defaults.image, a);
  assert.equal(f.service.save({ id: a, enabled: false }).defaults.image, b);
  assert.equal(f.service.remove({ id: b }).defaults.image, "");
  assert.throws(() => f.service.save({ defaults: { video: a } }), /该分类/);
});

test("explicit image generation sends exactly one paid request and returns validated bytes", async (t) => {
  const calls = [];
  const f = fixture(t, { fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 }); } });
  const snapshot = saveImage(f.service); assert.equal(calls.length, 0, "settings and snapshot never call models");
  const image = await f.service.getImageProvider().generate({ profileId: snapshot.profiles[0].id, prompt: "一棵树\n真实摄影", size: "1024x1024", model: "ignored-override" });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "https://image-provider.example/v1/images/generations");
  const request = calls[0][1]; const body = JSON.parse(request.body);
  assert.equal(body.n, 1); assert.equal(body.model, "gpt-image-1.5"); assert.equal(body.response_format, undefined); assert.equal(request.redirect, "error");
  assert.equal(request.headers.Authorization, "Bearer test-private-secret");
  assert.deepEqual(image.buffer, PNG); assert.equal(image.mime, "image/png");
  saveImage(f.service, { name: "兼容模型", model: "dall-e-3", isDefault: true });
  await f.service.getImageProvider().generate({ prompt: "一棵树" });
  assert.equal(JSON.parse(calls[1][1].body).response_format, "b64_json");
});

test("URL results use the safe public-image reader and never forward model credentials", async (t) => {
  const downloads = [];
  const f = fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ data: [{ url: "https://public-cdn.example/image.png" }] })), imageFetcher: async (...args) => { downloads.push(args); return { dataUrl: `data:image/png;base64,${PNG.toString("base64")}` }; } });
  saveImage(f.service);
  const result = await f.service.getImageProvider().generate({ prompt: "一棵树" });
  assert.deepEqual(result.buffer, PNG); assert.equal(downloads[0][1].maxBytes, 8 * 1024 * 1024); assert.equal(downloads[0][1].headers, undefined); assert.equal(downloads[0][1].credentials, undefined);
  const g = fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ data: [{ url: "http://127.0.0.1/private" }] })) });
  saveImage(g.service);
  await assert.rejects(g.service.getImageProvider().generate({ prompt: "树" }), /不会自动重试/);
});

test("HTTP errors and timeouts are safe and never retry", async (t) => {
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; return new Response("private-provider-secret-message", { status: 429 }); } });
  saveImage(f.service);
  await assert.rejects(f.service.getImageProvider().generate({ prompt: "树" }), (error) => error.message.includes("HTTP 429") && !error.message.includes("private-provider-secret"));
  assert.equal(calls, 1);
  let timeoutCalls = 0;
  const g = fixture(t, { timeoutMs: 10, fetchImpl: async (_url, { signal }) => { timeoutCalls++; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } });
  saveImage(g.service);
  await assert.rejects(g.service.getImageProvider().generate({ prompt: "树" }), /请求超时/); assert.equal(timeoutCalls, 1);
});

test("corrupt configuration is preserved and video configuration never implies generation", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, "broken-original");
  assert.throws(() => new MediaModelService(f.config), /原文件已保留/); assert.equal(fs.readFileSync(f.file, "utf8"), "broken-original");
  const g = fixture(t); g.service.save({ category: "video", name: "视频配置", model: "video-model", baseUrl: "https://video-provider.example/v1", apiKey: "video-secret" });
  assert.equal(g.service.getImageProvider().status().configured, false);
});

function saveApimartImage(service, override = {}) { return service.save({ category: "image", name: "APIMart图片", apiType: "apimart", baseUrl: "https://apimart.example/v1", model: "gpt-image-2", apiKey: "fixture-media-api-key-for-tests", enabled: true, ...override }); }
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(16)]);

test("apimart image generation submits a task, polls it and downloads the result without forwarding credentials", async (t) => {
  const calls = []; const downloads = [];
  const f = fixture(t, {
    videoPollIntervalMs: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/images/generations")) return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task_img_1" }] }));
      if (url.endsWith("/tasks/task_img_1")) return new Response(JSON.stringify({ code: 200, data: { id: "task_img_1", status: calls.length > 2 ? "completed" : "processing", result: { images: [{ url: ["https://cdn.apimart.example/f/image/a.png"] }] } } }));
      throw new Error(`unexpected url ${url}`);
    },
    imageFetcher: async (...args) => { downloads.push(args); return { dataUrl: `data:image/png;base64,${PNG.toString("base64")}` }; },
  });
  const snapshot = saveApimartImage(f.service);
  const result = await f.service.getImageProvider().generate({ profileId: snapshot.profiles[0].id, prompt: "一张建筑效果图", size: "1536x1024", referenceImages: [{ dataUrl: `data:image/png;base64,${PNG.toString("base64")}` }] });
  const submit = calls[0];
  assert.equal(submit.url, "https://apimart.example/v1/images/generations");
  const body = JSON.parse(submit.options.body);
  assert.equal(body.model, "gpt-image-2"); assert.equal(body.n, 1); assert.equal(body.size, "1536x1024"); assert.equal(body.response_format, undefined);
  assert.equal(body.image_urls.length, 1); assert.ok(body.image_urls[0].startsWith("data:image/png;base64,"));
  assert.equal(submit.options.headers.Authorization, "Bearer fixture-media-api-key-for-tests");
  assert.ok(calls.slice(1).every(call => call.url === "https://apimart.example/v1/tasks/task_img_1" && call.options.headers.Authorization === "Bearer fixture-media-api-key-for-tests"));
  assert.equal(downloads[0][0], "https://cdn.apimart.example/f/image/a.png"); assert.equal(downloads[0][1].headers, undefined);
  assert.deepEqual(result.buffer, PNG); assert.equal(result.model, "gpt-image-2");
});

test("apimart video generation maps canvas size and seconds then downloads the public video link", async (t) => {
  const calls = [];
  const f = fixture(t, {
    videoPollIntervalMs: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/videos/generations")) return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task_vid_1" }] }));
      if (url.endsWith("/tasks/task_vid_1")) return new Response(JSON.stringify({ code: 200, data: { id: "task_vid_1", status: "completed", result: { videos: [{ url: "https://cdn.apimart.example/f/video/a.mp4" }] } } }));
      if (url === "https://cdn.apimart.example/f/video/a.mp4") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      throw new Error(`unexpected url ${url}`);
    },
  });
  const snapshot = f.service.save({ category: "video", name: "APIMart视频", apiType: "apimart", baseUrl: "https://apimart.example/v1", model: "kling-v3-omni", apiKey: "fixture-media-api-key-for-tests" });
  const result = await f.service.getVideoProvider().generate({ profileId: snapshot.profiles.find(p => p.category === "video").id, prompt: "建筑漫游动画", size: "1920x1080", seconds: 5 });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "https://apimart.example/v1/videos/generations");
  assert.equal(body.model, "kling-v3-omni"); assert.equal(body.duration, 5); assert.equal(body.aspect_ratio, "16:9"); assert.equal(body.seconds, undefined);
  const content = calls.find(call => call.url === "https://cdn.apimart.example/f/video/a.mp4");
  assert.equal(content.options.headers?.Authorization, undefined, "the model key must not reach public result links");
  assert.deepEqual(result.buffer, MP4); assert.equal(result.mime, "video/mp4"); assert.equal(result.model, "kling-v3-omni");
});

test("APIMart preserves canvas ratios and resolution tiers for Gemini and GPT Image 2", async (t) => {
  const submissions = [];
  const { service } = fixture(t, {
    videoPollIntervalMs: 1,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/images/generations")) {
        submissions.push(JSON.parse(options.body));
        return Response.json({ data: [{ task_id: "canvas-image" }] });
      }
      return Response.json({ data: { status: "completed", result: { images: [{ url: ["https://cdn.example/result.png"] }] } } });
    },
    imageFetcher: async () => ({ dataUrl: `data:image/png;base64,${PNG.toString("base64")}` }),
  });
  for (const [model, aspectRatio, resolution] of [["gemini-nano-banana-2.1", "16:9", "2K"], ["gemini-3-pro-image-preview", "3:4", "4K"], ["gpt-image-2", "4:3", "2K"]]) {
    const snapshot = saveApimartImage(service, { model });
    await service.generateImage({ profileId: snapshot.profiles.at(-1).id, prompt: "购物中心立面", size: "1536x1024", aspectRatio, resolution });
    assert.deepEqual(submissions.at(-1), { model, prompt: "购物中心立面", n: 1, size: aspectRatio, resolution: model === "gpt-image-2" ? "2k" : resolution });
  }
  const snapshot = saveApimartImage(service, { model: "gemini-2.5-flash-image-preview" });
  await service.generateImage({ profileId: snapshot.profiles.at(-1).id, prompt: "旧接口像素尺寸", size: "1024x1024" });
  assert.equal(submissions.at(-1).size, "1:1");
  assert.equal(submissions.at(-1).resolution, undefined);
  assert.equal(submissions.length, 4, "one submission per explicit generation");
});

test("invalid image controls stop before submission and network failures remain safe", async (t) => {
  let calls = 0;
  const { service } = fixture(t, { fetchImpl: async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); } });
  saveApimartImage(service, { model: "gemini-nano-banana-2.1" });
  await assert.rejects(service.generateImage({ prompt: "立面", aspectRatio: "17:9" }), { code: "MEDIA_INVALID_REQUEST" });
  await assert.rejects(service.generateImage({ prompt: "立面", resolution: "8K" }), { code: "MEDIA_INVALID_REQUEST" });
  assert.equal(calls, 0);
  await assert.rejects(service.generateImage({ prompt: "立面", aspectRatio: "16:9", resolution: "2K" }), error => error.code === "MEDIA_NETWORK_UNAVAILABLE" && error.message.includes("代理") && !error.message.includes("fixture-media-api-key-for-tests"));
  assert.equal(calls, 1, "connection errors never submit an automatic retry");
});

test("apimart failures surface provider status once and never retry", async (t) => {
  let submitCalls = 0;
  const f = fixture(t, { videoPollIntervalMs: 1, fetchImpl: async () => { submitCalls++; return new Response(JSON.stringify({ error: { code: 402, message: "balance", type: "payment_required" } }), { status: 402 }); } });
  saveApimartImage(f.service);
  await assert.rejects(f.service.getImageProvider().generate({ prompt: "树" }), (error) => error.message.includes("HTTP 402") && !error.message.includes("balance"));
  assert.equal(submitCalls, 1);
  let polls = 0;
  const g = fixture(t, {
    videoPollIntervalMs: 1,
    fetchImpl: async (url) => {
      if (url.endsWith("/images/generations")) return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task_bad" }] }));
      polls++; return new Response(JSON.stringify({ code: 200, data: { id: "task_bad", status: "failed", error: { code: 500, message: "secret-upstream-detail", type: "server_error" } } }));
    },
  });
  saveApimartImage(g.service);
  await assert.rejects(g.service.getImageProvider().generate({ prompt: "树" }), (error) => error.code === "MEDIA_GENERATION_FAILED" && !error.message.includes("secret-upstream-detail"));
  assert.equal(polls, 1);
});

test("apimart apiType round-trips through configuration and unknown types stay rejected", (t) => {
  const f = fixture(t);
  const snapshot = saveApimartImage(f.service);
  assert.equal(snapshot.profiles[0].apiType, "apimart");
  assert.equal(new MediaModelService(f.config).snapshot().profiles[0].apiType, "apimart");
  assert.throws(() => f.service.save({ category: "image", name: "x", apiType: "other-gateway", baseUrl: "https://apimart.example/v1", model: "m", apiKey: "k" }), /接口/);
});
