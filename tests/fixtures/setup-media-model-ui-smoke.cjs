'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(process.env.ADH_MEDIA_UI_TEST_ROOT || '');
if (!/^adh-media-model-ui-/.test(path.basename(root))) throw new Error('An isolated UI test directory is required.');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 950, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const repo = path.resolve(__dirname, '..', '..');
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><button id="hubGlobalModelSettings"><small id="hubGlobalModelStatus"></small></button><button id="projectModelSettings">模型设置</button><div class="view-stack"></div></body></html>';
  const file = path.join(root, 'fixture.html'); fs.writeFileSync(file, html); await window.loadFile(file);
  for (const stylesheet of ['styles.css', 'project-hub.css', 'setup-center.css']) await window.webContents.executeJavaScript(`document.head.append(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(fs.readFileSync(path.join(repo, stylesheet), 'utf8'))}}));`);
  await window.webContents.executeJavaScript(`
    window.__calls=[];window.__changed=0;window.__paid=0;window.__autoPair=0;
    window.__media={profiles:[{id:'image-existing',category:'image',name:'现有图片模型',apiType:'apimart',baseUrl:'https://api.apimart.ai/v1',model:'gpt-image-2',hasApiKey:true,enabled:true}],defaults:{image:'image-existing',video:null}};
    window.__text={configured:true,provider:'deepseek',model:'deepseek-flash',baseUrl:'https://api.deepseek.com',hasApiKey:true,keyring:['deepseek|https://api.deepseek.com','openai-compatible|https://api.apimart.ai/v1'],profiles:[{id:'text-deepseek',provider:'deepseek',name:'DeepSeek V4.1 Flash',model:'deepseek-flash',baseUrl:'https://api.deepseek.com',hasApiKey:true},{id:'text-sol',provider:'openai-compatible',name:'GPT 6.1 Sol · APIMart',model:'gpt-6.1-sol',baseUrl:'https://api.apimart.ai/v1',hasApiKey:true},{id:'text-astra',provider:'openai-compatible',name:'GPT 6 Astra · APIMart',model:'gpt-6-astra',baseUrl:'https://api.apimart.ai/v1',hasApiKey:true}]};
    const clone=value=>JSON.parse(JSON.stringify(value));
    window.fetch=()=>{window.__paid++;throw new Error('Paid network is disabled in this test.');};
    window.bycjWorkbench={
      projectModelStatus:async()=>clone(window.__text),
      projectModelSave:async payload=>{window.__calls.push({method:'text-save',payload:clone(payload)});if(payload.isDefault!==false)Object.assign(window.__text,{provider:payload.provider,model:payload.model,baseUrl:payload.baseUrl});},
      projectModelOnChanged:()=>()=>{},mediaModelSettings:async()=>clone(window.__media),
      mediaModelSave:async payload=>{window.__calls.push({method:'media-save',payload:clone(payload)});if(window.__fail)throw new Error(window.__fail);const old=window.__media.profiles.find(profile=>profile.id===payload.id);const profile={...old,...payload,id:old?.id||'profile-'+window.__calls.length,enabled:true,hasApiKey:Boolean(payload.apiKey||old?.hasApiKey)};delete profile.apiKey;delete profile.isDefault;window.__media.profiles=window.__media.profiles.filter(item=>item.id!==profile.id).concat(profile);if(payload.isDefault)window.__media.defaults[payload.category]=profile.id;return clone(window.__media);},
      mediaModelRemove:async payload=>{window.__calls.push({method:'media-remove',payload:clone(payload)});window.__media.profiles=window.__media.profiles.filter(profile=>profile.id!==payload.id);for(const key of ['image','video'])if(window.__media.defaults[key]===payload.id)window.__media.defaults[key]=null;return clone(window.__media);}
    };
    window.aidesignAgentSetupUI={autoPair:async()=>{window.__autoPair++;}};
    window.addEventListener('adh-model-settings-changed',()=>window.__changed++);
  `);
  const projectSource = fs.readFileSync(path.join(repo, 'project-hub-ui.js'), 'utf8');
  const begin = projectSource.indexOf("  $('projectModelSettings')?.addEventListener('click',async()=>{");
  const end = projectSource.indexOf('  let skillRequest', begin); assert(begin >= 0 && end > begin);
  // Run the actual unchanged text-model handler with local fixture helpers.
  await window.webContents.executeJavaScript(`(()=>{const api=window.bycjWorkbench,$=id=>document.getElementById(id);const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));const options=(items,value)=>Object.entries(items).map(([id,label])=>'<option value="'+esc(id)+'" '+(id===value?'selected':'')+'>'+esc(label)+'</option>').join('');function dialog(title,body){const d=document.createElement('dialog');d.className='hub-dialog';d.innerHTML='<h2>'+esc(title)+'</h2>'+body+'<div class="hub-actions"><button class="secondary-button" data-dialog-close>关闭</button></div>';document.body.append(d);d.querySelector('[data-dialog-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.showModal();return d;}const refresh=async()=>{},notice=()=>{};${projectSource.slice(begin, end)}})();`);
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(repo, 'setup-center-ui.js'), 'utf8'));
  const checks = await window.webContents.executeJavaScript(`(async()=>{
    const wait=async fn=>{for(let count=0;count<100;count++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('UI condition did not settle.');};
    const dialog=()=>document.querySelector('dialog[data-hub-model-settings]'),panel=category=>document.getElementById('hubModelPanel-'+category),form=category=>document.getElementById('mediaModelForm-'+category),buttons=(parent,label)=>[...parent.querySelectorAll('button')].find(button=>button.textContent===label);
    const result={}; window.aidesignSetupUI.openModelSettings();await wait(()=>dialog());
    const text=document.getElementById('hubModelForm');await wait(()=>document.querySelectorAll('.setup-text-profile').length===3);result.textProviderBehavior=text.elements.provider.options.length===3&&typeof text.onsubmit==='function';
    const saveButton=dialog().querySelector('.setup-text-submit');result.sharedTextLayout=text.classList.contains('setup-media-form')&&text.elements.provider.getBoundingClientRect().top===text.elements.model.getBoundingClientRect().top&&getComputedStyle(text.elements.provider.closest('label')).marginTop==='0px'&&text.getBoundingClientRect().height<420;
    result.sharedFooter=saveButton.form===text&&saveButton.parentElement===dialog().querySelector('[data-dialog-close]').parentElement;
    text.querySelector('details').open=true;const local=text.elements.allowLocalHttp,localCopy=local.nextElementSibling;result.checkboxAligned=local.getBoundingClientRect().width<=18&&localCopy.getBoundingClientRect().left-local.getBoundingClientRect().right<=12;text.querySelector('details').open=false;
    document.querySelector('input[name=textDefault][value=text-sol]').click();await wait(()=>window.__text.model==='gpt-6.1-sol'&&document.querySelector('input[name=textDefault][value=text-sol]:checked')&&!document.querySelector('#hubModelTab-text').disabled);result.textSwitchPreserved=window.__calls.filter(call=>call.method==='text-save').at(-1).payload.keyFromKeyring===true&&text.elements.model.value==='gpt-6.1-sol';
    text.elements.provider.value='bailian';text.elements.provider.dispatchEvent(new Event('change'));result.textProviderBehavior&&=text.elements.baseUrl.value==='';text.elements.provider.value='deepseek';text.elements.provider.dispatchEvent(new Event('change'));
    window.dispatchEvent(new CustomEvent('adh-open-model-settings',{detail:{category:'image'}}));await wait(()=>panel('image').querySelector('.setup-media-profile'));
    result.textSaveHidden=saveButton.hidden;
    if(document.querySelectorAll('dialog[data-hub-model-settings]').length!==1)throw new Error('Opening a category created a duplicate dialog.');
    buttons(panel('image'),'编辑').click();let editing=form('image');if(editing.elements.apiKey.value!==''||editing.elements.apiKey.type!=='password')throw new Error('A stored key was exposed.');editing.elements.name.value='重命名的图片模型';editing.requestSubmit();await wait(()=>!form('image'));
    const saved=window.__calls.filter(call=>call.method==='media-save').at(-1);result.blankKeyPreserved=!Object.hasOwn(saved.payload,'apiKey')&&window.__media.profiles[0].hasApiKey;
    buttons(panel('image'),'+ 新增配置').click();await wait(()=>form('image'));editing=form('image');editing.elements.name.value='第二个图片模型';editing.elements.baseUrl.value='https://another.example/v1';editing.elements.model.value='image-secondary';editing.elements.apiKey.value='mock-secret-never-real';editing.requestSubmit();await wait(()=>!form('image'));result.multipleImages=panel('image').querySelectorAll('.setup-media-profile').length===2;
    const second=window.__media.profiles.find(profile=>profile.model==='image-secondary');panel('image').querySelector('[data-media-profile-id="'+second.id+'"] input[type=radio]').click();await wait(()=>window.__media.defaults.image===second.id&&!document.querySelector('#hubModelTab-image').disabled);result.defaultChanged=window.__calls.filter(call=>call.method==='media-save').at(-1).payload.isDefault===true;
    window.dispatchEvent(new CustomEvent('adh-open-model-settings',{detail:{category:'video'}}));buttons(panel('video'),'+ 新增配置').click();await wait(()=>form('video'));editing=form('video');result.videoPlaceholder=editing.elements.name.placeholder.includes('视频');result.compactMedia=getComputedStyle(editing.querySelector('label')).marginTop==='0px'&&editing.getBoundingClientRect().height<500;editing.elements.name.value='预留视频模型';editing.elements.baseUrl.value='https://video.example/v1';editing.elements.model.value='video-reserved';editing.requestSubmit();await wait(()=>!form('video'));result.videoMetadataOnly=window.__media.profiles.some(profile=>profile.category==='video'&&!profile.hasApiKey)&&panel('video').textContent.includes('保存配置不会发起生成');
    buttons(panel('video'),'删除').click();buttons(panel('video'),'删除配置').click();await wait(()=>!window.__media.profiles.some(profile=>profile.category==='video'));result.deleted=panel('video').querySelectorAll('.setup-media-profile').length===0;result.changedEvents=window.__changed>=5;
    window.dispatchEvent(new CustomEvent('adh-open-model-settings',{detail:{category:'image'}}));buttons(panel('image'),'编辑').click();window.__fail='network timeout';form('image').requestSubmit();await wait(()=>document.querySelector('.setup-media-notice').textContent.includes('超时'));result.localizedError=!document.querySelector('.setup-media-notice').textContent.includes('timeout');window.__fail='';buttons(form('image'),'取消').click();
    result.secretHidden=!document.body.textContent.includes('mock-secret-never-real');result.paidNetworkCalls=window.__paid;
    buttons(panel('image'),'APIMart 接入 / 更新密钥').click();await wait(()=>dialog().querySelector('[data-apimart-batch]'));
    const batch=dialog().querySelector('[data-apimart-batch]');result.singleModelDialog=document.querySelectorAll('dialog[open]').length===1&&document.getElementById('hubModelPanel-image').hidden;
    result.savedModelsAreStatus=!!batch.querySelector('.setup-apimart-state.is-saved')&&!batch.querySelector('input[type=checkbox]:disabled')&&!batch.querySelector('input[type=checkbox]:checked');
    const row=batch.querySelector('.setup-apimart-row'),rowStyle=getComputedStyle(row);result.compactApimart=rowStyle.display==='grid'&&row.getBoundingClientRect().height<90;
    const newKey=batch.querySelector('input[type=password]');newKey.value='mock-updated-connection-key';newKey.dispatchEvent(new Event('input'));buttons(batch,'更新密钥（3 个已保存配置）').click();await wait(()=>!dialog().querySelector('[data-apimart-batch]'));result.sharedKeyUpdated=window.__calls.some(call=>call.method==='media-save'&&call.payload.id==='image-existing'&&call.payload.apiKey==='mock-updated-connection-key');
    document.querySelector('#hubModelTab-text').click();await wait(()=>!saveButton.hidden);text.elements.provider.value='openai-compatible';text.elements.provider.dispatchEvent(new Event('change'));text.elements.baseUrl.value='https://text.example/v1';text.elements.model.value='text-model';text.elements.apiKey.value='mock-text-secret';text.elements.autoPair.checked=false;text.elements.autoPair.dispatchEvent(new Event('change'));result.footerLabelUpdated=saveButton.textContent==='仅保存模型设置';saveButton.click();await wait(()=>!dialog());const textSaved=window.__calls.filter(call=>call.method==='text-save').at(-1);result.textSavePreserved=textSaved.payload.provider==='openai-compatible'&&textSaved.payload.model==='text-model'&&window.__autoPair===0;
    window.aidesignSetupUI.openModelSettings('image');await wait(()=>dialog());return result;
  })()`);
  window.setSize(420, 800); await new Promise(resolve => setTimeout(resolve, 60));
  checks.smallWidth = await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('dialog[data-hub-model-settings]');return dialog.scrollWidth<=dialog.clientWidth+1;})()`);
  checks.smallTextWidth = await window.webContents.executeJavaScript(`(async()=>{document.querySelector('#hubModelTab-text').click();await new Promise(resolve=>setTimeout(resolve,30));const dialog=document.querySelector('dialog[data-hub-model-settings]'),form=document.getElementById('hubModelForm');form.querySelector('details').open=true;return !document.getElementById('hubModelTextPanel').hidden&&dialog.scrollWidth<=dialog.clientWidth+1&&form.elements.provider.getBoundingClientRect().top<form.elements.model.getBoundingClientRect().top;})()`);
  if (process.env.ADH_MODEL_UI_CAPTURE_DIR) {
    const captures = path.resolve(process.env.ADH_MODEL_UI_CAPTURE_DIR); fs.mkdirSync(captures, { recursive: true });
    await window.webContents.capturePage();
    await new Promise(resolve => setTimeout(resolve, 80));
    fs.writeFileSync(path.join(captures, 'text-narrow.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`Object.assign(window.__text,{provider:'deepseek',model:'deepseek-flash',baseUrl:'https://api.deepseek.com'});`);
    window.setSize(1000, 1000);
    for (const category of ['text', 'image', 'video']) {
      await window.webContents.executeJavaScript(`document.getElementById('hubModelForm').querySelector('details').open=false;window.dispatchEvent(new CustomEvent('adh-open-model-settings',{detail:{category:${JSON.stringify(category)}}}));`);
      await window.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 60));
      fs.writeFileSync(path.join(captures, category + '-wide.png'), (await window.webContents.capturePage()).toPNG());
    }
  }
  process.stdout.write(`ADH_MEDIA_UI_RESULT ${JSON.stringify(checks)}\n`);
  window.destroy(); app.quit();
}).catch(error => { process.stderr.write(String(error.stack || error)); app.exit(1); });
