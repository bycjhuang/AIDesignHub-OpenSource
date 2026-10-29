'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const bundled = path.join(root, '.runtime', 'electron.exe');
  const child = require('node:child_process').spawn(fs.existsSync(bundled) ? bundled : require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-case-selection-'));
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1380, height: 1080, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
    try {
      const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      const library = source.slice(source.lastIndexOf('<section', source.indexOf('id="view-cases"')), source.indexOf('<section class="page-view" id="view-tools"'));
      const detail = source.slice(source.lastIndexOf('<div class="modal-backdrop', source.indexOf('id="caseModal"')), source.lastIndexOf('<div class="modal-backdrop', source.indexOf('id="decisionModal"')));
      const styles = ['styles.css', 'case-name.css', 'project-research.css'].map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, file)).href}">`).join('');
      const html = path.join(output, 'case-library.html');
      fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>.page-view{display:block!important;max-width:1250px;margin:auto;padding:30px}</style><body>${library}${detail}</body></html>`);
      await win.loadFile(html);
      await win.webContents.executeJavaScript(`(() => {
        const fixture = {project:{id:'p1'},cases:[{id:'a',projectId:'p1',name:'滨水街区',typeLabel:'商业街区',area:'56000㎡',location:'上海',designer:'案例设计方',sourceUrl:'',scope:'local',notes:'以街巷和水岸组织公共空间。'},{id:'b',projectId:'p1',name:'城市文化中心',typeLabel:'文化建筑',area:'42000㎡',sourceUrl:'',scope:'local',notes:'展览与阅读围绕公共庭院组织。'}]};
        window.__caseFixture=fixture;window.__caseCalls=[];window.__caseRequests=[];window.__caseErrors=[];
        addEventListener('error', event=>window.__caseErrors.push(event.message));
        addEventListener('adh-workbench-request', event=>window.__caseRequests.push(event.detail));
        window.bycjWorkbench={agentSnapshot:async()=>({projectId:fixture.project.id,connections:[]}),bootstrap:async()=>fixture,caseCollect:async payload=>{window.__caseCalls.push(payload);return {id:'new',projectId:payload.projectId,research:{status:'queued'}};},caseOnChanged:()=>()=>{},openExternalUrl:async()=>{}};
        window.aidesignHubToast=()=>{};
      })()`);
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'case-ui.js'), 'utf8'));
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'project-research-ui.js'), 'utf8'));
      const result = await win.webContents.executeJavaScript(`(async () => {
        const check=(condition,message)=>{if(!condition)throw new Error(message);};const $=id=>document.getElementById(id);const pause=()=>new Promise(resolve=>setTimeout(resolve,40));
        window.aidesignCaseUI.render(__caseFixture.cases,__caseFixture);
        __caseFixture.cases[0].typeLabel='地下半地下开放式商业与城市绿地，以及文化展览、阅读、餐饮、公共步道等复合功能，'.repeat(8);__caseFixture.cases[0].source='项目案例调研';window.aidesignCaseUI.render(__caseFixture.cases,__caseFixture);
        const firstCard=document.querySelector('[data-case-id="a"]'),typeValue=firstCard.querySelector('.case-fact-summary dd'),typeStyle=getComputedStyle(typeValue);
        check(!firstCard.querySelector('.case-cover-labels'),'Cover exposes long type or system mode label');check(!firstCard.querySelector('.case-cover').textContent.includes('项目案例调研'),'Cover exposes research mode');
        check(typeValue.textContent.length<=45&&typeValue.title.length>200,'Long type summary not bounded or full value lost');check(typeValue.getBoundingClientRect().height<=parseFloat(typeStyle.lineHeight)*2+1,'Type summary exceeds two lines');
        check(!$('projectResearchPanel'),'Removed research form still mounted');
        check(!$('caseCollectUrl').disabled&&$('caseCollectConnection').closest('label').hidden,'Collector is not link-only');
        const first=document.querySelector('[data-case-select="a"]');first.click();
        check(!$('caseSelectionBar').hidden&&$('caseSelectionCount').textContent.includes('1'),'Selection bar missing');
        check(!$('caseModal').classList.contains('is-open'),'Checkbox opened case drawer');
        document.querySelector('[data-case-select="b"]').click();
        window.aidesignCaseUI.render([__caseFixture.cases[0]],__caseFixture);
        check(window.aidesignCaseUI.getSelection().caseIds.length===2,'Filtering lost valid case selection');
        $('caseSelectionSend').click();check(__caseRequests.length===1&&__caseRequests[0].action==='presentation'&&__caseRequests[0].caseIds.length===2&&__caseRequests[0].projectId==='p1','ADH case handoff invalid');
        $('openProjectResearch').click();check(__caseRequests[1].action==='research'&&__caseRequests[1].caseIds.length===0,'ADH research entry invalid');
        window.dispatchEvent(new CustomEvent('hub-project-changed',{detail:{projectId:'p2'}}));
        check(window.aidesignCaseUI.getSelection().caseIds.length===0&&$('caseSelectionBar').hidden,'Project switch leaked selected cases');
        __caseFixture.project.id='p2';__caseFixture.cases=[{id:'c',projectId:'p2',name:'新项目案例',scope:'local',sourceUrl:''}];
        window.aidesignCaseUI.render(__caseFixture.cases,__caseFixture);
        const before=__caseRequests.length;window.aidesignCaseUI.handOff('presentation',['a']);check(__caseRequests.length===before,'Foreign case id was handed off');
        $('casePageOnly').checked=false;$('caseCollectUrl').value='https://architecture.example.org/project';$('caseCollectForm').requestSubmit();await pause();
        check(__caseCalls.length===1&&__caseCalls[0].projectId==='p2'&&__caseCalls[0].connectionId===null&&__caseCalls[0].url==='https://architecture.example.org/project','Collection did not use current project without Agent');
        check(__caseErrors.length===0,'Renderer error: '+__caseErrors.join(';'));
        __caseFixture.project.id='p1';__caseFixture.cases=[{id:'a',projectId:'p1',name:'滨水街区',typeLabel:'商业街区',area:'56000㎡',scope:'local',sourceUrl:'',notes:'以街巷和水岸组织公共空间。'},{id:'b',projectId:'p1',name:'城市文化中心',typeLabel:'文化建筑',area:'42000㎡',scope:'local',sourceUrl:'',notes:'展览与阅读围绕公共庭院组织。'}];window.dispatchEvent(new CustomEvent('hub-project-changed',{detail:{projectId:'p1'}}));window.aidesignCaseUI.render(__caseFixture.cases,__caseFixture);document.querySelector('[data-case-select="a"]').click();
        return {selection:true,filteredSelection:true,currentProjectCollection:true,noExternalDispatch:true,adhResearch:true,adhPresentation:true,projectIsolation:true,rendererErrors:__caseErrors};
      })()`);
      assert.equal(result.rendererErrors.length, 0);
      fs.writeFileSync(path.join(output, 'case-library.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, ...result, output })); win.destroy(); app.quit();
    } catch (error) { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(JSON.stringify({ ok: false, error: error.message, output })); app.exit(1); }
  });
}
