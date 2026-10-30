/*
 * AI Design Hub public frontend demonstration.
 * Original Harness browser plugins remain copyright (c) 2026 DeepSeek, MIT.
 * This adapter contains synthetic data and prewritten replies only. It has no
 * Host, filesystem, credentials, model provider, tool executor, or API backend.
 */
(() => {
  'use strict';
  window.ADH_AGENT_PUBLIC_DEMO = true;
  const DEMO_MESSAGE = '网页交互演示：回复为预设内容，不连接模型、不执行工具。';
  const WELCOME_NOTICE_VERSION = '2026-09-28.1';
  const WELCOME_STORAGE_KEY = 'adh-public-demo-welcome-notice';
  // The public demo already explains its scope in its own permanent notice.
  // Keep the upstream credential onboarding disabled through its supported
  // page-bootstrap option, without pretending to provide a desktop bridge.
  window.__DSH_MODELS_ONBOARDING__ = Object.freeze({ credentialOnboarding: false });
  const now = Date.now();
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const success = value => ({ ok: true, value: clone(value) });
  const failure = (message, code = 'demo/unavailable') => ({
    ok: false, error: { code, message: `${message}（仅浏览器演示）`, details: {} },
  });
  const catalog = {
    default: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    routableProviders: ['deepseek', 'apimart'],
    groups: [
      { id: 'deepseek', name: 'DeepSeek · 演示', models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · 演示', description: DEMO_MESSAGE },
      ] },
      { id: 'apimart', name: 'APIMart · 演示', models: [
        { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol · 演示', description: DEMO_MESSAGE },
        { id: 'gpt-6-astra', name: 'GPT 6 Astra · 演示', description: DEMO_MESSAGE },
      ] },
    ],
    failures: [],
  };
  const skills = [
    { name: 'case-research', description: '案例调研：展示信息收集、来源归档与案例梳理流程。', modelInvocable: false },
    { name: 'case-presentation', description: '案例简报：展示每个案例一页的简报与杂志模板。', modelInvocable: false },
    { name: 'project-context', description: '项目上下文：展示任务、决策、风险与人工核对。', modelInvocable: false },
    { name: 'design-review', description: '设计复核：展示待核对项与协作记录。', modelInvocable: false },
  ];
  const presets = [
    { id: 'standard', isDefault: true, name: 'ADH 工作模式 · 演示', description: '浏览项目上下文与预设对话；不会运行工具。' },
    { id: 'minimal', isDefault: false, name: '简洁模式 · 演示', description: '仅切换浏览器中的展示选项。' },
  ];
  const permissionCatalog = {
    options: [{ value: 'read-only', name: '仅可查看 · 演示', description: '网页不具有主机、文件或工具执行权限。' }],
    defaultOptions: [{ value: 'read-only', name: '仅可查看 · 演示' }],
    defaultPreset: 'read-only',
  };
  const calls = [];
  const streams = new Map();
  const sessions = new Map();
  const archived = new Set();
  const pinned = new Set();
  let counter = 0;
  let blockedNetwork = 0;
  const publicProject = new URLSearchParams(location.search);
  let workspace = {
    workspaceId: publicProject.get('projectId') || 'demo-design-studio', path: '/demo/AI-Design-Hub',
    title: (publicProject.get('projectName') || 'AI Design Hub · 示例项目') + ' · 网页演示', sessionIds: [],
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };

  function log(kind, endpoint) {
    calls.push({ kind, endpoint, at: Date.now() });
    if (calls.length > 200) calls.shift();
  }
  function id(prefix) { return `demo-${prefix}-${++counter}`; }
  function emit(key, value) {
    for (const subscription of streams.get(key) || []) {
      subscription.items.push(clone(value));
      subscription.wake?.();
      subscription.wake = undefined;
    }
  }
  async function* subscribe(key, initial, signal) {
    const subscription = { items: clone(initial), wake: undefined };
    const subscribers = streams.get(key) || new Set();
    subscribers.add(subscription);
    streams.set(key, subscribers);
    const abort = () => { subscription.wake?.(); subscription.wake = undefined; };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (!signal?.aborted) {
        if (subscription.items.length) yield subscription.items.shift();
        else await new Promise(resolve => { subscription.wake = resolve; });
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      subscribers.delete(subscription);
      if (!subscribers.size) streams.delete(key);
    }
  }
  function forwarded(event, ...args) { emit('$events', { type: 'emit', event, args }); }
  function values(session) {
    return {
      title: session.title || null,
      sessionListMetadata: { blank: session.turns === 0, lastPromptAt: session.lastPromptAt || null },
      modelSelection: { lastUsed: null, next: session.selected },
      permissions: { currentValue: 'read-only' },
      agentPreset: session.preset,
    };
  }
  function projections(session) { return { asOfSeq: session.records.length - 1, values: values(session) }; }
  function summary(session) {
    return {
      agentAvailable: true, formatStatus: 'current', sessionId: session.sessionId,
      updatedAt: session.updatedAt, running: false, blank: session.turns === 0,
      cwd: workspace.path, projections: { kind: 'sequenced', ...projections(session) },
    };
  }
  function publish(session) {
    forwarded('api-session/added', summary(session));
    const seq = session.records.length - 1;
    // Unlike baseline cursors, live Session projection deltas cannot use -1.
    if (seq < 0) return;
    for (const [key, value] of Object.entries(values(session))) {
      emit('session/control', { type: 'projection', sessionId: session.sessionId, key, value, seq });
    }
  }
  function workspaceBaseline() {
    return { items: [workspace], archivedSessionIds: [...archived], pinnedSessionIds: [...pinned] };
  }
  function publishWorkspace() { emit('workspace/follow', { type: 'replace', value: workspaceBaseline() }); }
  function append(session, type, data, surface = false) {
    const event = { type, seq: session.records.length, time: Date.now(), data,
      ...(surface ? { surfaceOp: 'append' } : {}) };
    const record = { type: 'event', event };
    session.records.push(record);
    session.updatedAt = event.time;
    emit(`session/follow:${session.sessionId}`, record);
    return event.seq;
  }
  function exchange(session, prompt, answer, requestId) {
    const turn = ++session.turns;
    session.lastPromptAt = Date.now();
    append(session, 'turn/start', { turn });
    append(session, 'step/start', { turn, step: 1 });
    append(session, 'user/message', {
      id: id('message'), role: 'user', content: [{ type: 'text', text: prompt }],
      source: { kind: 'user', ...(requestId ? { rpcId: requestId } : {}) },
    }, true);
    append(session, 'assistant/message', {
      turn, step: 1,
      message: { id: id('message'), role: 'assistant', content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: 'demo', model: 'prewritten-demo' } },
      stream: [],
    }, true);
    append(session, 'step/end', { turn, step: 1 });
    append(session, 'turn/end', { turn, reason: { kind: 'completed' } });
    publish(session);
  }
  function createSession(title, sessionId = id('session')) {
    const session = { sessionId, title, records: [], selected: clone(catalog.default),
      preset: 'standard', turns: 0, updatedAt: Date.now(), lastPromptAt: null };
    sessions.set(sessionId, session);
    workspace.sessionIds.push(sessionId);
    // A metadata-only birth event anchors even a blank demo Session at a real
    // non-negative sequence, while turns === 0 keeps its composer blank.
    append(session, 'session/title', { title, messageSeqs: [], source: { kind: 'fallback' } });
    return session;
  }
  const start = createSession('从设计问题到可追溯项目记录', 'demo-project-context');
  exchange(start, 'AI Design Hub 如何帮助设计团队？',
    '**演示预设回复**\n\nAI Design Hub 把项目任务、决策、风险和参考资料放在同一份上下文中，帮助团队保留讨论依据。\n\n你可以在这里切换示例会话、查看技能、打开模型菜单和设置。桌面版中的模型调用、文件操作及外部 Agent 协作需要另行配置。\n\n本页只在浏览器内展示交互，刷新后恢复示例。');
  const cases = createSession('案例调研与一页简报', 'demo-case-research');
  exchange(cases, '如何把案例资料整理成设计参考？',
    '**演示预设回复**\n\n一个示例流程是：明确问题 → 收集并核对来源 → 归档案例图文 → 人工筛选 → 输出简报。\n\n案例简报可选择简报版或杂志版，每个案例一页。真实检索、原图下载和文稿生成由桌面版的独立能力完成；本页展示预设示例。');
  const collaboration = createSession('团队协作与人工确认', 'demo-design-review');
  exchange(collaboration, 'AI 可以直接替我批准设计决策吗？',
    '**演示预设回复**\n\n设计决策由人确认。AI 可协助把讨论整理成任务、决策和风险草稿，再由项目经理或公司负责人核对与审批。\n\n这条内容是网页演示预设文本，未读取任何真实项目，也没有发起审批或向外部 Agent 派单。');

  function schema(value) {
    let uid = 0;
    const refs = {};
    function add(item) {
      const current = ++uid;
      if (Array.isArray(item)) refs[current] = { type: 'array', inner: add(item[0] || ''), meta: { default: item } };
      else if (item && typeof item === 'object') {
        refs[current] = { type: 'object', dict: Object.fromEntries(Object.entries(item).map(([key, child]) => [key, add(child)])), meta: { default: {} } };
      } else refs[current] = { type: typeof item, meta: { default: item } };
      return current;
    }
    const root = add(value);
    return { uid: root, refs };
  }
  const themePreference = theme => theme === 'dark' ? 'dark' : 'light';
  function initialTheme() {
    try {
      if (window.parent !== window && window.parent.location.origin === location.origin) {
        return themePreference(window.parent.document.documentElement.dataset.theme);
      }
      return themePreference(window.localStorage?.getItem('adh-theme'));
    } catch (_) { return 'light'; }
  }
  const settingsValues = {
    locale: { preference: 'zh' },
    'ui-theme': { preference: initialTheme(), fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' },
    'ui-chat': { transcriptView: 'standard', collapseTiming: 'completion', linkOpening: 'new-tab', performanceUsage: 'compact' },
    'ui-settings': { enabled: true },
    'ui-settings-general': { welcomeNoticeVersion: WELCOME_NOTICE_VERSION },
    'agent-preset-registry': { selectedDefault: 'standard' },
    permission: { defaultPreset: 'read-only' },
    'llm-deepseek': { baseURL: '', apiKeyEnv: 'DEMO_DEEPSEEK_KEY' },
    'llm-apimart': { baseURL: '', apiKeyEnv: 'DEMO_APIMART_KEY' },
  };
  let welcomeRevision = 0;
  let themeRevision = 0;
  function syncTheme(theme) {
    const preference = themePreference(theme);
    if (settingsValues['ui-theme'].preference === preference) return;
    settingsValues['ui-theme'].preference = preference;
    forwarded('settings/document-updated', 'ui-theme', ++themeRevision);
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin ||
        event.data?.type !== 'adh-public-theme' || !['light', 'dark', 'minimal'].includes(event.data.theme)) return;
    syncTheme(event.data.theme);
  });
  window.addEventListener('storage', event => {
    if (event.key === 'adh-theme') syncTheme(event.newValue);
  });
  function namespace(ns) {
    const value = settingsValues[ns];
    return { autoGenerate: false, ns, schema: schema(value), value: clone(value), base: clone(value),
      applies: 'live', secrets: [], revision: ns === 'ui-settings-general' ? welcomeRevision : ns === 'ui-theme' ? themeRevision : 0 };
  }
  function requireSession(request) {
    const sessionId = request?.sessionId || request?.address?.sessionId;
    return sessions.get(sessionId);
  }
  function demoReply(prompt) {
    const label = '**演示预设回复**\n\n';
    if (/案例|调研|case-research/.test(prompt)) return label + '案例调研示例流程：明确研究问题、核对来源、归档图文、人工筛选，再把结论写回项目。这里没有联网检索；请切换左侧“案例调研与一页简报”查看预设示例。';
    if (/PPT|简报|汇报|case-presentation/i.test(prompt)) return label + '案例成果提供简报版与杂志版两种展示方式，每个案例默认一页。网页只展示流程和界面；真实排版生成与文件导出请在桌面版进行。';
    if (/任务|决策|风险|审批|project-context|design-review/.test(prompt)) return label + '项目记录示例包含任务、决策与风险。AI 整理后的内容需要人核对，重要写入由项目负责人确认。本次只显示这条预设文本，未修改项目或派发任务。';
    if (/技能|skill/i.test(prompt)) return label + '在输入区输入“/”可浏览示例技能，包括案例调研、案例简报、项目上下文和设计复核。选择技能会展示输入流程；本页不会执行技能、脚本或工具。';
    if (/模型|DeepSeek|GPT|API|key|密钥/i.test(prompt)) return label + '模型菜单展示 DeepSeek V4.1 Flash、GPT 6.1 Sol 与 GPT 6 Astra 的选择方式。切换只改变浏览器中的展示状态。本页不接受 API 密钥，也不会测试连接或调用模型。';
    return label + '你已完成一次网页对话交互。这里的答复是预先编写的示例，并未分析或执行你的请求。\n\n可以继续体验左侧示例会话、输入“/”查看技能、打开模型菜单，以及查看设置。真实项目资料、模型连接和工具执行都在桌面版中配置。';
  }

  async function call(channel, endpoint, payload = {}, signal) {
    signal?.throwIfAborted();
    log('call', endpoint);
    if (channel !== '/api') return failure('此通道未在演示中提供');
    const args = payload.args || {};
    const request = args.request || args._request || {};
    const session = requireSession(request);
    switch (endpoint) {
      case 'session/list': return success({ items: [...sessions.values()].map(summary) });
      case 'session/search': {
        const query = String(request.query || '').toLowerCase();
        return success({ items: [...sessions.values()].filter(item => item.title.toLowerCase().includes(query))
          .map(item => ({ sessionId: item.sessionId, snippet: item.title })), hasMore: false });
      }
      case 'session/modelCatalog': return success(catalog);
      case 'session/initializeDefaultModel': return success(undefined);
      case 'session/create': {
        const existing = sessions.get(request.sessionId);
        const created = existing || createSession('新的演示对话');
        publish(created);
        publishWorkspace();
        return success({ sessionId: created.sessionId, agentPreset: created.preset });
      }
      case 'session/projections': return success(session ? { kind: 'sequenced', ...projections(session) } : null);
      case 'session/page': return session ? success({ records: session.records.filter(record => record.event.seq <= request.throughSeq &&
        (request.beforeSeq === undefined || record.event.seq < request.beforeSeq)), hasMore: false }) : failure('找不到示例会话');
      case 'session/prompt': {
        if (!session) return failure('找不到示例会话');
        if (!Array.isArray(request.content) || request.content.some(part => part.type !== 'text')) return failure('网页演示仅接收文本，不上传附件');
        const text = request.content.map(part => part.text || '').join('\n').trim().slice(0, 12000);
        if (!text) return failure('请输入文本');
        // One local event turn: no model, agent, network, shell, or tool runs.
        exchange(session, text, demoReply(text), request.requestId);
        return success({ accepted: true });
      }
      case 'session/selectModel': {
        if (!session) return failure('找不到示例会话');
        const known = catalog.groups.some(group => group.id === request.provider && group.models.some(model => model.id === request.model));
        if (!known) return failure('此模型不在演示目录中');
        session.selected = { provider: request.provider, model: request.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) };
        append(session, 'model/selection', session.selected);
        publish(session);
        return success({ selected: session.selected });
      }
      case 'session/rename': {
        if (!session) return failure('找不到示例会话');
        session.title = String(request.title || '').trim().slice(0, 100) || '演示对话';
        const seq = append(session, 'session/title', { title: session.title, messageSeqs: [], source: { kind: 'user' } });
        publish(session);
        return success({ title: session.title, seq });
      }
      case 'session/canOpenWorkspacePath': return success(false);
      case 'session/workspacePathApplications': return success([]);
      case 'skills/list': return success({ skills });
      case 'commands/list': return success([]);
      case 'agentPresets/list': return success({ presets });
      case 'agentPresets/read': return success({ agentPreset: args.agentPreset,
        name: presets.find(item => item.id === args.agentPreset)?.name || '演示模式',
        content: '# AI Design Hub 网页演示\n\n此模式仅用于浏览原版 Agent 界面。\n\n不连接模型、不执行工具、不读取文件、不派单。对话答复为预设内容。' });
      case 'agentPresets/select': {
        const item = sessions.get(args.agentId);
        if (!item || !presets.some(preset => preset.id === args.agentPreset)) return failure('找不到演示模式');
        item.preset = args.agentPreset;
        append(item, 'agent-preset/selected', { id: item.preset });
        publish(item);
        return success(item.preset);
      }
      case 'permissionPresets/catalog': return success(permissionCatalog);
      case 'settings/describe': return success({ writable: false, hasDocument: false, namespaces: Object.keys(settingsValues).map(namespace) });
      case 'llm/listProviders': return success(catalog.groups.map(group => ({ id: group.id, name: group.name })));
      case 'llm/listConfigurableProviders': return success(catalog.groups.map(group => ({ provider: group.id,
        displayName: group.name, settingsNs: `llm-${group.id}`, settingsPath: [], declared: true,
        nativeAuth: { env: [], oauth: false }, error: '仅展示模型菜单；网页没有 API 连接。' })));
      case 'credentials/describe': return success(Object.fromEntries((args.refs || []).map(ref => [ref, { configured: false, writable: false }])));
      case 'workspace/initializeDefault': return success({ workspace });
      case 'workspace/rename': {
        if (request.workspaceId !== workspace.workspaceId) return failure('找不到示例项目');
        workspace.title = String(request.title || '').trim().slice(0, 100) || '演示项目';
        workspace.updatedAt = new Date().toISOString();
        publishWorkspace();
        return success({ workspace });
      }
      case 'workspace/pinSession': case 'workspace/unpinSession': {
        if (!session) return failure('找不到示例会话');
        endpoint === 'workspace/pinSession' ? pinned.add(session.sessionId) : pinned.delete(session.sessionId);
        publishWorkspace();
        return success({ pinnedSessionIds: [...pinned] });
      }
      case 'workspace/archiveSession': case 'workspace/unarchiveSession': {
        if (!session) return failure('找不到示例会话');
        endpoint === 'workspace/archiveSession' ? archived.add(session.sessionId) : archived.delete(session.sessionId);
        publishWorkspace();
        return success({ archivedSessionIds: [...archived] });
      }
      case 'productAnalytics/enabled': return success(false);
      case '$events/result': return failure('演示不会发起需要客户端执行的主机事件');
      case 'settings/mutate': {
        const op = args.ops?.[0];
        if (args.ns === 'ui-settings-general' && args.ops?.length === 1 && op?.op === 'set' &&
            op.path?.length === 1 && op.path[0] === 'welcomeNoticeVersion' && op.value === WELCOME_NOTICE_VERSION) {
          // This exact, non-sensitive UI acknowledgement is the only settings
          // write accepted. Model, credential, permission, and host settings
          // retain the read-only behavior below.
          settingsValues['ui-settings-general'].welcomeNoticeVersion = WELCOME_NOTICE_VERSION;
          welcomeRevision++;
          try { window.localStorage?.setItem(WELCOME_STORAGE_KEY, WELCOME_NOTICE_VERSION); } catch (_) { /* optional browser storage */ }
          forwarded('settings/document-updated', args.ns, welcomeRevision);
          return success(namespace(args.ns));
        }
        return failure('此设置仅供查看，请在桌面版保存配置');
      }
      case 'settings/update': case 'settings/replace': case 'settings/openSettingsDocument':
        return failure('此设置仅供查看，请在桌面版保存配置');
      case 'credentials/set': case 'credentials/unset':
        return failure('网页演示不接收或保存密钥');
      case 'llm/discoverModels':
        return failure('模型发现与连接测试未在网页演示中启用');
      default: return failure('此操作需要桌面版，网页不会执行工具或访问主机');
    }
  }

  function open(channel, endpoint, payload = {}, signal) {
    log('stream', endpoint);
    if (channel !== '/api') return rejectedStream('此通道未在演示中提供');
    const request = payload.args?.request || {};
    switch (endpoint) {
      case '$events': return subscribe('$events', [{ type: 'ready', clientId: 'demo-browser-client', host: { home: '/demo' } }], signal);
      case 'remoteAccess/follow': return subscribe('remoteAccess/follow', [{ type: 'baseline', owner: true }], signal);
      case 'workspace/follow': return subscribe('workspace/follow', [{ type: 'baseline', value: workspaceBaseline() }], signal);
      case 'session/control': return subscribe('session/control', [{ type: 'baseline', value: {
        projections: Object.fromEntries([...sessions.values()].map(session => [session.sessionId, projections(session)])),
      } }], signal);
      case 'session/follow': {
        const session = requireSession(request);
        if (!session) return rejectedStream('找不到示例会话');
        const snapshot = {
          type: 'snapshot', header: { version: 4, id: session.sessionId, createdAt: now,
            cwd: workspace.path, isSeeded: false, agentPreset: session.preset },
          cursor: session.records.length - 1, records: session.records, hasMore: false,
          projections: projections(session), assistantStream: { revision: 0 },
        };
        return subscribe(`session/follow:${session.sessionId}`, [snapshot], signal);
      }
      default: return rejectedStream('此实时功能需要桌面版');
    }
  }
  async function* rejectedStream(message) {
    const error = new Error(`${message}（仅浏览器演示）`);
    error.dshRemoteStreamFailure = { kind: 'remote', code: 'demo/unavailable', details: {} };
    throw error;
  }

  // Dynamic plugin scripts and the original Vite assets remain same-origin
  // static resources. Every HTTP API request and all external fetches fail.
  const staticFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const pageBase = new URL('./', window.location.href);
  window.fetch = function(input, init = {}) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, pageBase);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const relative = target.pathname.startsWith(pageBase.pathname) ? target.pathname.slice(pageBase.pathname.length) : '';
    if (staticFetch && target.origin === pageBase.origin && ['GET', 'HEAD'].includes(method) &&
        /^(?:assets\/|plugins\/|favicon[^/]*\.(?:svg|png)$|manifest\.webmanifest$)/.test(relative)) {
      return staticFetch(input, { ...init, credentials: 'omit' });
    }
    blockedNetwork++;
    return Promise.reject(new Error('演示已阻止网络/API 请求；仅本地预设内容可用。'));
  };
  for (const name of ['WebSocket', 'EventSource', 'WebTransport', 'XMLHttpRequest']) {
    if (name in window) window[name] = class {
      constructor() { blockedNetwork++; throw new Error('网页演示不建立网络或主机连接。'); }
    };
  }
  try { if (navigator.sendBeacon) navigator.sendBeacon = () => { blockedNetwork++; return false; }; } catch (_) { /* readonly host */ }
  window.__DSH_TRANSPORT__ = Object.freeze({ ownsHost: true, rpc: Object.freeze({ call, open }) });
  window.__ADH_AGENT_DEMO__ = Object.freeze({
    status: DEMO_MESSAGE,
    snapshot: () => ({ sessionCount: sessions.size, calls: clone(calls), blockedNetwork,
      streamCount: [...streams.values()].reduce((sum, group) => sum + group.size, 0) }),
  });
  function installNotice() {
    if (!document.body || document.getElementById('adh-agent-demo-notice')) return;
    const style = document.createElement('style');
    style.textContent = '#adh-agent-demo-notice{position:fixed;z-index:2147483000;left:50%;top:9px;transform:translateX(-50%);max-width:calc(100vw - 36px);box-sizing:border-box;padding:5px 11px;border:1px solid #5167e933;border-radius:20px;background:#f5f6fbf0;color:#59658a;font:11px/1.5 system-ui,"Microsoft YaHei",sans-serif;text-align:center;pointer-events:none;box-shadow:0 2px 14px #0001}body[data-ds-dark-theme] #adh-agent-demo-notice{background:#252735f0;color:#dce6f5;border-color:#8b9bff55}@media(max-width:640px){#adh-agent-demo-notice{top:auto;bottom:6px;font-size:10px;padding:3px 8px;width:max-content;max-width:calc(100vw - 12px)}}';
    document.head.appendChild(style);
    const notice = document.createElement('div');
    notice.id = 'adh-agent-demo-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = '网页演示 · 预设回复 · 不调用模型 / 工具';
    document.body.appendChild(notice);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installNotice, { once: true });
  else installNotice();
})();
