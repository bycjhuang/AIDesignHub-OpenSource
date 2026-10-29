window.__ModuleLoader__.load({
  id: '@aidesign/dsh-project-workbench',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const COMMANDS = [
      { name: '案例调研', action: 'research', hint: '结合当前项目检索、下载高清图并保存案例。' },
      { name: '案例PPT', action: 'presentation', hint: '生成案例 PPT：可选简报版或杂志版，如 /案例PPT 杂志版。' },
      { name: '协作', action: 'external', hint: '@ 多个 Agent，分别安排任务，一次发送。' },
      { name: 'Hub', action: 'hub', hint: '案例调研、制作 PPT、参考案例与历史成果。' },
    ];
    const TOOL_TITLES = Object.freeze({
      hub_project_context: '读取当前项目', hub_case_catalog: '筛选参考案例', hub_case_details: '阅读案例资料',
      hub_web_search: '检索公开案例', hub_web_read: '读取公开来源', hub_research_archive: '归档案例与高清图片',
      hub_presentation_create: '制作案例成果', hub_agent_dispatch: '分派外部协作', hub_agent_status: '查看协作回传',
    });
    let pluginContext;
    let disposed = false;
    let pendingIntent;
    let intentRunning = false;
    let modelSlotReady = false;
    let releaseExternalModel = null;
    const PANEL_ID = 'adh-agents';
    let collaborationTab = 'tasks';
    let collaborationIntent = null;
    let centerIntentSerial = 0;
    const consumedCenterIntents = new Set();
    const centerListeners = new Set();
    let nativeTriggerRenderer = null;
    const records = new Map();
    const clean = value => typeof value === 'string' ? value.trim() : '';
    const list = value => Array.isArray(value) ? value : [];
    const friendlyError = error => {
      const message = clean(typeof error === 'string' ? error : error?.message);
      if (/time.?out|timed out|ETIMEDOUT/i.test(message)) return '连接超时，请稍后重试。';
      if (/failed to fetch|network.?error|network request|fetch failed|ECONN|ERR_NETWORK/i.test(message)) return '暂时无法连接项目服务，请稍后重试。';
      if (/abort|cancelled|canceled/i.test(message)) return '本次操作已取消，请重试。';
      return message || '操作未完成，请稍后重试。';
    };
    const statuses = { queued: '等待执行', waiting_agent: '等待外部 Agent', running: '执行中', researching: '调研中', validating: '核对资料中', archiving: '保存图片中', awaiting_review: '成果已返回', complete: '已完成', completed: '已完成', partial: '资料已保存', failed: '未完成', cancelled: '已取消', interrupted: '已中断' };
    function recordFor(sessionId) {
      if (!records.has(sessionId)) records.set(sessionId, { sessionId, executor: 'adh', executorIds: [], listeners: new Set(), snapshot: { loading: true }, loading: null, users: 0, timer: null, routing: false, submission: null, nativeSync: false, nativeTimer: null });
      return records.get(sessionId);
    }
    function publish(record, patch) {
      record.snapshot = { ...record.snapshot, ...patch };
      for (const listener of record.listeners) listener(record.snapshot);
      syncModelSeat();
    }
    function currentSession() {
      try { return Object.values(pluginContext.sessions.list.getSnapshot().byId).find(row => (row.retainedBy?.mainView || 0) > 0)?.id || ''; }
      catch { return ''; }
    }
    function openCollaborationCenter(tab = 'tasks', intent = null) {
      collaborationTab = tab === 'settings' ? 'settings' : 'tasks';
      if (intent) collaborationIntent = { ...intent, serial: ++centerIntentSerial };
      for (const listener of centerListeners) listener(collaborationTab, collaborationIntent);
      pluginContext.get('layout')?.selectPanel(PANEL_ID);
    }
    function syncModelSeat() {
      if (!modelSlotReady || disposed) return;
      const sessionId = currentSession();
      let external = recordFor(sessionId).executor !== 'adh';
      try { external ||= /^\/协作(?:\s|$)/.test(inputFor(sessionId).state.getSnapshot().draft); } catch {}
      // Static SDK providers occupy priority 0; a lower rank shadows them.
      if (external && !releaseExternalModel) releaseExternalModel = pluginContext.slots.register({ name: 'conversation.input.model', priority: -100, inject: sessionId => ({ sessionId }) }, ExternalModel);
      else if (!external && releaseExternalModel) { releaseExternalModel(); releaseExternalModel = null; }
    }
    function scopeFor(sessionId) {
      const scope = pluginContext.sessions.scope(sessionId);
      if (!scope) throw new Error('请先打开或新建一个 ADH 会话。');
      return scope;
    }
    function inputFor(sessionId) { return pluginContext.conversation.input.for(scopeFor(sessionId)); }
    async function request(endpoint, options = {}) {
      let response;
      try { response = await fetch(`/api/adh-project-workbench/${endpoint}`, { credentials: 'same-origin', ...options }); }
      catch (error) { throw new Error(friendlyError(error)); }
      let payload;
      try { payload = await response.json(); } catch { throw new Error('项目协作暂时无法连接，请稍后重试。'); }
      if (!response.ok || payload.ok === false) throw new Error(friendlyError(payload.error?.message || payload.error || '项目协作暂时无法连接。'));
      return payload.result ?? payload.data ?? payload;
    }
    function post(action, sessionId, projectId, args = {}, signal) {
      return request('action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, sessionId, ...(projectId ? { projectId } : {}), arguments: args }), signal });
    }
    async function refresh(sessionId) {
      if (!sessionId || disposed) return null;
      const record = recordFor(sessionId);
      if (record.loading) return record.loading;
      record.loading = (async () => {
        try {
          const state = await request(`state?sessionId=${encodeURIComponent(sessionId)}`);
          if (disposed) return null;
          if (record.snapshot.project?.id && record.snapshot.project.id !== state.project?.id) { record.executor = 'adh'; record.executorIds = []; record.submission = null; }
          if (typeof state.executorId === 'string') record.executor = state.executorId;
          if (Array.isArray(state.executorIds)) record.executorIds = state.executorIds;
          publish(record, { ...state, loading: false, error: null, executor: record.executor });
          if (list(state.collaborationBatches).length || list(state.runs).length) syncCollaborationConversation(sessionId);
          return state;
        } catch (error) {
          if (!disposed) publish(record, { loading: false, error: friendlyError(error) });
          return null;
        } finally { record.loading = null; }
      })();
      return record.loading;
    }
    function useWorkbench(sessionId) {
      const [state, setState] = useState(() => recordFor(sessionId).snapshot);
      useEffect(() => {
        const record = recordFor(sessionId); setState(record.snapshot); record.listeners.add(setState); record.users++;
        void refresh(sessionId);
        if (!record.timer) record.timer = setInterval(() => { if (!document.hidden) void refresh(sessionId); }, 5500);
        return () => { record.listeners.delete(setState); record.users--; if (!record.users) { clearInterval(record.timer); record.timer = null; } };
      }, [sessionId]);
      return state;
    }
    function notify(sessionId, message, isError = false) {
      if (isError) message = friendlyError(message);
      const record = recordFor(sessionId); publish(record, { notice: message, noticeError: isError });
      try { inputFor(sessionId).notify(isError ? 'error' : 'info', message); } catch {}
    }
    function syncCollaborationConversation(sessionId, reveal = false) {
      const sessions = pluginContext.sessions, record = recordFor(sessionId);
      if (reveal && currentSession() === sessionId) {
        const layout = pluginContext.get('layout');
        if (!layout?.panelInfo?.getSnapshot().activePanelId) pluginContext.get('uiWorkspace')?.openSession(sessionId);
      }
      if (record.nativeSync || disposed || typeof sessions.refreshProjections !== 'function' || typeof sessions.refresh !== 'function') return;
      const blank = () => sessions.binding(sessionId)?.session?.getSnapshot?.().blank;
      if (blank() === false) return;
      record.nativeSync = true; let attempts = 0;
      const poll = async () => {
        if (disposed) return;
        // External collaboration has a durable no-model user turn. Refresh its
        // real metadata after Host outbox delivery so a blank draft can promote.
        try { await Promise.all([sessions.refreshProjections(sessionId), sessions.refresh()]); } catch {}
        if (disposed) return;
        if (blank() !== false && ++attempts < 10) record.nativeTimer = setTimeout(poll, 1500);
        else { record.nativeSync = false; record.nativeTimer = null; }
      };
      void poll();
    }
    async function prepared(sessionId, action, prompt, caseIds, signal, expectedProjectId) {
      const record = recordFor(sessionId), state = await refresh(sessionId);
      if (!state?.project?.id) throw new Error(record.snapshot.error || '请先在 Hub 选择一个项目。');
      if (expectedProjectId && expectedProjectId !== state.project.id) throw new Error('项目已切换，请重新选择当前项目的案例。');
      const result = await post('prepare_context', sessionId, state.project.id, { action, prompt, executorId: record.executor, ...(Array.isArray(caseIds) ? { caseIds } : {}) }, signal);
      await refresh(sessionId);
      return { state, result };
    }
    function presentationTemplate(args, fallback = 'brief') {
      const raw = clean(args);
      const editorial = Math.max(raw.lastIndexOf('杂志'), raw.lastIndexOf('editorial'), raw.lastIndexOf('暗色'));
      const brief = Math.max(raw.lastIndexOf('简报'), raw.lastIndexOf('brief'));
      return editorial >= 0 && editorial > brief ? 'editorial' : brief >= 0 ? 'brief' : fallback;
    }
    function taskText(action, args, selectedCount, selectedTemplate) {
      const template = presentationTemplate(args, selectedTemplate);
      const layout = [
        template === 'editorial'
          ? 'PPT 固定使用“杂志版”：暗色底、右侧全幅主图、借鉴 / 转译 / 警示三段结构。'
          : 'PPT 固定使用“简报版”：蓝白版面、左侧项目档案 / 核心特色 / 优势借鉴 / 项目改进，右侧 2×2 图片网格。',
        `调用 hub_presentation_create 时必须传 template: '${template}'。每个案例 1–3 页，默认 1 页；逐页填写 caseId，只放该案例的图。不要额外生成封面、目录、筛选过程、来源清单或分析续页；完整分析和来源放备注与 HTML 分析页。`,
      ];
      if (action === 'presentation') {
        return [
          args || '请结合当前项目制作一份案例分析页和可编辑的案例研究 PPT。',
          selectedCount ? `本次已选择 ${selectedCount} 个案例，请先比较它们与当前项目的匹配程度，再选用适合的案例。` : '请先查看本地案例的简要索引，结合当前项目的定位、规模和设计重点筛选候选，再深入读取合适案例的资料。',
          ...layout,
          '按需要补充公开来源与高清项目图，排除其他项目或广告图片。请实际调用 Hub 的案例与成果工具保存资料、生成并登记分析页和 PPT；保留来源与未完成事项。',
        ].join('\n');
      }
      return [
        args || '请结合当前项目调研两个有参考价值的设计案例。',
        '先查看当前项目与已有案例索引，自行判断哪些案例值得深入研究。实际检索并读取多个公开来源，选择相关高清项目图、下载到本地，把案例资料与全部可用来源写回 Hub。',
        '调研后提炼对当前项目的参考点和限制，并通过 Hub 工具生成案例分析页与可编辑 PPT，完成后在当前对话中给出成果。',
        ...layout,
      ].join('\n');
    }
    async function sendNative(sessionId, prompt, signal) {
      const session = pluginContext.sessions.binding(sessionId)?.session;
      if (!session) throw new Error('当前 ADH 会话尚未就绪，请稍后再试。');
      const echo = session.beginSubmission({ mode: 'queue', text: prompt, attachments: [] });
      try {
        const result = await session.prompt([{ type: 'text', text: prompt }], 'queue', signal, echo.requestId);
        if (!result?.ok) throw new Error(result?.error?.message || 'ADH 未接收本次任务。');
      } catch (error) { echo.abandon(); throw error; }
    }
    async function submitTask(sessionId, action, args, signal) {
      const record = recordFor(sessionId);
      try {
        if (action === 'hub') { await refresh(sessionId); publish(record, { dialog: 'hub', notice: null }); return { kind: 'success' }; }
        if (action === 'external' || record.executor !== 'adh') {
          const instruction = clean(args);
          const state = await refresh(sessionId);
          if (!state?.project?.id) throw new Error(record.snapshot.error || '请先在 Hub 选择一个项目。');
          if (!instruction) { publish(record, { dialog: 'collaboration' }); return { kind: 'success' }; }
          const tasks = parseCollaboration(instruction, state.executors || state.connections, record.executor);
          const executorIds = [...new Set(tasks.map(task => task.connectionId))];
          await post('select_executor', sessionId, state.project.id, { executorId: executorIds.length === 1 ? executorIds[0] : 'collaboration', executorIds }, signal);
          const caseIds = list(state.selectedCaseIds), key = JSON.stringify({ projectId: state.project.id, tasks, caseIds });
          if (record.submission?.key !== key) record.submission = { key, requestId: crypto.randomUUID() };
          const result = await post('external_dispatch_many', sessionId, state.project.id, { requestId: record.submission.requestId, commandText: `/协作 ${instruction}`, tasks, caseIds }, signal);
          record.submission = null;
          publish(record, { externalBatch: result, notice: null, noticeError: false });
          syncCollaborationConversation(sessionId, true);
          void refresh(sessionId); return { kind: 'success', text: `已分派 ${tasks.length} 项协作任务，状态和回传将出现在本会话。` };
        }
        const { state } = await prepared(sessionId, action, args, undefined, signal);
        await sendNative(sessionId, taskText(action, clean(args), list(record.snapshot.selectedCaseIds || state.selectedCaseIds).length, record.snapshot.presentationTemplate || 'brief'), signal);
        return { kind: 'success' };
      } catch (error) { notify(sessionId, error.message, true); return { kind: 'error', text: error.message }; }
    }
    function claimFor(command) {
      return { name: command.name, token: `/${command.name} `, hint: command.hint, attachments: false,
        async submit(args, actx, attachments) {
          const sessionId = pluginContext.sessions.scopeOf(actx);
          if (!sessionId) return { kind: 'error', text: '当前会话不可读取，请重新打开 ADH。' };
          if (attachments?.length) return { kind: 'error', text: '请先移除附件；项目案例资料会由 Hub 自动带入。' };
          return submitTask(sessionId, command.action, args);
        } };
    }
    function findCommand(line) { return COMMANDS.find(command => line === `/${command.name}` || line.startsWith(`/${command.name} `)); }
    function parseCollaboration(text, executors, fallback) {
      const available = list(executors).filter(item => item.id !== 'adh' && !item.internal), matches = [...text.matchAll(/@([^\s@：，,;；]+)/g)];
      const resolve = mention => available.find(item => item.id.toLowerCase() === mention.replace(/:$/, '').toLowerCase() || clean(item.label || item.name).split(/[\s·（(]/)[0].toLowerCase() === mention.replace(/:$/, '').toLowerCase());
      if (!matches.length) {
        const single = available.find(item => item.id === fallback);
        if (!single) throw new Error('请用 @ 选择执行器，并在每个 Agent 后写清它的任务。');
        return [{ connectionId: single.id, instruction: text, title: text.slice(0, 100) }];
      }
      if (matches[0].index > 0 && clean(text.slice(0, matches[0].index))) throw new Error('请把每项任务写在对应的 @Agent 后面。');
      if (matches.length > 8) throw new Error('一次最多分派 8 项任务，请分批发送。');
      return matches.map((match, index) => {
        const executor = resolve(match[1]);
        if (!executor) throw new Error(`未找到执行器 @${match[1]}，请从 @ 菜单选择。`);
        const instruction = clean(text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length)).replace(/^[：:\s]+/, '').trim();
        if (!instruction) throw new Error(`请补充 @${match[1]} 要执行的任务。`);
        return { connectionId: executor.id, instruction, title: instruction.slice(0, 100) };
      });
    }
    function externalPrefix(record) { return record.executor === 'collaboration' ? '/协作 ' : `/协作 @${record.executor} `; }
    async function setExecutor(sessionId, executor, executorIds = []) {
      const record = recordFor(sessionId), state = await refresh(sessionId);
      if (!state?.project?.id) throw new Error('请先在 Hub 选择一个项目。');
      await post('select_executor', sessionId, state.project.id, { executorId: executor, ...(executor === 'collaboration' ? { executorIds } : {}) });
      const input = inputFor(sessionId), draft = input.state.getSnapshot().draft;
      const previous = record.executor; record.executor = executor; record.executorIds = executorIds; publish(record, { executor, notice: null }); record.routing = true;
      let body = draft.replace(/^\/协作(?:\s+|$)/, '');
      if (executor !== 'collaboration' && previous !== 'adh' && previous !== 'collaboration') body = body.replace(new RegExp(`^@${previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+|$)`), '');
      try { input.setDraft(executor === 'adh' ? body : `${externalPrefix(record)}${body}`); input.focus(); }
      finally { record.routing = false; syncModelSeat(); }
    }
    async function selectPresentationTemplate(sessionId, template) {
      const record = recordFor(sessionId);
      publish(record, { styleSaving: true });
      try {
        const state = await refresh(sessionId);
        if (!state?.project?.id) throw new Error('请先在 Hub 选择一个项目。');
        const result = await post('select_presentation_template', sessionId, state.project.id, { template });
        publish(record, { ...result, presentationTemplate: template });
      } catch (error) { notify(sessionId, error.message, true); }
      finally { publish(record, { styleSaving: false }); }
    }
    function ensureExternalRouting(sessionId) {
      const record = recordFor(sessionId), input = inputFor(sessionId), snapshot = input.state.getSnapshot();
      if (record.routing || record.executor === 'adh' || snapshot.phase !== 'plain' || /^\/协作(?:\s|$)/.test(snapshot.draft)) return;
      record.routing = true;
      try { input.setDraft(`${externalPrefix(record)}${snapshot.draft}`); } finally { record.routing = false; }
    }
    async function stageTask(sessionId, action, args = '') {
      const command = COMMANDS.find(item => item.action === action);
      if (!command) return;
      const record = recordFor(sessionId);
      if (record.executor !== 'adh') await setExecutor(sessionId, 'adh');
      record.executor = 'adh'; publish(record, { executor: 'adh', notice: null });
      const input = inputFor(sessionId), current = input.state.getSnapshot();
      if (current.phase === 'submitting' || current.phase === 'adjudicating') throw new Error('请等待当前消息发送后再发起新任务。');
      let previous = current.draft.trim();
      const previousCommand = findCommand(previous);
      if (previousCommand) previous = previous.slice(previousCommand.name.length + 1).trim();
      if (previous && previous !== args.trim()) args = args ? `${previous}\n\n${args}` : previous;
      input.setDraft(`/${command.name}${args ? ` ${args}` : ' '}`); input.focus();
    }
    async function receiveIntent(intent) {
      if (intent.panel === 'skills') {
        window.__adhWorkbenchPendingIntent = null;
        pluginContext.get('layout')?.selectPanel('adh-skills'); return;
      }
      if (intent.panel === 'collaboration') {
        window.__adhWorkbenchPendingIntent = null;
        openCollaborationCenter(intent.tab, intent); return;
      }
      pendingIntent = intent;
      if (intentRunning) return;
      intentRunning = true;
      try {
        let sessionId = currentSession();
        if (!sessionId) {
          const workspace = pluginContext.get('uiWorkspace');
          if (!workspace) throw new Error('请先在 ADH 新建会话，再选择案例。');
          await workspace.startSession(); sessionId = currentSession();
        }
        if (!sessionId) throw new Error('请先在 ADH 选择工作区并新建会话，案例选择已保留。');
        const current = pendingIntent; pendingIntent = null;
        const action = current.action === 'research' ? 'research' : 'presentation';
        if (recordFor(sessionId).executor !== 'adh') await setExecutor(sessionId, 'adh');
        await prepared(sessionId, action, current.prompt || '', current.caseIds, undefined, current.projectId);
        pluginContext.get('layout')?.selectPanel(null);
        await stageTask(sessionId, action, current.prompt || '');
        window.__adhWorkbenchPendingIntent = null;
      } catch (error) {
        const sessionId = currentSession();
        if (sessionId) notify(sessionId, error.message, true);
        else { window.__adhWorkbenchPendingIntent = pendingIntent || intent; console.warn('[adh-workbench] task draft awaits a session'); }
      } finally { intentRunning = false; }
    }
    function glyph(name) {
      const paths = name === 'chevron' ? ['M6 9l6 6 6-6'] : name === 'case' ? ['M4 5h16v14H4z', 'M4 14l5-5 5 5 3-3 3 3'] : ['M9 3h6v4H9z', 'M5 8h14v12H5z', 'M9 12h.01', 'M15 12h.01', 'M9 16h6'];
      return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...paths.map((d, index) => h('path', { key: index, d })));
    }
    const CSS = `
      .adh-wb-controls,.adh-wb-agents { --wb-ink:var(--dsw-alias-label-primary,#20243b);--wb-muted:var(--dsw-alias-label-caption,#7c819a);--wb-paper:var(--dsw-alias-bg-layer-1,#fff);--wb-line:var(--dsw-alias-border-l3,#e5e7f0);--wb-accent:var(--dsw-alias-brand-primary,#5167e9);color:var(--wb-ink);font-family:inherit; }
      .adh-wb-controls button,.adh-wb-dock button,.adh-wb-results button,.adh-wb-dialog button { font:inherit;cursor:pointer; }
      .adh-wb-controls {position:relative;display:inline-flex;align-items:center;min-width:0;}
      .adh-wb-ppt-style {max-width:108px;min-width:0;padding:5px 2px;border:0;border-radius:7px;background:transparent;color:var(--wb-muted);font:inherit;font-size:12px;cursor:pointer;}
      .adh-wb-ppt-style:hover {background:color-mix(in srgb,var(--wb-accent) 7%,transparent);color:var(--wb-accent);}
      .adh-wb-executor {border:0;background:transparent;color:var(--wb-muted);display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:190px;font-size:12px;padding:5px 7px;border-radius:7px;white-space:nowrap;}
      .adh-wb-executor > svg {flex:none;}.adh-wb-executor-label {min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .adh-wb-executor:hover,.adh-wb-action:hover {background:color-mix(in srgb,var(--wb-accent) 7%,transparent);color:var(--wb-accent);}
      .adh-wb-executor.is-external {color:var(--wb-accent);background:color-mix(in srgb,var(--wb-accent) 7%,transparent);}
      .adh-wb-menu {position:absolute;right:0;bottom:calc(100% + 10px);z-index:90;width:min(290px,80vw);padding:7px;background:var(--wb-paper);border:1px solid var(--wb-line);border-radius:12px;box-shadow:0 10px 40px #17214b20;}
      .adh-wb-menu-label {padding:7px 10px 5px;font-size:11px;color:var(--wb-muted);}
      .adh-wb-option {width:100%;display:flex;justify-content:space-between;gap:12px;text-align:left;border:0;border-radius:7px;background:transparent;color:var(--wb-ink);padding:9px 10px;font-size:12px;}
      .adh-wb-option:hover,.adh-wb-option[aria-selected=true] {background:color-mix(in srgb,var(--wb-accent) 8%,transparent);color:var(--wb-accent);}
      .adh-wb-option small {display:block;margin-top:3px;font-size:10px;color:var(--wb-muted);}
      .adh-wb-menu-separator {margin:5px 4px;border-top:1px solid var(--wb-line);}
      .adh-wb-external-model {display:inline-flex;align-items:center;gap:4px;max-width:120px;min-width:0;border:0;background:transparent;color:var(--dsw-alias-label-disable,#a3a7b8);font:inherit;font-size:12px;padding:5px 7px;cursor:default;white-space:nowrap;}
      .adh-wb-external-model span {overflow:hidden;text-overflow:ellipsis;}.adh-wb-external-model svg {flex:none;}
      .adh-wb-controls button:focus-visible,.adh-wb-dock button:focus-visible,.adh-wb-results button:focus-visible,.adh-wb-dialog button:focus-visible {outline:2px solid #7585ee;outline-offset:2px;}
      .adh-wb-results {display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;min-width:0;max-width:100%;padding:4px 0 2px;font-size:11px;}
      .adh-wb-result {display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--wb-accent);border:0;border-radius:5px;padding:3px 2px;font-size:11px;max-width:150px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
      .adh-wb-result:hover {text-decoration:underline;}.adh-wb-result.history {color:var(--wb-muted);font-size:10px;}
      .adh-wb-notice {min-width:0;max-width:100%;overflow-wrap:anywhere;color:var(--wb-muted);font-size:11px;line-height:1.6;flex-basis:100%;}
      .adh-wb-notice.error {color:#b95568;}
      .adh-wb-tool {display:flex;align-items:center;gap:8px;min-height:30px;padding:3px 0;color:var(--dsw-alias-label-primary,#30354c);font-family:inherit;font-size:12px;line-height:1.5;}
      .adh-wb-tool-mark {flex:0 0 15px;display:flex;align-items:center;justify-content:center;width:15px;height:15px;color:var(--dsw-alias-brand-primary,#6877e9);font-size:11px;}
      .adh-wb-tool-mark.done {color:#659579;}.adh-wb-tool-mark.failed {color:#b75d6f;}
      .adh-wb-tool-title {flex:0 0 auto;font-weight:500;}
      .adh-wb-tool-summary {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#81879b);font-size:11px;}
      .adh-wb-tool-inspect {flex:0 0 auto;margin-left:2px;border:0;background:transparent;color:var(--dsw-alias-label-caption,#81879b);font:inherit;font-size:10px;padding:3px 5px;border-radius:4px;cursor:pointer;}
      .adh-wb-tool-inspect:hover {color:var(--dsw-alias-brand-primary,#6877e9);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6877e9) 7%,transparent);}
      .adh-wb-tool-inspect:focus-visible {outline:2px solid #7585ee;outline-offset:2px;}
      .adh-wb-collaboration-message {padding:14px 0;color:var(--dsw-alias-label-primary,#20243b);font:inherit;min-width:0;}.adh-wb-collaboration-message header {display:flex;align-items:center;gap:9px;margin-bottom:8px;font-size:12px;}.adh-wb-collaboration-message header strong {font-size:12px;font-weight:550;}.adh-wb-collaboration-message header span {font-size:11px;color:var(--dsw-alias-label-caption,#7c819a);}.adh-wb-collaboration-body {font-size:13px;line-height:1.8;overflow-wrap:anywhere;}.adh-wb-collaboration-body > p {margin:0;white-space:pre-wrap;}.adh-wb-history-events {padding:0 23px 20px;font-size:12px;}.adh-wb-history-events p {overflow-wrap:anywhere;}
      .adh-wb-dialog {position:fixed;inset:0;margin:auto;width:min(670px,calc(100vw - 36px));max-height:calc(100vh - 70px);padding:0;border:1px solid var(--dsw-alias-border-l3,#e5e7f0);border-radius:15px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#20243b);box-shadow:0 18px 70px #17214b38;font:inherit;font-size:13px;line-height:1.7;}
      .adh-wb-dialog::backdrop {background:#141d3d55;}
      .adh-wb-dialog-head {display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:20px 23px 15px;border-bottom:1px solid var(--dsw-alias-border-l3,#e5e7f0);}
      .adh-wb-dialog h2 {margin:0;font-size:18px;font-weight:650;}
      .adh-wb-dialog p {margin:6px 0;color:var(--dsw-alias-label-caption,#7c819a);font-size:12px;line-height:1.7;}
      .adh-wb-close {border:0;background:transparent;color:inherit;padding:3px 7px;border-radius:5px;font-size:18px;}
      .adh-wb-cases {max-height:calc(100vh - 295px);min-height:80px;overflow:auto;padding:0 23px;}
      .adh-wb-case {display:flex;align-items:flex-start;gap:11px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#e5e7f0);cursor:pointer;}
      .adh-wb-case input {accent-color:#6576ec;margin:5px 0 0;}
      .adh-wb-case > span {min-width:0;overflow-wrap:anywhere;}
      .adh-wb-case strong {display:block;font-size:13px;font-weight:600;overflow-wrap:anywhere;}
      .adh-wb-case small {display:block;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-caption,#7c819a);margin-top:4px;overflow-wrap:anywhere;}
      .adh-wb-case-note {padding:22px 0;text-align:center;}
      .adh-wb-dialog-foot {display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:15px 23px;border-top:1px solid var(--dsw-alias-border-l3,#e5e7f0);}
      .adh-wb-primary {border:0;border-radius:8px;background:#6071ec;color:white;font-size:12px;padding:9px 15px;}
      .adh-wb-secondary {border:1px solid var(--dsw-alias-border-l3,#e5e7f0);border-radius:8px;background:transparent;color:inherit;font-size:12px;padding:8px 13px;}
      .adh-wb-dialog pre {font-family:inherit;font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:20px 23px;max-height:55vh;overflow:auto;}
      .adh-wb-artifact-history {list-style:none;margin:0;padding:0 23px;max-height:55vh;overflow:auto;}
      .adh-wb-artifact-history li {display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#e5e7f0);}
      .adh-wb-artifact-history span {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;}
      .adh-wb-artifact-history button {flex:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary,#5167e9);font:inherit;font-size:12px;}
      .adh-wb-hub {padding:20px 23px;}.adh-wb-hub-actions {display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;}.adh-wb-hub .adh-wb-results {margin-top:12px;}
      .adh-wb-style {display:flex;align-items:center;gap:6px;flex-basis:100%;}
      .adh-wb-style-label {font-size:12px;color:var(--dsw-alias-label-caption,#7c819a);margin-right:2px;}
      .adh-wb-style button[aria-pressed="true"] {border-color:#6071ec;color:#6071ec;background:rgba(96,113,236,.10);}
      .adh-wb-task-editor {padding:0 23px 18px;overflow:auto;max-height:55vh;}.adh-wb-task-row {display:grid;grid-template-columns:minmax(120px,1fr) auto;gap:8px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#e5e7f0);}
      .adh-wb-task-row select,.adh-wb-task-row textarea {box-sizing:border-box;width:100%;min-width:0;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l3,#e5e7f0);border-radius:7px;font:inherit;font-size:12px;padding:8px 10px;}
      .adh-wb-task-row textarea {grid-column:1/-1;min-height:72px;resize:vertical;}.adh-wb-task-remove {border:0;background:transparent;color:var(--dsw-alias-label-caption,#7c819a);font-size:12px;padding:5px;}.adh-wb-task-add {margin-top:14px;}
      .adh-wb-agents {box-sizing:border-box;height:100%;display:flex;flex-direction:column;min-width:0;padding:30px clamp(20px,4vw,52px);}.adh-wb-agents h1 {font-size:23px;font-weight:600;margin:0;}.adh-wb-agents p {font-size:12px;color:var(--wb-muted);margin:8px 0 0;}.adh-wb-agents-head {display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:26px;}
      .adh-wb-agents-body {display:flex;gap:30px;min-height:0;flex:1;}.adh-wb-agent-list {width:180px;flex:0 0 auto;display:flex;flex-direction:column;gap:5px;overflow:auto;}.adh-wb-agent-item {border:0;border-radius:8px;background:transparent;color:var(--wb-muted);font:inherit;font-size:13px;display:flex;justify-content:space-between;gap:8px;padding:11px 12px;text-align:left;cursor:pointer;}.adh-wb-agent-item span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}.adh-wb-agent-item[aria-pressed=true] {background:color-mix(in srgb,var(--wb-accent) 8%,transparent);color:var(--wb-accent);}.adh-wb-agent-item small {font-size:11px;flex:none;}
      .adh-wb-agent-tasks {flex:1;min-width:0;overflow:auto;}.adh-wb-agent-tasks h2 {font-size:15px;font-weight:550;margin:8px 0 14px;}.adh-wb-agent-task {width:100%;border:0;border-bottom:1px solid var(--wb-line);background:transparent;color:var(--wb-ink);font:inherit;text-align:left;display:flex;align-items:center;gap:18px;padding:16px 2px;cursor:pointer;}.adh-wb-agent-task > span {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}.adh-wb-agent-task small {color:var(--wb-muted);font-size:11px;flex:none;}.adh-wb-agent-task:hover {color:var(--wb-accent);}.adh-wb-agent-empty {padding:30px 0;color:var(--wb-muted);font-size:13px;}
      .adh-wb-project-folder {border-bottom:1px solid var(--wb-line);}.adh-wb-project-folder > summary {display:flex;align-items:center;gap:8px;list-style:none;padding:13px 0;cursor:pointer;font-size:13px;color:var(--wb-ink);}.adh-wb-project-folder > summary::-webkit-details-marker {display:none;}.adh-wb-project-folder > summary:before {content:'›';display:inline-block;color:var(--wb-muted);font-size:18px;line-height:16px;transition:transform .12s;}.adh-wb-project-folder[open] > summary:before {transform:rotate(90deg);}.adh-wb-project-folder > summary span {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.adh-wb-project-folder > summary small {margin-left:auto;color:var(--wb-muted);font-size:11px;flex:none;}.adh-wb-project-folder .adh-wb-agent-task {padding-left:23px;border-bottom:0;}.adh-wb-project-folder .adh-wb-agent-empty {padding:7px 0 17px 23px;margin:0;}.adh-wb-agent-task:disabled {color:var(--wb-muted);cursor:default;}.adh-wb-agent-task:disabled:hover {color:var(--wb-muted);}
      .adh-wb-center-tabs {display:flex;gap:24px;border-bottom:1px solid var(--wb-line);margin:-8px 0 22px;flex:none;}.adh-wb-center-tabs button {font:inherit;font-size:13px;color:var(--wb-muted);border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 0;cursor:pointer;}.adh-wb-center-tabs button[aria-pressed=true] {color:var(--wb-accent);border-bottom-color:var(--wb-accent);}
      .adh-wb-settings {min-height:0;overflow:auto;max-width:960px;width:100%;padding-right:5px;padding-bottom:30px;}.adh-wb-settings * {box-sizing:border-box;}.adh-wb-settings button {font:inherit;font-size:12px;cursor:pointer;}.adh-wb-settings button:disabled {opacity:.5;cursor:default;}.adh-wb-settings h2 {font-size:15px;font-weight:600;margin:0;}.adh-wb-settings h3 {font-size:13px;font-weight:550;margin:18px 0 12px;}.adh-wb-settings p {line-height:1.7;}.adh-wb-settings-section {padding:0 0 23px;margin:0 0 22px;border-bottom:1px solid var(--wb-line);}.adh-wb-settings-heading {display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px;}.adh-wb-settings-actions {display:flex;align-items:center;flex-wrap:wrap;gap:9px;}.adh-wb-text-button {border:0;background:transparent;color:var(--wb-accent);padding:5px 3px;font:inherit;font-size:12px;white-space:nowrap;}.adh-wb-detected-item,.adh-wb-connection {display:flex;align-items:center;justify-content:space-between;gap:15px;padding:13px 0;border-bottom:1px solid var(--wb-line);}.adh-wb-detected-item:last-child,.adh-wb-connection:last-child {border-bottom:0;}.adh-wb-detected-item > div:first-child,.adh-wb-connection > div:first-child {min-width:0;}.adh-wb-settings strong {font-size:13px;font-weight:550;overflow-wrap:anywhere;}.adh-wb-settings small {display:block;color:var(--wb-muted);font-size:11px;margin-top:4px;}.adh-wb-settings code {font-family:monospace;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;display:block;margin-top:8px;}.adh-wb-settings summary {font-size:12px;cursor:pointer;color:var(--wb-muted);}.adh-wb-settings details {margin-top:10px;}.adh-wb-settings details[open] > summary {margin-bottom:12px;}.adh-wb-settings-notice {color:var(--wb-muted);}.adh-wb-settings-error {color:#b95565!important;}
      .adh-wb-connection-editor,.adh-wb-grant-form {display:flex;flex-direction:column;gap:13px;margin-top:18px;}.adh-wb-settings label {display:flex;flex-direction:column;gap:7px;font-size:12px;min-width:0;color:var(--wb-ink);}.adh-wb-settings input:not([type=checkbox]),.adh-wb-settings select,.adh-wb-settings textarea {width:100%;min-width:0;border:1px solid var(--wb-line);border-radius:7px;background:var(--wb-paper);color:var(--wb-ink);font:inherit;font-size:12px;padding:8px 10px;}.adh-wb-settings textarea {resize:vertical;line-height:1.65;}.adh-wb-form-row {display:grid;grid-template-columns:1fr 1fr;gap:15px;}.adh-wb-advanced > label,.adh-wb-advanced > .adh-wb-form-row {margin-top:13px;}.adh-wb-mcp > summary {font-size:14px;color:var(--wb-ink);font-weight:550;}.adh-wb-mcp-body {padding:1px 0;}.adh-wb-gateway {display:flex;gap:12px;margin-top:15px;}.adh-wb-gateway button {flex:none;}.adh-wb-scopes {border:1px solid var(--wb-line);border-radius:7px;display:flex;flex-wrap:wrap;gap:10px 18px;padding:11px 13px 14px;margin:0;}.adh-wb-scopes legend {font-size:11px;color:var(--wb-muted);padding:0 5px;}.adh-wb-scopes label {flex-direction:row;align-items:center;gap:6px;}.adh-wb-scopes input {accent-color:var(--wb-accent);}.adh-wb-grant-form > button {align-self:flex-start;}.adh-wb-grant-form > p {margin:0;}.adh-wb-template {margin:25px 0 15px;display:flex;flex-direction:column;align-items:flex-start;gap:10px;}.adh-wb-template textarea {font-family:monospace;font-size:11px;}
      @media(max-width:700px){.adh-wb-executor{max-width:140px}.adh-wb-dialog-head,.adh-wb-dialog-foot{padding:17px}.adh-wb-cases,.adh-wb-task-editor{padding-left:17px;padding-right:17px}.adh-wb-agents-body{flex-direction:column;gap:12px}.adh-wb-agent-list{width:100%;flex-direction:row;flex-shrink:0}.adh-wb-agent-item{flex-shrink:0;max-width:180px}.adh-wb-agent-tasks{overflow:auto}}
      @media(max-width:600px){.adh-wb-settings-heading{align-items:flex-start;flex-direction:column}.adh-wb-form-row{grid-template-columns:1fr}.adh-wb-detected-item,.adh-wb-connection{flex-wrap:wrap}.adh-wb-gateway{flex-wrap:wrap}.adh-wb-agents{padding:22px 18px}}
    `;
    function Dialog({ title, description, onClose, children, footer }) {
      const ref = useRef(null);
      useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
      return h('dialog', { className: 'adh-wb-dialog', ref, onCancel: onClose, onClick: event => { if (event.target !== ref.current) return; const box = ref.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } },
        h('header', { className: 'adh-wb-dialog-head' }, h('div', null, h('h2', null, title), description && h('p', null, description)), h('button', { type: 'button', className: 'adh-wb-close', onClick: onClose, 'aria-label': '关闭' }, '×')),
        children, footer && h('footer', { className: 'adh-wb-dialog-foot' }, footer));
    }
    function ExecutorMenu({ sessionId }) {
      const state = useWorkbench(sessionId), [open, setOpen] = useState(false), ref = useRef(null);
      const record = recordFor(sessionId), executors = [{ id: 'adh', label: 'ADH Agent', internal: true }, ...list(state.executors || state.connections).filter(item => item.id !== 'adh')];
      const chosen = record.executor === 'collaboration' ? { label: '多 Agent 协作' } : executors.find(item => item.id === record.executor) || executors[0];
      const closeDialog = () => publish(record, { dialog: null });
      useEffect(() => { const listener = event => { if (!ref.current?.contains(event.target)) setOpen(false); }; document.addEventListener('pointerdown', listener); return () => document.removeEventListener('pointerdown', listener); }, []);
      useEffect(() => { try { const input = inputFor(sessionId); return input.state.subscribe(() => { ensureExternalRouting(sessionId); syncModelSeat(); }); } catch { return undefined; } }, [sessionId]);
      return h('div', { className: 'adh-wb-controls', ref },
        h('button', { type: 'button', className: `adh-wb-executor${record.executor !== 'adh' ? ' is-external' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': open, onClick: () => { setOpen(value => !value); if (!open) void refresh(sessionId); }, title: '选择本次任务的执行器' }, glyph('agent'), h('span', { className: 'adh-wb-executor-label' }, chosen.label || chosen.name || 'ADH Agent'), glyph('chevron')),
        record.executor === 'adh' && h('select', { className: 'adh-wb-ppt-style', 'aria-label': '案例 PPT 风格', title: '案例 PPT 风格 · 每个案例 1–3 页（默认 1 页）', value: state.presentationTemplate || 'brief', disabled: state.loading || state.styleSaving, onChange: event => { void selectPresentationTemplate(sessionId, event.target.value); } },
          h('option', { value: 'brief' }, 'PPT · 简报版'), h('option', { value: 'editorial' }, 'PPT · 杂志版')),
        open && h('div', { className: 'adh-wb-menu', role: 'listbox', 'aria-label': '任务执行器', onKeyDown: event => { if (event.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } } }, h('div', { className: 'adh-wb-menu-label' }, '由谁执行'),
          ...executors.map((executor, index) => h(React.Fragment, { key: executor.id }, index === 1 && h('div', { className: 'adh-wb-menu-separator' }), h('button', { type: 'button', role: 'option', 'aria-selected': record.executor === executor.id, className: 'adh-wb-option', onClick: async () => { try { await setExecutor(sessionId, executor.id); setOpen(false); } catch (error) { notify(sessionId, error.message, true); } } }, h('span', null, executor.label || executor.name, h('small', null, executor.id === 'adh' ? '当前项目中的研究与制作' : '外部协作，任务与回传保存在协作中心')), record.executor === executor.id ? '✓' : null))),
          h('div', { className: 'adh-wb-menu-separator' }),
          h('button', { type: 'button', role: 'option', 'aria-selected': record.executor === 'collaboration', className: 'adh-wb-option', disabled: executors.length === 1, onClick: async () => { try { await setExecutor(sessionId, 'collaboration', record.executorIds); setOpen(false); publish(record, { dialog: 'collaboration' }); } catch (error) { notify(sessionId, error.message, true); } } }, h('span', null, '多 Agent 协作', h('small', null, '@ 多个 Agent，分别安排任务'))),
          h('button', { type: 'button', className: 'adh-wb-option', onClick: () => { setOpen(false); publish(record, { dialog: 'hub' }); } }, 'Hub 任务…'),
          h('button', { type: 'button', className: 'adh-wb-option', onClick: () => { setOpen(false); openCollaborationCenter('settings'); } }, 'Agent 协作中心…')),
        state.dialog === 'hub' && h(HubTasks, { sessionId, state, onClose: closeDialog }),
        state.dialog === 'cases' && h(CasePicker, { key: `${sessionId}:${state.project?.id}`, sessionId, state, onClose: () => publish(record, { dialog: 'hub' }) }),
        state.dialog === 'collaboration' && h(CollaborationEditor, { key: `${sessionId}:${state.project?.id}`, sessionId, state, onClose: closeDialog }));
    }
    function ExternalModel({ sessionId }) {
      const record = recordFor(sessionId);
      return h('button', { type: 'button', disabled: true, className: 'adh-wb-external-model', title: record.executor === 'collaboration' ? '每项任务使用对应 Agent 配置的模型。' : '模型以该 Agent 的配置为准。', 'aria-label': '外部 Agent 模型由其自身配置，此处不可修改' }, h('span', null, record.executor === 'collaboration' ? '各 Agent 模型' : 'Agent 模型'), glyph('chevron'));
    }
    function CasePicker({ sessionId, state, onClose }) {
      const [selected, select] = useState(() => new Set(list(state.selectedCaseIds))), [busy, setBusy] = useState(false), [error, setError] = useState('');
      const cases = list(state.cases || state.caseCatalog);
      async function save() {
        setBusy(true); setError('');
        try { await post('select_cases', sessionId, state.project.id, { caseIds: [...selected] }); await refresh(sessionId); onClose(); }
        catch (cause) { setError(cause.message); } finally { setBusy(false); }
      }
      return h(Dialog, { title: '选择参考案例', description: '可手动选择，也可以留空，让 ADH 先按当前项目筛选。', onClose, footer: h(React.Fragment, null, h('button', { type: 'button', className: 'adh-wb-secondary', disabled: busy, onClick: () => select(new Set()) }, '由 ADH 筛选'), h('button', { type: 'button', className: 'adh-wb-primary', disabled: busy, onClick: save }, busy ? '保存中…' : selected.size ? `使用 ${selected.size} 个案例` : '让 ADH 自行筛选')) },
        h('div', { className: 'adh-wb-cases' }, cases.length ? cases.map(item => h('label', { key: item.id, className: 'adh-wb-case' }, h('input', { type: 'checkbox', checked: selected.has(item.id), disabled: busy, onChange: event => select(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }) }), h('span', null, h('strong', null, item.name || item.title), h('small', null, [item.typeLabel || item.type, item.location, item.area?.value || item.area].filter(value => typeof value === 'string').join(' · ')), h('small', null, clean(item.summary || item.features || item.notes).slice(0, 150))))) : h('p', { className: 'adh-wb-case-note' }, '本地还没有案例，可先从“案例调研”开始。'), error && h('p', { role: 'alert' }, error)));
    }
    function HubTasks({ sessionId, state, onClose }) {
      const template = state.presentationTemplate || 'brief';
      const stage = (action, args = '') => { onClose(); void stageTask(sessionId, action, args).catch(error => notify(sessionId, error.message, true)); };
      const templateLabel = template === 'editorial' ? '杂志版' : '简报版';
      return h(Dialog, { title: 'Hub 任务', description: state.project?.name ? `当前项目：${state.project.name}` : '请先在 Hub 选择项目。', onClose },
        h('div', { className: 'adh-wb-hub' }, h('div', { className: 'adh-wb-hub-actions' },
          h('button', { type: 'button', className: 'adh-wb-primary', onClick: () => stage('research') }, '案例调研'),
          h('div', { className: 'adh-wb-style', role: 'group', 'aria-label': '案例 PPT 风格' },
            h('span', { className: 'adh-wb-style-label' }, 'PPT 风格'),
            h('button', { type: 'button', className: 'adh-wb-secondary', disabled: state.styleSaving, 'aria-pressed': template === 'brief', onClick: () => selectPresentationTemplate(sessionId, 'brief') }, '简报版'),
            h('button', { type: 'button', className: 'adh-wb-secondary', disabled: state.styleSaving, 'aria-pressed': template === 'editorial', onClick: () => selectPresentationTemplate(sessionId, 'editorial') }, '杂志版')),
          h('button', { type: 'button', className: 'adh-wb-secondary', onClick: () => stage('presentation', `使用${templateLabel}固定版式。调用 hub_presentation_create 时必须传 template: '${template}'。`) }, `制作案例 PPT · ${templateLabel}`),
          h('button', { type: 'button', className: 'adh-wb-secondary', onClick: () => publish(recordFor(sessionId), { dialog: 'cases' }) }, list(state.selectedCaseIds).length ? `参考案例 · ${state.selectedCaseIds.length}` : '参考案例')),
          h('p', null, '简报版为蓝白四图网格，杂志版为暗色全幅主图。每个案例 1–3 页，默认 1 页；选择会保留。调研与 PPT 均使用所选风格。任务会作为草稿带入输入框，确认后发送。'),
          h(ResultsDock, { sessionId, state })));
    }
    function CollaborationEditor({ sessionId, state, onClose }) {
      const available = list(state.executors || state.connections).filter(item => item.id !== 'adh' && !item.internal);
      const [tasks, setTasks] = useState(() => {
        const record = recordFor(sessionId), draft = inputFor(sessionId).state.getSnapshot().draft.replace(/^\/协作(?:\s+|$)/, '').trim();
        if (draft) { try { return parseCollaboration(draft, available, record.executor); } catch {} }
        const ids = record.executorIds.length ? record.executorIds : record.executor !== 'adh' && record.executor !== 'collaboration' ? [record.executor] : [];
        return ids.length ? ids.map(connectionId => ({ connectionId, instruction: '' })) : [{ connectionId: available[0]?.id || '', instruction: draft }];
      }), [busy, setBusy] = useState(false), [error, setError] = useState('');
      function edit(index, patch) { setTasks(previous => previous.map((task, i) => i === index ? { ...task, ...patch } : task)); }
      async function save() {
        setError('');
        if (!tasks.length || tasks.some(task => !task.connectionId || !clean(task.instruction))) { setError('请为每项任务选择 Agent，并填写任务内容。'); return; }
        setBusy(true);
        try {
          await setExecutor(sessionId, 'collaboration', [...new Set(tasks.map(task => task.connectionId))]);
          inputFor(sessionId).setDraft(`/协作 ${tasks.map(task => `@${task.connectionId} ${clean(task.instruction)}`).join('\n')}`);
          inputFor(sessionId).focus(); onClose();
        } catch (cause) { setError(friendlyError(cause)); } finally { setBusy(false); }
      }
      return h(Dialog, { title: '安排 Agent 协作', description: '分别写下每个 Agent 的任务，加入草稿后在当前对话发送。', onClose, footer: h(React.Fragment, null, h('span', null, '状态和回传保存在本对话'), h('button', { type: 'button', className: 'adh-wb-primary', disabled: busy || !available.length, onClick: save }, busy ? '保存中…' : '加入输入框')) },
        h('div', { className: 'adh-wb-task-editor' }, available.length ? tasks.map((task, index) => h('div', { className: 'adh-wb-task-row', key: index },
          h('select', { 'aria-label': `第 ${index + 1} 项任务的 Agent`, value: task.connectionId, disabled: busy, onChange: event => edit(index, { connectionId: event.target.value }) }, available.map(item => h('option', { key: item.id, value: item.id }, item.label || item.name || item.id))),
          h('button', { type: 'button', className: 'adh-wb-task-remove', disabled: busy || tasks.length === 1, onClick: () => setTasks(previous => previous.filter((_, i) => i !== index)), 'aria-label': `移除第 ${index + 1} 项任务` }, '移除'),
          h('textarea', { value: task.instruction, disabled: busy, 'aria-label': `第 ${index + 1} 项任务`, placeholder: '例如：调研两个滨水文化商业案例，保存来源与高清图片。', onChange: event => edit(index, { instruction: event.target.value }) }))) : h('p', null, '请先在 Agent 协作中心配置可用执行器。'),
          available.length > 0 && tasks.length < 8 && h('button', { type: 'button', className: 'adh-wb-secondary adh-wb-task-add', disabled: busy, onClick: () => setTasks(previous => [...previous, { connectionId: available[0].id, instruction: '' }]) }, '+ 添加任务'),
          error && h('p', { role: 'alert' }, error)));
    }
    function AgentsIcon({ size = 20 }) { return h('span', { style: { display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center' } }, glyph('agent')); }
    function AgentsPanel() {
      const [catalog, setCatalog] = useState({ loading: true, agents: [] }), [selected, setSelected] = useState(''), [error, setError] = useState(''), [expanded, setExpanded] = useState(() => new Map()), [tab, setTab] = useState(collaborationTab), [intent, setIntent] = useState(collaborationIntent), [history, setHistory] = useState(null);
      const active = useRef(true);
      async function load() {
        try { const next = await post('collaboration_catalog', currentSession(), undefined); if (active.current) { setCatalog({ ...next, loading: false }); setError(''); } }
        catch (cause) { if (active.current) { setError(friendlyError(cause)); setCatalog(previous => ({ ...previous, loading: false })); } }
      }
      useEffect(() => { active.current = true; void load(); const interval = setInterval(() => { if (!document.hidden) void load(); }, 5500); const unsubscribe = pluginContext.sessions.list.subscribe(() => void load()); return () => { active.current = false; clearInterval(interval); unsubscribe(); }; }, []);
      useEffect(() => { const listener = (nextTab, nextIntent) => { setTab(nextTab); setIntent(nextIntent); }; centerListeners.add(listener); return () => centerListeners.delete(listener); }, []);
      useEffect(() => {
        if (!intent || catalog.loading || intent.tab === 'settings' || consumedCenterIntents.has(intent.serial)) return;
        consumedCenterIntents.add(intent.serial);
        if (intent.projectId && intent.projectId !== catalog.projectId) { setError('项目已切换，请从当前项目重新查看任务。'); return; }
        if (intent.connectionId) setSelected(intent.connectionId);
        if (intent.runId) {
          const task = list(catalog.agents).flatMap(agent => list(agent.projects).filter(project => project.id === catalog.projectId).flatMap(project => list(project.tasks))).find(item => item.runId === intent.runId || item.jobId === intent.runId);
          if (task?.sessionId) openTask(task, catalog.projectId); else void readLegacyRun(intent.runId);
        }
      }, [catalog.loading, catalog.projectId, intent?.serial]);
      const agents = list(catalog.agents), chosen = agents.find(agent => agent.id === selected) || agents[0];
      const projects = list(chosen?.projects).slice().sort((a, b) => Number(b.id === catalog.projectId) - Number(a.id === catalog.projectId));
      const projectName = catalog.project?.name || projects.find(item => item.id === catalog.projectId)?.name;
      const timestamp = value => typeof value === 'number' ? value : Number(value) || Date.parse(value) || 0;
      async function start() {
        try {
          const workspace = pluginContext.get('uiWorkspace');
          let sessionId = currentSession();
          if (!sessionId) { workspace?.startSession(); sessionId = currentSession(); }
          if (!sessionId) throw new Error('请先选择工作区并新建会话，再安排协作。');
          await setExecutor(sessionId, 'collaboration', chosen ? [chosen.id] : []);
          publish(recordFor(sessionId), { dialog: 'collaboration' }); pluginContext.get('layout')?.selectPanel(null);
        } catch (cause) { setError(friendlyError(cause)); }
      }
      async function readLegacyRun(runId) {
        try { const data = await post('collaboration_run', currentSession(), catalog.projectId, { runId }); if (active.current) setHistory(data); }
        catch (cause) { if (active.current) setError(friendlyError(cause)); }
      }
      function openTask(task, projectId) {
        if (projectId !== catalog.projectId || task.projectId && task.projectId !== catalog.projectId) return;
        if (!task.sessionId) { void readLegacyRun(task.runId || task.id); return; }
        const workspace = pluginContext.get('uiWorkspace');
        if (!task.sessionId || !workspace) { setError('此任务的原始会话暂不可打开。'); return; }
        workspace.openSession(task.sessionId); pluginContext.get('layout')?.selectPanel(null);
      }
      return h('section', { className: 'adh-wb-agents', 'aria-label': 'Agent 协作中心' },
        h('header', { className: 'adh-wb-agents-head' }, h('div', null, h('h1', null, 'Agent 协作中心'), h('p', null, projectName ? `当前项目：${projectName}` : '按 Agent 查看项目任务与会话')), tab === 'tasks' && h('button', { type: 'button', className: 'adh-wb-primary', disabled: !agents.length, onClick: start }, '发起协作')),
        h('nav', { className: 'adh-wb-center-tabs', 'aria-label': '协作中心分类' }, [{ id: 'tasks', label: '任务' }, { id: 'settings', label: '接入设置' }].map(item => h('button', { type: 'button', key: item.id, 'aria-pressed': tab === item.id, onClick: () => { collaborationTab = item.id; setTab(item.id); } }, item.label))),
        error && h('p', { role: 'alert' }, error),
        tab === 'settings' ? h(CollaborationSettings, { intent, onChanged: () => { void load(); const sessionId = currentSession(); if (sessionId) void refresh(sessionId); } }) : catalog.loading ? h('p', { className: 'adh-wb-agent-empty' }, '正在读取协作任务…') : !agents.length ? h('p', { className: 'adh-wb-agent-empty' }, '还没有外部执行器，可在“接入设置”中检测并配对。') : h('div', { className: 'adh-wb-agents-body' },
          h('nav', { className: 'adh-wb-agent-list', 'aria-label': '按 Agent 筛选' }, agents.map(agent => h('button', { type: 'button', key: agent.id, className: 'adh-wb-agent-item', 'aria-pressed': chosen?.id === agent.id, onClick: () => setSelected(agent.id) }, h('span', null, agent.label || agent.id), h('small', null, list(agent.projects).reduce((total, project) => total + list(project.tasks).length, 0))))),
          h('div', { className: 'adh-wb-agent-tasks' }, h('h2', null, chosen?.label || '协作任务'), projects.length ? projects.map(project => {
            const current = project.id === catalog.projectId, key = `${chosen.id}:${project.id}`, tasks = list(project.tasks).slice().sort((a, b) => timestamp(b.updatedAt || b.createdAt) - timestamp(a.updatedAt || a.createdAt));
            return h('details', { key: project.id, className: 'adh-wb-project-folder', open: expanded.has(key) ? expanded.get(key) : current, onToggle: event => { const open = event.currentTarget.open; setExpanded(previous => { if ((previous.has(key) ? previous.get(key) : current) === open) return previous; const next = new Map(previous); next.set(key, open); return next; }); } },
              h('summary', null, h('span', null, project.name || '项目'), h('small', null, tasks.length)),
              tasks.length ? tasks.map(task => h('button', { type: 'button', key: task.runId || task.jobId, className: 'adh-wb-agent-task', disabled: !current, onClick: () => openTask(task, project.id), title: current ? '打开原始会话，查看任务状态和回传' : `请先在 Hub 切换到「${project.name || '此项目'}」再打开会话。` }, h('span', null, task.title || '协作任务'), h('small', null, statuses[task.status] || '待更新'))) : h('p', { className: 'adh-wb-agent-empty' }, '还没有协作任务。'));
          }) : h('p', { className: 'adh-wb-agent-empty' }, '这个 Agent 还没有项目任务。'))),
        history && h(Dialog, { title: history.run?.title || '历史任务', description: history.run?.statusLabel || statuses[history.run?.status] || '任务记录', onClose: () => setHistory(null) }, h('pre', null, history.run?.output || history.run?.error || '此任务尚未返回文字成果。'), list(history.events).length > 0 && h('details', { className: 'adh-wb-history-events' }, h('summary', null, '执行记录'), list(history.events).map(event => h('p', { key: event.id }, event.message)))));
    }
    const CONNECTION_MODES = { cli: 'CLI', acp: 'ACP', 'openclaw-http': 'OpenClaw Gateway', inbound: 'MCP 接入', handoff: '文件交接' };
    function connectionStatus(item) {
      if (item?.validation?.ok === false) return '最近检查未通过';
      if (item?.runtimeVerification || item?.modelValidation?.verified || item?.verifiedAt) return '已有模型执行记录';
      if (item?.validation?.ok) return '接口已响应';
      return ['cli', 'acp', 'openclaw-http'].includes(item?.mode) ? '待检查' : '待客户端接入';
    }
    function CollaborationSettings({ onChanged, intent }) {
      const [settings, setSettings] = useState({ loading: true, connections: [], catalog: [] }), [discovery, setDiscovery] = useState(null), [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [editing, setEditing] = useState(null), [test, setTest] = useState(null), [report, setReport] = useState(null);
      const alive = useRef(true), running = useRef(false);
      async function load() {
        const value = await post('collaboration_settings', currentSession(), undefined);
        if (alive.current) setSettings({ ...value, loading: false });
        return value;
      }
      useEffect(() => { alive.current = true; void load().catch(cause => { if (alive.current) { setError(friendlyError(cause)); setSettings(previous => ({ ...previous, loading: false })); } }); return () => { alive.current = false; }; }, []);
      useEffect(() => { if (!settings.progress?.running && busy !== 'runtime_auto_pair') return undefined; const timer = setInterval(() => { void load().catch(() => {}); }, 2000); return () => clearInterval(timer); }, [settings.progress?.running, busy]);
      useEffect(() => {
        if (!intent || settings.loading || consumedCenterIntents.has(intent.serial)) return;
        consumedCenterIntents.add(intent.serial);
        if (intent.projectId && intent.projectId !== settings.project?.id) { setError('项目已切换，请重新打开当前项目设置。'); return; }
        if (intent.connectionId) { const connection = list(settings.connections).find(item => item.id === intent.connectionId); if (connection) setEditing(connection); }
        if (intent.autoPair === true) void act('runtime_auto_pair', { confirmed: true, useModel: false });
      }, [settings.loading, settings.project?.id, intent?.serial]);
      async function act(action, args = {}) {
        if (running.current) return null;
        running.current = true; setBusy(action); setError(''); setNotice('');
        try {
          const result = await post(action, currentSession(), settings.project?.id, args);
          if (!alive.current) return result;
          if (action === 'runtime_discover') setDiscovery(result);
          if (action === 'runtime_auto_pair') setReport(result);
          if (result.discovery) setDiscovery(result.discovery);
          setNotice(result.message || result.summary || result.validation?.message || (action === 'runtime_discover' ? '检测完成，可选择入口进行配对。' : action === 'connection_save' ? '连接已保存。' : '操作已完成。'));
          if (action !== 'runtime_discover') { await load(); onChanged(); }
          return result;
        } catch (cause) { if (alive.current) setError(friendlyError(cause)); return null; }
        finally { running.current = false; if (alive.current) setBusy(''); }
      }
      const writable = settings.capabilities?.canConfigure !== false, blocked = Boolean(busy) || !writable || settings.progress?.running, connections = list(settings.connections), candidates = list(discovery?.candidates), found = candidates.filter(item => item.installed);
      return h('div', { className: 'adh-wb-settings' },
        settings.loading ? h('p', null, '正在读取接入设置…') : h(React.Fragment, null,
          h('section', { className: 'adh-wb-settings-section' }, h('div', { className: 'adh-wb-settings-heading' }, h('div', null, h('h2', null, '本机 Agent'), h('p', null, '检测已安装入口，配对时保存连接并检查启动或协议。')), h('div', { className: 'adh-wb-settings-actions' },
            h('button', { type: 'button', className: 'adh-wb-secondary', disabled: Boolean(busy), onClick: () => act('runtime_discover') }, busy === 'runtime_discover' ? '检测中…' : '仅检测'),
            h('button', { type: 'button', className: 'adh-wb-primary', disabled: blocked || settings.capabilities?.pairingAvailable === false, onClick: () => act('runtime_auto_pair', { confirmed: true, useModel: false }) }, busy === 'runtime_auto_pair' || settings.progress?.running ? '正在配对…' : '自动检测并配对'))),
            settings.progress?.running && h('p', { role: 'status' }, settings.progress.message || '正在检查本机入口…'),
            discovery && h('div', { className: 'adh-wb-detected' }, found.length ? found.map(candidate => h('div', { className: 'adh-wb-detected-item', key: candidate.id },
              h('div', null, h('strong', null, candidate.label || candidate.provider), h('small', null, [candidate.version, candidate.pairable === false ? '需在客户端完成接入' : candidate.config ? '已找到可配对入口' : '已发现安装'].filter(Boolean).join(' · ')),
                h('details', null, h('summary', null, '安装信息'), h('code', null, candidate.source || candidate.config?.command || '未提供路径'), candidate.note && h('p', null, candidate.note))),
              candidate.pairable !== false && candidate.config && h('button', { type: 'button', className: 'adh-wb-secondary', disabled: blocked, onClick: () => act('runtime_pair', { candidateId: candidate.id, confirmLaunch: true }) }, '配对'))) : h('p', null, '本次未找到可用安装入口，可手动添加连接。')),
            report && h('details', null, h('summary', null, '配对结果'), list(report.results).map((item, index) => h('p', { key: index }, `${item.ok ? '✓' : '○'} ${item.label || item.provider || '执行器'}：${item.message || item.validation?.message || '请查看接口状态'}`)))),
          h('section', { className: 'adh-wb-settings-section' }, h('div', { className: 'adh-wb-settings-heading' }, h('h2', null, '执行器连接'), h('button', { type: 'button', className: 'adh-wb-secondary', disabled: blocked, onClick: () => setEditing({ id: '' }) }, '+ 添加连接')),
            h('div', { className: 'adh-wb-connections' }, connections.map(connection => h('div', { className: 'adh-wb-connection', key: connection.id }, h('div', null, h('strong', null, connection.label || connection.provider), h('small', null, `${CONNECTION_MODES[connection.mode] || connection.mode} · ${connectionStatus(connection)}`)),
              h('div', { className: 'adh-wb-settings-actions' }, ['cli', 'acp', 'openclaw-http'].includes(connection.mode) && h('button', { type: 'button', className: 'adh-wb-text-button', disabled: blocked, onClick: () => act('connection_probe', { connectionId: connection.id, confirmLaunch: true }) }, '检查接口'),
                h('button', { type: 'button', className: 'adh-wb-text-button', disabled: blocked, onClick: () => setEditing(connection) }, '设置'))))),
            editing && h(ConnectionEditor, { key: editing.id || 'new', connection: editing, catalog: list(settings.catalog), disabled: blocked, onSave: async connection => { const result = await act('connection_save', { connection, confirmed: true }); if (result) setEditing(null); }, onClose: () => setEditing(null), onTest: connection => setTest(connection) })),
          h(McpSettings, { key: settings.project?.id || 'mcp', settings, disabled: blocked, act })),
        (error || notice) && h('p', { className: error ? 'adh-wb-settings-error' : 'adh-wb-settings-notice', role: error ? 'alert' : 'status' }, error || notice),
        test && h(Dialog, { title: `测试 ${test.label || '执行器'}`, description: '最小测试将使用这个 Agent 配置的模型，可能消耗它的模型额度；只发送固定测试文字。', onClose: () => setTest(null), footer: h(React.Fragment, null, h('button', { type: 'button', className: 'adh-wb-secondary', onClick: () => setTest(null) }, '取消'), h('button', { type: 'button', className: 'adh-wb-primary', disabled: blocked, onClick: async () => { const id = test.id; setTest(null); await act('connection_test', { connectionId: id, confirmed: true, allowModel: true }); } }, '运行最小测试')) }));
    }
    function ConnectionEditor({ connection, catalog, disabled, onSave, onClose, onTest }) {
      const [draft, setDraft] = useState(() => ({ provider: connection.provider || catalog[0]?.id || 'openclaw', label: connection.label || '', mode: connection.mode || catalog[0]?.modes?.[0] || 'cli', command: connection.command || '', args: JSON.stringify(connection.args || [], null, 2), cwd: connection.cwd || '', endpoint: connection.endpoint || '', agentId: connection.agentId || 'main', tokenEnv: connection.tokenEnv || '', timeoutMs: connection.timeoutMs || 300000 })), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
      const provider = catalog.find(item => item.id === draft.provider), modes = list(provider?.modes).length ? provider.modes : ['cli', 'acp', 'openclaw-http', 'inbound', 'handoff'], executable = ['cli', 'acp'].includes(draft.mode), automatic = executable || draft.mode === 'openclaw-http';
      const change = (key, value) => { setDirty(true); setDraft(previous => ({ ...previous, [key]: value })); };
      const field = (label, key, options = {}) => h('label', null, label, h('input', { value: draft[key], disabled, onChange: event => change(key, event.target.value), autoComplete: 'off', ...options }));
      async function save(event) {
        event.preventDefault(); setError(''); let args = [];
        if (executable) { try { args = JSON.parse(draft.args); if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error(); } catch { setError('高级参数需要填写 JSON 字符串数组。'); return; } }
        await onSave({ ...(connection.id ? { id: connection.id, revision: connection.revision } : {}), provider: draft.provider, label: clean(draft.label), mode: draft.mode, command: executable ? clean(draft.command) : '', args, cwd: executable ? clean(draft.cwd) : '', endpoint: draft.mode === 'openclaw-http' ? clean(draft.endpoint) : '', agentId: clean(draft.agentId) || 'main', tokenEnv: automatic ? clean(draft.tokenEnv) : '', timeoutMs: Number(draft.timeoutMs) || 300000 });
      }
      return h('form', { className: 'adh-wb-connection-editor', onSubmit: save }, h('div', { className: 'adh-wb-form-row' },
        h('label', null, '客户端', h('select', { value: draft.provider, disabled, onChange: event => { const next = catalog.find(item => item.id === event.target.value); setDirty(true); setDraft(previous => ({ ...previous, provider: event.target.value, mode: next?.modes?.[0] || 'inbound' })); } }, catalog.map(item => h('option', { value: item.id, key: item.id }, item.name || item.id)))), field('连接名称', 'label', { required: true, maxLength: 100 })),
        h('label', null, '接入方式', h('select', { value: draft.mode, disabled, onChange: event => change('mode', event.target.value) }, modes.map(mode => h('option', { key: mode, value: mode }, CONNECTION_MODES[mode] || mode)))),
        draft.mode === 'openclaw-http' && field('Gateway 地址', 'endpoint', { type: 'url', required: true, placeholder: 'http://127.0.0.1:18789' }),
        h('details', { className: 'adh-wb-advanced' }, h('summary', null, '高级启动配置'), executable && h(React.Fragment, null, field('可执行文件绝对路径', 'command', { required: true, spellCheck: false }), h('label', null, '启动参数 · JSON 字符串数组', h('textarea', { value: draft.args, disabled, rows: 4, spellCheck: false, onChange: event => change('args', event.target.value) })), field('工作目录 · 可选', 'cwd', { placeholder: '留空使用受管运行目录' }), h('p', null, '参数支持 {sessionId}、{promptFile} 等占位符；OpenClaw CLI 应使用独立 session-id。')),
          draft.mode === 'openclaw-http' && field('Agent ID', 'agentId'), automatic && h('div', { className: 'adh-wb-form-row' }, field('凭据环境变量名 · 可选', 'tokenEnv', { placeholder: '只填写变量名' }), field('超时 · 毫秒', 'timeoutMs', { type: 'number', min: 1000, max: 3600000 }))),
        error && h('p', { role: 'alert' }, error), h('div', { className: 'adh-wb-settings-actions' }, h('button', { type: 'submit', className: 'adh-wb-primary', disabled }, '保存连接'), h('button', { type: 'button', className: 'adh-wb-secondary', disabled, onClick: onClose }, '取消'), connection.id && automatic && h('button', { type: 'button', className: 'adh-wb-text-button', disabled: disabled || dirty, title: dirty ? '请先保存连接修改' : '会调用此 Agent 自身配置的模型额度', onClick: () => onTest(connection) }, '运行最小测试')));
    }
    const SCOPE_LABELS = { 'project:read': '项目信息', 'tasks:read': '读取任务', 'skills:read': '专业 Skill', 'knowledge:read': '知识摘录', 'tasks:write': '创建任务', 'runs:write': '提交成果', 'cases:read': '读取案例', 'cases:write': '采集案例' };
    function McpSettings({ settings, disabled, act }) {
      const [open, setOpen] = useState(false);
      return h('details', { className: 'adh-wb-settings-section adh-wb-mcp', open, onToggle: event => setOpen(event.currentTarget.open) }, h('summary', null, '高级接入 · MCP 与项目授权'), open && h(McpAccess, { settings, disabled, act }));
    }
    function McpAccess({ settings, disabled, act }) {
      const [label, setLabel] = useState(''), [memberId, setMember] = useState(settings.members?.[0]?.id || ''), [scopes, setScopes] = useState(() => new Set(['project:read', 'tasks:read', 'skills:read', 'cases:read'])), [transport, setTransport] = useState('stdio'), [copy, setCopy] = useState('config'), [template, setTemplate] = useState(''), [message, setMessage] = useState(''), [revoke, setRevoke] = useState(null);
      const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
      const gateway = settings.gateway || {}, availableScopes = list(settings.scopes).length ? settings.scopes : Object.keys(SCOPE_LABELS);
      async function create(event) { event.preventDefault(); setMessage(''); const result = await act('grant_create_copy', { label: clean(label), memberId, scopes: [...scopes].filter(scope => availableScopes.includes(scope)), copy, transport, confirmed: true }); if (alive.current && result?.copied) setMessage(copy === 'token' ? '新访问密钥已复制到系统剪贴板。' : '含新访问密钥的 MCP 配置已复制到系统剪贴板。'); }
      async function generate() { setTemplate(''); const result = await act('client_config', { transport }); if (!alive.current || !result) return; if (result.containsToken) { setMessage('此模板包含敏感信息，已阻止显示。'); return; } setTemplate(typeof result.config === 'string' ? result.config : JSON.stringify(result.config, null, 2)); }
      async function copyTemplate() { try { await navigator.clipboard.writeText(template); setMessage('不含密钥的模板已复制。'); } catch { setMessage('剪贴板暂不可用，可在模板中手动选择并复制。'); } }
      return h('div', { className: 'adh-wb-mcp-body' }, h('p', null, '外部客户端调用 Hub 时使用独立项目授权。'), h('div', { className: 'adh-wb-gateway' }, h('input', { readOnly: true, value: gateway.url || '', placeholder: '本机入口尚未开启', 'aria-label': '本机 MCP 入口地址' }), h('button', { type: 'button', className: 'adh-wb-secondary', disabled, onClick: () => act('gateway_toggle', { enabled: !gateway.running, confirmed: true }) }, gateway.running ? '关闭本机入口' : '开启本机入口')),
        h('form', { className: 'adh-wb-grant-form', onSubmit: create }, h('h3', null, '创建当前项目授权'), h('div', { className: 'adh-wb-form-row' }, h('label', null, '授权名称', h('input', { value: label, disabled, required: true, maxLength: 100, onChange: event => setLabel(event.target.value) })), h('label', null, '项目成员', h('select', { value: memberId, disabled, required: true, onChange: event => setMember(event.target.value) }, list(settings.members).map(member => h('option', { key: member.id, value: member.id }, member.name))))),
          h('fieldset', { className: 'adh-wb-scopes', disabled }, h('legend', null, '开放的能力'), availableScopes.map(scope => h('label', { key: scope }, h('input', { type: 'checkbox', checked: scopes.has(scope), onChange: event => setScopes(previous => { const next = new Set(previous); if (event.target.checked) next.add(scope); else next.delete(scope); return next; }) }), SCOPE_LABELS[scope] || scope))),
          h('div', { className: 'adh-wb-form-row' }, h('label', null, '传输方式', h('select', { value: transport, disabled, onChange: event => { setTransport(event.target.value); setTemplate(''); } }, h('option', { value: 'stdio' }, 'stdio · 本机桥接'), h('option', { value: 'http' }, 'HTTP · 工具端点'))), h('label', null, '复制内容', h('select', { value: copy, disabled, onChange: event => setCopy(event.target.value) }, h('option', { value: 'config' }, '完整 MCP 配置'), h('option', { value: 'token' }, '项目访问密钥')))),
          h('button', { type: 'submit', className: 'adh-wb-primary', disabled: disabled || !scopes.size }, '创建并复制'), h('p', null, '密钥直接写入系统剪贴板，只能在创建时复制一次。')),
        h('div', { className: 'adh-wb-template' }, h('button', { type: 'button', className: 'adh-wb-secondary', disabled, onClick: generate }, '生成不含密钥的配置模板'), template && h(React.Fragment, null, h('textarea', { readOnly: true, rows: 7, value: template, spellCheck: false, 'aria-label': '不含密钥的 MCP 配置模板' }), h('button', { type: 'button', className: 'adh-wb-text-button', onClick: copyTemplate }, '复制模板'))),
        message && h('p', { role: 'status' }, message), h('h3', null, '已有项目授权'), list(settings.grants).length ? list(settings.grants).map(grant => h('div', { key: grant.id, className: 'adh-wb-connection' }, h('div', null, h('strong', null, grant.label || '项目授权'), h('small', null, grant.revokedAt ? '已撤销' : grant.expiresAt && grant.expiresAt < Date.now() ? '已到期' : '有效', ` · ${list(grant.scopes).length} 项能力`)), !grant.revokedAt && h('button', { type: 'button', className: 'adh-wb-text-button', disabled, onClick: () => setRevoke(grant) }, '撤销'))) : h('p', null, '当前项目尚未创建外部访问授权。'),
        revoke && h(Dialog, { title: `撤销「${revoke.label || '项目授权'}」`, description: '使用此授权的外部客户端将无法继续访问项目。', onClose: () => setRevoke(null), footer: h(React.Fragment, null, h('button', { type: 'button', className: 'adh-wb-secondary', onClick: () => setRevoke(null) }, '保留'), h('button', { type: 'button', className: 'adh-wb-primary', disabled, onClick: async () => { const grantId = revoke.id; setRevoke(null); await act('grant_revoke', { grantId, confirmed: true }); } }, '撤销授权')) }));
    }
    function ResultsDock({ sessionId, state }) {
      const [external, setExternal] = useState(null), [busy, setBusy] = useState(false), [history, setHistory] = useState(false);
      const artifacts = list(state.artifacts), newest = [...artifacts].reverse(), latest = list(state.research).slice(-1)[0];
      const recent = ['pptx', 'html'].map(type => newest.find(item => item.type === type || item.format === type)).filter(Boolean);
      const labelFor = artifact => artifact.type === 'pptx' || artifact.format === 'pptx' ? '打开 PPT' : '查看分析页';
      async function openArtifact(artifact) {
        setBusy(true);
        try { const result = await post('artifact_open', sessionId, state.project?.id, { artifactId: artifact.id }); if (result.opening) notify(sessionId, result.message || '已交给系统打开，请完成系统提示。'); else if (result.opened) publish(recordFor(sessionId), { notice: null, noticeError: false }); }
        catch (error) { notify(sessionId, error.message, true); } finally { setBusy(false); }
      }
      async function readExternal() { setBusy(true); try { const data = await post('external_status', sessionId, state.project?.id, { runId: state.externalRun.id || state.externalRun.runId }); setExternal(data.run || data); } catch (error) { notify(sessionId, error.message, true); } finally { setBusy(false); } }
      if (!artifacts.length && !latest && !state.notice && !state.error && !state.externalRun && state.artifactOpen?.status !== 'failed') return null;
      const openError = state.artifactOpen?.status === 'failed' ? friendlyError(state.artifactOpen.message) : '';
      const notice = openError || state.notice || state.error;
      return h('div', { className: 'adh-wb-results', 'aria-label': '最近生成的案例成果' }, ...recent.map(artifact => h('button', { key: artifact.id, type: 'button', className: 'adh-wb-result', disabled: busy, onClick: () => openArtifact(artifact), title: clean(artifact.title) }, glyph('case'), labelFor(artifact))),
        artifacts.length > recent.length && h('button', { type: 'button', className: 'adh-wb-result history', onClick: () => setHistory(true) }, '历史成果'),
        latest && !artifacts.length && h('span', { className: 'adh-wb-notice' }, statuses[latest.status] || latest.message || '项目任务已保存'),
        state.externalRun && h('button', { type: 'button', className: 'adh-wb-result', disabled: busy, onClick: readExternal }, '协作回传'),
        notice && h('span', { className: `adh-wb-notice${openError || state.noticeError || state.error ? ' error' : ''}`, role: openError || state.noticeError || state.error ? 'alert' : 'status' }, friendlyError(notice)),
        history && h(Dialog, { title: '历史成果', description: '查看此会话中生成的案例资料。', onClose: () => setHistory(false) }, h('ul', { className: 'adh-wb-artifact-history' }, newest.map(artifact => h('li', { key: artifact.id }, h('span', { title: clean(artifact.title) }, clean(artifact.title) || (artifact.type === 'pptx' ? '案例研究 PPT' : '案例分析页')), h('button', { type: 'button', disabled: busy, onClick: () => openArtifact(artifact) }, labelFor(artifact)))))),
        external && h(Dialog, { title: '外部 Agent 回传', description: statuses[external.status] || external.status || '任务状态待更新', onClose: () => setExternal(null), footer: h('button', { type: 'button', className: 'adh-wb-primary', disabled: busy, onClick: readExternal }, '刷新') }, h('pre', null, external.output || external.error || '执行器尚未回传结果。可继续在 Agent 协作中心查看完整记录。')));
    }
    const resultViews = new WeakMap();
    function resultValue(block) {
      if (!block || typeof block !== 'object') return {};
      if (resultViews.has(block)) return resultViews.get(block);
      const serialized = list(block.content).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
      let value = {};
      if (serialized.length <= 2 * 1024 * 1024) { try { const parsed = JSON.parse(serialized); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed.result || parsed.data || parsed; } catch {} }
      resultViews.set(block, value); return value;
    }
    function toolSummary(toolName, phase, block) {
      if (phase !== 'result') return phase === 'preparing' ? '准备中' : '进行中';
      const value = resultValue(block);
      if (block.isError || value.ok === false) return '未完成，可查看详情';
      const names = list(value.cases || value.caseCatalog || value.items).map(item => clean(item?.name || item?.title)).filter(Boolean);
      if (toolName === 'hub_project_context') return clean(value.project?.name || value.context?.project?.name) || '当前项目已带入';
      if (toolName === 'hub_case_catalog') return names.length ? `找到 ${names.length} 个候选案例` : '案例索引已读取';
      if (toolName === 'hub_case_details') return names.length ? names.slice(0, 2).join('、').slice(0, 60) : '案例资料已读取';
      if (toolName === 'hub_web_read') return clean(value.title || value.page?.title).slice(0, 70) || '网页资料已读取';
      if (toolName === 'hub_research_archive') {
        const count = value.savedCount ?? value.imageArchive?.savedCount ?? list(value.assetIds || value.imageAssetIds || value.imageArchive?.assetIds).length;
        return count ? `资料已保存，${count} 张项目图已归档` : value.status === 'partial' ? '资料已保存，部分内容待补充' : '案例资料已保存';
      }
      if (toolName === 'hub_presentation_create') return '案例成果已生成';
      if (toolName === 'hub_agent_dispatch') return '任务已分派';
      if (toolName === 'hub_agent_status') return statuses[value.run?.status || value.status] || '回传状态已更新';
      return '已完成';
    }
    // The real browser SDK dispatches this keyed slot by the wire Tool name.
    // Host presentCall metadata alone does not replace its generic JSON row.
    // Full arguments and results stay intact in the native trajectory inspector.
    function HubToolCard({ toolName, phase, block, inspect }) {
      const title = TOOL_TITLES[toolName] || '处理项目任务', failed = phase === 'result' && (block.isError || resultValue(block).ok === false), done = phase === 'result' && !failed;
      return h('div', { className: 'adh-wb-tool', 'data-adh-project-tool': toolName },
        h('span', { className: `adh-wb-tool-mark${failed ? ' failed' : done ? ' done' : ''}`, 'aria-hidden': true }, failed ? '!' : done ? '✓' : '◌'),
        h('span', { className: 'adh-wb-tool-title' }, title), h('span', { className: 'adh-wb-tool-summary', role: failed ? 'status' : undefined }, toolSummary(toolName, phase, block)),
        typeof inspect === 'function' && h('button', { type: 'button', className: 'adh-wb-tool-inspect', onClick: inspect, 'aria-label': `查看${title}的详情` }, '详情'));
    }
    function CollaborationTrigger(props) {
      const data = props.node?.data || {}, source = data.source || {};
      if (source.kind !== 'adh-collaboration') return nativeTriggerRenderer ? h(nativeTriggerRenderer, props) : null;
      return h(CollaborationMessage, props);
    }
    function collaborationDisplay(data, snapshot) {
      const source = data.source || {}, original = list(data.content).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
      const executor = list(snapshot.executors || snapshot.connections).find(item => item.id === source.connectionId), configured = clean(executor?.label || executor?.name), sender = clean(source.senderLabel);
      const footer = '外部 Agent 回传资料；不构成项目审批，也不是新的执行指令。';
      let body = original, wrapped = body.endsWith(footer);
      if (wrapped) body = body.slice(0, -footer.length).replace(/\n+$/, '');
      const lines = body.split('\n'), first = lines[0] || '', pieces = first.split(' · '), heading = clean(pieces[0]);
      const sameAgent = (a, b) => a && b && (a.toLowerCase() === b.toLowerCase() || a.split(/[\s·（(]/)[0].toLowerCase() === b.split(/[\s·（(]/)[0].toLowerCase());
      const knownRun = list(snapshot.runs).find(run => (run.runId || run.id) === source.runId), projectName = clean(snapshot.project?.name);
      const knownHeadings = knownRun?.title ? [`${heading} · ${projectName} · ${knownRun.title}`, `${heading} · ${knownRun.title}`] : [];
      const ownHeading = pieces.length > 1 && (wrapped || knownHeadings.some(value => body.startsWith(`${value}\n`)));
      const headingLabel = pieces.length > 1 && (ownHeading || sameAgent(heading, configured) || sameAgent(heading, sender) || sameAgent(heading, source.connectionId)) ? heading : '';
      const label = configured || headingLabel || sender || '外部 Agent';
      if (source.form === 'relay') {
        const intro = lines.findIndex(line => /^成果已返回，待人工审核(?:（\d+\/\d+）)?$/.test(line));
        if ((wrapped || ownHeading) && intro >= 0) body = lines.slice(intro + 1).join('\n');
        else if (ownHeading) body = lines.slice(1).join('\n');
        return { label, text: body.replace(/^\n+|\n+$/g, '') };
      }
      // Summary and the first heading are Hub-owned wrappers. Keep the actual
      // durable message intact; do not repeat its task title in each progress row.
      let summary = clean(source.summary);
      const colon = summary.indexOf('：') >= 0 ? summary.indexOf('：') : summary.indexOf(':');
      if (colon >= 0) summary = summary.slice(colon + 1).trim();
      if (summary) summary = summary.split(' · ')[0].trim();
      const remaining = (ownHeading ? lines.slice(1) : lines).filter(line => clean(line));
      const progress = summary || clean(remaining[remaining.length - 1]) || '状态待更新';
      return { label, text: progress.length > 180 ? `${progress.slice(0, 180)}…` : progress };
    }
    function CollaborationMessage(props) {
      const data = props.node?.data || {}, source = data.source || {}, sessionId = props.sessionId || source.sessionId || currentSession();
      const [snapshot, setSnapshot] = useState(() => recordFor(sessionId).snapshot);
      useEffect(() => { const record = recordFor(sessionId); setSnapshot(record.snapshot); record.listeners.add(setSnapshot); return () => record.listeners.delete(setSnapshot); }, [sessionId]);
      const { label, text } = collaborationDisplay(data, snapshot), relay = source.form === 'relay';
      return h('article', { className: `adh-wb-collaboration-message${relay ? ' is-result' : ''}`, 'data-adh-collaboration-message': relay ? 'result' : 'progress' },
        h('header', null, h('strong', null, label), h('span', null, relay ? '回传' : '任务进度')),
        h('div', { className: 'adh-wb-collaboration-body' }, relay && typeof props.renderFactorySlot === 'function' ? props.renderFactorySlot('conversation.chat.reasoning.content', { text, running: false }) : h('p', null, text)));
    }
    return {
      inject: ['slots', 'sessions', 'conversation', 'inputTriggers'],
      apply(ctx) {
        pluginContext = ctx;
        ctx.effect(() => { const style = document.createElement('style'); style.dataset.adhProjectWorkbench = ''; style.textContent = CSS; document.head.appendChild(style); return () => style.remove(); }, 'adh-project-workbench: styles');
        const inject = sessionId => ({ sessionId });
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'adh-workbench-executor', order: 30, inject }, ExecutorMenu));
        ctx.slots.inject('conversation.input.model', () => { modelSlotReady = true; syncModelSeat(); return () => { modelSlotReady = false; releaseExternalModel?.(); releaseExternalModel = null; }; });
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 35, label: () => 'Agent 协作中心' }, AgentsIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, AgentsPanel));
        for (const key of Object.keys(TOOL_TITLES)) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, HubToolCard));
        ctx.slots.inject('conversation.chat.node', () => {
          let release;
          const mount = () => {
            if (release) return;
            const native = ctx.slots.entries?.('conversation.chat.node').find(entry => entry.options.key === 'turn-trigger' && entry.component !== CollaborationTrigger);
            if (!native) return;
            nativeTriggerRenderer = native.component;
            release = ctx.slots.register({ name: 'conversation.chat.node', key: 'turn-trigger', priority: -100, locale: native.locale || 'chat', ...(native.inject ? { inject: native.inject } : {}) }, CollaborationTrigger);
          };
          mount(); const stop = ctx.slots.subscribe?.('conversation.chat.node', mount);
          return () => { stop?.(); release?.(); nativeTriggerRenderer = null; };
        });
        ctx.effect(() => ctx.inputTriggers.registerSource({ trigger: '/', name: 'Hub 项目任务', order: -30, showGroupTitle: true,
          async candidates(_session, request) { if (request.position !== 'leading') return []; const needle = request.query.toLowerCase(); return COMMANDS.filter(item => !needle || item.name.toLowerCase().includes(needle)).map(item => ({ name: item.name, label: item.name, description: item.hint, value: item.action })); },
          onPick(pick) { const command = COMMANDS.find(item => item.action === pick.candidate.value || item.name === pick.candidate.name); return command ? { claim: claimFor(command) } : undefined; },
          matchSpace(_session, token) { const command = COMMANDS.find(item => token === `/${item.name}`); return command ? { claim: claimFor(command) } : undefined; },
          async matchEnter(_session, line, _signal, envelope) { const command = findCommand(line); if (!command) return undefined; if (envelope.attachments) throw new Error('请先移除附件；当前项目与案例资料会自动带入。'); return { claim: claimFor(command) }; },
          async matchClaim(_session, token) { const command = COMMANDS.find(item => token === `/${item.name}`); return command ? claimFor(command) : undefined; },
        }), 'adh-project-workbench: commands');
        ctx.effect(() => ctx.inputTriggers.registerSource({ trigger: '@', name: '协作执行器', order: -40, showGroupTitle: true,
          async candidates({ sessionId }, request) {
            const record = recordFor(sessionId), draft = inputFor(sessionId).state.getSnapshot().draft;
            if (record.executor === 'adh' && !/^\/协作(?:\s|$)/.test(draft)) return [];
            const state = await refresh(sessionId), needle = request.query.toLowerCase();
            return list(state?.executors || state?.connections).filter(item => item.id !== 'adh' && !item.internal && (!needle || `${item.id} ${item.label || item.name}`.toLowerCase().includes(needle))).map(item => ({ name: item.id, label: item.label || item.name, description: '为这个 Agent 安排一项协作任务', value: item.id, icon: 'session' }));
          },
          onPick({ candidate }) { return { insert: { source: '协作执行器', ref: candidate.value || candidate.name, label: candidate.label || candidate.name, appearance: 'session', clipboardText: `@${candidate.value || candidate.name}` } }; },
          codec: { clipboardText: ref => `@${ref}`, async serialize(ref) { return `@${ref}`; } },
        }), 'adh-project-workbench: executor mentions');
        ctx.effect(() => {
          const listener = event => { if (event.detail && typeof event.detail === 'object') void receiveIntent(event.detail); };
          window.addEventListener('adh-workbench-request', listener);
          const centerListener = event => openCollaborationCenter(event.detail?.tab, event.detail);
          window.addEventListener('adh-workbench-open-collaboration', centerListener);
          const unsubscribe = ctx.sessions.list.subscribe(() => { syncModelSeat(); if (window.__adhWorkbenchPendingIntent && currentSession()) void receiveIntent(window.__adhWorkbenchPendingIntent); });
          if (window.__adhWorkbenchPendingIntent) void receiveIntent(window.__adhWorkbenchPendingIntent);
          return () => { window.removeEventListener('adh-workbench-request', listener); window.removeEventListener('adh-workbench-open-collaboration', centerListener); unsubscribe(); };
        }, 'adh-project-workbench: case handoff');
        ctx.effect(() => () => { disposed = true; releaseExternalModel?.(); releaseExternalModel = null; for (const record of records.values()) { clearInterval(record.timer); clearTimeout(record.nativeTimer); } records.clear(); }, 'adh-project-workbench: lifetime');
      },
    };
  },
});
