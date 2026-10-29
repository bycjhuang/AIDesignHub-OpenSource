'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// Only called by the isolated Electron smoke harness. All management mutations
// below travel through the renderer's real preload IPC; no model is configured,
// no file picker is used, and no external Agent is dispatched.
async function runProjectHubSmoke(win, projectHub, skillCenter) {
  if (process.env.BYCJ_WORKBENCH_SMOKE !== '1') throw new Error('Isolated smoke mode required.');
  const backend = projectHub?.backend;
  if (!backend || skillCenter?.backend !== backend) throw new Error('Shared isolated backend required.');
  const dataDir = path.resolve(backend.dataDir);
  if (!/(?:^|[\\/])(?:\.smoke(?:[-_][^\\/]*)?|aidesignhub[-_]smoke[^\\/]*)$/i.test(dataDir)) {
    throw new Error('Project Hub smoke refuses a data directory not explicitly named as smoke data.');
  }

  const projectId = backend.projectId();
  const originalMemberId = backend.store.settings.currentMemberId;
  const originalRole = backend.store.settings.currentRole;
  const memberId = backend.store.members.find(item => item.projectId === projectId && item.active !== false && item.role === 'designer')?.id;
  const approverId = backend.store.members.find(item => item.projectId === projectId && item.active !== false && ['pm','leader'].includes(item.role))?.id;
  assert(memberId && approverId, 'Isolated designer and actual project approver fixtures are required.');
  const stamp = `项目助手烟测 ${Date.now()}`;
  const payload = {
    note: `  \n${stamp} 人工电话记录。<img src=x onerror="window.projectHubXss=true">\n此处只保存原文，事项由人核对后确认。\n  `,
    taskTitle: `${stamp} 比较两个入口方案`,
    confirmedTitle: `${stamp} 已确认入口要求`,
    proposedTitle: `${stamp} 尚未定案的要求`,
    riskTitle: `${stamp} 待排除的资料缺口`,
    stage: 'develop',
    stageRound: 3,
    focus: `${stamp} 本轮仅比较入口，不推定业主已批准`,
    memberId,
  };
  const before = {
    tasks: backend.store.tasks.length,
    risks: backend.store.risks.length,
    decisions: backend.store.decisions.length,
    audits: backend.store.projectHub?.audits.length || 0,
    notifications: backend.store.projectHub?.notifications.length || 0,
    stage: backend.store.projects.find(item => item.id === projectId).stage,
  };
  const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);

  const prepared = await run(async function prepareFromUi(p) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate, label) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
    await window.bycjWorkbench.setCurrentMember(p.memberId);
    await window.aidesignProjectUI.refresh();
    document.querySelector('.nav-item[data-view="assistant"]').click();
    await wait(() => document.querySelector('#projectModelState').textContent.includes('未配置'), '未展示未配置模型状态');
    const model = await window.bycjWorkbench.projectModelStatus();
    if (model.configured) throw new Error('Smoke must not use a configured model or credentials.');
    const noModelUi = document.querySelector('#projectUseModel').disabled && !document.querySelector('#projectUseModel').checked;
    document.querySelector('#projectInput').value = p.note;
    document.querySelector('#projectInputForm').requestSubmit();
    await wait(() => !document.querySelector('#projectPrepare').disabled && document.querySelector('#projectDraftReview').textContent.includes(p.note), '人工原文未进入待确认界面');
    const snapshot = await window.bycjWorkbench.projectSnapshot();
    const draft = snapshot.drafts.find(item => item.text === p.note);
    if (!draft) throw new Error('真实 IPC 未保存原文草稿');
    const xssEscaped = !window.projectHubXss && !document.querySelector('#projectDraftReview img') && document.querySelector('#projectDraftReview').textContent.includes('<img');
    const nonApproverReadOnly = !snapshot.approval.canApprove && !document.querySelector('#projectConfirm') && !document.querySelector('#projectConfirmAck') && document.querySelector('#projectDraftReview').textContent.includes('待项目负责人审批');
    let backendDenied = false;
    try { await window.bycjWorkbench.projectConfirm({ id: draft.id, actions: [{ type:'task.create',data:{title:'不应写入的越权候选'} }] }); } catch(error) { backendDenied = /项目经理|公司负责人|审批权限/.test(error.message); }
    return { draftId: draft.id, modelStatus: draft.modelStatus, status: draft.status, noModelUi, xssEscaped, nonApproverReadOnly, backendDenied };
  }, payload);
  assert.equal(prepared.status, 'pending');
  assert.equal(prepared.modelStatus, 'not_requested');
  assert(prepared.noModelUi && prepared.xssEscaped, 'Manual input or unconfigured model UI unsafe.');
  assert(prepared.nonApproverReadOnly && prepared.backendDenied, 'A designer must not approve candidates through UI or IPC.');
  assert.equal(backend.store.tasks.length, before.tasks, 'Saving a note must not create a task.');
  assert.equal(backend.store.risks.length, before.risks, 'Saving a note must not create a risk.');
  assert.equal(backend.store.decisions.length, before.decisions, 'Saving a note must not create a decision.');
  assert.equal(backend.store.projects.find(item => item.id === projectId).stage, before.stage);

  await run(async function becomeActualApprover(input) {
    document.querySelector('#hubDraftDialog')?.close();
    await window.bycjWorkbench.setCurrentMember(input.approverId);
    await window.aidesignProjectUI.refresh();
    await window.aidesignProjectUI.openDraft(input.draftId);
    if (!(await window.bycjWorkbench.projectSnapshot()).approval.canApprove) throw new Error('实际项目负责人未获得审批权限');
    if (document.querySelector('#projectConfirm')?.textContent !== '审批并写入项目上下文') throw new Error('负责人审批按钮未正确呈现');
  }, { approverId, draftId:prepared.draftId });

  const confirmedUi = await run(async function confirmFromUi(p) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate, label) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
    const add = (type, values) => {
      document.querySelector('#projectAddActionType').value = type;
      document.querySelector('#projectAddAction').click();
      const rows = document.querySelectorAll('[data-action-index]');
      const row = rows[rows.length - 1];
      for (const [key, value] of Object.entries(values)) {
        const field = row.querySelector(`[data-field="${key}"]`);
        if (!field) throw new Error(`缺少事项字段 ${type}.${key}`);
        field.value = value;
      }
    };
    add('task.create', { title: p.taskTitle, ownerId: p.memberId, phase: p.stage, priority: 'high' });
    add('risk.create', { title: p.riskTitle, ownerId: p.memberId, description: '请补充现场资料；不自动断言已发生问题。', severity: 'medium' });
    add('decision.create', { title: p.confirmedTitle, ownerId: p.memberId, summary: '由项目成员确认作为当前工作要求。', status: 'confirmed' });
    add('decision.create', { title: p.proposedTitle, ownerId: p.memberId, summary: '只是待确认意见，不可放入正式 Agent 指令。', status: 'proposed' });
    add('project.update', { stage: p.stage, stageRound: String(p.stageRound), focus: p.focus });
    document.querySelector('#projectConfirm').click();
    await wait(() => document.querySelector('#projectConfirmNotice')?.textContent.includes('勾选确认'), '未勾选确认时没有在操作旁提示阻止写入');
    const localConfirmationError = !document.querySelector('#projectConfirmNotice').hidden && Boolean(document.querySelector('#projectDraftReview #projectConfirmNotice'));
    const notConfirmed = (await window.bycjWorkbench.projectSnapshot()).drafts.find(item => item.id === p.draftId)?.status === 'pending';
    const recipient = Array.from(document.querySelectorAll('[name="projectNotify"]')).find(item => item.value === p.memberId);
    if (!recipient) throw new Error('缺少本项目提醒对象');
    recipient.checked = true;
    document.querySelector('#projectConfirmAck').checked = true;
    document.querySelector('#projectConfirm').click();
    await wait(async () => (await window.bycjWorkbench.projectSnapshot()).drafts.find(item => item.id === p.draftId)?.status === 'confirmed', '人工确认未实际写入后台');
    await wait(() => document.querySelector('#projectNotice').textContent.includes('5 项更新'), '未展示真实写入回执');
    const receiptVisible = document.querySelector('#projectReceipts').textContent.includes('5 项更新') && document.querySelector('#projectNotice').textContent.includes('尚未发送');
    const confirmedActionsVisible = Array.from(document.querySelectorAll('#projectDraftReview [data-field="title"]')).some(field => field.value === p.taskTitle);
    const context = JSON.parse(document.querySelector('#projectContextPreview').textContent);
    const includesConfirmed = context.decisions.some(item => item.title === p.confirmedTitle);
    const excludesProposed = !JSON.stringify(context).includes(p.proposedTitle);
    const noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth + 2;
    return { notConfirmed, localConfirmationError, receiptVisible, confirmedActionsVisible, includesConfirmed, excludesProposed, noHorizontalOverflow };
  }, { ...payload, draftId: prepared.draftId });
  for (const [name, value] of Object.entries(confirmedUi)) assert.equal(value, true, `Project UI check failed: ${name}`);

  assert.equal(backend.store.tasks.length, before.tasks + 1);
  assert.equal(backend.store.risks.length, before.risks + 1);
  assert.equal(backend.store.decisions.length, before.decisions + 2);
  assert.equal(backend.store.projectHub.audits.length, before.audits + 1);
  assert.equal(backend.store.projectHub.notifications.length, before.notifications + 1);
  const project = backend.store.projects.find(item => item.id === projectId);
  assert.equal(project.stage, payload.stage);
  assert.equal(project.stageRound, payload.stageRound);
  assert.equal(project.focus, payload.focus);
  const task = backend.store.tasks.find(item => item.title === payload.taskTitle);
  assert.equal(task.ownerId, memberId);
  assert.equal(task.status, 'todo');
  const confirmedDraft = backend.store.projectHub.drafts.find(item => item.id === prepared.draftId);
  const audit = backend.store.projectHub.audits.find(item => item.id === confirmedDraft.receipt.auditId);
  assert.equal(audit.text, payload.note);
  assert.equal(audit.actorId, approverId);
  assert.equal(audit.source.memberId, memberId);
  assert.equal(confirmedDraft.createdBy, memberId);
  assert.equal(confirmedDraft.confirmedBy, approverId);
  assert.equal(audit.changes.length, 5);
  assert.equal(backend.store.projectHub.notifications.find(item => item.auditId === audit.id)?.status, 'local_pending');

  const duplicate = await run(async function confirmDuplicate(input) { return window.bycjWorkbench.projectConfirm(input); }, {
    id: prepared.draftId, actions: confirmedDraft.confirmedActions, notifyMemberIds: [memberId], acknowledgeImportant: true,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.auditId, audit.id);
  assert.equal(backend.store.tasks.length, before.tasks + 1);
  assert.equal(backend.store.projectHub.audits.length, before.audits + 1);
  assert.equal(backend.store.projectHub.notifications.length, before.notifications + 1);
  const directContext = projectHub.context(projectId);
  assert(directContext.decisions.some(item => item.title === payload.confirmedTitle));
  assert(!JSON.stringify(directContext).includes(payload.proposedTitle));

  const unconfigured = await run(async function checkUnconfiguredModel(note) {
    if ((await window.bycjWorkbench.projectModelStatus()).configured) throw new Error('Configured model not allowed in smoke.');
    const draft = await window.bycjWorkbench.projectPrepare({ text: note, useModel: true });
    return { id: draft.id, status: draft.status, modelStatus: draft.modelStatus, actions: draft.actions.length, preserved: draft.text === note, error: Boolean(draft.error) };
  }, `${stamp} 未配置模型时保留人工原文`);
  assert.equal(unconfigured.status, 'pending');
  assert(['unconfigured', 'failed'].includes(unconfigured.modelStatus));
  assert.equal(unconfigured.actions, 0);
  assert(unconfigured.preserved && unconfigured.error);
  assert.equal(backend.store.projectHub.audits.length, before.audits + 1, 'Failed model preparation must not write management records.');

  const taskBeforePatch = JSON.parse(JSON.stringify(task));
  const patchUi = await run(async function verifySparseUpdate(p) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate, label) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
    await window.aidesignProjectUI.prepareDirect('隔离烟测：只调整已有任务状态', [{ type: 'task.update', id: p.taskId, data: { status: 'blocked' } }]);
    const fields = Array.from(document.querySelectorAll('#projectActionList [data-field]')).map(item => item.dataset.field);
    const onlyPatchedFieldVisible = fields.length === 1 && fields[0] === 'status' && document.querySelector('#projectActionList [data-field="status"]').value === 'blocked';
    document.querySelector('#projectConfirmAck').checked = true;
    document.querySelector('#projectConfirm').click();
    await wait(async () => (await window.bycjWorkbench.bootstrap()).tasks.find(item => item.id === p.taskId)?.status === 'blocked', '仅状态更新没有写入真实任务');
    await wait(() => document.querySelector('#projectDraftReview').textContent.includes('该记录已处理'), '状态更新后未展示处理回执');
    await window.aidesignProjectUI.prepareDirect('隔离烟测：高风险初始状态必须显示待确认', [
      { type: 'task.create', data: { title: '仅预览未写入的已完成任务', ownerId: p.memberId, status: 'done' } },
      { type: 'risk.create', data: { title: '仅预览未写入的已关闭风险', ownerId: p.memberId, status: 'closed' } },
    ]);
    const rows = document.querySelectorAll('#projectActionList [data-action-index]');
    const createStatusesExplicit = rows[0]?.querySelector('[data-field="status"]')?.value === 'done' && rows[1]?.querySelector('[data-field="status"]')?.value === 'closed';
    document.querySelector('#projectDismiss').click();
    await wait(() => document.querySelector('#projectDraftReview').textContent.includes('该记录已处理'), '预览草稿未能搁置');
    return { onlyPatchedFieldVisible, createStatusesExplicit };
  }, { taskId: task.id, memberId });
  assert(patchUi.onlyPatchedFieldVisible && patchUi.createStatusesExplicit);
  const taskAfterPatch = backend.store.tasks.find(item => item.id === task.id);
  assert.equal(taskAfterPatch.status, 'blocked');
  for (const key of ['title', 'ownerId', 'phase', 'priority', 'dueAt']) assert.equal(taskAfterPatch[key], taskBeforePatch[key], `Sparse status update overwrote ${key}.`);
  assert.equal(backend.store.tasks.length, before.tasks + 1, 'Discarded create preview must not create a task.');
  assert.equal(backend.store.risks.length, before.risks + 1, 'Discarded create preview must not create a risk.');

  const cachedDraftUi=await run(async function preserveLocalActionEdits(p) {
    await window.aidesignProjectUI.prepareDirect(`${p.stamp} 本窗口缓存草稿A`,[{type:'task.create',data:{title:'初始建议'}}]);
    const snapshotA=await window.bycjWorkbench.projectSnapshot(),a=snapshotA.drafts.find(d=>d.text===`${p.stamp} 本窗口缓存草稿A`);
    document.querySelector('#projectActionList [data-field="title"]').value=`${p.stamp} A中人工改写且未确认`;
    document.querySelector('#projectAddActionType').value='risk.create';document.querySelector('#projectAddAction').click();
    const rows=document.querySelectorAll('#projectActionList [data-action-index]');rows[1].querySelector('[data-field="title"]').value=`${p.stamp} A中新加风险`;
    await window.aidesignProjectUI.prepareDirect(`${p.stamp} 本窗口缓存草稿B`,[{type:'decision.create',data:{title:'仅本窗口B'}}]);
    document.querySelector(`[data-hub-draft="${a.id}"]`).click();
    const restored=Array.from(document.querySelectorAll('#projectActionList [data-field="title"]')).map(field=>field.value);
    const original=(await window.bycjWorkbench.projectSnapshot()).drafts.find(d=>d.id===a.id);
    const retained=restored.length===2&&restored[0]===`${p.stamp} A中人工改写且未确认`&&restored[1]===`${p.stamp} A中新加风险`;
    const noBusinessWrite=original.status==='pending'&&original.actions.length===0;
    document.querySelector('#projectDismiss').click();
    for(let i=0;i<120&&document.querySelector('#projectDismiss');i++)await new Promise(resolve=>setTimeout(resolve,25));
    document.querySelector(`[data-hub-draft="${a.id}"]`).click();
    const dismissedCacheCleared=!document.querySelector('#projectActionList [data-field="title"]');
    return {retained,noBusinessWrite,dismissedCacheCleared};
  },{stamp});
  for(const [key,value]of Object.entries(cachedDraftUi))assert.equal(value,true,`Draft edit cache check failed: ${key}`);

  // Delay only the synthetic IPC reply after the real manual note is persisted.
  // The user can type the next note, or switch project, while that reply is pending.
  const originalPrepare = projectHub.prepare;
  const settingsBeforeDelay = { ...backend.store.settings };
  const otherProjectId = `smoke_management_other_${Date.now()}`;
  const otherMemberId = `${otherProjectId}_member`;
  let releaseDelayed, delayedDraft;
  let delayedText = `${stamp} delayed-original`;
  let gate = new Promise(resolve => { releaseDelayed = resolve; });
  projectHub.prepare = async function delayedPreparation(input) {
    const draft = await originalPrepare.call(this, input);
    if (input.text === delayedText) { delayedDraft = draft; await gate; }
    return draft;
  };
  try {
    await run(function submitDelayed(text) { document.querySelector('.nav-item[data-view="assistant"]').click();document.querySelector('#projectInput').value=text;document.querySelector('#projectUseModel').checked=false;document.querySelector('#projectInputForm').requestSubmit(); }, delayedText);
    for(let i=0;i<100&&!delayedDraft;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert(delayedDraft, 'Delayed original note was not saved through IPC.');
    const nextNote=`${stamp} 新写的下一段，不能被迟到回复清除`;
    await run(function typeNext(text) { document.querySelector('#projectInput').value=text; },nextNote);
    releaseDelayed();
    const retained=await run(async function waitForDelayed(next) { for(let i=0;i<120&&document.querySelector('#projectPrepare').disabled;i++)await new Promise(resolve=>setTimeout(resolve,25));return !document.querySelector('#projectPrepare').disabled&&document.querySelector('#projectInput').value===next; },nextNote);
    assert(retained,'Late preparation reply erased newer user input.');

    delayedText=`${stamp} delayed-old-project`;delayedDraft=null;gate=new Promise(resolve=>{releaseDelayed=resolve;});
    await run(function submitSecond(text) { document.querySelector('#projectInput').value=text;document.querySelector('#projectInputForm').requestSubmit(); },delayedText);
    for(let i=0;i<100&&!delayedDraft;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert(delayedDraft,'Second delayed note was not saved.');
    backend.mutate(store=>{store.projects.push({id:otherProjectId,name:'隔离切换项目',stage:'intake',stageRound:1});store.members.push({id:otherMemberId,projectId:otherProjectId,name:'隔离成员',role:'designer',active:true});store.settings.currentProjectId=otherProjectId;store.settings.currentMemberId=otherMemberId;return true;});
    const otherNote=`${stamp} 新项目尚未提交的输入`;
    await run(async function changeRenderedProject(note) { await window.aidesignProjectUI.refresh();document.querySelector('#projectInput').value=note; },otherNote);
    releaseDelayed();
    const otherPreserved=await run(async function waitOldProject(note) { for(let i=0;i<120&&document.querySelector('#projectPrepare').disabled;i++)await new Promise(resolve=>setTimeout(resolve,25));return !document.querySelector('#projectPrepare').disabled&&document.querySelector('#projectInput').value===note&&document.querySelector('#projectDraftReview').hidden; },otherNote);
    assert(otherPreserved,'Old-project reply changed new-project input or editor.');
    assert.equal(delayedDraft.projectId,projectId);
    assert(!backend.store.projectHub.drafts.some(d=>d.projectId===otherProjectId),'Old project preparation must not move into the new project.');
  } finally {
    releaseDelayed?.();projectHub.prepare=originalPrepare;
    backend.mutate(store=>{Object.assign(store.settings,settingsBeforeDelay);store.projects=store.projects.filter(p=>p.id!==otherProjectId);store.members=store.members.filter(m=>m.id!==otherMemberId);return true;});
    await run(async function restoreProjectUi() { await window.aidesignProjectUI.refresh();document.querySelector('#projectInput').value=''; });
  }

  const skillInput = {
    name: `${stamp} <img src=x onerror="window.skillHubXss=true">`,
    description: `仅文本技能；超长无空格资料也不应挤出页面。${'Evidence'.repeat(34)}`,
    instructions: '适用场景：隔离测试。\n输入：公开说明。\n输出：人工可审核的摘要。\n<script>window.skillHubXss=true</script>\n不得读取未授权文件或执行命令。',
  };
  await run(async function returnToSkillContributor(memberId) { await window.bycjWorkbench.setCurrentMember(memberId);window.dispatchEvent(new Event('project-hub-changed'));await window.aidesignProjectUI.refresh(); }, memberId);
  const skillUi = await run(async function skillFromUi(p) {
    window.__SMOKE_STEP__ = 'project hub skill publish and viewer';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate, label) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await sleep(50); } throw new Error(label); };
    document.querySelector('#hubDraftDialog')?.close();
    document.querySelector('.nav-item[data-view="skills"]').click();
    document.querySelector('#skillCreate').click();
    const form = document.querySelector('#hubSkillForm');
    form.elements.name.value = p.name;
    form.elements.description.value = p.description;
    form.elements.category.value = '项目管理';
    form.elements.version.value = '1.0.0';
    form.elements.instructions.value = p.instructions;
    form.requestSubmit();
    await wait(() => !document.querySelector('#hubSkillForm') && document.querySelector('#skillDrafts').textContent.includes(p.name), '技能表单未保存为当前成员草稿');
    const draft = (await window.bycjWorkbench.skillSnapshot()).drafts.find(item => item.name === p.name);
    if (!draft) throw new Error('技能草稿没有经真实 IPC 保存');
    const draftNotSelectable = !(await window.bycjWorkbench.agentSnapshot()).skills.some(item => item.id === draft.id);
    const draftSafe = !window.skillHubXss && !document.querySelector('#skillDrafts img');
    const originalConfirm = window.confirm;
    try {
      window.confirm = () => true;
      document.querySelector(`[data-skill-publish="${draft.id}"]`).click();
      await wait(() => document.querySelector(`[data-skill-use="${draft.id}"]`), '人工发布后没有进入技能目录');
    } finally { window.confirm = originalConfirm; }
    const card = document.querySelector(`[data-skill-use="${draft.id}"]`).closest('.hub-skill-card');
    const cardSafe = !window.skillHubXss && !card.querySelector('img') && card.textContent.includes(p.name);
    const cardTextFits = card.scrollWidth <= card.clientWidth + 2;
    const skillPageNoOverflow = document.documentElement.scrollWidth <= window.innerWidth + 2;
    document.querySelector(`[data-skill-view="${draft.id}"]`).click();
    const viewer = Array.from(document.querySelectorAll('dialog.hub-dialog[open]')).find(dialog => dialog.querySelector('.hub-context')?.textContent === p.instructions);
    if (!viewer) throw new Error('未找到本次技能方法查看弹层');
    const instructionsSafe = Boolean(viewer) && !viewer.querySelector('script,img') && viewer.textContent.includes('<script>') && !window.skillHubXss;
    viewer.querySelector('[data-dialog-close]').click();
    document.querySelector(`[data-skill-use="${draft.id}"]`).click();
    await wait(() => document.querySelector(`#agentChatSkill option[value="${draft.id}"]`) && document.querySelector(`#agentJobSkill option[value="${draft.id}"]`), '发布技能未出现在 Agent 聊天/派单下拉');
    await wait(() => document.querySelector('#agentChatSkill').value === draft.id, '从技能目录跳转后未选中该技能');
    const selectedForAgent = document.querySelector('.page-view.is-active')?.id === 'view-agents' && document.querySelector('#agentChatSkill').value === draft.id;
    const snapshot = await window.bycjWorkbench.skillSnapshot();
    const published = snapshot.skills.find(item => item.id === draft.id);
    return { id: draft.id, draftNotSelectable, draftSafe, cardSafe, cardTextFits, skillPageNoOverflow, instructionsSafe, selectedForAgent, version: published?.version, usageCount: published?.stats?.usageCount, authorId: published?.authorId };
  }, skillInput);
  for (const name of ['draftNotSelectable', 'draftSafe', 'cardSafe', 'cardTextFits', 'skillPageNoOverflow', 'instructionsSafe', 'selectedForAgent']) assert.equal(skillUi[name], true, `Skill UI check failed: ${name}`);
  assert.equal(skillUi.version, '1.0.0');
  assert.equal(skillUi.authorId, memberId);
  assert.equal(skillUi.usageCount, 0, 'Viewing or selecting a Skill must not count as actual execution.');
  const published = skillCenter.get(skillUi.id, projectId, '1.0.0');
  assert.equal(published.instructions, skillInput.instructions);
  assert.equal(published.status, 'published');

  await run(async function restoreOriginalIdentity(input) { await window.bycjWorkbench.setCurrentMember(input.memberId);await window.bycjWorkbench.setRole(input.role);window.dispatchEvent(new Event('project-hub-changed')); }, {memberId:originalMemberId,role:originalRole});

  return {
    manualNotePersisted: true, originalWhitespacePreserved: true, noAutomaticManagementWrite: true,
    ...confirmedUi, backendTaskAndRiskWritten: true, backendDecisionStatusesWritten: true,
    backendStageWritten: true, auditSourcePreserved: true, localReminderNotSent: true,
    duplicateConfirmIdempotent: true, contextConfirmedOnly: true,
    designerCanSubmitButNotApprove: prepared.nonApproverReadOnly && prepared.backendDenied, actualProjectApproverConfirmed: true,
    noModelNotFakeSuccess: true, originalNoteSurvivesModelFailure: true,
    noteXssEscaped: prepared.xssEscaped, ...patchUi, sparseUpdatePreservesOtherFields: true,
    delayedReplyPreservesNewInput: true, oldProjectReplyCannotClearNewProjectInput: true,
    draftSwitchPreservesUnconfirmedActions: cachedDraftUi.retained, dismissedDraftClearsLocalEditCache: cachedDraftUi.dismissedCacheCleared,
    discardedPreviewDoesNotWrite: true, skillDraftPersisted: true,
    skillPublished: true, skillDraftNotSelectable: skillUi.draftNotSelectable,
    skillCardXssEscaped: skillUi.cardSafe, skillInstructionsXssEscaped: skillUi.instructionsSafe,
    skillPageNoOverflow: skillUi.skillPageNoOverflow, skillCardTextFits: skillUi.cardTextFits,
    skillSelectableByAgent: skillUi.selectedForAgent, noFakeSkillUsage: true,
    modelCalls: 'none; unconfigured failure path only', dataScope: 'isolated-smoke',
  };
}

module.exports = { runProjectHubSmoke };
