'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {TeamDirectory}=require('../backend/team-directory.cjs');

// Execute the real Electron startup and IPC handlers with inert windows and
// counted sync transports. No socket, external process, model or user store is
// touched; all persisted settings below are synthetic isolated test fixtures.
async function runtime(mode,env={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-legacy-sync-'));
  const dataDir=path.join(root,'data');
  const seed=new LocalBackend({dataDir});
  seed.setTeamSyncConfig({mode,lan:true,port:12345,hostToken:'fixture-host-secret',url:'http://fixture.invalid:12345',token:'fixture-client-secret'});
  const original=structuredClone(seed.store),remote=seed.bootstrap();
  const calls={servers:0,starts:0,stops:0,clients:0,health:0,reads:0,modelSaves:0,modelDataDir:null,deviceInput:null,demoDataDirs:[],shutdownOrder:[]};
  const handlers=new Map(),appEvents=new Map();let ready,backend,startupError;
  class StubService extends EventEmitter {dispose(){} changed(){} status(){return {configured:false};}}
  class StubServer {
    constructor(){calls.servers++;this.running=false;}
    async start(){calls.starts++;this.running=true;return this.status();}
    async stop(){calls.stops++;this.running=false;}
    status(){return {running:this.running,port:12345,token:'fixture-host-secret',addresses:['http://fixture.invalid:12345']};}
  }
  class StubClient {
    constructor(){calls.clients++;}
    async health(){calls.health++;return {ok:true};}
    async bootstrap(){calls.reads++;return structuredClone(remote);}
  }
  class StubWindow {
    constructor(){this.webContents={on(){},once(){},setWindowOpenHandler(){},send(){}};}
    once(){} loadFile(){} show(){}
    static getAllWindows(){return [];}
  }
  const app={
    whenReady:()=>({then(fn){ready=Promise.resolve().then(fn);return {catch(onError){ready=ready.catch(error=>{startupError=error;onError(error);});}};}}),
    getPath:()=>root,getVersion:()=> 'test',on:(event,handler)=>appEvents.set(event,handler),quit(){},
  };
  const mocks={
    electron:{app,BrowserWindow:StubWindow,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},Menu:{setApplicationMenu(){}},dialog:{showErrorBox(){}},shell:{},safeStorage:{}},
    './backend/local-backend.cjs':{LocalBackend:class extends LocalBackend{constructor(options){super(options);backend=this;}}},
    './backend/team-sync.cjs':{TeamSyncServer:StubServer,TeamSyncClient:StubClient},
    './backend/team-directory.cjs':{TeamDirectory},
    './backend/agent-hub.cjs':{AgentHub:class extends StubService{dispose(){calls.shutdownOrder.push('agent-hub');}},SKILLS:[]},
    './backend/project-hub.cjs':{ProjectHub:StubService},
    './backend/skill-center.cjs':{SkillCenter:StubService},
    './backend/resource-library.cjs':{ResourceLibrary:StubService},
    './backend/agent-config-writer.cjs':{listAgents:()=>[],syncAgent:()=>({}),writeMcpServers:()=>({}),writeInstructions:()=>({})},
    './backend/model-service.cjs':{ModelService:class extends StubService{constructor(options){super();calls.modelDataDir=options.dataDir;}save(){calls.modelSaves++;return {configured:true};}}},
    './backend/device-settings.cjs':{resolveDeviceSettings:input=>{calls.deviceInput=input;return {dataDir:path.join(input.backendDataDir,'device-settings-v1'),scope:'device',isolated:true,migration:{status:'not_configured',needsSelection:false,sourceCount:0,sourceLabels:[]}};}},
    './backend/demo-company.cjs':{ensureDemoCompany:async backend=>{calls.demoDataDirs.push(backend.dataDir);}},
    './backend/agent-pairing.cjs':{AgentPairingService:class extends StubService{constructor(){super();this.progress={stage:'idle'};}restore(){return {restored:[],skipped:[],warning:''};}dispose(){calls.shutdownOrder.push('pairing');}}},
    './backend/hub-chat.cjs':{HubChat:StubService},
    './backend/agent-gateway.cjs':{AgentGateway:StubService},
    './backend/agent-executors.cjs':{executeAgent(){}},
    './backend/service-lock.cjs':{acquireServiceLock:()=>()=>calls.shutdownOrder.push('service-lock')},
    './backend/case-research.cjs':{CaseResearchService:StubService},
    './backend/case-article-ipc.cjs':{SCHEME:'adh-case',registerCaseArticleIpc(){}},
    './backend/image-collection.cjs':{ImageCollectionService:StubService},
    './backend/image-browser.cjs':{createImageBrowserCapture:()=>Object.assign(async()=>{throw new Error('Unexpected image capture in legacy sync fixture.');},{dispose(){}})},
    './backend/image-collection-ipc.cjs':{registerImageCollectionIpc(){},rasterPreview(){throw new Error('Unexpected image preview in legacy sync fixture.');}},
    './backend/project-research.cjs':{ProjectResearchService:StubService},
    './backend/research-images.cjs':{ResearchImageService:StubService},
    './backend/project-research-ipc.cjs':{registerProjectResearchIpc(){}},
    './backend/adh-workbench-service.cjs':{AdhWorkbenchService:class extends StubService{async start(){}selectCases(ids){return ids;}}},
    './backend/knowledge-workbench-ipc.cjs':{registerKnowledgeWorkbenchIpc:()=>({service:{},dispose(){}})},
    './backend/knowledge-engine/client.cjs':require('../backend/knowledge-engine/client.cjs'),
    './backend/client-config.cjs':{buildClientConfig(){}},
    './backend/dsh-runtime.cjs':{DshRuntimeManager:class extends StubService{stop(){}getState(){return {status:'missing'};}getAuthUrl(){return null;}}},
    './backend/dsh-model-proxy.cjs':{startDshModelProxy:async()=>({token:'fixture-loopback-token',baseUrl:'http://127.0.0.1:1/v1',stop(){}})},
    './backend/dsh-view.cjs':{DshViewManager:StubService},
    './backend/media-model-service.cjs':{MediaModelService:class extends StubService{getImageProvider(){return {status:()=>({configured:false})};}getVideoProvider(){return {status:()=>({configured:false})};}}},
    './backend/loomic-local.cjs':{createLoomicLocalService:()=>({async stop(){}})},
    './backend/canvas-agent-provider.cjs':{createCanvasAgentProvider:()=>({status:()=>({configured:false})})},
    './tests/fixtures/smoke-case.cjs':{fetchPage(){},fetchImage(){}},
  };
  const context={require:name=>Object.hasOwn(mocks,name)?mocks[name]:require(name),__dirname:root,process:{env:{AIDESIGNHUB_DATA_DIR:dataDir,...env},versions:{},platform:process.platform},URL,Buffer,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','electron-main.cjs'),'utf8'),context,{filename:'electron-main.cjs'});
  await ready;if(startupError)throw startupError;
  return {root,backend,original,calls,emitApp:event=>appEvents.get(event)?.(),invoke:(name,...args)=>handlers.get(`workbench:${name}`)(null,...args)};
}

for(const mode of ['host','client'])test(`default desktop ignores persisted legacy ${mode} without losing settings or project data`,async()=>{
  const r=await runtime(mode),config=structuredClone(r.original.settings.teamSync);
  assert.equal(r.calls.servers,0);assert.equal(r.calls.starts,0);assert.equal(r.calls.clients,0);assert.equal(r.calls.reads,0);
  assert.deepEqual(r.backend.store,r.original);
  const status=r.invoke('team-sync-status');assert.equal(status.mode,'off');assert.equal(status.disabled,true);
  for(const field of ['token','hostToken','url','addresses'])assert.equal(Object.hasOwn(status,field),false);
  assert.equal(r.invoke('team-directory').syncMode,'local');
  const created=r.invoke('team-create-project',{name:`本机隔离 ${mode}`});
  assert.notEqual(created.project.id,r.original.settings.currentProjectId);
  assert.equal(r.backend.bootstrap().messages.length,0);assert.equal(r.backend.bootstrap().tasks.length,0);assert.equal(r.backend.bootstrap().cases.length,0);
  assert.deepEqual(r.backend.bootstrap(r.original.settings.currentProjectId).messages,r.original.messages);
  r.invoke('team-switch-project',{projectId:r.original.settings.currentProjectId});
  assert.equal(r.backend.store.settings.currentMemberId,r.original.settings.currentMemberId);
  assert.deepEqual(r.backend.store.settings.teamSync,config);
  for(const [name,payload] of [['start-team-server',{lan:true}],['connect-team-server',{url:'http://fixture.invalid',token:'fixture'}],['team-sync-now',undefined]])await assert.rejects(()=>r.invoke(name,payload),e=>e.code==='LEGACY_TEAM_SYNC_DISABLED');
  const disconnected=await r.invoke('disconnect-team-sync');assert.equal(disconnected.disabled,true);
  assert.deepEqual(r.backend.store.settings.teamSync,config);assert.equal(r.calls.starts,0);assert.equal(r.calls.clients,0);assert.equal(r.calls.reads,0);
  const persisted=new LocalBackend({dataDir:path.join(r.root,'data')});assert.deepEqual(persisted.store.settings.teamSync,config);
});

for(const mode of ['host','client'])test(`explicit legacy ${mode} keeps the active connection project guard`,async()=>{
  const r=await runtime(mode,{AIDESIGNHUB_LEGACY_TEAM_SYNC:'1'});
  assert.equal(r.invoke('team-directory').syncMode,mode);
  assert.equal(mode==='host'?r.calls.starts:r.calls.reads,1);
  const before=JSON.stringify(r.backend.store);
  assert.throws(()=>r.invoke('team-create-project',{name:'must-not-create'}),/断开同步/);
  assert.throws(()=>r.invoke('team-switch-project',{projectId:r.backend.store.settings.currentProjectId}),/断开同步/);
  assert.equal(JSON.stringify(r.backend.store),before);
  if(mode==='client')assert.throws(()=>r.invoke('team-set-role',{projectId:r.backend.store.settings.currentProjectId,memberId:'member_designer',role:'pm',expectedRole:'designer'}),/项目主机/);
  await r.invoke('disconnect-team-sync');assert.equal(r.invoke('team-directory').syncMode,'local');
  assert.equal(r.invoke('team-create-project',{name:'legacy 已手动断开'}).project.name,'legacy 已手动断开');
});

test('historical smoke can explicitly exercise legacy sync without enabling it for ordinary launches',async()=>{
  const r=await runtime('host',{BYCJ_WORKBENCH_SMOKE:'1'});assert.equal(r.calls.starts,1);assert.equal(r.invoke('team-directory').syncMode,'host');
  const off=await runtime('client',{AIDESIGNHUB_LEGACY_TEAM_SYNC:'true',BYCJ_WORKBENCH_SMOKE:'0'});assert.equal(off.calls.clients,0);assert.equal(off.invoke('team-directory').syncMode,'local');
});

test('directory runtime mode rejects an actual client even when persisted mode says off',()=>{
  const backend=new LocalBackend({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-sync-directory-'))});
  backend.setTeamSyncConfig({mode:'off'});
  const team=new TeamDirectory({backend,syncMode:()=> 'client'});
  assert.equal(team.snapshot().syncMode,'client');assert.throws(()=>team.createProject({name:'denied'}),e=>e.code==='LOCAL_WRITE_ONLY');
  assert.throws(()=>new TeamDirectory({backend,syncMode:'local'}),/must be a function/);
});

test('device-scoped model saving is allowed while the legacy project client is connected',async()=>{
  const r=await runtime('client',{AIDESIGNHUB_LEGACY_TEAM_SYNC:'1'});const before=JSON.stringify(r.backend.store);
  assert.equal(r.invoke('team-directory').syncMode,'client');
  const saved=await r.invoke('project-model-save',{provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'synthetic',apiKey:'synthetic-model-test-key'});
  assert.equal(saved.configured,true);assert.equal(r.calls.modelSaves,1);assert.equal(JSON.stringify(r.backend.store),before);
  assert.throws(()=>r.invoke('project-prepare',{text:'must not write project'}),/项目主机/);
});

test('demo plus smoke without an explicit data root stays under the smoke directory',async()=>{
  const r=await runtime('off',{AIDESIGNHUB_DATA_DIR:undefined,AIDESIGNHUB_DEMO_COMPANY:'1',BYCJ_WORKBENCH_SMOKE:'1'});
  const expected=path.join(r.root,'.smoke-data','demo-company-v1');
  assert.equal(r.backend.dataDir,expected);assert.deepEqual(r.calls.demoDataDirs,[expected]);assert.equal(r.calls.deviceInput.backendDataDir,expected);
  assert.equal(r.calls.deviceInput.smoke,true);assert.equal(r.calls.modelDataDir,path.join(expected,'device-settings-v1'));
  assert.equal(fs.existsSync(path.join(r.root,'demo-company-v1')),false);assert.equal(fs.existsSync(path.join(r.root,'design-workbench-v1')),false);
  const original=new LocalBackend({dataDir:path.join(r.root,'data')});assert.deepEqual(original.store,r.original);
});

test('demo plus smoke honors an explicit isolated data root without accessing normal user data',async()=>{
  const r=await runtime('off',{AIDESIGNHUB_DEMO_COMPANY:'1',BYCJ_WORKBENCH_SMOKE:'1'});const expected=path.join(r.root,'data','demo-company-v1');
  assert.equal(r.backend.dataDir,expected);assert.deepEqual(r.calls.demoDataDirs,[expected]);assert.equal(r.calls.deviceInput.backendDataDir,expected);
  assert.equal(fs.existsSync(path.join(r.root,'demo-company-v1')),false);
});

test('application shutdown stops automatic pairing before agent cleanup and service-lock release',async()=>{
  const r=await runtime('off');r.emitApp('before-quit');assert.deepEqual(r.calls.shutdownOrder,['pairing','agent-hub','service-lock']);
});
