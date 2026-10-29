'use strict';

// Actual Electron UI acceptance, using only a newly-created OS temp directory.
// The sentinel represents an existing non-demo database: demo-company startup
// must select its own child directory and leave the sentinel byte-for-byte alone.
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
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-company-smoke-'));
  const dataRoot = path.join(output, 'data');
  const sentinelPath = path.join(dataRoot, 'store.json');
  const sentinel = JSON.stringify({ syntheticNonDemoSentinel: true, note: 'Must never be loaded or changed by demo-company mode.' });
  fs.mkdirSync(dataRoot);
  fs.writeFileSync(sentinelPath, sentinel);
  process.env.AIDESIGNHUB_DATA_DIR = dataRoot;
  process.env.AIDESIGNHUB_DEMO_COMPANY = '1';
  delete process.env.BYCJ_WORKBENCH_SMOKE;
  delete process.env.AIDESIGNHUB_LEGACY_TEAM_SYNC;
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function keepTestHidden() {};
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
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function loadTestElectron(name, parent, isMain) {
    if (name === 'electron' && parent?.filename === path.resolve(__dirname, '../electron-main.cjs')) return testElectron;
    return originalLoad.call(this, name, parent, isMain);
  };
  try { require('../electron-main.cjs'); } finally { Module._load = originalLoad; }
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const watchdog = setTimeout(() => { console.error(`Company smoke timed out. Artifacts: ${output}`); app.exit(1); }, 120000);

  app.whenReady().then(async () => {
    let win, step = 'startup';
    const result = { identitySwitches: [], projectSwitches: [], approvalChecks: [] };
    try {
      for (let i = 0; i < 250; i++) {
        win = BrowserWindow.getAllWindows()[0];
        if (win && await win.webContents.executeJavaScript(`!!window.aidesignTeamUI && document.querySelectorAll('#teamPortfolio .team-person').length === 8 && !!document.querySelector('#teamPortfolio .team-security-note')`).catch(() => false)) break;
        await pause();
      }
      assert.ok(win, 'Actual app created its hidden window');
      const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);
      const wait = async (fn, label, ...args) => {
        for (let i = 0; i < 100; i++) { if (await run(fn, ...args)) return; await pause(); }
        throw new Error(label);
      };
      const capture = async name => { await pause(); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
      const readState = () => run(async function state() {
        return { bootstrap: await window.bycjWorkbench.bootstrap(), directory: await window.bycjWorkbench.teamDirectory(), snapshot: await window.bycjWorkbench.projectSnapshot() };
      });
      const initial = await readState();
      const directory = initial.directory;
      assert.equal(initial.bootstrap.demoCompany?.initialized, true);
      assert.equal(directory.demoCompany?.initialized, true);
      assert.equal(directory.projects.length, 3);
      assert.equal(directory.people.length, 8);
      assert.equal(new Set(directory.people.map(person => person.personId)).size, 8);
      assert.equal(new Set(directory.people.map(person => person.title)).size, 8);
      for (const project of directory.projects) {
        assert.equal(project.memberCount, 8);
        assert.equal(new Set(project.members.map(member => member.personId)).size, 8);
        assert.equal(project.workload.total, 8);
      }
      for (const person of directory.people) {
        assert.equal(person.projectCount, 3);
        assert.equal(person.memberships.length, 3);
        assert.ok(person.skills.length > 0);
        assert.ok(person.memberships.every(member => member.workload.total >= 1));
      }
      const storePath = path.join(dataRoot, 'demo-company-v1', 'store.json');
      assert.ok(fs.existsSync(storePath), 'Mode uses the isolated demo-company child directory');
      assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel);
      const baseline = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      assert.equal(baseline.projectHub.drafts.length, 3);
      assert.ok(baseline.projectHub.drafts.every(draft => draft.status === 'pending'));
      assert.equal(baseline.projectHub.audits.length, 0);
      assert.ok(baseline.projects.every(project => project.folderPath === null));
      result.seed = { projects: 3, uniquePeople: 8, distinctResponsibilities: 8, memberships: 24, assignedTasks: 24, pendingCandidates: 3, confirmedApprovalReceipts: 0 };
      result.bootUsesIndependentDemoChild = true;
      result.nonDemoSentinelUntouched = true;

      step = 'team overview';
      await run(function openTeam() { window.aidesignHubChatUI.close(); document.querySelector('.nav-item[data-view="team"]').click(); });
      await wait(function teamReady() { return document.querySelectorAll('#teamPortfolio .team-person').length === 8; }, 'Company overview did not render eight people');
      assert.equal(await run(function matrix() { return document.querySelectorAll('.team-matrix tbody tr').length; }), 8);
      assert.equal(await run(function flags() { return document.title.includes('演示公司') && !!document.querySelector('#teamPortfolio .team-security-note') && document.querySelector('#teamPortfolio').textContent.includes('隔离演示公司'); }), true);
      await capture('company-overview.png');

      const initialProject = directory.projects.find(project => project.id === directory.currentProjectId);
      const initialPerson = directory.people.find(person => person.memberships.some(member => member.memberId === directory.currentMemberId));
      // Last selection returns to the initial person; the first selection must
      // be different, so every one of the eight cards performs an actual switch.
      const people = [...directory.people.filter(person => person.key !== initialPerson.key), initialPerson];
      const marker = '仅属于最初成员的未发送演示草稿';
      await run(async function draft(text) { await window.aidesignHubChatUI.open('group'); const input = document.querySelector('.cd-input'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); window.aidesignHubChatUI.close(); }, marker);

      const selectIdentity = async (person, project, capturePicker = false) => {
        const membership = person.memberships.find(member => member.projectId === project.id);
        await run(function openFromProfile() { document.querySelector('.profile-mini').click(); });
        await wait(function pickerReady() { return !!document.querySelector('dialog[open][data-demo-identity-picker]'); }, 'Profile did not open demo identity cards');
        const picker = await run(function pickerState(memberId) {
          const dialog = document.querySelector('dialog[open][data-demo-identity-picker]');
          return { cards: dialog.querySelectorAll('[data-demo-person]').length, buttons: dialog.querySelectorAll('[data-demo-member]').length, currentButtons: dialog.querySelectorAll('[data-demo-member]:disabled').length, targetDisabled: dialog.querySelector(`[data-demo-member="${memberId}"]`).disabled, roleModalOpen: document.querySelector('#roleModal').classList.contains('is-open') };
        }, membership.memberId);
        assert.equal(picker.cards, 8);
        assert.equal(picker.buttons, 24);
        assert.equal(picker.currentButtons, 1);
        assert.equal(picker.targetDisabled, false);
        assert.equal(picker.roleModalOpen, false, 'Identity picker must not fall back to a cosmetic role view');
        if (capturePicker) await capture('identity-cards.png');
        await run(function choose(memberId) { document.querySelector(`dialog[open] [data-demo-member="${memberId}"]`).click(); }, membership.memberId);
        await wait(async function identityReady(memberId, projectId, name) {
          const data = await window.bycjWorkbench.bootstrap();
          return data.settings.currentMemberId === memberId && data.project.id === projectId && !document.querySelector('dialog[open][data-demo-identity-picker]') && document.querySelector('.profile-mini strong').textContent === name && !document.querySelector('.view-stack').inert;
        }, `Identity UI did not switch to ${person.name}`, membership.memberId, project.id, person.name);
        const current = await readState();
        const member = current.bootstrap.members.find(item => item.id === membership.memberId);
        assert.equal(member.personId, person.personId);
        assert.equal(current.bootstrap.settings.currentRole, member.role);
        assert.equal(current.snapshot.approval.canApprove, ['pm', 'leader'].includes(member.role));
        const ui = await run(function identityUi() {
          return { name: document.querySelector('.profile-mini strong').textContent, avatar: document.querySelector('.profile-mini .avatar').textContent, headerAvatar: document.querySelector('.role-chip .avatar').textContent, headerRole: document.querySelector('#headerRole').textContent, sidebarRole: document.querySelector('#sidebarRole').textContent, greeting: document.querySelector('#dashboardGreeting').textContent, brief: document.querySelector('#briefTitle').textContent, project: document.querySelector('#topProjectName').textContent };
        });
        assert.equal(ui.avatar, member.avatar);
        assert.equal(ui.headerAvatar, member.avatar);
        assert.equal(ui.headerRole, current.directory.roles[member.role]);
        assert.equal(ui.sidebarRole, member.title);
        assert.ok(ui.greeting.includes(person.name));
        assert.ok(ui.brief.includes(current.directory.roles[member.role]));
        assert.equal(ui.project, project.name);
        assert.ok(current.bootstrap.tasks.every(task => task.projectId === project.id));
        assert.ok(current.bootstrap.tasks.some(task => task.ownerId === membership.memberId));
        assert.ok(current.bootstrap.decisions.every(item => item.projectId === project.id));
        assert.ok(current.snapshot.drafts.every(item => item.projectId === project.id));
        result.identitySwitches.push({ person: person.name, personId: person.personId, projectId: project.id, memberId: member.id, title: member.title, role: member.role, canApprove: current.snapshot.approval.canApprove });
        return current;
      };

      const inspectApproval = async (current, name) => {
        const expected = current.snapshot.approval.canApprove;
        const candidate = current.snapshot.drafts.find(draft => draft.status === 'pending');
        assert.ok(candidate);
        await run(function openContext() { window.aidesignHubChatUI.close(); document.querySelector('.nav-item[data-view="files"]').click(); });
        await wait(function contextReady(id, projectName) { return !!document.querySelector(`[data-pc-draft="${id}"]`) && document.querySelector('#projectContextWorkspace .pc-overview h2')?.textContent === projectName; }, 'Context did not follow selected project', candidate.id, current.bootstrap.project.name);
        const contextText = await run(function contextText() { return document.querySelector('#projectContextWorkspace').textContent; });
        for (const task of current.bootstrap.tasks) assert.ok(contextText.includes(task.title), `Missing current-project task ${task.title}`);
        for (const task of baseline.tasks.filter(task => task.projectId !== current.bootstrap.project.id)) assert.ok(!contextText.includes(task.title), `Leaked other-project task ${task.title}`);
        await run(function openCandidate(id) { document.querySelector(`[data-pc-draft="${id}"]`).click(); }, candidate.id);
        await wait(function approvalReady() { return !!document.querySelector('#hubDraftDialog[open] #projectDraftReview h2'); }, 'Candidate review dialog did not open');
        const button = await run(function approvalButton() { const control = document.querySelector('#projectConfirm'); return { disabled: !control || control.disabled, label: control?.textContent || '', title: document.querySelector('#projectDraftReview h2')?.textContent || '' }; });
        assert.equal(button.disabled, !expected, 'Actual membership controls approval button');
        if (expected) assert.ok(button.label.includes('审批'));
        else assert.ok(button.title.includes('负责人'));
        await capture(`context-${name}.png`);
        await run(function closeCandidate() { document.querySelector('#hubDraftClose').click(); });
        result.approvalChecks.push({ name, projectId: current.bootstrap.project.id, memberId: current.bootstrap.settings.currentMemberId, allowed: expected });
      };

      for (const [index, person] of people.entries()) {
        step = `switch identity ${person.name}`;
        const current = await selectIdentity(person, initialProject, index === 0);
        await run(async function openGroup() { await window.aidesignHubChatUI.open('group'); });
        await wait(function groupReady(projectName) { return !document.querySelector('#hubChatDemo').hidden && document.querySelector('#hubChatDemo [data-cd-group-title]')?.textContent.includes(projectName); }, 'Group did not refresh for identity', initialProject.name);
        const draft = await run(function readDraft() { return document.querySelector('#hubChatDemo .cd-input').value; });
        assert.equal(draft, person.key === initialPerson.key ? marker : '', 'Group draft is scoped to actual project membership');
        await run(function closeGroup() { window.aidesignHubChatUI.close(); });
        if (current.snapshot.approval.canApprove || person.key === initialPerson.key) await inspectApproval(current, person.personId);
      }
      assert.equal(new Set(result.identitySwitches.map(item => item.personId)).size, 8);
      result.groupDraftIdentityIsolation = true;

      step = 'leader project switch';
      const leader = directory.people.find(person => person.memberships.every(member => member.role === 'leader'));
      assert.ok(leader);
      await selectIdentity(leader, initialProject);
      const projectOrder = [...directory.projects.filter(project => project.id !== initialProject.id), initialProject];
      for (const project of projectOrder) {
        await run(function openProjectPicker() { document.querySelector('#projectSwitcher').click(); });
        await wait(function projectPickerReady(id) { return !!document.querySelector(`dialog[open] [data-project-choice="${id}"]`); }, 'Project picker did not open', project.id);
        await run(function chooseProject(id) { document.querySelector(`dialog[open] [data-project-choice="${id}"]`).click(); }, project.id);
        const membership = leader.memberships.find(item => item.projectId === project.id);
        await wait(async function projectSwitched(id, memberId, name) {
          const data = await window.bycjWorkbench.bootstrap();
          return data.project.id === id && data.settings.currentMemberId === memberId && document.querySelector('#topProjectName').textContent === name && !document.querySelector('.view-stack').inert;
        }, 'Project switch did not preserve actual person identity', project.id, membership.memberId, project.name);
        const current = await readState();
        assert.equal(current.bootstrap.members.find(item => item.id === membership.memberId).personId, leader.personId);
        assert.equal(current.snapshot.approval.canApprove, true);
        await inspectApproval(current, `${project.id}-leader`);
        result.projectSwitches.push({ projectId: project.id, memberId: membership.memberId, personId: leader.personId, stage: current.bootstrap.project.stage });
      }
      assert.equal(new Set(result.projectSwitches.map(item => item.stage)).size, 3);
      const target = directory.projects.find(project => project.id !== initialProject.id);
      await selectIdentity(initialPerson, target);
      result.explicitDifferentPersonAndProject = true;

      step = 'final isolation checks';
      const after = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      for (const key of ['members', 'projects', 'tasks', 'risks', 'decisions', 'messages', 'contractMilestones', 'scopeChanges', 'projectHub']) assert.deepEqual(after[key], baseline[key], `Switching identity/project must not mutate business data: ${key}`);
      assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel, 'Non-demo database must remain byte-identical');
      assert.deepEqual(requests, [], 'Company UI demo must not contact remote services');
      const errors = await run(function errors() { return window.__BYCJ_WORKBENCH_ERRORS__ || []; });
      assert.deepEqual(errors, []);
      assert.equal(win.isVisible(), false);
      result.businessDataUnchanged = true;
      result.noRealUserDataLoaded = true;
      result.networkRequests = requests.length;
      result.errors = errors;
      result.actualVisibleWindowOpened = false;
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, result }, null, 2));
      console.log(JSON.stringify({ ok: true, output, result }, null, 2));
      clearTimeout(watchdog);
      app.quit();
    } catch (error) {
      clearTimeout(watchdog);
      console.error(error);
      if (win && !win.isDestroyed()) {
        try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
        try { fs.writeFileSync(path.join(output, 'failure-dom.txt'), await win.webContents.executeJavaScript('document.body.innerText')); } catch {}
      }
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ step, error: error.stack, result }, null, 2));
      console.error(`Step: ${step}. Artifacts: ${output}`);
      app.exit(1);
    }
  });
}
