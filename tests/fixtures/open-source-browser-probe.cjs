'use strict';
// Explicit manual acceptance probe: opens ONE public source in the system browser.
// Not part of npm test. Uses the production main process, UI, IPC and shell call.
const {app,ipcMain}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
if(!process.argv.includes('--open-public-link'))throw new Error('Explicit --open-public-link is required.');
if(process.env.BYCJ_WORKBENCH_SMOKE==='1')throw new Error('This probe must use production external-link behavior.');
const dataDir=process.env.AIDESIGNHUB_DATA_DIR;
const tempRoot=fs.realpathSync.native(os.tmpdir());
const resolvedDir=fs.realpathSync.native(dataDir||'.');
if(!dataDir||!resolvedDir.toLowerCase().startsWith((tempRoot+path.sep).toLowerCase())||!path.basename(resolvedDir).startsWith('aidesignhub-open-source-'))throw new Error('Use a new isolated aidesignhub-open-source-* directory under the OS temp directory.');
fs.mkdirSync(path.join(resolvedDir,'electron-user-data'),{recursive:true});
app.setPath('userData',path.join(resolvedDir,'electron-user-data'));
const sourceUrl='https://ennead.com/work/shanghai-astronomy-museum/#aidesignhub-source-check';
let settleOpen,started=false,finished=false;
const opened=new Promise(resolve=>{settleOpen=resolve;});
const originalHandle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>originalHandle(channel,async(...args)=>{
  const result=await listener(...args);
  if(channel==='workbench:open-external-url')settleOpen(result);
  return result;
});
function finish(result){
  if(finished)return;finished=true;clearTimeout(timeout);
  fs.writeFileSync(path.join(resolvedDir,'open-source-result.json'),JSON.stringify(result,null,2),'utf8');
  process.stdout.write(JSON.stringify(result)+'\n');app.quit();
}
const timeout=setTimeout(()=>finish({ok:false,error:'Production source-link probe timed out.'}),45000);
app.on('browser-window-created',(_event,win)=>{
  if(started)return;started=true;
  win.on('show',()=>win.hide());win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load',async()=>{
    try{
      const detail=await win.webContents.executeJavaScript(`(async()=>{
        const wait=async(fn)=>{for(let i=0;i<400;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('Source-link UI wait timed out.');};
        const el=id=>document.getElementById(id);
        await wait(()=>window.bycjWorkbench&&document.querySelector('[data-view="cases"]'));
        document.querySelector('[data-view="cases"]').click();
        await wait(()=>el('caseCollectConnection').options.length>0);
        el('casePageOnly').checked=true;el('casePageOnly').dispatchEvent(new Event('change'));
        el('caseCollectUrl').value=${JSON.stringify(sourceUrl)};el('caseCollectForm').requestSubmit();
        const item=await wait(async()=>{const data=await window.bycjWorkbench.bootstrap();const c=data.cases.find(c=>c.sourceUrl===${JSON.stringify(sourceUrl)});return c&&['page_extracted','failed'].includes(c.research?.status)?c:null;});
        const button=await wait(()=>document.querySelector('[data-case-detail="'+item.id+'"]'));button.click();
        const link=await wait(()=>document.querySelector('#caseDetailOriginal a'));
        const source=link.getAttribute('href');if(source!==${JSON.stringify(sourceUrl)})throw new Error('Original URL was not preserved.');link.click();
        return {source,status:item.research.status,area:item.area,location:item.location,openingDate:item.openingDate,caseId:item.id};
      })()`);
      const result=await opened;
      if(result.simulated!==false||result.opened!==true||result.url!==sourceUrl)throw new Error('Production shell did not accept the original source.');
      finish({ok:true,...detail,systemShellAccepted:true,simulated:false,browserVisualConfirmation:'must be checked separately through the browser UI',dataDir:resolvedDir});
    }catch(error){finish({ok:false,error:error.message});}
  });
});
require('../../electron-main.cjs');
