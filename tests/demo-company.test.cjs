'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {ProjectHub}=require('../backend/project-hub.cjs');
const {TeamDirectory,ROLES}=require('../backend/team-directory.cjs');
const {createDemoCompanyStore,ensureDemoCompany}=require('../backend/demo-company.cjs');
const NOW=1791201600000;
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-demo-company-test-'));
  const backend=new LocalBackend({dataDir});
  t.after(()=>{assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('aidesignhub-demo-company-test-'));fs.rmSync(dataDir,{recursive:true,force:true});});
  return {backend,dataDir};
}
function assertReferences(store){
  const projects=new Set(store.projects.map(p=>p.id));
  for(const key of ['members','channels','messages','decisions','tasks','risks','cases','contractMilestones','scopeChanges','knowledgeDocs','events']){
    const ids=new Set();
    for(const record of store[key]){
      assert.ok(projects.has(record.projectId),`${key} project scope`);
      assert.ok(!ids.has(record.id),`${key} unique ids`);ids.add(record.id);
      for(const field of ['ownerId','senderId'])if(record[field])assert.ok(store.members.some(m=>m.id===record[field]&&m.projectId===record.projectId&&m.active!==false),`${key}.${field} belongs to project`);
      if(record.channelId)assert.ok(store.channels.some(c=>c.id===record.channelId&&c.projectId===record.projectId),`${key} channel scope`);
      for(const id of record.sourceMessageIds||[])assert.ok(store.messages.some(m=>m.id===id&&m.projectId===record.projectId),`${key} message scope`);
    }
  }
}

test('pure deterministic company factory has exactly three projects, eight people and no real integrations',()=>{
  const a=createDemoCompanyStore({now:NOW}),b=createDemoCompanyStore({now:NOW});
  assert.deepEqual(a,b);assert.equal(a.projects.length,3);assert.equal(new Set(a.members.map(m=>m.personId)).size,8);
  assert.deepEqual(a.projects.map(p=>p.stage),['concept','develop','research']);assert.equal(new Set(a.members.map(m=>m.title)).size,8);
  assert.equal(new Set(a.members.map(m=>m.role)).size,6);assert.ok(a.members.every(m=>Object.hasOwn(ROLES,m.role)&&m.skills.length));
  assert.ok(a.projects.every(p=>p.isDemo&&p.folderPath===null&&!Object.hasOwn(p,'progress')));
  assert.ok(a.members.every(m=>a.tasks.some(t=>t.ownerId===m.id&&t.projectId===m.projectId)));
  assert.equal(a.settings.currentRole,'designer');assert.equal(a.demoCompany.initialized,false);
  assert.deepEqual(a.projectHub.audits,[]);assert.deepEqual(a.projectHub.notifications,[]);assert.deepEqual(a.connectorSettings,[]);assert.deepEqual(a.knowledgeDocs,[]);
  assert.ok(!/https?:\/\/|apiKey|hostToken|storedPath|originalPath|accessToken/.test(JSON.stringify(a)));
  assertReferences(a);a.members[0].skills.push('changed');assert.ok(!b.members[0].skills.includes('changed'));
});

test('explicit fresh prototype installation creates actual pending drafts without fabricated approval history',async t=>{
  const {backend}=fixture(t);const result=await ensureDemoCompany(backend,{fresh:true,now:NOW});
  assert.equal(result.initialized,true);assert.equal(result.projectCount,3);assert.equal(result.personCount,8);
  const store=backend.store;assert.equal(store.demoCompany.initialized,true);assert.equal(store.projectHub.drafts.length,3);
  assert.equal(store.projectHub.audits.length,0);assert.equal(store.projectHub.notifications.length,0);assertReferences(store);
  for(const draft of store.projectHub.drafts){
    assert.equal(draft.status,'pending');assert.equal(draft.modelStatus,'not_requested');assert.equal(draft.confirmedBy,undefined);assert.equal(draft.receipt,undefined);
    assert.ok(draft.base&&draft.contextRevision);assert.ok(draft.text.includes('未审批'));
    assert.ok(store.members.some(m=>m.projectId===draft.projectId&&m.id===draft.createdBy&&m.role==='designer'));
    assert.equal(draft.source.memberId,draft.createdBy);
    for(const action of draft.actions)if(action.data.ownerId)assert.ok(store.members.some(m=>m.id===action.data.ownerId&&m.projectId===draft.projectId));
  }
  const directory=new TeamDirectory({backend,clock:()=>NOW,syncMode:()=> 'local'}).snapshot();
  assert.equal(directory.projects.length,3);assert.equal(directory.people.length,8);assert.ok(directory.people.every(p=>p.workload.total>0&&p.memberships.length===3));
  assert.equal(directory.people.reduce((sum,p)=>sum+p.workload.total,0),store.tasks.length);
});

test('all eight identities can be selected through existing project membership APIs without changing roles',async t=>{
  const {backend}=fixture(t);await ensureDemoCompany(backend,{fresh:true,now:NOW});
  const team=new TeamDirectory({backend,clock:()=>NOW}),roles=new Map(backend.store.members.map(m=>[m.id,m.role]));
  for(const member of [...backend.store.members]){
    const switched=team.switchProject({projectId:member.projectId,memberId:member.id});
    assert.equal(switched.settings.currentMemberId,member.id);assert.equal(switched.settings.currentRole,member.role);
    assert.equal(team.snapshot().currentProjectCanManage,['pm','leader'].includes(member.role));
  }
  for(const member of backend.store.members)assert.equal(member.role,roles.get(member.id));
});

test('each demo project has a truly approvable candidate and pending candidates stay outside context',async t=>{
  const {backend}=fixture(t);await ensureDemoCompany(backend,{fresh:true,now:NOW});
  const team=new TeamDirectory({backend,clock:()=>NOW}),hub=new ProjectHub({backend,clock:()=>NOW+1});t.after(()=>hub.dispose());
  for(const draft of [...backend.store.projectHub.drafts]){
    team.switchProject({projectId:draft.projectId,memberId:draft.createdBy});
    assert.equal(hub.snapshot(draft.projectId).approval.canApprove,false);
    const candidateTitle=draft.actions[0].data.title;assert.ok(!hub.context(draft.projectId).tasks.some(task=>task.title===candidateTitle));
    assert.throws(()=>hub.confirm({id:draft.id,actions:draft.actions,acknowledgeImportant:true}),e=>e.code==='PROJECT_APPROVAL_DENIED');
    const approver=backend.store.members.find(m=>m.projectId===draft.projectId&&m.role==='pm');backend.setCurrentMember(approver.id);
    const receipt=hub.confirm({id:draft.id,actions:draft.actions,acknowledgeImportant:true});
    assert.equal(receipt.status,'confirmed');assert.ok(hub.context(draft.projectId).tasks.some(task=>task.title===candidateTitle));
    assert.ok(hub.context(draft.projectId).tasks.every(task=>backend.store.tasks.find(t=>t.id===task.id).projectId===draft.projectId));
    assert.equal(backend.store.projectHub.drafts.find(d=>d.id===draft.id).confirmedBy,approver.id);
  }
  assert.equal(backend.store.projectHub.audits.length,3);
});

test('repeated initialization preserves demo user edits and performs no further writes',async t=>{
  const {backend,dataDir}=fixture(t);await ensureDemoCompany(backend,{fresh:true,now:NOW});
  backend.mutate(store=>{store.tasks[0].title='用户在演示库中新写的任务';store.projects[0].focus='用户练习内容';return true;});
  const before=copy(backend.store),disk=fs.readFileSync(path.join(dataDir,'store.json'));let writes=0;const mutate=backend.mutate;backend.mutate=()=>{writes++;throw new Error('must not write');};
  try{const result=await ensureDemoCompany(backend,{fresh:true,now:NOW+86400000});assert.equal(result.initialized,false);assert.equal(result.existing,true);}finally{backend.mutate=mutate;}
  assert.equal(writes,0);assert.deepEqual(backend.store,before);assert.deepEqual(fs.readFileSync(path.join(dataDir,'store.json')),disk);
});

test('unmarked databases require fresh opt-in, and modified/real records are refused even with it',async t=>{
  const {backend,dataDir}=fixture(t),pristine=copy(backend.store);
  await assert.rejects(ensureDemoCompany(backend,{now:NOW}),e=>e.code==='DEMO_FRESH_REQUIRED');assert.deepEqual(backend.store,pristine);
  for(const change of [store=>{store.projects[0].name='真实公司项目';},store=>{store.tasks[0].dueAt+=86400000;},store=>{store.settings.teamSync={mode:'client',token:'not-a-real-secret'};},store=>{store.projectHub={version:1,drafts:[{text:'真实原文'}],audits:[],notifications:[]};},store=>{store.projects.push({id:'real-project',name:'真实项目'});}]){
    backend.mutate(store=>{for(const key of Object.keys(store))delete store[key];Object.assign(store,copy(pristine));change(store);return true;});
    const before=copy(backend.store),disk=fs.readFileSync(path.join(dataDir,'store.json'));
    await assert.rejects(ensureDemoCompany(backend,{fresh:true,now:NOW}),e=>e.code==='DEMO_DATA_EXISTS');
    assert.deepEqual(backend.store,before);assert.deepEqual(fs.readFileSync(path.join(dataDir,'store.json')),disk);
  }
});

test('a pure marked template can be finalized once but a modified template is never overwritten',async t=>{
  const {backend}=fixture(t);backend.mutate(store=>{for(const key of Object.keys(store))delete store[key];Object.assign(store,createDemoCompanyStore({now:NOW}));return true;});
  const template=copy(backend.store);backend.mutate(store=>{store.tasks[0].title='保留这次修改';return true;});
  const modified=copy(backend.store);await assert.rejects(ensureDemoCompany(backend),e=>e.code==='DEMO_DATA_EXISTS');assert.deepEqual(backend.store,modified);
  backend.mutate(store=>{for(const key of Object.keys(store))delete store[key];Object.assign(store,template);return true;});
  assert.equal((await ensureDemoCompany(backend)).initialized,true);assert.equal(backend.store.projectHub.drafts.length,3);
});

test('unknown demo markers and invalid times fail without overwriting the store',async t=>{
  const {backend}=fixture(t);backend.mutate(store=>{store.demoCompany={id:'someone-else',version:1,initialized:true};return true;});
  const before=copy(backend.store);await assert.rejects(ensureDemoCompany(backend,{fresh:true,now:NOW}),e=>e.code==='DEMO_MARKER_MISMATCH');assert.deepEqual(backend.store,before);
  for(const now of [-1,NaN,Infinity,'tomorrow'])assert.throws(()=>createDemoCompanyStore({now}),e=>e.code==='DEMO_INVALID_TIME');
});

test('initialization is atomic on disk failure and does not overwrite a concurrent edit',async t=>{
  const {backend,dataDir}=fixture(t),before=copy(backend.store),disk=fs.readFileSync(path.join(dataDir,'store.json'));
  const persist=backend.persist;backend.persist=()=>{throw new Error('synthetic disk failure');};
  try{await assert.rejects(ensureDemoCompany(backend,{fresh:true,now:NOW}),/disk failure/);}finally{backend.persist=persist;}
  assert.deepEqual(backend.store,before);assert.deepEqual(fs.readFileSync(path.join(dataDir,'store.json')),disk);
  const pending=ensureDemoCompany(backend,{fresh:true,now:NOW});backend.mutate(store=>{store.projects[0].focus='初始化期间的真实并发修改';return true;});
  await assert.rejects(pending,e=>e.code==='DEMO_STORE_CHANGED');assert.equal(backend.store.projects.length,1);assert.equal(backend.store.projects[0].focus,'初始化期间的真实并发修改');assert.equal(backend.store.demoCompany,undefined);
});
