'use strict';

// Run only the real Project Hub approval UI fixture in a fresh local store.
// The obsolete global group-chat/LAN-sync smoke is intentionally not started.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  const env={...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BYCJ_WORKBENCH_SMOKE;
  delete env.AIDESIGNHUB_LEGACY_TEAM_SYNC;
  const bundled=path.resolve(__dirname,'../.runtime/electron.exe');
  const executable=fs.existsSync(bundled)?bundled:require('electron');
  const child=require('node:child_process').spawn(executable,[__filename],{env,cwd:path.resolve(__dirname,'..'),stdio:'inherit',windowsHide:true});
  child.on('error',error=>{console.error(error);process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
}else{
  const electron=require('electron');
  const {app,BrowserWindow,session}=electron;
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-approval-ui-'));
  process.env.AIDESIGNHUB_DATA_DIR=path.join(output,'aidesignhub-smoke-project-hub');
  delete process.env.BYCJ_WORKBENCH_SMOKE;
  delete process.env.AIDESIGNHUB_LEGACY_TEAM_SYNC;
  app.setPath('userData',path.join(output,'profile'));
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show=function keepTestHidden(){};
  const testElectron=Object.create(electron);
  Object.defineProperty(testElectron,'BrowserWindow',{value:class BrowserWindow extends electron.BrowserWindow{
    constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});}
  }});
  const requests=[];
  app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{requests.push(details.url);callback({cancel:true});}));
  const Module=require('node:module'),load=Module._load;
  const mainPath=path.resolve(__dirname,'../electron-main.cjs');
  let projectHub,skillCenter;
  Module._load=function isolatedServiceCapture(name,parent,isMain){
    if(parent?.filename===mainPath){
      if(name==='electron')return testElectron;
      if(name==='./backend/project-hub.cjs'){
        const real=load.call(this,name,parent,isMain);
        return {...real,ProjectHub:class extends real.ProjectHub{constructor(options){super(options);projectHub=this;}}};
      }
      if(name==='./backend/skill-center.cjs'){
        const real=load.call(this,name,parent,isMain);
        return {...real,SkillCenter:class extends real.SkillCenter{constructor(options){super(options);skillCenter=this;}}};
      }
    }
    return load.call(this,name,parent,isMain);
  };
  try{require('../electron-main.cjs');}finally{Module._load=load;}
  app.whenReady().then(async()=>{
    let win;
    try{
      const deadline=Date.now()+20000;
      while(Date.now()<deadline){
        win=BrowserWindow.getAllWindows()[0];
        if(win&&projectHub&&skillCenter&&await win.webContents.executeJavaScript('!!window.aidesignProjectUI && !!window.bycjWorkbench && !!document.querySelector("#projectModelState")').catch(()=>false))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(win&&projectHub&&skillCenter,'Actual application and Project Hub services initialized');
      const sync=await win.webContents.executeJavaScript('window.bycjWorkbench.teamSyncStatus()');
      assert.equal(sync.disabled,true,'Legacy transport stays disabled during the focused smoke');
      // Set only after application startup to satisfy the fixture's isolation
      // guard without enabling the production app's old broad smoke branch.
      process.env.BYCJ_WORKBENCH_SMOKE='1';
      let result;
      try{result=await require('../tests/fixtures/project-hub-ui-smoke.cjs').runProjectHubSmoke(win,projectHub,skillCenter);}finally{delete process.env.BYCJ_WORKBENCH_SMOKE;}
      const errors=await win.webContents.executeJavaScript('window.__BYCJ_WORKBENCH_ERRORS__||[]');
      assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'No remote resources or models were requested');
      const report={ok:true,output,result,rendererErrors:errors,networkRequests:0,legacyGlobalGroupSmoke:'not run: superseded by frontend-only demo fixtures'};
      fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
      fs.writeFileSync(path.join(output,'project-hub-ui.png'),(await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify(report,null,2));app.quit();
    }catch(error){
      const diagnostics=await win?.webContents.executeJavaScript('({step:window.__SMOKE_STEP__,errors:window.__BYCJ_WORKBENCH_ERRORS__,text:document.body.innerText.slice(-4000)})').catch(()=>null);
      fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,diagnostics},null,2));
      if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
      console.error(error);console.error(`Artifacts: ${output}`);app.exit(1);
    }
  });
}
