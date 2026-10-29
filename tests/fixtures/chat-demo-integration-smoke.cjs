'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function runHubChatDemoIntegration(win, { root, output, installAuditSource }) {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dock = source.match(/<aside id="hubChatDock"[\s\S]*?<\/aside>/)?.[0];
  const draftDialog = source.match(/<dialog id="hubDraftDialog"[\s\S]*?<\/dialog>/)?.[0];
  assert(dock && draftDialog, 'Integration fixture uses real Hub dock markup.');
  function installSyntheticBridge() {
    const calls = [];
    const p = id => ({ project: { id, name: id === 'integration-a' ? '江湾项目 · 集成合成测试' : '海湾项目 · 集成合成测试' }, settings: { currentMemberId: 'member-me' }, members: [{ id: 'member-me', projectId: id, name: '陈设计', role: 'designer', active: true }, { id: 'member-lin', projectId: id, name: '林澜', role: 'project_manager', active: true }] });
    window.__integration = { calls, data: p('integration-a'), p, holdBootstrap: false, bootstrapPending: [], modelConfigured: false, sends: [] };
    const fixture = window.__integration;
    document.getElementById('projectModelSettings').addEventListener('click', () => calls.push('modelSettingsOpen'));
    const denied = window.bycjWorkbench;
    window.bycjWorkbench = new Proxy({
      bootstrap: async () => { calls.push('bootstrap'); if (fixture.holdBootstrap) return new Promise((resolve, reject) => fixture.bootstrapPending.push({ resolve, reject })); return structuredClone(fixture.data); },
      hubChatOnChanged: () => { calls.push('hubChatOnChanged'); },
      hubChatSnapshot: async input => { calls.push('hubChatSnapshot'); return { projectId: input.projectId, channelId: `assistant-${input.projectId}`, assistantChannelId: `assistant-${input.projectId}`, messages: [], members: structuredClone(fixture.data.members), syncMode: 'local', model: { configured: fixture.modelConfigured, provider: 'synthetic', baseUrl: 'https://synthetic.invalid', model: 'no-network-fixture' }, context: { project: { name: fixture.data.project.name }, scopeLabel: fixture.data.project.name, page: { view: input.view, access: 'allowed' } } }; },
      hubChatSend: async input => { calls.push('hubChatSend'); fixture.sends.push(structuredClone(input)); return { projectId: input.projectId, status: 'succeeded' }; },
      projectSnapshot: async () => { calls.push('projectSnapshot'); return { drafts: [] }; },
    }, { get: (target, name) => name in target ? target[name] : denied[name] });
  }
  const url = file => pathToFileURL(path.join(root, file)).href;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><base href="${pathToFileURL(root + path.sep).href}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file: 'unsafe-inline'; style-src 'self' file: 'unsafe-inline'; img-src 'self' file: data: blob:; connect-src 'none'; font-src 'none'; media-src blob: data:"><link rel="stylesheet" href="${url('styles.css')}"><link rel="stylesheet" href="${url('hub-chat.css')}"><link rel="stylesheet" href="${url('chat-demo.css')}"><style>.app-shell{display:block;height:100vh}.hub-chat-dock{position:static!important;width:100%!important;max-width:100%!important;height:100vh!important}#hubChatDemo{min-height:0;flex:1}</style></head><body><div class="app-shell">${dock}</div>${draftDialog}<button hidden id="projectModelSettings"></button><script>(${installAuditSource})();(${installSyntheticBridge.toString()})();</script><script src="${url('chat-demo-ui.js')}"></script><script src="${url('hub-chat-ui.js')}"></script></body></html>`;
  const file = path.join(output, 'integration.html');
  fs.writeFileSync(file, html.replace(`<script src="${url('chat-demo-ui.js')}">`, `<script src="${url('context-review-demo.js')}"></script><script src="${url('chat-demo-ui.js')}">`));
  win.setSize(720, 940);
  await win.loadFile(file);
  const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);
  const result = await run(async function integration() {
    const $ = id => document.getElementById(id), fixture = window.__integration, checks = [];
    const sleep = () => new Promise(resolve => setTimeout(resolve, 20));
    const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(); } throw new Error(label); };
    const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
    await wait(() => !$('hubChatDemo').hidden, 'Default group did not become ready.');
    check($('hubChatLive').hidden && $('hubChatGroupTab').classList.contains('is-active'), 'default mode is demo group');
    check(!$('hubChatChannel'), 'old topic selector removed from real markup');
    check(!$('hubChatMembers') && !$('hubChatMore'), 'assistant member and more controls are removed');
    check(!fixture.calls.includes('hubChatSnapshot'), 'default group never reads private assistant history');
    const demo = $('hubChatDemo');
    const input = demo.querySelector('.cd-input'); input.value = '@DesignHub 集成演示消息'; input.dispatchEvent(new Event('input', { bubbles: true })); demo.querySelector('form').requestSubmit();
    check(demo.textContent.includes('上下文候选') && demo.textContent.includes('待负责人审批'), 'real dock routes demo mention to local pending candidate');
    check(window.__demoAudit.bridge.length === 0, 'demo send makes no backend writes');
    $('hubChatAssistantTab').click();
    await wait(() => !$('hubChatLive').hidden && !$('hubChatSend').disabled, 'Assistant tab did not become ready.');
    const modelButton = $('hubChatModelSettings');
    check(modelButton?.closest('form') === $('hubChatForm'), 'model settings is inside assistant composer');
    check(Boolean($('hubChatInput').compareDocumentPosition(modelButton) & Node.DOCUMENT_POSITION_FOLLOWING), 'model settings follows textarea in DOM order');
    check(modelButton.getBoundingClientRect().top >= $('hubChatInput').getBoundingClientRect().bottom - 1, 'model settings is visually below textarea');
    modelButton.click();
    check(fixture.calls.filter(call => call === 'modelSettingsOpen').length === 1, 'model settings delegates to existing settings entry');
    check(!document.querySelector('[data-chat-sync]') && !$('hubChatLive').textContent.includes('团队同步'), 'assistant has no retired team sync entry');
    $('hubChatInput').value = '独立助手草稿，不应进入群聊'; $('hubChatInput').dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 390));
    $('hubChatGroupTab').click(); await wait(() => !demo.hidden, 'Group failed to reopen.');
    check(!demo.textContent.includes('独立助手草稿'), 'private assistant draft does not leak into group');
    $('hubChatAssistantTab').click(); await wait(() => !$('hubChatLive').hidden && !$('hubChatSend').disabled, 'Assistant failed to reopen.');
    check($('hubChatInput').value === '独立助手草稿，不应进入群聊', 'assistant draft survives switching to demo');
    check(!$('hubChatRecords') && !$('hubChatRecord') && !$('hubChatUseModel'), 'old record and per-message consent controls removed');
    $('hubChatForm').requestSubmit(); await sleep();
    check(fixture.sends.length === 0 && $('hubChatInput').value.includes('独立助手草稿') && $('hubChatNotice').textContent.includes('尚未发送'), 'unconfigured model preserves draft and makes no send');
    fixture.modelConfigured = true; await window.aidesignHubChatUI.refresh();
    $('hubChatForm').requestSubmit();
    await wait(() => !!document.querySelector('[data-consent-allow]'), 'First send did not show consent.');
    check(fixture.sends.length === 0 && document.querySelector('dialog[open]').textContent.includes('资料范围'), 'first configured send waits for explicit scoped consent');
    document.querySelector('[data-consent-allow]').click();
    await wait(() => fixture.sends.length === 1 && !$('hubChatSend').disabled, 'Approved synthetic send did not finish.');
    check(fixture.sends[0].useModel === true, 'authorized assistant dispatch has useModel true');
    $('hubChatInput').value = '新页面需要重新授权'; $('hubChatInput').dispatchEvent(new Event('input', { bubbles: true }));
    await window.aidesignHubChatUI.setView('knowledge');
    $('hubChatForm').requestSubmit(); await wait(() => !!document.querySelector('[data-consent-allow]'), 'Changed page did not ask for new consent.');
    $('hubChatGroupTab').click(); await wait(() => !demo.hidden, 'Group failed to reopen from pending consent.');
    await sleep(); check(!document.querySelector('dialog[data-hub-chat-dialog]') && fixture.sends.length === 1, 'switching to group cancels pending assistant authorization');
    fixture.holdBootstrap = true; fixture.data = fixture.p('integration-b');
    window.dispatchEvent(new CustomEvent('hub-project-changed', { detail: { projectId: 'integration-b' } }));
    check(demo.hidden && demo.inert && !$('hubChatDemoLoading').hidden, 'old group hidden and inert while next project loads');
    await wait(() => fixture.bootstrapPending.length === 1, 'Expected pending project bootstrap.');
    fixture.bootstrapPending.shift().resolve(structuredClone(fixture.data)); fixture.holdBootstrap = false;
    await wait(() => !demo.hidden, 'New project group did not load.');
    check(demo.textContent.includes('海湾项目') && !demo.textContent.includes('集成演示消息'), 'new project does not show old project demo messages');
    fixture.holdBootstrap = true; fixture.data = fixture.p('integration-a');
    window.dispatchEvent(new CustomEvent('hub-project-changed', { detail: { projectId: 'integration-a' } }));
    await wait(() => fixture.bootstrapPending.length === 1, 'Expected rejected project bootstrap.');
    fixture.bootstrapPending.shift().reject(new Error('合成加载失败')); fixture.holdBootstrap = false; await sleep();
    check(demo.hidden && demo.inert && $('hubChatNotice').textContent.includes('合成加载失败'), 'failed project load cannot expose prior demo');
    check(!$('hubChatDemoRetry').hidden, 'failed demo load exposes retry action');
    $('hubChatDemoRetry').click(); await wait(() => !demo.hidden, 'Retry action did not recover demo.');
    check(!demo.hidden && demo.textContent.includes('集成演示消息'), 'refresh recovers isolated project demo');
    const before = demo.querySelectorAll('[data-cd-message]').length;
    $('hubChatClose').click(); demo.querySelector('form').requestSubmit();
    check($('hubChatDock').hidden && demo.inert && demo.querySelectorAll('[data-cd-message]').length === before, 'closed dock prevents demo interactions');
    await window.aidesignHubChatUI.open('group');
    $('hubChatExpand').click();
    check($('hubChatDock').classList.contains('is-expanded'), 'expand control works');
    check(window.__demoAudit.bridge.length === 0, 'entire group integration caused zero mutating bridge calls');
    return { checks, assertionCount: checks.length, calls: fixture.calls };
  });
  const audit = await run(function audit() { return window.__demoAudit; });
  for (const [key, values] of Object.entries(audit)) assert.equal(values.length, 0, `${key}: ${JSON.stringify(values)}`);
  fs.writeFileSync(path.join(output, 'demo-integrated.png'), (await win.webContents.capturePage()).toPNG());
  await run(async function showAssistant() { await window.aidesignHubChatUI.open('assistant'); });
  await new Promise(resolve => setTimeout(resolve, 80));
  fs.writeFileSync(path.join(output, 'assistant-composer.png'), (await win.webContents.capturePage()).toPNG());
  return { ...result, audit };
}
module.exports = { runHubChatDemoIntegration };
