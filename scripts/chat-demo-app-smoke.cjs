'use strict';

// Boot the actual application with an isolated test store, never user data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BYCJ_WORKBENCH_SMOKE;
  delete env.AIDESIGNHUB_LEGACY_TEAM_SYNC;
  const bundled = path.resolve(__dirname, '../.runtime/electron.exe');
  const executable = fs.existsSync(bundled) ? bundled : require('electron');
  const child = require('node:child_process').spawn(executable, [__filename], {
    env, cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const electron = require('electron');
  const { app, BrowserWindow, session } = electron;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-demo-app-'));
  process.env.AIDESIGNHUB_DATA_DIR = path.join(output, 'data');
  delete process.env.BYCJ_WORKBENCH_SMOKE;
  delete process.env.AIDESIGNHUB_LEGACY_TEAM_SYNC;
  app.setPath('userData', path.join(output, 'profile'));
  // Reproduce an old persisted client setting in a brand-new synthetic store.
  // This must not activate transport or block normal local project creation.
  const { LocalBackend } = require('../backend/local-backend.cjs');
  const seed = new LocalBackend({ dataDir: process.env.AIDESIGNHUB_DATA_DIR });
  seed.mutate(store => {
    store.settings.teamSync = { mode: 'client', url: 'http://127.0.0.1:9', token: 'isolated-smoke-token-not-a-credential' };
    return true;
  });
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function keepTestHidden() {};
  // Test-only constructor wrapper forces fresh rendering while the window stays
  // invisible; production Electron options and source files remain unchanged.
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, 'BrowserWindow', { value: class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); }
  }});
  const requests = [];
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      requests.push(details.url); callback({ cancel: true });
    });
  });
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function loadTestElectron(name, parent, isMain) {
    if (name === 'electron' && parent?.filename === path.resolve(__dirname, '../electron-main.cjs')) return testElectron;
    return originalLoad.call(this, name, parent, isMain);
  };
  try { require('../electron-main.cjs'); } finally { Module._load = originalLoad; }

  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  app.whenReady().then(async () => {
    let win;
    try {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        win = BrowserWindow.getAllWindows()[0];
        if (win && await win.webContents.executeJavaScript(`!!document.querySelector('#hubChatDemo .cd-message') && !document.querySelector('#hubChatDemo').hidden`).catch(() => false)) break;
        await pause();
      }
      assert.ok(win, 'App window was created');
      const result = await win.webContents.executeJavaScript(`(() => {
        const demo=document.querySelector('#hubChatDemo');
        return {title:document.title,demoVisible:!!demo&&!demo.hidden,liveHidden:document.querySelector('#hubChatLive').hidden,oldChannelRemoved:!document.querySelector('#hubChatChannel'),messages:demo.querySelectorAll('.cd-message').length,errors:window.__BYCJ_WORKBENCH_ERRORS__||[],horizontalOverflow:document.documentElement.scrollWidth>window.innerWidth};
      })()`);
      assert.equal(result.demoVisible, true);
      assert.equal(result.liveHidden, true);
      assert.equal(result.oldChannelRemoved, true);
      assert.equal(result.messages, 4);
      assert.deepEqual(result.errors, []);
      assert.equal(result.horizontalOverflow, false);
      const storePath = path.join(output, 'data', 'store.json');
      const before = fs.readFileSync(storePath, 'utf8');
      const beforeStore = JSON.parse(before);
      const initialProjectId = beforeStore.settings.currentProjectId;
      result.persistedLegacyMode = beforeStore.settings.teamSync.mode;
      const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);
      const wait = async (fn, label, ...args) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await run(fn, ...args)) return;
          await pause();
        }
        throw new Error(label);
      };
      const syncState = await run(async function syncState() {
        return { transport: await window.bycjWorkbench.teamSyncStatus(), directory: await window.bycjWorkbench.teamDirectory() };
      });
      assert.equal(syncState.transport.mode, 'off');
      assert.equal(syncState.transport.disabled, true);
      assert.equal(syncState.directory.syncMode, 'local');
      result.legacyClientSettingsDoNotActivateTransport = true;
      await win.webContents.executeJavaScript(`(() => {
        const input=document.querySelector('.cd-input');input.value='完整应用中的前端演示，不写入项目';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.cd-composer').requestSubmit();
      })()`);
      await pause();
      assert.equal(fs.readFileSync(storePath, 'utf8'), before, 'Demo send must not alter the project store');
      await win.webContents.executeJavaScript(`document.querySelector('#hubChatExpand').click();document.querySelector('[data-cd-action="members"]').click()`);
      await pause();
      fs.writeFileSync(path.join(output, 'app-group-members.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelector('[data-cd-action="search"]').click()`);
      await pause();
      fs.writeFileSync(path.join(output, 'app-group-search.png'), (await win.webContents.capturePage()).toPNG());
      const reviewScope = { projectId: initialProjectId, memberId: beforeStore.settings.currentMemberId };
      const candidateId = await run(function reviewConversation(scope) {
        const root = document.querySelector('#hubChatDemo');
        const send = text => { const input=root.querySelector('.cd-input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));root.querySelector('.cd-composer').requestSubmit(); };
        root.querySelector('[data-cd-action="close-panel"]')?.click();
        send('@DesignHub 业主可能把汇报改到周五，暂定。');
        const item = window.aidesignContextReviewDemo.snapshot(scope).items.at(-1);
        if(item.status!=='needs_clarification')throw new Error('Ambiguous message must request clarification');
        send('已确认：这是没有关联的普通聊天。');
        if(window.aidesignContextReviewDemo.snapshot(scope).items[0].status!=='needs_clarification')throw new Error('Unlinked message must not clarify');
        root.querySelector(`[data-cd-clarify="${item.id}"]`).click();
        send('已确认：周五下午两点汇报，由林澜负责。');
        if(window.aidesignContextReviewDemo.snapshot(scope).items[0].status!=='pending')throw new Error('Explicit clarification must become pending');
        root.querySelector(`[data-cd-review-open="${item.id}"]`).click();
        return item.id;
      }, reviewScope);
      await wait(function contextPending(id) {return !!document.querySelector(`[data-pc-demo-review="${id}"]`);}, 'Context page did not show demo pending candidate', candidateId);
      assert.equal(await run(function visibleApprovalPage(){return document.querySelector('#hubChatDock').hidden;}),true,'View approval closes expanded chat so context is visible');
      await run(function openApproval(id) {document.querySelector(`[data-pc-demo-review="${id}"]`).click();}, candidateId);
      await wait(function approvalReady() {return !!document.querySelector('dialog[open] [data-pc-demo-approve]');}, 'Demo owner approval dialog missing');
      await run(function approve() {document.querySelector('[data-pc-demo-approve]').click();});
      await wait(function approved(scope) {return window.aidesignContextReviewDemo.snapshot(scope).approved.length===1&&!document.querySelector('dialog[open] [data-pc-demo-approve]');}, 'Demo approval did not finish', reviewScope);
      const approvedReceipt = await run(function receipt(id) {return document.querySelector(`[data-cd-review-card="${id}"]`).textContent.includes('已进入演示上下文');}, candidateId);
      assert.equal(approvedReceipt, true);
      await run(async function reopenGroup(){await window.aidesignHubChatUI.open('group');});
      const rejectedId = await run(function rejectConversation(scope) {
        const root=document.querySelector('#hubChatDemo'),input=root.querySelector('.cd-input');input.value='@DesignHub 已确定入口采用方案二，周四完成模型。';input.dispatchEvent(new Event('input',{bubbles:true}));root.querySelector('.cd-composer').requestSubmit();
        const id=window.aidesignContextReviewDemo.snapshot(scope).items.at(-1).id;root.querySelector(`[data-cd-review-open="${id}"]`).click();return id;
      }, reviewScope);
      await wait(function rejectReady(id){return !!document.querySelector(`[data-pc-demo-review="${id}"]`);}, 'Second demo candidate not visible', rejectedId);
      await run(function openReject(id){document.querySelector(`[data-pc-demo-review="${id}"]`).click();}, rejectedId);
      await wait(function rejectDialogReady(){return !!document.querySelector('dialog[open] [data-pc-demo-reject]');}, 'Demo reject dialog missing');
      await run(function reject(){document.querySelector('[data-pc-demo-reject]').click();});
      await wait(function rejected(scope,id){return window.aidesignContextReviewDemo.snapshot(scope).items.find(item=>item.id===id)?.status==='rejected';}, 'Demo rejection did not finish',reviewScope,rejectedId);
      assert.equal(await run(function approvedCount(scope){return window.aidesignContextReviewDemo.snapshot(scope).approved.length;},reviewScope),1);
      assert.equal(fs.readFileSync(storePath,'utf8'),before,'Clarification, approval and rejection demos must not change real project store');
      result.contextReviewDemo={ambiguousPrompt:true,unlinkedReplyIgnored:true,explicitClarificationPending:true,approvedViaOwnerDemoDialog:true,rejectedViaOwnerDemoDialog:true,groupReceiptUpdated:true,storeUnchanged:true};
      await run(function centerReviewDemo(){document.querySelector('[data-pc-demo]')?.scrollIntoView({block:'center'});});
      await pause();
      fs.writeFileSync(path.join(output,'app-context-approved.png'),(await win.webContents.capturePage()).toPNG());
      await run(async function openAssistant() { await window.aidesignHubChatUI.open('assistant'); });
      await wait(function assistantReady() { return !document.querySelector('#hubChatLive').hidden && !document.querySelector('#hubChatSend').disabled; }, 'Actual assistant UI did not become ready');
      result.assistant = await run(function assistantLayout() {
        const input = document.querySelector('#hubChatInput'), button = document.querySelector('#hubChatModelSettings');
        return {
          topMembersRemoved: !document.querySelector('#hubChatMembers'),
          topMoreRemoved: !document.querySelector('#hubChatMore'),
          settingsInsideComposer: button?.closest('form') === document.querySelector('#hubChatForm'),
          settingsAfterInput: Boolean(input.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
          settingsBelowInput: button.getBoundingClientRect().top >= input.getBoundingClientRect().bottom - 1,
        };
      });
      for (const [check, passed] of Object.entries(result.assistant)) assert.equal(passed, true, check);
      await pause();
      fs.writeFileSync(path.join(output, 'app-assistant-composer.png'), (await win.webContents.capturePage()).toPNG());
      await run(function tryUnconfiguredAssistant(){const input=document.querySelector('#hubChatInput');input.value='未配置模型不得发送这条隔离测试消息';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#hubChatForm').requestSubmit();});
      await wait(function blockedModel(){return !!document.querySelector('dialog[open] #hubModelForm');},'Unconfigured assistant should open configuration without sending');
      assert.equal(await run(function unsentDraft(){return document.querySelector('#hubChatInput').value==='未配置模型不得发送这条隔离测试消息'&&document.querySelector('#hubChatNotice').textContent.includes('尚未发送');}),true);
      assert.equal(fs.readFileSync(storePath,'utf8'),before,'Unconfigured assistant must not save/send message');
      result.assistant.unconfiguredModelDoesNotSend=true;
      await run(function closeUnconfiguredSettings(){document.querySelector('#hubModelForm').closest('dialog').querySelector('[data-dialog-close]').click();});
      await run(function openModelSettings() { document.querySelector('#hubChatModelSettings').click(); });
      await wait(function modelReady() { return !!document.querySelector('dialog[open] #hubModelForm'); }, 'Actual model settings dialog did not open');
      result.assistant.modelSettingsOpensExistingDialog = await run(function modelDialog() {
        const form = document.querySelector('#hubModelForm');
        return form.closest('dialog').textContent.includes('本机模型设置') && !!form.elements.provider && !!form.elements.apiKey && !!form.elements.autoPair;
      });
      assert.equal(result.assistant.modelSettingsOpensExistingDialog, true);
      await pause();
      fs.writeFileSync(path.join(output, 'app-model-settings.png'), (await win.webContents.capturePage()).toPNG());
      await run(function closeSettingsAndOpenTeam() {
        document.querySelector('#hubModelForm').closest('dialog').querySelector('[data-dialog-close]').click();
        document.querySelector('#hubChatClose').click();
        document.querySelector('.nav-item[data-view="team"]').click();
      });
      await wait(function createReady() { return !!document.querySelector('[data-team-create]') && !document.querySelector('[data-team-create]').disabled; }, 'New project action remains blocked by legacy client settings');
      await run(function startCreating() { document.querySelector('[data-team-create]').click(); });
      await wait(function createFormReady() { return !!document.querySelector('dialog[open] [data-create-form]'); }, 'Actual project creation dialog did not open');
      const newProjectName = '海湾社区更新 · 隔离界面验收';
      await run(function fillCreateProject(name) {
        const form = document.querySelector('[data-create-form]');
        form.elements.name.value = name;
        form.elements.city.value = '合成测试城市';
        form.elements.type.value = '社区更新';
        form.requestSubmit();
      }, newProjectName);
      await wait(async function created(name) {
        const data = await window.bycjWorkbench.teamDirectory();
        return data.projects.some(project => project.name === name && project.isCurrent) && !document.querySelector('dialog[open] [data-create-form]');
      }, 'UI project creation did not finish and switch', newProjectName);
      const createdStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const createdProject = createdStore.projects.find(project => project.name === newProjectName);
      assert.ok(createdProject);
      assert.notEqual(createdStore.settings.currentProjectId, initialProjectId);
      assert.equal(createdStore.settings.currentProjectId, createdProject.id);
      assert.equal(createdStore.projects.length, beforeStore.projects.length + 1);
      assert.deepEqual(createdStore.projects.find(project => project.id === initialProjectId), beforeStore.projects.find(project => project.id === initialProjectId), 'Original project must remain unchanged');
      assert.deepEqual(createdStore.messages.filter(message => message.projectId === initialProjectId), beforeStore.messages.filter(message => message.projectId === initialProjectId), 'Original project messages must be preserved');
      assert.equal(createdStore.messages.filter(message => message.projectId === createdProject.id).length, 0, 'A new project must not copy historical messages');
      assert.deepEqual(createdStore.settings.teamSync, beforeStore.settings.teamSync, 'Disabled legacy config stays intact on disk');
      result.projectCreation = { createdViaUi: true, switchedToNewProject: true, originalProjectPreserved: true, originalMessagesPreserved: true, noOldMessagesCopied: true, inactiveLegacyConfigPreserved: true, id: createdProject.id, name: newProjectName };
      await pause();
      fs.writeFileSync(path.join(output, 'app-new-project-team.png'), (await win.webContents.capturePage()).toPNG());
      await run(function openNewProjectGroup() { document.querySelector('.nav-item[data-view="chat"]').click(); });
      await wait(function newGroupReady(name) { const root = document.querySelector('#hubChatDemo'); return !root.hidden && root.querySelector('[data-cd-group-title]')?.textContent.includes(name); }, 'New project group demo did not follow project switch', newProjectName);
      result.projectCreation.groupDemoFollowsProject = await run(function freshDemo() { return document.querySelectorAll('#hubChatDemo [data-cd-message]').length === 4 && !document.querySelector('#hubChatDemo').textContent.includes('完整应用中的前端演示，不写入项目'); });
      assert.equal(result.projectCreation.groupDemoFollowsProject, true);
      await wait(function titlesFollowProject(name) { return document.querySelector('#projectSwitcher').textContent.includes(name) && document.querySelector('#hubChatProject').textContent.includes(name) && document.querySelector('#hubChatDemoLoading').hidden; }, 'Visible project switcher and chat title did not follow created project', newProjectName);
      result.projectCreation.projectSwitcherAndChatTitleUpdated = true;
      await pause();
      fs.writeFileSync(path.join(output, 'app-new-project-group.png'), (await win.webContents.capturePage()).toPNG());
      assert.deepEqual(requests, [], 'No remote resources were requested');
      result.finalErrors = await win.webContents.executeJavaScript(`window.__BYCJ_WORKBENCH_ERRORS__||[]`);
      assert.deepEqual(result.finalErrors, []);
      result.demoSendPreservesStore = true;
      result.networkRequests = 0;
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, result }, null, 2));
      console.log(JSON.stringify({ ok: true, output, result }, null, 2));
      app.quit();
    } catch (error) {
      console.error(error);
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack }, null, 2));
      console.error(`Artifacts: ${output}`);
      app.exit(1);
    }
  });
}
