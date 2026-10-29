'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drives the tab-based hub chat dock. Group mode is a renderer-only demo and is
// asserted to never touch the backend or the model; assistant mode is the real
// project-scoped path. All writes stay in the Electron harness's isolated store
// and the model below is synthetic (restored in finally); this is not live AI.
async function runGlobalChatSmoke(win, hubChat, teamDirectory) {
  if (process.env.BYCJ_WORKBENCH_SMOKE !== '1') throw new Error('Isolated smoke mode required.');
  const backend = hubChat?.backend;
  if (!backend || teamDirectory?.backend !== backend) throw new Error('Shared smoke backend required.');
  if (!/(?:^|[\\/])(?:\.smoke(?:[-_][^\\/]*)?|aidesignhub[-_]smoke[^\\/]*)$/i.test(path.resolve(backend.dataDir))) throw new Error('Refusing a non-smoke data directory.');
  const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);
  const wait = async (predicate, label) => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(50); } throw new Error(label); };
  const originalModel = hubChat.modelService;
  const originalProject = backend.projectId();
  const originalMember = backend.store.settings.currentMemberId;
  const originalRole = backend.store.settings.currentRole;
  const actor = backend.store.members.find(item => item.projectId === originalProject && item.active !== false && item.role === 'designer');
  if (!actor) throw new Error('An isolated non-admin designer fixture is required.');
  const approver = backend.store.members.find(item => item.projectId === originalProject && item.active !== false && ['pm','leader'].includes(item.role));
  if (!approver) throw new Error('An actual isolated project approver fixture is required.');
  const marker = `全局聊天烟测 ${Date.now()}`;
  const candidateTitle = `${marker} 入口对比候选任务`;
  const calls = [];
  let releaseDelayed, delayedFinished = false;
  const delayedText = `${marker} 请延迟答复`;
  const delayedReply = `${marker} 仅属于旧项目的迟到答复`;
  hubChat.modelService = {
    status: () => ({ configured: true, provider: 'isolated-smoke', model: 'synthetic-not-live', baseUrl: 'http://127.0.0.1:9/v1', hasApiKey: false }),
    reply: async input => {
      calls.push(JSON.parse(JSON.stringify(input)));
      if (input.text === delayedText) {
        await new Promise(resolve => { releaseDelayed = resolve; });
        delayedFinished = true;
        return { reply: delayedReply, summary: '', actions: [] };
      }
      return {
        reply: `${marker} 合成答复：${input.pageContext.view}。<img src=x onerror="window.hubChatXss=true">`,
        summary: input.text.includes('候选任务') ? '仅是等待人工确认的事项。' : '',
        actions: input.text.includes('候选任务') ? [{ type: 'task.create', data: { title: candidateTitle, ownerId: actor.id, phase: 'concept', priority: 'medium' } }] : [],
      };
    },
  };

  const result = {};
  try {
    await run(async function initialize(input) {
      window.__SMOKE_STEP__ = 'global chat initialization';
      document.querySelector('#hubDraftDialog')?.close();
      await window.bycjWorkbench.setCurrentMember(input.memberId);
      window.dispatchEvent(new Event('project-hub-changed'));
      document.querySelector('.nav-item[data-view="dashboard"]').click();
      await window.aidesignHubChatUI.open('assistant');
    }, { memberId: actor.id });
    await wait(() => run(function assistantReady() {
      const dock = document.querySelector('#hubChatDock');
      const live = document.querySelector('#hubChatLive');
      return Boolean(dock && !dock.hidden && live && !live.hidden && document.querySelector('#hubChatDemo').hidden && !document.querySelector('#hubChatSend').disabled);
    }), '项目助手抽屉未能打开或快照未就绪');
    result.assistantDockOpened = true;

    // Group mode is renderer-only: it must not write real messages or call a model.
    const messagesBeforeGroup = backend.store.messages.length;
    await run(async function openGroup() {
      window.__SMOKE_STEP__ = 'global chat group demo isolation';
      await window.aidesignHubChatUI.open('group');
    });
    await wait(() => run(function groupShown() {
      return !document.querySelector('#hubChatDemo').hidden
        && document.querySelector('#hubChatLive').hidden
        && document.querySelectorAll('#hubChatDemo .cd-message').length > 0;
    }), '群聊演示未渲染');
    await delay(400);
    result.groupDemoRendererOnly = calls.length === 0 && backend.store.messages.length === messagesBeforeGroup;
    assert(result.groupDemoRendererOnly, 'Group demo must stay renderer-only (no backend writes, no model calls).');
    await run(async function backToAssistant() {
      window.__SMOKE_STEP__ = 'global chat back to assistant';
      await window.aidesignHubChatUI.open('assistant');
    });
    await wait(() => run(function liveAgain() { return !document.querySelector('#hubChatLive').hidden && !document.querySelector('#hubChatSend').disabled; }), '未能切回项目助手');

    async function sendAssistant(text) {
      await run(async function submit(input) {
        window.__SMOKE_STEP__ = `global chat assistant send: ${input.text.slice(0, 80)}`;
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const ready = async (predicate, label) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
        await ready(() => !document.querySelector('#hubChatSend').disabled, '聊天发送按钮未就绪');
        document.querySelector('#hubChatInput').value = input.text;
        document.querySelector('#hubChatInput').dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#hubChatForm').requestSubmit();
        for (let i = 0; i < 40; i++) { const allow = document.querySelector('[data-consent-allow]'); if (allow) { allow.click(); return; } await sleep(30); }
      }, { text });
      await wait(() => backend.store.messages.some(item => item.projectId === backend.projectId() && item.body === text), '助手消息未通过真实 IPC 保存');
      await wait(() => run(function idle() { return !document.querySelector('#hubChatSend').disabled; }), '助手发送未结束');
    }

    const ordinary = `${marker} 请概括当前项目 <img src=x onerror="window.hubChatXss=true">`;
    await sendAssistant(ordinary);
    assert.equal(calls.length, 1, 'The first assistant message must call the synthetic model exactly once.');
    assert.equal(calls[0].projectId, originalProject);
    assert.equal(calls[0].history.length, 0, 'A first assistant turn must not carry prior history.');
    result.assistantCallsSyntheticModel = true;
    result.firstTurnHasNoHistory = true;

    result.chatXssEscaped = await run(function escaped() {
      const messages = document.querySelector('#hubChatMessages');
      return !window.hubChatXss && !messages.querySelector('img,script') && messages.textContent.includes('<img');
    });
    assert(result.chatXssEscaped, 'Assistant output must be escaped as text.');

    // The dock must follow real navigation and hand the matching page context to the model.
    const pageContexts = [];
    for (const [navView, expected] of [['cases', 'cases'], ['knowledge', 'knowledge'], ['workflow', 'phases'], ['files', 'files']]) {
      const settled = await run(async function navAndSettle(input) {
        window.__SMOKE_STEP__ = `global chat nav ${input.navView}`;
        document.querySelector(`.nav-item[data-view="${input.navView}"]`).click();
        const snapshot = await window.aidesignHubChatUI.setView(input.navView);
        return { view: snapshot?.context?.page?.view || null, access: snapshot?.context?.page?.access || null, projectId: snapshot?.projectId || null };
      }, { navView });
      assert.equal(settled.view, expected, `Dock snapshot did not follow navigation to ${navView}.`);
      assert.equal(settled.projectId, originalProject);
      await sendAssistant(`${marker} 当前页面 ${expected}`);
      const call = calls[calls.length - 1];
      assert.equal(call.pageContext.view, expected, `Model did not receive the ${expected} page context.`);
      assert.equal(call.projectId, originalProject);
      pageContexts.push(expected);
    }
    result.pageContextFollowsNavigation = pageContexts.length === 4;
    result.pageSwitchKeepsDock = await run(function remainsOpen() { return !document.querySelector('#hubChatDock').hidden && !document.querySelector('#hubChatLive').hidden; });
    assert(result.pageSwitchKeepsDock);
    assert.equal(calls[calls.length - 1].pageContext.items.some(item => Object.hasOwn(item, 'path') || Object.hasOwn(item, 'filePath')), false, 'File page must not silently expose local paths.');
    result.fileContextDoesNotReadRawFiles = true;

    const beforeTasks = backend.store.tasks.length;
    await sendAssistant(`${marker} 请整理候选任务`);
    assert.equal(backend.store.tasks.length, beforeTasks, 'Chat suggestions must not auto-create tasks.');
    const candidate = backend.store.projectHub.drafts.find(item => item.source?.kind === 'hub_chat' && item.actions.some(action => action.data?.title === candidateTitle));
    assert(candidate && candidate.status === 'pending');
    await run(async function reviewCandidate(input) {
      window.__SMOKE_STEP__ = 'global chat candidate confirmation';
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const ready = async (predicate, label) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
      await ready(() => document.querySelector(`[data-hub-chat-draft="${input.draftId}"]`), '聊天未提供候选事项核对入口');
      document.querySelector(`[data-hub-chat-draft="${input.draftId}"]`).click();
      await ready(() => document.querySelector('#hubDraftDialog')?.open && document.querySelector('#projectDraftReview')?.textContent.includes('待项目负责人审批'), '普通成员应看到待负责人审批的只读候选');
      if (document.querySelector('#projectConfirm')) throw new Error('普通成员不应看到真实审批按钮');
      document.querySelector('#hubDraftDialog').close();
      await window.bycjWorkbench.setCurrentMember(input.approverId);
      await window.aidesignProjectUI.refresh();
      await window.aidesignProjectUI.openDraft(input.draftId);
      await ready(() => document.querySelector('#hubDraftDialog')?.open && document.querySelector('#projectConfirmAck'), '候选事项没有在核对弹层打开');
      const titles = Array.from(document.querySelectorAll('#projectDraftReview [data-field="title"]'));
      if (!titles.some(field => field.value === input.title)) throw new Error('候选任务未正确填入核对表单');
      document.querySelector('#projectConfirmAck').checked = true;
      document.querySelector('#projectConfirm').click();
      await ready(async () => (await window.bycjWorkbench.bootstrap()).tasks.some(item => item.title === input.title), '聊天候选经人工确认后未写入任务');
      document.querySelector('#hubDraftDialog')?.close();
      await window.bycjWorkbench.setCurrentMember(input.actorId);
      window.dispatchEvent(new Event('project-hub-changed'));
    }, { draftId: candidate.id, title: candidateTitle, approverId: approver.id, actorId: actor.id });
    assert.equal(backend.store.tasks.length, beforeTasks + 1);
    assert.equal(backend.store.projectHub.drafts.find(item => item.id === candidate.id).status, 'confirmed');
    assert.equal(backend.store.projectHub.drafts.find(item => item.id === candidate.id).confirmedBy, approver.id);
    result.candidateNotAutomatic = true;
    result.candidateConfirmedViaRealIpc = true;

    const permissions = await run(async function checkRoleScope(input) {
      window.__SMOKE_STEP__ = 'global chat role scope';
      await window.bycjWorkbench.setRole('leader');
      let denied = false;
      try { await window.bycjWorkbench.teamSetRole({ projectId: input.projectId, memberId: input.memberId, role: 'leader', expectedRole: 'designer' }); } catch { denied = true; }
      const directory = await window.bycjWorkbench.teamDirectory();
      await window.bycjWorkbench.setRole('designer');
      return { denied, cannotManage: directory.currentProjectCanManage === false, honestIdentityNotice: directory.securityNotice.includes('不是企业账号认证') };
    }, { projectId: originalProject, memberId: actor.id });
    assert(permissions.denied && permissions.cannotManage && permissions.honestIdentityNotice);
    assert.equal(backend.store.members.find(item => item.id === actor.id).role, 'designer');
    result.roleViewDoesNotGrantPermissions = true;
    result.localIdentityNotMisrepresented = true;

    // A slow reply must stay bound to the project it was asked in, even if the
    // user switches projects while it is in flight.
    await run(async function sendDelayed(input) {
      window.__SMOKE_STEP__ = 'global chat delayed reply send';
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      await (async () => { for (let i = 0; i < 120; i++) { if (!document.querySelector('#hubChatSend').disabled) return; await sleep(50); } })();
      document.querySelector('#hubChatInput').value = input.text;
      document.querySelector('#hubChatInput').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#hubChatForm').requestSubmit();
      for (let i = 0; i < 40; i++) { const allow = document.querySelector('[data-consent-allow]'); if (allow) { allow.click(); return; } await sleep(30); }
    }, { text: delayedText });
    await wait(() => typeof releaseDelayed === 'function', 'Delayed synthetic model request was not reached.');
    const secondName = `${marker} 第二项目`;
    await run(async function createProjectFromUi(input) {
      window.__SMOKE_STEP__ = 'global chat delayed reply and project creation';
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const ready = async (predicate, label) => { for (let i = 0; i < 160; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
      document.querySelector('.nav-item[data-view="team"]').click();
      await ready(() => document.querySelector('[data-team-create]'), '团队页面未提供新建项目入口');
      document.querySelector('[data-team-create]').click();
      await ready(() => document.querySelector('[data-create-form]'), '新建项目对话框没有打开');
      const form = document.querySelector('[data-create-form]');
      form.elements.name.value = input.name;
      form.elements.city.value = '隔离测试城市';
      form.elements.type.value = '测试项目';
      form.requestSubmit();
      await ready(() => document.querySelector('#topProjectName').textContent === input.name && document.querySelector('#hubChatProject').textContent.includes(input.name), '新建项目后工作台和聊天没有同步切换');
    }, { name: secondName });
    const secondProject = backend.store.projects.find(item => item.name === secondName);
    assert(secondProject && secondProject.id !== originalProject);
    const secondMember = backend.store.members.find(item => item.projectId === secondProject.id && item.id === backend.store.settings.currentMemberId);
    assert(secondMember && secondMember.personId === backend.store.members.find(item => item.id === actor.id).personId);
    assert.equal(backend.store.cases.filter(item => item.projectId === secondProject.id).length, 0);
    assert.equal(backend.store.knowledgeDocs.filter(item => item.projectId === secondProject.id).length, 0);
    const newDraft = `${marker} 新项目尚未发送的输入`;
    await run(function newProjectDraft(text) { document.querySelector('#hubChatInput').value = text; document.querySelector('#hubChatInput').dispatchEvent(new Event('input', { bubbles: true })); }, newDraft);
    releaseDelayed();
    await wait(() => delayedFinished && backend.store.messages.some(item => item.projectId === originalProject && item.body === delayedReply), 'Old-project reply did not remain associated with its originating project.');
    await delay(200);
    const late = await run(function lateResult(input) {
      return {
        lateReplyNotInNewProject: !document.querySelector('#hubChatMessages').textContent.includes(input.oldReply),
        newInputPreserved: document.querySelector('#hubChatInput').value === input.newDraft,
        contextStaysNewProject: document.querySelector('#hubChatProject').textContent.includes(input.marker),
        projectHeaderStaysNew: document.querySelector('#topProjectName').textContent === input.projectName,
      };
    }, { oldReply: delayedReply, newDraft, marker, projectName: secondName });
    for (const [name, value] of Object.entries(late)) assert.equal(value, true, name);
    assert.equal(backend.store.messages.filter(item => item.projectId === secondProject.id && item.body === delayedReply).length, 0);
    Object.assign(result, late, { newProjectDoesNotCopyDocuments: true, linkedIdentityPreserved: true });

    await run(async function createCountingFixtures(input) {
      window.__SMOKE_STEP__ = 'global chat cross-project workload';
      const sameName = await window.bycjWorkbench.addMember({ projectId: input.projectId, name: input.name, title: '同名独立测试成员', role: 'designer' });
      const draft = await window.bycjWorkbench.projectPrepare({ projectId: input.projectId, text: '隔离测试：登记真实任务统计样本', useModel: false });
      if (!(await window.bycjWorkbench.projectSnapshot()).approval.canApprove) throw new Error('新项目真实创建者应为该项目有效负责人；不能借界面角色绕过审批');
      await window.bycjWorkbench.projectConfirm({ id: draft.id, actions: [
        { type: 'task.create', data: { title: '隔离统计受阻任务', ownerId: input.memberId, status: 'blocked', dueAt: 1700000000000 } },
        { type: 'task.create', data: { title: '隔离统计完成任务', ownerId: input.memberId, status: 'done' } },
        { type: 'task.create', data: { title: '同名独立成员任务', ownerId: sameName.id, status: 'doing' } },
      ], acknowledgeImportant: true });
      window.dispatchEvent(new Event('project-hub-changed'));
      await window.aidesignTeamUI.refresh();
    }, { projectId: secondProject.id, memberId: secondMember.id, name: actor.name });
    const directory = teamDirectory.snapshot();
    const person = directory.people.find(item => item.personId === secondMember.personId);
    const expectedTasks = backend.store.tasks.filter(item => (item.projectId === originalProject && item.ownerId === actor.id) || (item.projectId === secondProject.id && item.ownerId === secondMember.id));
    assert.equal(person.projectCount, 2);
    assert.equal(person.workload.total, expectedTasks.length);
    assert.equal(person.workload.open, expectedTasks.filter(item => !['done', 'cancelled', 'canceled'].includes(item.status)).length);
    assert.equal(person.memberships.find(item => item.projectId === secondProject.id).workload.total, 2);
    assert(directory.people.some(item => item.name === actor.name && item.key !== person.key && !item.personId), 'Same names must not implicitly merge across identities.');
    const newProjectRow = directory.projects.find(item => item.id === secondProject.id);
    assert.equal(newProjectRow.workload.total, 3);
    assert.equal(newProjectRow.workload.open, 2);
    assert.equal(newProjectRow.workload.overdue, 1);
    result.crossProjectCountsFromRealTasks = true;
    result.sameNameNotAutoMerged = true;
    result.overdueNotFakeWorkloadPercentage = true;
    const layout = await run(function layoutAndClose() {
      const noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 2;
      document.querySelector('#hubChatClose').click();
      return { noHorizontalOverflow: noOverflow, dockCloseWorks: document.querySelector('#hubChatDock').hidden };
    });
    assert(layout.noHorizontalOverflow && layout.dockCloseWorks);
    Object.assign(result, layout);
    return { ...result, syntheticModelCalls: calls.length, verification: 'isolated IPC and synthetic replies; no real model or external Agent invoked' };
  } finally {
    releaseDelayed?.();
    hubChat.modelService = originalModel;
    // Leave the enclosing smoke harness on its original project and member.
    await run(async function restore(input) {
      if ((await window.bycjWorkbench.bootstrap()).project.id !== input.projectId) {
        await window.bycjWorkbench.teamSwitchProject({ projectId: input.projectId, memberId: input.memberId });
        window.dispatchEvent(new CustomEvent('hub-project-changed', { detail: { projectId: input.projectId } }));
      }
      await window.bycjWorkbench.setCurrentMember(input.memberId);
      await window.bycjWorkbench.setRole(input.role);
      window.dispatchEvent(new Event('project-hub-changed'));
      document.querySelector('#hubChatClose')?.click();
    }, { projectId: originalProject, memberId: originalMember, role: originalRole });
  }
}

module.exports = { runGlobalChatSmoke };
