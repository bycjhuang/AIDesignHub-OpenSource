'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { safeCliProbe } = require('./agent-runtime-discovery.cjs');

// These adapters execute explicitly configured agents; they never select a model API.
const activeConnections = new Map();
const MAX_PROMPT_BYTES = 1024 * 1024;
const TEMPLATE_FIELDS = new Set(['prompt', 'promptFile', 'runId', 'projectId', 'sessionId', 'sessionKey']);
const error = (code, message) => Object.assign(new Error(message), { code });
const limit = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;

function diagnosticCategory(stderr) {
  // Return only fixed labels, never provider text, paths, URLs, or credentials.
  if (/requires credentials before opening a websocket|gateway url override requires explicit credentials|no stored device auth/i.test(stderr)) return 'gateway-auth-required';
  if (/token mismatch|unauthorized|authentication_error|invalid_api_key|no api key/i.test(stderr)) return 'authentication-failed';
  if (/insufficient_quota|quota.{0,30}exceed|insufficient.{0,30}credit/i.test(stderr)) return 'model-quota';
  if (/rate.?limit|\b429\b/i.test(stderr)) return 'rate-limited';
  if (/ECONNREFUSED|gateway closed|connection refused/i.test(stderr)) return 'gateway-unreachable';
  if (/unknown option|invalid option|invalid thinking level/i.test(stderr)) return 'unsupported-arguments';
  if (/unknown model|model.{0,30}not found/i.test(stderr)) return 'model-unavailable';
  return 'agent-failed';
}

function openclawHealthProbe(connection) {
  if (connection.provider !== 'openclaw' || connection.mode !== 'cli' || !safeCliProbe(connection)) return null;
  const args = connection.args || [];
  const prefix = [args[0]];
  let index = 1;
  // Retain an explicitly selected profile, but never reuse task arguments.
  while (index < args.length && args[index] !== 'agent') {
    if (args[index] === '--dev') prefix.push(args[index++]);
    else if (args[index] === '--profile' && typeof args[index + 1] === 'string') prefix.push(args[index++], args[index++]);
    else if (/^--profile=.+/.test(args[index])) prefix.push(args[index++]);
    else return null;
  }
  if (args[index] !== 'agent' || args[index + 1] === 'exec' || args.includes('--local') || args.some(arg => arg.startsWith('--local='))) return null;
  return { ...connection, args: [...prefix, 'health', '--json', '--timeout', '2500'], outputFormat: 'text' };
}

async function checkOpenclawGateway(connection, options) {
  const probe = openclawHealthProbe(connection);
  if (!probe) return null;
  options.emit({ type: 'status', status: 'checking', message: '正在检查 OpenClaw Gateway；尚未发送任务或调用模型。' });
  try {
    const result = await executeCli(probe, { ...options, env: {}, prompt: 'Protocol check only', timeoutMs: Math.min(options.timeoutMs, 45000), emit() {} });
    let value;
    try { value = JSON.parse(result.text); } catch { throw error('PROTOCOL_ERROR', 'OpenClaw health did not return valid JSON.'); }
    if (value.status === 'starting') throw error('GATEWAY_NOT_READY', 'OpenClaw Gateway is still starting.');
    if (value.ok !== true) throw error('GATEWAY_UNREACHABLE', 'OpenClaw Gateway did not confirm readiness.');
    options.emit({ type: 'status', status: 'ready', message: 'OpenClaw Gateway 已连通；模型与联网工具仍以本次任务实际结果为准。' });
    return { level: 'gateway', code: 'GATEWAY_READY', modelCalled: false, message: 'OpenClaw Gateway 健康检查通过；未调用模型，未发送项目资料。' };
  } catch (cause) {
    cause.phase = 'preflight';
    if (cause.category === 'gateway-unreachable') cause.code = 'GATEWAY_UNREACHABLE';
    else if (cause.code === 'AGENT_FAILED' && cause.category === 'agent-failed') cause.code = 'GATEWAY_CHECK_FAILED';
    throw cause;
  }
}

function recordStdoutNoise(options, line) {
  const state = options.noise || (options.noise = { count: 0, samples: [] });
  state.count += 1;
  if (state.samples.length >= 10) return;
  let text = String(line).replace(/\s+/g, ' ').slice(0, 300);
  for (const secret of Object.values(options.env || {})) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[凭据已隐藏]');
  }
  state.samples.push(text);
}

function flushStdoutNoise(options) {
  const state = options.noise;
  if (!state?.samples.length || typeof options.diagnosticsFile !== 'string' || !path.isAbsolute(options.diagnosticsFile)) return;
  try {
    fs.appendFileSync(options.diagnosticsFile, state.samples.map(line => `${new Date().toISOString()} ${line}`).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    state.samples = [];
  } catch { /* diagnostics only */ }
}

function executionOptions(connection, input) {
  if (!connection || typeof connection !== 'object') throw error('INVALID_CONNECTION', 'Agent connection is required.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw error('INVALID_PROMPT', 'A non-empty prompt is required.');
  if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES) throw error('INPUT_LIMIT', 'Agent prompt exceeds 1 MiB.');
  if (input.signal?.aborted) throw error('ABORTED', 'Agent execution was cancelled.');
  const env = {};
  if (input.env !== undefined) {
    if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env)) throw error('INVALID_ENV', 'Only temporary Hub environment variables are supported.');
    for (const [name, value] of Object.entries(input.env)) {
      if (!['AIDESIGNHUB_URL', 'AIDESIGNHUB_TOKEN'].includes(name) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
        throw error('INVALID_ENV', 'Only temporary Hub environment variables are supported.');
      }
      env[name] = value;
    }
  }
  const cwd = input.cwd || connection.cwd || process.cwd();
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw error('INVALID_CWD', 'Agent workspace must be an existing absolute directory.');
  }
  let events = 0;
  return {
    ...input, cwd, env,
    noise: { count: 0, samples: [] },
    timeoutMs: limit(connection.timeoutMs, 120000, 20, 3600000),
    maxOutputBytes: limit(connection.maxOutputBytes, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024),
    emit(event) {
      if (++events > 10000) throw error('EVENT_LIMIT', 'Agent emitted too many progress events.');
      input.onEvent?.(event);
    },
  };
}

function subprocess(connection, options, args) {
  const executable = connection.executable || connection.command;
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw error('INVALID_EXECUTABLE', 'Configure an absolute executable path; shell commands are not accepted.');
  }
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe') {
    throw error('INVALID_EXECUTABLE', 'Windows agents require an absolute .exe path, not .cmd/.bat or a shell command.');
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw error('INVALID_ARGUMENTS', 'Agent args must be an array of strings.');
  }
  // Count a conservatively quoted Windows command line in UTF-16 code units.
  // This includes escaping quotes and doubling trailing backslashes, not UTF-8 bytes.
  if (process.platform === 'win32' && [executable, ...args].reduce((size, arg) =>
    size + 3 + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').length, 1) > 32760) {
    throw error('ARGUMENT_LIMIT', 'Windows command line is too long. Use --message-file {promptFile}, or an agent-supported stdin interface.');
  }
  let failure, totalBytes = 0, stderrTail = '', closed = false, forceTimer, onAbort;
  let settle;
  const finished = new Promise(resolve => { settle = resolve; });
  const childEnv = { ...process.env };
  // Hub access is explicitly scoped to this run, never ambiently inherited.
  delete childEnv.AIDESIGNHUB_URL; delete childEnv.AIDESIGNHUB_TOKEN;
  Object.assign(childEnv, options.env);
  const child = spawn(executable, args, {
    cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    // The agent retains its own configured authentication. Do not persist/copy credentials.
    env: childEnv,
  });
  function kill() {
    if (closed) return;
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      // Kill only this invocation's owned process tree; no shell interpolation.
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
      killer.on('close', code => { if (code && !closed) child.kill('SIGKILL'); });
    } else child.kill('SIGKILL');
  }
  function fail(reason) {
    if (failure || closed) return;
    failure = reason;
    try { onAbort?.(); } catch { /* Cancellation is best effort. */ }
    forceTimer = setTimeout(kill, onAbort ? 150 : 0);
  }
  const aborted = () => fail(error('ABORTED', 'Agent execution was cancelled.'));
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const timer = setTimeout(() => fail(error('TIMEOUT', 'Agent execution exceeded its time limit.')), options.timeoutMs);
  child.stdin.on('error', () => { /* Exit handling reports EPIPE without leaking command details. */ });
  child.on('error', () => fail(error('SPAWN_FAILED', 'Unable to start the configured agent executable.')));
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      totalBytes += Buffer.byteLength(chunk);
      if (stream === child.stderr) stderrTail = (stderrTail + chunk).slice(-16384);
      if (totalBytes > options.maxOutputBytes) fail(error('OUTPUT_LIMIT', 'Agent output exceeded its byte limit.'));
    });
  }
  child.on('close', (code, signal) => {
    closed = true;
    clearTimeout(timer); clearTimeout(forceTimer);
    options.signal?.removeEventListener('abort', aborted);
    settle({ code, signal, error: failure, bytes: totalBytes, category: diagnosticCategory(stderrTail) });
  });
  return {
    child, finished, fail, get failed() { return !!failure; },
    set onAbort(callback) { onAbort = callback; },
    send(value) { if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); },
    finish() { child.stdin.end(); if (!closed && !forceTimer) forceTimer = setTimeout(kill, 300); },
  };
}

function lineReader(stream, onLine, fail, onNoise) {
  let buffer = '';
  // Agents occasionally leak plain-text diagnostics onto stdout (browser helpers,
  // warnings, ANSI banners). Those lines are noise, not protocol corruption: keep
  // them as diagnostics instead of discarding an otherwise finished turn. A line
  // that opens like a JSON-RPC object but fails to parse is still fatal.
  function isNoise(line, cause) {
    if (cause?.code || !(cause instanceof SyntaxError || cause?.name === 'SyntaxError')) return false;
    return !line.replace(/\u001B\[[0-9;]*m/g, '').trim().startsWith('{');
  }
  function processLine(line) {
    if (!line.trim()) return;
    try { onLine(line); } catch (cause) {
      if (isNoise(line, cause) && onNoise) { onNoise(line); return; }
      fail(cause.code ? cause : error('PROTOCOL_ERROR', 'Agent emitted invalid protocol data.'));
    }
  }
  stream.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      processLine(line);
    }
  });
  stream.on('end', () => { if (buffer) processLine(buffer); buffer = ''; });
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

function responseText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.final === 'string') return payload.final;
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (payload.choices?.[0]?.message) return textContent(payload.choices[0].message.content);
  if (Array.isArray(payload.payloads)) return payload.payloads.map(part => textContent(part.text)).filter(Boolean).join('\n');
  if (Array.isArray(payload.output)) return payload.output.filter(item => item.type === 'message' && item.phase !== 'commentary')
    .map(item => textContent(item.content)).join('\n');
  if (payload.result) return responseText(payload.result);
  return typeof payload.text === 'string' ? payload.text : '';
}

function routingValue(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
    throw error('INVALID_TEMPLATE', `A valid per-run ${field} is required.`);
  }
  return value;
}

function checkedPromptFile(options) {
  const file = options.promptFile;
  if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file)) {
    throw error('INVALID_PROMPT_FILE', 'promptFile must be an existing absolute UTF-8 file matching this run prompt.');
  }
  let descriptor;
  try {
    // The caller owns creation, permissions and cleanup. Never overwrite a supplied file.
    if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
    descriptor = fs.openSync(file, 'r');
    const expected = Buffer.from(options.prompt, 'utf8');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== expected.length) throw new Error('unexpected file size');
    const bytes = Buffer.alloc(expected.length + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length !== expected.length || !bytes.subarray(0, length).equals(expected)) throw new Error('prompt mismatch');
    return file;
  } catch {
    throw error('INVALID_PROMPT_FILE', 'promptFile must be an existing absolute UTF-8 file matching this run prompt.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function invocationArguments(connection, options) {
  const sourceArgs = connection.args || [];
  if (!Array.isArray(sourceArgs) || sourceArgs.some(arg => typeof arg !== 'string')) throw error('INVALID_ARGUMENTS', 'Agent args must be an array of strings.');
  const used = new Set();
  const values = new Map();
  // A single pass over each original argument is essential: prompt text may itself
  // contain {sessionId}, {promptFile}, or other brace-delimited untrusted content.
  const args = sourceArgs.map(arg => arg.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, field) => {
    if (!TEMPLATE_FIELDS.has(field)) throw error('INVALID_TEMPLATE', 'Unknown agent argument placeholder.');
    used.add(field);
    if (!values.has(field)) values.set(field, field === 'prompt' ? options.prompt : field === 'promptFile'
      ? checkedPromptFile(options) : routingValue(options[field], field));
    return values.get(field);
  }));
  if (used.has('prompt') && used.has('promptFile')) throw error('INVALID_TEMPLATE', 'Choose either {prompt} or {promptFile}, not both.');
  return { args, promptProvided: used.has('prompt') || used.has('promptFile') };
}

async function executeCli(connection, options) {
  const { args, promptProvided } = invocationArguments(connection, options);
  const proc = subprocess(connection, options, args);
  const preset = connection.preset || connection.provider;
  const format = connection.outputFormat || (preset === 'hermes' ? 'hermes-jsonl' : preset === 'openclaw' ? 'openclaw-json' : 'text');
  let raw = '', text = '', sessionId, terminal;
  if (!['text', 'hermes-jsonl', 'openclaw-json'].includes(format)) { proc.fail(error('INVALID_FORMAT', 'Unsupported CLI output format.')); }
  if (format === 'hermes-jsonl') {
    lineReader(proc.child.stdout, line => {
      if (proc.failed) return;
      const event = JSON.parse(line);
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'text' && typeof event.text === 'string') {
        text += event.text; options.emit({ type: 'text', text: event.text });
      } else if (event.type === 'tool_use' || event.type === 'tool_result') {
        options.emit({ type: 'tool', name: event.name, status: event.type === 'tool_use' ? 'running' : event.is_error ? 'failed' : 'completed' });
      } else if (event.type === 'result') terminal = event;
      else if (event.type === 'system') options.emit({ type: 'status', status: 'running', sessionId });
    }, proc.fail, line => recordStdoutNoise(options, line));
  } else proc.child.stdout.on('data', chunk => {
    if (proc.failed) return;
    raw += chunk;
    if (format === 'text') {
      try { options.emit({ type: 'text', text: chunk }); } catch (cause) { proc.fail(cause); }
    }
  });
  // Arguments are passed directly, never through cmd.exe/PowerShell. Prefer stdin for secrets/untrusted prompts.
  proc.child.stdin.end(promptProvided ? undefined : options.prompt);
  const exit = await proc.finished;
  if (exit.error) throw exit.error;
  if (exit.code !== 0) throw Object.assign(error('AGENT_FAILED', `Agent process exited unsuccessfully (${exit.code ?? exit.signal}; ${exit.category}).`), { category: exit.category });
  let metadata = { transport: 'cli', exitCode: exit.code, outputBytes: exit.bytes };
  if (format === 'hermes-jsonl') {
    if (!terminal || typeof terminal.exit_code !== 'number') throw error('PROTOCOL_ERROR', 'Hermes did not emit a terminal result event.');
    if (terminal.exit_code !== 0) throw error(terminal.exit_code === 130 ? 'ABORTED' : 'AGENT_FAILED', 'Hermes reported an unsuccessful turn.');
    text = typeof terminal.text === 'string' ? terminal.text : text;
    metadata = { ...metadata, usage: terminal.tokens, durationMs: terminal.duration_ms };
  } else if (format === 'openclaw-json') {
    let payload;
    try { payload = JSON.parse(raw); } catch { throw error('PROTOCOL_ERROR', 'OpenClaw did not return valid JSON.'); }
    if (payload.ok === false || ['error', 'failed', 'cancelled', 'incomplete', 'in_flight', 'running', 'queued'].includes(payload.status)) throw error('AGENT_FAILED', 'OpenClaw did not report a completed turn.');
    text = responseText(payload);
    sessionId = payload.sessionId || payload.meta?.agentMeta?.sessionId || payload.result?.meta?.agentMeta?.sessionId;
    metadata = { ...metadata, usage: payload.usage || payload.meta?.agentMeta?.usage || payload.result?.meta?.agentMeta?.usage };
  } else text = raw;
  if (!text.trim()) throw error('EMPTY_RESULT', 'Agent completed without an answer.');
  return { text, sessionId, metadata };
}

async function executeAcp(connection, options) {
  const proc = subprocess(connection, options, invocationArguments(connection, options).args);
  let nextId = 1, sessionId, text = '', promptId;
  const pending = new Map();
  function request(method, params) {
    const id = nextId++;
    if (method === 'session/prompt') promptId = id;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    proc.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }
  proc.onAbort = () => {
    if (sessionId) proc.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  };
  proc.finished.then(exit => {
    for (const waiter of pending.values()) waiter.reject(exit.error || error('AGENT_EXITED', 'ACP agent exited before completing the request.'));
    pending.clear();
  });
  lineReader(proc.child.stdout, line => {
    if (proc.failed) return;
    const message = JSON.parse(line);
    if (message.jsonrpc !== '2.0') throw error('PROTOCOL_ERROR', 'ACP JSON-RPC 2.0 is required.');
    if (message.method) {
      if (message.method === 'session/update' && message.id === undefined) {
        const params = message.params || {};
        if (params.sessionId !== sessionId) return;
        const update = params.update || {};
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          text += update.content.text || '';
          options.emit({ type: 'text', text: update.content.text || '', sessionId });
        } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
          options.emit({ type: 'tool', id: update.toolCallId, name: update.title, status: update.status });
        }
      } else if (message.id !== undefined) {
        if (message.method === 'session/request_permission') {
          const reject = message.params?.options?.find(item => item.kind === 'reject_once');
          proc.send({ jsonrpc: '2.0', id: message.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
          options.emit({ type: 'permission', decision: 'denied', sessionId });
        } else proc.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability is not enabled.' } });
      }
    } else if (pending.has(message.id)) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(error('ACP_ERROR', `ACP request failed (${message.error.code ?? 'unknown'}).`));
      else waiter.resolve(message.result);
    }
  }, proc.fail, line => recordStdoutNoise(options, line));
  try {
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'aidesignhub', version: '0.1.0' },
    });
    if (initialized?.protocolVersion !== 1) throw error('UNSUPPORTED_PROTOCOL', 'ACP agent did not negotiate protocol version 1.');
    if (options.probeOnly) return { level: 'protocol', code: 'ACP_READY', protocolVersion: 1, modelCalled: false, sessionCreated: false };
    if (!Array.isArray(connection.mcpServers || [])) throw error('INVALID_MCP', 'ACP MCP servers must be an array.');
    for (const server of connection.mcpServers || []) {
      if (server?.type === 'http' && !initialized.agentCapabilities?.mcpCapabilities?.http) throw error('UNSUPPORTED_CAPABILITY', 'ACP agent does not advertise HTTP MCP support.');
      if (server?.type === 'sse' && !initialized.agentCapabilities?.mcpCapabilities?.sse) throw error('UNSUPPORTED_CAPABILITY', 'ACP agent does not advertise SSE MCP support.');
    }
    const session = await request('session/new', { cwd: options.cwd, mcpServers: connection.mcpServers || [] });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw error('PROTOCOL_ERROR', 'ACP agent did not return a session ID.');
    sessionId = session.sessionId;
    options.emit({ type: 'status', status: 'running', sessionId });
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: options.prompt }] });
    if (proc.failed) throw (await proc.finished).error;
    if (result?.stopReason === 'cancelled') throw error('ABORTED', 'ACP turn was cancelled.');
    if (result?.stopReason !== 'end_turn') throw error('INCOMPLETE_RESULT', 'ACP turn stopped without a completed answer.');
    if (!text.trim()) throw error('EMPTY_RESULT', 'ACP agent completed without an answer.');
    return { text, sessionId, metadata: { transport: 'acp', protocolVersion: 1, stopReason: result.stopReason, promptId, permissions: 'deny-by-default' } };
  } catch (cause) {
    proc.fail(cause);
    throw cause;
  } finally {
    proc.finish();
    await proc.finished;
  }
}

function endpointUrl(connection) {
  let endpoint;
  try { endpoint = new URL(connection.endpoint); } catch { throw error('INVALID_ENDPOINT', 'Configure the explicit OpenClaw gateway URL.'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw error('INVALID_ENDPOINT', 'Gateway URL must not contain credentials, query parameters or a fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw error('INSECURE_ENDPOINT', 'Remote gateways require HTTPS; HTTP is allowed only on loopback.');
  const selected = connection.api === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  if (['', '/', '/v1', '/v1/'].includes(endpoint.pathname)) endpoint.pathname = selected;
  if (!['/v1/responses', '/v1/chat/completions'].includes(endpoint.pathname)) throw error('INVALID_ENDPOINT', 'Only OpenClaw chat/completions or responses gateway routes are supported.');
  return endpoint;
}

async function executeOpenclawHttp(connection, options) {
  const endpoint = endpointUrl(connection);
  const sessionKey = options.sessionKey === undefined ? connection.sessionKey : routingValue(options.sessionKey, 'sessionKey');
  if (sessionKey !== undefined) routingValue(sessionKey, 'sessionKey');
  if (options.sessionKey !== undefined && ((connection.sessionKey && connection.sessionKey !== sessionKey) || connection.previousResponseId)) {
    throw error('SESSION_CONFLICT', 'A per-run session must not reuse a different connection session or previous response.');
  }
  if (typeof connection.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(connection.tokenEnv)) throw error('MISSING_AUTH', 'Configure the name of the gateway token environment variable.');
  const token = process.env[connection.tokenEnv];
  if (!token || /[\r\n]/.test(token)) throw error('MISSING_AUTH', 'The gateway token environment variable is unavailable.');
  const controller = new AbortController();
  let abortReason;
  const abort = reason => { abortReason ||= reason; controller.abort(); };
  const onAbort = () => abort(error('ABORTED', 'Gateway request cancelled; remote run termination is not confirmed.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => abort(error('TIMEOUT', 'Gateway request timed out; remote run termination is not confirmed.')), options.timeoutMs);
  let totalBytes = 0, text = '', terminalText, payload, responseId, complete = false;
  const responses = endpoint.pathname.endsWith('/responses');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (connection.agentId) headers['x-openclaw-agent-id'] = String(connection.agentId);
  if (sessionKey) headers['x-openclaw-session-key'] = sessionKey;
  const body = { model: connection.model || 'openclaw', stream: connection.stream !== false };
  if (responses) {
    body.input = options.prompt;
    if (connection.previousResponseId) body.previous_response_id = connection.previousResponseId;
  } else body.messages = [{ role: 'user', content: options.prompt }];
  function consume(event, data) {
    if (data === '[DONE]') { if (!responses) complete = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { throw error('PROTOCOL_ERROR', 'Gateway emitted invalid JSON.'); }
    const type = value.type || event;
    if (value.error || type === 'response.failed' || value.response?.status === 'failed') throw error('AGENT_FAILED', 'Gateway reported a failed turn.');
    if (type === 'response.incomplete' || value.response?.status === 'incomplete') throw error('INCOMPLETE_RESULT', 'Gateway reported an incomplete turn.');
    responseId ||= value.id || value.response?.id;
    const choice = value.choices?.[0];
    if (['length', 'content_filter', 'tool_calls'].includes(choice?.finish_reason)) throw error('INCOMPLETE_RESULT', 'Gateway returned an unfinished, truncated or filtered answer.');
    if (choice?.finish_reason === 'stop') complete = true;
    const delta = responses ? (type === 'response.output_text.delta' ? value.delta : '') : textContent(choice?.delta?.content);
    if (typeof delta === 'string' && delta) { text += delta; options.emit({ type: 'text', text: delta }); }
    if (type === 'response.completed') { complete = true; payload = value.response || value; terminalText = responseText(payload); }
    if (value.usage) payload = { ...(payload || {}), usage: value.usage };
  }
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw error('HTTP_ERROR', `Gateway request failed with HTTP ${response.status}.`); }
    const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '', event = '', data = [];
    const flush = () => { if (data.length) consume(event, data.join('\n')); event = ''; data = []; };
    for await (const chunk of response.body) {
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) throw error('OUTPUT_LIMIT', 'Gateway response exceeded its byte limit.');
      buffer += decoder.decode(chunk, { stream: true });
      if (sse) {
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (!line) flush();
          else if (line.startsWith('event:')) event = line.slice(6).trimStart();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    if (sse) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
      flush();
      if (!complete) throw error('INCOMPLETE_RESULT', 'Gateway stream ended before its completion signal.');
      if (terminalText !== undefined && terminalText !== '') text = terminalText;
    } else {
      try { payload = JSON.parse(buffer); } catch { throw error('PROTOCOL_ERROR', 'Gateway did not return valid JSON.'); }
      if (payload.error || payload.status === 'failed') throw error('AGENT_FAILED', 'Gateway reported a failed turn.');
      if (payload.status === 'incomplete' || ['length', 'content_filter', 'tool_calls'].includes(payload.choices?.[0]?.finish_reason)) throw error('INCOMPLETE_RESULT', 'Gateway did not finish its answer.');
      if (responses ? payload.status !== 'completed' : payload.choices?.[0]?.finish_reason !== 'stop') throw error('INCOMPLETE_RESULT', 'Gateway did not confirm a completed answer.');
      text = responseText(payload); responseId = payload.id;
    }
    if (!text.trim()) throw error('EMPTY_RESULT', 'Gateway completed without an answer.');
    return { text, metadata: { transport: 'openclaw-http', sessionKey, responseId, usage: payload?.usage, cancellation: 'request-abort-only', outputBytes: totalBytes } };
  } catch (cause) {
    controller.abort();
    if (abortReason) throw abortReason;
    if (cause.code && !String(cause.code).startsWith('UND_')) throw cause;
    throw error('HTTP_CONNECTION_FAILED', 'Could not complete the configured gateway request.');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
  }
}

async function executeAgent(connection, input = {}) {
  const options = executionOptions(connection, input);
  const key = `${connection.mode}:${connection.executable || connection.command || connection.endpoint || 'unknown'}`;
  const active = activeConnections.get(key) || 0;
  if (active >= limit(connection.maxConcurrency, 1, 1, 4)) throw error('BUSY', 'The configured agent has reached its concurrent execution limit.');
  activeConnections.set(key, active + 1);
  try {
    if (connection.mode === 'cli') {
      await checkOpenclawGateway(connection, options);
      return await executeCli(connection, options);
    }
    if (connection.mode === 'acp') return await executeAcp(connection, options);
    if (connection.mode === 'openclaw-http') return await executeOpenclawHttp(connection, options);
    throw error('UNSUPPORTED_MODE', 'Agent mode must be cli, acp or openclaw-http.');
  } finally {
    const remaining = (activeConnections.get(key) || 1) - 1;
    if (remaining > 0) activeConnections.set(key, remaining); else activeConnections.delete(key);
    flushStdoutNoise(options);
  }
}

async function probeAgentConnection(connection, input = {}) {
  // Explicit user action only. An initialize round trip does not send a model prompt.
  const options = executionOptions({ ...connection, timeoutMs: Math.min(Number(connection.timeoutMs) || 45000, 45000), maxOutputBytes: 1024 * 1024 }, { ...input, prompt: 'Protocol check only', probeOnly: true });
  if (connection.mode === 'openclaw-http') {
    const endpoint = endpointUrl(connection);
    endpoint.pathname = '/healthz';
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(Math.min(options.timeoutMs, 5000))]);
    try {
      const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal });
      await response.body?.cancel();
      if (!response.ok) throw error('GATEWAY_NOT_READY', 'Gateway health endpoint did not report a live server.');
      if (!connection.tokenEnv || !process.env[connection.tokenEnv]) throw error('MISSING_AUTH', 'Gateway credentials are not configured.');
      return { level: 'gateway', code: 'GATEWAY_REACHABLE', modelCalled: false, message: 'Gateway HTTP 服务可达，指定凭据已配置；未验证凭据有效性或模型，未发送项目资料。' };
    } catch (cause) {
      if (input.signal?.aborted) throw error('ABORTED', 'Agent check was cancelled.');
      if (cause.code === 'GATEWAY_NOT_READY' || cause.code === 'MISSING_AUTH') throw cause;
      throw error('GATEWAY_UNREACHABLE', 'Could not reach the configured Gateway health endpoint.');
    }
  }
  const executable = connection.executable || connection.command;
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe') || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw error('SPAWN_FAILED', 'The configured executable is missing or invalid.');
  const key = `${connection.mode}:${connection.executable || connection.command || connection.endpoint || 'unknown'}`;
  const active = activeConnections.get(key) || 0;
  if (active >= limit(connection.maxConcurrency, 1, 1, 4)) throw error('BUSY', 'The configured agent has reached its concurrent execution limit.');
  activeConnections.set(key, active + 1);
  try {
    if (connection.mode === 'acp') return await executeAcp(connection, options);
    if (connection.mode === 'cli') {
      const gateway = await checkOpenclawGateway(connection, options);
      if (gateway) return gateway;
      const probe = safeCliProbe(connection);
      if (!probe) return { level: 'configuration', code: 'CUSTOM_CLI_UNPROBED', modelCalled: false, message: '自定义 CLI 没有已知无模型探针；已检查文件，使用短任务验证实际输出。' };
      await executeCli(probe, options);
      return { level: 'cli', code: 'CLI_READY', modelCalled: false };
    }
    throw error('UNSUPPORTED_MODE', 'Only local CLI / ACP supports a no-model process check.');
  } finally {
    const remaining = (activeConnections.get(key) || 1) - 1;
    if (remaining > 0) activeConnections.set(key, remaining); else activeConnections.delete(key);
  }
}
module.exports = { executeAgent, probeAgentConnection };
