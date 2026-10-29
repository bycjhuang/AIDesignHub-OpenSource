'use strict';
// Adapted from BYCJ Design's tool-discovery SDK regression suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

// Real pinned Cordis, AgentLoop, tool registry, validation and policy pipeline.
// The only replacement is scripted provider I/O: these tests make no network calls.
const { DSH_RUNTIME_PINS } = require('../backend/dsh-provisioner.cjs');
const root = process.env.ADH_TEST_DSH_PACKAGE ?? path.join(process.env.APPDATA || '', 'bycj-design-workbench-prototype', 'cache', 'dsh-runtime', DSH_RUNTIME_PINS.dshVersion, 'package');
const available = existsSync(path.join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'));
const integrationTest = process.env.ADH_TEST_DSH_PACKAGE || available ? test : (title, fn) => test(title, { skip: 'Provision the pinned DSH runtime or set ADH_TEST_DSH_PACKAGE to run the offline SDK integration tests' }, fn);
const runtime = name => import(pathToFileURL(path.join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const SEARCH = 'adh_search_tools';
const ACTIVATE = 'adh_activate_tools';
const external = index => `mcp__fixture__operation_${index}`;
const text = value => ({ type: 'text', text: value });
const call = (name, args) => ({ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) });

async function fixture(t, { count = 817, config = {}, beforePlugin } = {}) {
  assert.ok(existsSync(path.join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')), `Pinned DSH runtime is required: ${root}`);
  const [{ Context }, { AgentRegistry }, { AgentLoop }, { SessionStore }, { SessionProjectionRegistry },
    { SystemPrompt }, tools, llm] = await Promise.all([
      runtime('cordis'), runtime('dsh-agent'), runtime('dsh-agent-loop'), runtime('dsh-session'),
      runtime('dsh-session-projection'), runtime('dsh-system-prompt'), runtime('dsh-tools'), runtime('dsh-llm'),
    ]);
  const plugin = await import('../backend/dsh-plugins/adh-tool-discovery/index.js');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const [service, options] of [[SessionProjectionRegistry], [SessionStore], [AgentRegistry],
    [SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }], [tools.ToolRuntime], [llm.LlmRuntime]]) {
    await ctx.plugin(service, options).await();
  }
  const operations = [];
  const definitions = new Map();
  const removers = new Map();
  const add = (name, description = `External operation ${name}; preserve the original typed parameters.`, size = 0) => {
    const parameters = { type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } };
    const definition = { name, description: description + 'x'.repeat(size), parameters,
      output: { schema: { type: 'object' }, render: (_args, value) => [text(JSON.stringify(value))] },
      isConcurrencySafe: () => false,
      execute(args) {
        const violations = tools.validateJsonSchemaValue(parameters, args);
        if (violations.length) throw new tools.ToolArgsError(violations);
        operations.push({ name, args }); return { ok: true, name, count: args.count };
      } };
    definitions.set(name, definition);
    removers.set(name, ctx.tools.register(definition));
    return definition;
  };
  add('read_file');
  add('execute_command');
  for (let index = 0; index < count; index += 1) add(external(index));
  await beforePlugin?.({ ctx, add });
  let fork = ctx.plugin(plugin, config);
  await fork.await();
  const scripts = [];
  const calls = [];
  class OfflineAdapter extends llm.LlmAdapter {
    async listModels() { return [{ provider: 'offline', id: 'test', name: 'Offline', context: { contextWindow: 200000 } }]; }
    async resolveModel() { return (await this.listModels())[0]; }
    async *stream(options) {
      options.signal.throwIfAborted();
      calls.push(structuredClone({ ...options, signal: undefined }));
      const blocks = scripts.shift() ?? [text('Complete')];
      for (const [index, block] of blocks.entries()) yield { type: 'block-end', index, block };
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' },
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
    }
  }
  ctx.llm.registerAdapter(['offline'], new OfflineAdapter());
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  const events = new Map();
  ctx.on('session/event', (session, event) => {
    const list = events.get(session) ?? []; list.push(event); events.set(session, list);
  });
  const create = async (options = {}) => (await ctx.agents.create({ sessionId: randomUUID(),
    agentOptions: { provider: 'offline', model: 'test' }, ...options })).agent;
  const agent = await create();
  return { ctx, agent, create, operations, definitions, removers, add, scripts, calls, events,
    names: target => ctx.tools.schemas(target ?? agent).map(schema => schema.name),
    async execute(name, args, target = agent, signal = new AbortController().signal) {
      return ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: target, signal });
    },
    async run(target = agent, message = 'Hello') {
      const before = events.get(target.session)?.length ?? 0;
      target.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [text(message)] }));
      await target.whenIdle();
      const end = events.get(target.session).slice(before).findLast(event => event.type === 'turn/end');
      assert.ok(end, 'real loop must complete a turn');
      assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end.data.reason));
    },
    async reload() { await fork.dispose(); fork = ctx.plugin(plugin, config); await fork.await(); },
  };
}

integrationTest('817 registered MCP tools are absent from the first real model request; base tools remain', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.names().sort(), [ACTIVATE, SEARCH, 'execute_command', 'read_file'].sort());
  await f.run();
  assert.deepEqual(f.calls[0].tools.map(tool => tool.name).sort(), f.names().sort());
  assert.equal(f.operations.length, 0);
  assert.ok(JSON.stringify(f.calls[0].tools).length < 4000);
  assert.ok(JSON.stringify(f.calls[0]).includes(SEARCH));
});

integrationTest('search returns bounded short candidates; activation preserves the original schema and validator', async t => {
  const f = await fixture(t);
  const found = await f.execute(SEARCH, { query: 'operation', limit: 8 });
  assert.equal(found.isError, false);
  assert.equal(found.value.tools.length, 8);
  assert.equal(found.value.total, 817);
  assert.equal(found.value.nextOffset, 8);
  assert.ok(found.value.tools.every(tool => !('parameters' in tool) && tool.description.length <= 180));
  assert.equal(f.names().filter(name => name.startsWith('mcp__')).length, 0);
  const activated = await f.execute(ACTIVATE, { names: [external(7)] });
  assert.equal(activated.value.ok, true);
  assert.equal(f.operations.length, 0);
  assert.deepEqual(f.ctx.tools.schemas(f.agent).find(schema => schema.name === external(7)).parameters, f.definitions.get(external(7)).parameters);
  const invalid = await f.execute(external(7), { count: 'bad' });
  assert.equal(invalid.isError, true);
  assert.equal(f.operations.length, 0);
  const valid = await f.execute(external(7), { count: 2 });
  assert.equal(valid.isError, false);
  assert.deepEqual(f.operations, [{ name: external(7), args: { count: 2 } }]);
});

integrationTest('actual agent loop activates a precise tool on the next request, then executes it once', async t => {
  const f = await fixture(t, { count: 30 });
  f.scripts.push([call(SEARCH, { query: 'operation_2', limit: 3 })], [call(ACTIVATE, { names: [external(2)] })],
    [call(external(2), { count: 3 })], [text('Done')]);
  await f.run();
  assert.ok(f.calls.slice(0, 2).every(request => !request.tools.some(tool => tool.name === external(2))));
  assert.ok(f.calls[2].tools.some(tool => tool.name === external(2)));
  assert.deepEqual(f.operations, [{ name: external(2), args: { count: 3 } }]);
  assert.equal(f.events.get(f.agent.session).filter(event => event.type === 'tool/result').length, 3);
});

integrationTest('activation is Agent-local, supports more than one software, and replace removes old capabilities', async t => {
  const f = await fixture(t, { count: 0 });
  f.add('mcp__photoshop__layers'); f.add('mcp__blender__render');
  const other = await f.create();
  await f.execute(ACTIVATE, { names: ['mcp__photoshop__layers', 'mcp__blender__render'] });
  assert.equal(f.names().filter(name => name.startsWith('mcp__')).length, 2);
  assert.equal(f.names(other).filter(name => name.startsWith('mcp__')).length, 0);
  await f.execute(ACTIVATE, { names: ['mcp__blender__render'], mode: 'replace' });
  assert.equal(f.names().includes('mcp__photoshop__layers'), false);
  assert.equal((await f.execute('mcp__photoshop__layers', { count: 1 })).isError, true);
  await f.execute(ACTIVATE, { names: [], mode: 'replace' });
  assert.equal(f.names().filter(name => name.startsWith('mcp__')).length, 0);
});

integrationTest('activation cannot bypass another plugin restriction or execution guard, including later changes', async t => {
  const f = await fixture(t, { count: 4 });
  const restrict = f.agent.ctx.tools.restrict({ deny: [external(1)] });
  assert.equal((await f.execute(SEARCH, { query: external(1) })).value.tools.some(tool => tool.name === external(1)), false);
  assert.equal((await f.execute(ACTIVATE, { names: [external(1)] })).value.code, 'TOOL_NOT_AVAILABLE');
  await f.execute(ACTIVATE, { names: [external(2)] });
  const denyLater = f.agent.ctx.tools.restrict({ deny: [external(2)] });
  assert.equal((await f.execute(ACTIVATE, { names: [external(2)] })).value.code, 'TOOL_NOT_AVAILABLE');
  denyLater(); restrict();
  await f.execute(ACTIVATE, { names: [external(2)] });
  f.agent.ctx.tools.guard(exec => exec.name === external(2) ? 'Protected operation remains denied' : undefined);
  assert.equal((await f.execute(external(2), { count: 1 })).isError, true);
  assert.equal(f.operations.length, 0);
});

integrationTest('count and schema budgets reject atomically; replacing the set recovers capacity', async t => {
  const f = await fixture(t, { count: 4, config: { maxActiveTools: 2, maxSchemaChars: 1000 } });
  await f.execute(ACTIVATE, { names: [external(0), external(1)] });
  const excess = await f.execute(ACTIVATE, { names: [external(2)] });
  assert.equal(excess.value.code, 'TOOL_BUDGET_EXCEEDED');
  assert.deepEqual(excess.value.active, [external(0), external(1)]);
  f.add('mcp__large__single', 'Large schema', 1500);
  assert.equal((await f.execute(ACTIVATE, { names: ['mcp__large__single'], mode: 'replace' })).value.code, 'TOOL_BUDGET_EXCEEDED');
  assert.equal((await f.execute(ACTIVATE, { names: [external(3)], mode: 'replace' })).value.ok, true);
  assert.deepEqual(f.names().filter(name => name.startsWith('mcp__')), [external(3)]);
});

integrationTest('a replacement schema that grows past the budget is removed before the next request', async t => {
  const f = await fixture(t, { count: 2, config: { maxSchemaChars: 1000 } });
  await f.execute(ACTIVATE, { names: [external(1)] });
  f.removers.get(external(1))();
  f.add(external(1), 'Replacement with a much larger schema', 2000);
  await Promise.resolve();
  assert.equal(f.names().includes(external(1)), false);
  await f.run();
  assert.ok(!f.calls[0].tools.some(tool => tool.name === external(1)));
});

integrationTest('parent and child tool scopes are independent and each retains its own external restrictions', async t => {
  const f = await fixture(t, { count: 3 });
  await f.execute(ACTIVATE, { names: [external(1)] });
  const child = await f.create({ parentAgent: f.agent });
  assert.equal((await f.execute(ACTIVATE, { names: [external(2)] }, child)).value.ok, true);
  assert.deepEqual(f.names(child).filter(name => name.startsWith('mcp__')), [external(2)]);
  const scoped = (await f.agent.ctx.agents.create({ sessionId: randomUUID(), parentAgent: f.agent,
    agentOptions: { provider: 'offline', model: 'test' } })).agent;
  scoped.ctx.tools.restrict({ deny: [external(2)] });
  assert.equal((await f.execute(ACTIVATE, { names: [external(2)] }, scoped)).value.code, 'TOOL_NOT_AVAILABLE');
  assert.equal((await f.execute(ACTIVATE, { names: [external(1)] }, scoped)).value.ok, true);
  await f.execute(ACTIVATE, { names: [], mode: 'replace' });
  assert.deepEqual(f.names(scoped).filter(name => name.startsWith('mcp__')), [external(1)]);
  assert.deepEqual(f.names(child).filter(name => name.startsWith('mcp__')), [external(2)]);
  assert.equal(f.operations.length, 0);
});

integrationTest('scope-local structured answer tools remain available during creation, activation and refresh', async t => {
  const f = await fixture(t, { count: 3 });
  const localAnswer = { name: 'local_answer', description: 'Answer the delegating parent with structured output.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [text('Answered')] },
    isConcurrencySafe: () => false, execute: () => ({ ok: true }) };
  const child = await f.create({ parentAgent: f.agent, setup(agentCtx) { agentCtx.tools.register(localAnswer); } });
  assert.ok(f.names(child).includes('local_answer'));
  assert.equal(f.names(child).filter(name => name.startsWith('mcp__')).length, 0);
  assert.equal((await f.execute(ACTIVATE, { names: [external(1)] }, child)).value.ok, true);
  assert.ok(f.names(child).includes('local_answer'));
  assert.equal((await f.execute('local_answer', {}, child)).isError, false);
  await f.run(child);
  assert.ok(f.calls.at(-1).tools.some(tool => tool.name === 'local_answer'));
  assert.equal(f.operations.length, 0);
});

integrationTest('unknown, unloaded and cancelled selections never execute or expand the tool surface', async t => {
  const f = await fixture(t, { count: 3 });
  const baseline = f.names().sort();
  assert.equal((await f.execute(ACTIVATE, { names: ['mcp__unknown__missing'] })).value.code, 'TOOL_NOT_AVAILABLE');
  await f.execute(ACTIVATE, { names: [external(1)] });
  f.removers.get(external(1))();
  assert.equal((await f.execute(ACTIVATE, { names: [external(1)] })).value.code, 'TOOL_NOT_AVAILABLE');
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await f.execute(ACTIVATE, { names: [external(2)] }, f.agent, aborted.signal)).isError, true);
  assert.deepEqual(f.names().sort(), baseline);
  assert.equal(f.operations.length, 0);
});

integrationTest('seeded history and plugin reload require rediscovery and never replay old operations', async t => {
  const f = await fixture(t, { count: 3 });
  f.scripts.push([call(ACTIVATE, { names: [external(1)] })], [call(external(1), { count: 1 })], [text('Done')]);
  await f.run();
  const seed = structuredClone(f.events.get(f.agent.session));
  const before = JSON.stringify(seed);
  const resumed = await f.create({ seed });
  assert.equal(f.operations.length, 1);
  assert.equal(f.names(resumed).filter(name => name.startsWith('mcp__')).length, 0);
  assert.equal(JSON.stringify(seed), before);
  await f.run(resumed, 'Continue without repeating completed work');
  assert.equal(f.operations.length, 1);
  assert.ok(!f.calls.at(-1).tools.some(tool => tool.name.startsWith('mcp__')));
  await f.reload();
  assert.equal(f.names().filter(name => name.startsWith('mcp__')).length, 0);
  assert.equal(f.operations.length, 1);
});
