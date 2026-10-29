export const name = 'adh-tool-discovery';
export const inject = ['agents', 'tools', 'systemPrompt'];

const SEARCH = 'adh_search_tools';
const ACTIVATE = 'adh_activate_tools';
const MCP = /^mcp__/;
const DEFAULTS = Object.freeze({ maxActiveTools: 24, maxSchemaChars: 48000, maxSearchResults: 8 });
const INSTRUCTIONS = `外部软件与知识库 MCP 工具按需发现，初始不向模型发送完整工具参数。需要这类能力时，先调用 ${SEARCH} 搜索任务所需的工具，再调用 ${ACTIVATE} 激活精确工具名称；下一次模型请求即可使用原工具及其完整参数。搜索和激活不会执行软件操作，也不会授予额外权限。可以同时激活多个软件中相关的工具，但只保留当前任务所需的少量工具；接近工具预算时使用 mode=replace 替换活动集。新建、恢复或压缩后的会话需要重新发现和激活；不要重放已完成的操作。基础文件、终端和其他非 MCP 工具保持原来的可用性。`;

function options(config) {
  const result = { ...DEFAULTS };
  for (const key of Object.keys(result)) {
    if (config?.[key] === undefined) continue;
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > (key === 'maxSchemaChars' ? 200000 : 64)) {
      throw new TypeError(`adh-tool-discovery: ${key} is outside its supported positive integer range`);
    }
    result[key] = value;
  }
  return result;
}

function normalized(value) { return value.normalize('NFKC').toLowerCase(); }
function words(value) {
  const text = normalized(value.replace(/([a-z])([A-Z])/g, '$1 $2'));
  const result = new Set(text.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []);
  for (const word of [...result]) if (/\p{Script=Han}/u.test(word) && word.length > 2) {
    for (let index = 0; index < word.length - 1; index += 1) result.add(word.slice(index, index + 2));
  }
  return result;
}
function serverOf(toolName) { return toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/u)?.[1] ?? toolName.split('__')[1] ?? 'mcp'; }
function shortDescription(value) { return String(value ?? '').replace(/\s+/g, ' ').slice(0, 180); }
function schemaSize(schema) { return JSON.stringify(schema).length; }
function render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; }
function failure(code, message, extra = {}) { return { ok: false, code, message, ...extra }; }

// The local index contains original descriptions and parameter documentation.
// Only short ranked matches, never the full schema catalogue, reach the model.
function ranked(catalog, query) {
  const terms = words(query);
  const phrase = normalized(query.trim());
  return [...catalog.values()].map(schema => {
    const name = normalized(schema.name);
    const description = normalized(schema.description ?? '');
    const parameterText = normalized(JSON.stringify(schema.parameters ?? {}));
    let score = phrase && name.includes(phrase) ? 60 : phrase && description.includes(phrase) ? 25 : 0;
    for (const term of terms) score += name.includes(term) ? 12 : description.includes(term) ? 4 : parameterText.includes(term) ? 1 : 0;
    return { schema, score };
  }).filter(item => !phrase || item.score > 0).sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name));
}

export function apply(ctx, config = {}) {
  const limits = options(config);
  const states = new WeakMap();
  const live = new Set();
  const disposers = [];
  let projecting = false;
  let queued = false;
  let disposed = false;

  function release(state) { const stop = state.stop; state.stop = undefined; stop?.(); }

  // Temporarily remove ONLY our own mask, synchronously, to inspect the current
  // externally permitted surface. Other plugins' restrictions and guards remain
  // in force; an old cached catalogue must never authorize a newly denied tool.
  // There is no await or provider I/O inside this projection transaction.
  function project(state, select) {
    if (state.busy) return state.last;
    state.busy = true;
    const wasProjecting = projecting;
    projecting = true;
    release(state);
    let base = [];
    try {
      const schemas = ctx.tools.schemas(state.agent);
      const restrictable = ctx.tools.view(state.agent).restrictableNames;
      // The PTC transport is reserved and cannot be named in a restriction.
      // Scope-local answer/delegation tools also remain natively exempt: the
      // restriction API accepts inherited capabilities only, never local names.
      base = schemas.filter(schema => !MCP.test(schema.name) && schema.name !== 'run_code'
        && restrictable.has(schema.name)).map(schema => schema.name);
      const catalog = new Map(schemas.filter(schema => MCP.test(schema.name)).map(schema => [schema.name, schema]));
      const current = new Set();
      let chars = 0;
      for (const toolName of state.active) {
        if (!catalog.has(toolName)) continue;
        const size = schemaSize(catalog.get(toolName));
        if (current.size >= limits.maxActiveTools || chars + size > limits.maxSchemaChars) continue;
        current.add(toolName); chars += size;
      }
      const selection = select?.(catalog, current) ?? { active: current };
      const active = selection.active ?? current;
      state.stop = state.agent.ctx.tools.restrict({ allow: [...base, ...active] });
      const leaked = ctx.tools.schemas(state.agent).find(schema => MCP.test(schema.name) && !active.has(schema.name));
      if (leaked) throw new Error('adh-tool-discovery: scope-local MCP tools cannot be deferred by inherited-tool restrictions');
      state.catalog = catalog;
      state.active = active;
      state.last = selection;
      return selection;
    } catch (error) {
      release(state);
      // Fail closed on an unexpected registry incompatibility. Never leave an
      // entire MCP catalogue exposed after lifting our previous restriction.
      state.stop = state.agent.ctx.tools.restrict({ allow: base });
      throw error;
    } finally {
      projecting = wasProjecting;
      state.busy = false;
    }
  }

  function ensure(agent) {
    if (!agent?.ctx) throw new Error('adh-tool-discovery requires a live calling Agent');
    let state = states.get(agent);
    if (!state) {
      state = { agent, active: new Set(), catalog: new Map() };
      states.set(agent, state);
      live.add(state);
      try { project(state); }
      catch (error) { live.delete(state); states.delete(agent); release(state); throw error; }
    }
    return state;
  }

  function status(state) {
    return {
      active: [...state.active].sort(),
      schemaChars: [...state.active].reduce((sum, toolName) => sum + schemaSize(state.catalog.get(toolName)), 0),
      limits,
    };
  }

  function search(args, exec) {
    exec.signal.throwIfAborted();
    const state = ensure(exec.agent);
    project(state);
    const query = typeof args.query === 'string' ? args.query.slice(0, 300) : '';
    const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(args.limit, limits.maxSearchResults)) : limits.maxSearchResults;
    const matches = ranked(state.catalog, query);
    const servers = new Map();
    for (const schema of state.catalog.values()) {
      const server = serverOf(schema.name);
      servers.set(server, (servers.get(server) ?? 0) + 1);
    }
    return { ok: true, query, total: matches.length,
      tools: matches.slice(offset, offset + limit).map(({ schema }) => ({ name: schema.name,
        description: shortDescription(schema.description), server: serverOf(schema.name), active: state.active.has(schema.name) })),
      ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
      servers: [...servers].sort(([a], [b]) => a.localeCompare(b)).slice(0, 32).map(([server, count]) => ({ server, count })),
      ...status(state) };
  }

  function activate(args, exec) {
    exec.signal.throwIfAborted();
    const state = ensure(exec.agent);
    const requested = args.names;
    if (!Array.isArray(requested) || requested.length > limits.maxActiveTools
      || requested.some(value => typeof value !== 'string' || value.length > 256)) {
      return failure('INVALID_TOOL_SELECTION', `names must be an array of at most ${limits.maxActiveTools} exact tool names`);
    }
    if (args.mode !== undefined && args.mode !== 'add' && args.mode !== 'replace') return failure('INVALID_TOOL_SELECTION', 'mode must be add or replace');
    const result = project(state, (catalog, current) => {
      const unavailable = [...new Set(requested)].filter(toolName => !catalog.has(toolName));
      if (unavailable.length) return { active: current, error: failure('TOOL_NOT_AVAILABLE', 'Requested tools are unavailable to this Agent; search again.', { unavailable }) };
      const active = new Set(args.mode === 'replace' ? requested : [...current, ...requested]);
      const chars = [...active].reduce((sum, toolName) => sum + schemaSize(catalog.get(toolName)), 0);
      if (active.size > limits.maxActiveTools || chars > limits.maxSchemaChars) return { active: current,
        error: failure('TOOL_BUDGET_EXCEEDED', 'Choose fewer tools or use mode=replace; no requested tools were activated.',
          { requestedCount: active.size, requestedSchemaChars: chars, limits }) };
      return { active };
    });
    return result.error ? { ...result.error, ...status(state) } : { ok: true, ...status(state),
      message: 'Selected original tools will be available on the next model request. No software operation was executed.' };
  }

  disposers.push(ctx.tools.register({ name: SEARCH,
    description: '搜索当前 Agent 可用的外部软件/知识库 MCP 工具，只返回少量名称和简短说明。先搜索再用 adh_activate_tools 激活精确名称；搜索不执行操作。空 query 可分页浏览。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 300 }, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: limits.maxSearchResults },
    } }, output: { schema: { type: 'object' }, render }, isConcurrencySafe: () => false, execute: search }));
  disposers.push(ctx.tools.register({ name: ACTIVATE,
    description: '为当前 Agent 激活搜索得到的精确 MCP 工具名称，下一次模型请求出现原始参数 schema。mode=add增量加入，replace替换活动集；names=[]且replace可清空。保留原权限与严格参数校验，不执行软件操作。',
    parameters: { type: 'object', additionalProperties: false, required: ['names'], properties: {
      names: { type: 'array', maxItems: limits.maxActiveTools, items: { type: 'string' } },
      mode: { type: 'string', enum: ['add', 'replace'] },
    } }, output: { schema: { type: 'object' }, render }, isConcurrencySafe: () => false, execute: activate }));
  disposers.push(ctx.systemPrompt.section({ name: 'adh-tool-discovery', order: 89, text: INSTRUCTIONS }));
  disposers.push(ctx.on('agent/created', ({ agent, signal }) => { signal?.throwIfAborted(); ensure(agent); }));
  disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (!context.agent) return next();
    const state = ensure(context.agent);
    project(state);
    const assembled = await next();
    const visible = new Set(ctx.tools.schemas(context.agent).map(schema => schema.name));
    // Providers were collected before this waterfall. Remove any schema whose
    // live permission/budget changed during assembly; no broad catalogue is added.
    return { ...assembled, tools: assembled.tools.filter(schema => visible.has(schema.name)) };
  }, { prepend: true }));
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent);
    if (!state) return;
    live.delete(state); states.delete(agent); release(state);
  }));
  disposers.push(ctx.on('tools/change', () => {
    if (projecting || queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      for (const state of live) {
        try { project(state); }
        catch (error) { ctx.logger.error('adh-tool-discovery: tool surface refresh failed', error); }
      }
    });
  }));
  for (const agent of ctx.agents.list()) ensure(agent);
  ctx.effect(() => () => {
    disposed = true;
    for (const dispose of disposers.reverse()) dispose();
    for (const state of live) release(state);
    live.clear();
  });
}
