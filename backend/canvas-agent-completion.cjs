'use strict';
const { usesResponsesApi, responsesRequest, responsesResult } = require('./text-model-protocol.cjs');

const ALLOWED_CANVAS_TOOLS = Object.freeze(['inspect_canvas', 'manipulate_canvas', 'generate_image', 'edit_image', 'get_brand_kit']);
const ALLOWED_NAMES = new Set(ALLOWED_CANVAS_TOOLS);
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ARGUMENT_BYTES = 32 * 1024;
class CanvasAgentCompletionError extends Error {
  constructor(code, message) { super(message); this.name = 'ModelServiceError'; this.code = code; }
}
function fail(code, message) { return new CanvasAgentCompletionError(code, message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function text(value, max, empty = false) { return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) && (empty || value.trim().length > 0); }
function keys(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.includes(key)); }
function validJson(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2048 && value.every(item => validJson(item, depth + 1));
  return plain(value) && Object.keys(value).length <= 512 && Object.entries(value).every(([key, item]) => !['__proto__', 'prototype', 'constructor'].includes(key) && validJson(item, depth + 1));
}
function json(value, max, code = 'MODEL_INVALID_CONTEXT') {
  let raw;
  try { raw = JSON.stringify(value); } catch { throw fail(code, '画布模型数据必须是有界的 JSON。'); }
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > max) throw fail(code, '画布模型数据超过请求上限。');
  if (!validJson(value)) throw fail(code, '画布模型数据包含不支持的结构。');
  return raw;
}
function toolCall(value, allowed, incoming) {
  const code = incoming ? 'MODEL_INVALID_RESPONSE' : 'MODEL_INVALID_CONTEXT';
  if (!keys(value, incoming ? ['id', 'type', 'function', 'index'] : ['id', 'type', 'function']) || incoming && value.index !== undefined && (!Number.isSafeInteger(value.index) || value.index < 0) || !text(value.id, 160) || !/^[A-Za-z0-9_.:-]+$/.test(value.id)
    || value.type !== 'function' || !keys(value.function, ['name', 'arguments']) || !ALLOWED_NAMES.has(value.function.name) || !allowed.has(value.function.name)) {
    throw fail(code, '画布模型包含未知或无效的工具调用。');
  }
  if (!text(value.function.arguments, MAX_ARGUMENT_BYTES, true) || Buffer.byteLength(value.function.arguments) > MAX_ARGUMENT_BYTES) throw fail(code, '画布工具参数超过上限或格式无效。');
  let args;
  try { args = JSON.parse(value.function.arguments); } catch { throw fail(code, '画布工具参数不是完整的 JSON 对象。'); }
  if (!plain(args)) throw fail(code, '画布工具参数必须是 JSON 对象。');
  json(args, MAX_ARGUMENT_BYTES, code);
  return { id: value.id, name: value.function.name, arguments: args };
}
function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 8) throw fail('MODEL_INVALID_TOOLS', '画布工具清单无效或过多。');
  json(tools, MAX_CONTEXT_BYTES, 'MODEL_INVALID_TOOLS');
  const allowed = new Set();
  for (const tool of tools) {
    if (!keys(tool, ['type', 'function']) || tool.type !== 'function' || !keys(tool.function, ['name', 'description', 'parameters', 'strict'])
      || !ALLOWED_NAMES.has(tool.function.name) || allowed.has(tool.function.name)
      || tool.function.description !== undefined && !text(tool.function.description, 8000, true)
      || !plain(tool.function.parameters) || tool.function.parameters.type !== 'object'
      || tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean') throw fail('MODEL_INVALID_TOOLS', '只允许已注册的画布工具。');
    allowed.add(tool.function.name);
  }
  return allowed;
}
function validateMessages(messages, tools, allowed) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 96) throw fail('MODEL_INVALID_CONTEXT', '画布模型消息数量无效。');
  json({ messages, tools }, MAX_CONTEXT_BYTES, 'MODEL_CONTEXT_LIMIT');
  const waiting = new Set();
  for (const message of messages) {
    if (!keys(message, ['role', 'content', 'tool_calls', 'tool_call_id']) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw fail('MODEL_INVALID_CONTEXT', '画布模型只接受有界的文本和工具消息。');
    if (message.role === 'tool') {
      if (Object.hasOwn(message, 'tool_calls') || !text(message.content, MAX_CONTEXT_BYTES, true) || !waiting.has(message.tool_call_id)) throw fail('MODEL_INVALID_CONTEXT', '画布工具结果与调用不匹配。');
      waiting.delete(message.tool_call_id);
      continue;
    }
    if (waiting.size || Object.hasOwn(message, 'tool_call_id')) throw fail('MODEL_INVALID_CONTEXT', '画布工具调用缺少对应结果。');
    if (message.role === 'assistant' && Object.hasOwn(message, 'tool_calls')) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 8 || message.content !== null && !text(message.content, MAX_CONTEXT_BYTES, true)) throw fail('MODEL_INVALID_CONTEXT', '画布助手工具消息格式无效。');
      for (const call of message.tool_calls) {
        const parsed = toolCall(call, allowed, false);
        if (waiting.has(parsed.id)) throw fail('MODEL_INVALID_CONTEXT', '画布工具调用 ID 重复。');
        waiting.add(parsed.id);
      }
    } else if (Object.hasOwn(message, 'tool_calls') || !text(message.content, MAX_CONTEXT_BYTES)) throw fail('MODEL_INVALID_CONTEXT', '画布文本消息格式无效。');
  }
  if (waiting.size) throw fail('MODEL_INVALID_CONTEXT', '画布工具调用缺少对应结果。');
}
async function boundedJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) throw fail('MODEL_RESPONSE_LIMIT', '画布模型响应超过上限。');
  let raw = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw fail('MODEL_RESPONSE_LIMIT', '画布模型响应超过上限。');
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { try { await reader.cancel(); } catch {} }
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw fail('MODEL_RESPONSE_LIMIT', '画布模型响应超过上限。');
  }
  try { return JSON.parse(raw); } catch { throw fail('MODEL_INVALID_RESPONSE', '画布模型未返回有效的 JSON 响应。'); }
}
/** One bounded request using the server-owned encrypted text-model config. Never retries. */
async function completeCanvasAgent({ messages, tools = [], model, signal, config, fetchImpl, responseContext } = {}) {
  if (signal?.aborted) throw fail('MODEL_CANCELLED', '画布请求已取消，本次请求不会自动重试。');
  if (!config?.apiKey) throw fail('MODEL_NOT_CONFIGURED', '请先在 Hub 模型设置中配置文本模型。');
  const allowed = validateTools(tools);
  validateMessages(messages, tools, allowed);
  const selectedModel = model === undefined ? config.model : model;
  if (!text(selectedModel, 200) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(selectedModel)) throw fail('MODEL_INVALID_MODEL', '画布模型 ID 无效。');
  const controller = new AbortController();
  let timer, stopError, onAbort;
  const stopped = new Promise((_, reject) => {
    const stop = error => { if (stopError) return; stopError = error; controller.abort(); reject(error); };
    onAbort = () => stop(fail('MODEL_CANCELLED', '画布请求已取消，本次请求不会自动重试。'));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop(fail('MODEL_TIMEOUT', '画布模型请求超时，本次请求不会自动重试。')), config.timeoutMs || 30000);
  });
  const request = async () => {
    const responses = usesResponsesApi(selectedModel);
    const body = responses ? responsesRequest({ model: selectedModel, messages, tools }, responseContext) : { model: selectedModel, messages, stream: false, max_tokens: 8192, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
    const response = await fetchImpl(`${config.baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (response.redirected || response.status >= 300 && response.status < 400) {
      response.body?.cancel?.().catch?.(() => {});
      throw fail('MODEL_REDIRECT_BLOCKED', '模型接口发生重定向，已停止请求以保护 API Key。');
    }
    if (!response.ok) {
      response.body?.cancel?.().catch?.(() => {});
      const code = [401, 403].includes(response.status) ? 'MODEL_AUTH_FAILED' : response.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_HTTP_ERROR';
      throw fail(code, code === 'MODEL_AUTH_FAILED' ? '画布模型鉴权失败，请检查本机模型设置。' : code === 'MODEL_RATE_LIMITED' ? '画布模型限流或额度不足，本次请求不会自动重试。' : `画布模型接口返回 HTTP ${Number.isInteger(response.status) ? response.status : '错误'}。`);
    }
    const rawResult = await boundedJson(response);
    if (JSON.stringify(rawResult).includes(config.apiKey)) throw fail('MODEL_SECRET_IN_RESPONSE', '模型响应意外包含密钥，已拒绝展示或保存。');
    const result = responses ? responsesResult(rawResult) : rawResult;
    if (!plain(result) || !Array.isArray(result.choices) || result.choices.length !== 1 || !plain(result.choices[0])) throw fail('MODEL_INVALID_RESPONSE', '画布模型响应不符合 Chat Completions 格式。');
    const choice = result.choices[0], message = choice.message;
    if (!plain(message) || message.role !== undefined && message.role !== 'assistant' || message.function_call != null || message.content !== null && message.content !== undefined && !text(message.content, MAX_RESPONSE_BYTES, true)) throw fail('MODEL_INVALID_RESPONSE', '画布模型消息格式无效。');
    const rawCalls = message.tool_calls == null ? [] : message.tool_calls;
    if (!Array.isArray(rawCalls) || rawCalls.length > 8) throw fail('MODEL_INVALID_RESPONSE', '画布模型工具调用数量无效。');
    if (rawCalls.length ? choice.finish_reason !== 'tool_calls' : choice.finish_reason !== 'stop') throw fail('MODEL_INCOMPLETE_RESPONSE', '画布模型未完整结束输出，本次请求不会自动重试。');
    const toolCalls = rawCalls.map(call => toolCall(call, allowed, true));
    if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw fail('MODEL_INVALID_RESPONSE', '画布模型工具调用 ID 重复。');
    const reply = (message.content || '').trim();
    if (!reply && !toolCalls.length) throw fail('MODEL_INVALID_RESPONSE', '画布模型没有返回文本或工具调用。');
    const usage = plain(result.usage) ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(key => Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0).map(key => [key, result.usage[key]])) : undefined;
    return { reply, toolCalls, model: selectedModel, ...(usage ? { usage } : {}), ...(responses && toolCalls.length ? { responseContext: { model: selectedModel, messageCount: messages.length, input: [...body.input, ...rawResult.output] } } : {}) };
  };
  try { return await Promise.race([request(), stopped]); }
  catch (error) {
    if (stopError) throw stopError;
    if (error instanceof CanvasAgentCompletionError) throw error;
    throw fail('MODEL_NETWORK_ERROR', '无法完成画布模型请求，请检查网络和本机模型设置；本次请求不会自动重试。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

module.exports = { completeCanvasAgent, ALLOWED_CANVAS_TOOLS };
