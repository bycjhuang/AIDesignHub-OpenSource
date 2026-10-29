'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');

const PID='project_jiangwan';
const OTHER='project_sync_isolation_other';
const COLLECTIONS=['members','channels','messages','decisions','tasks','risks','cases','contractMilestones','scopeChanges','events'];
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-project-isolation-'));
  t.after(()=>{assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('aidesignhub-project-isolation-'));fs.rmSync(dataDir,{recursive:true,force:true});});
  const backend=new LocalBackend({dataDir});
  backend.mutate(store=>{
    store.projects.push({id:OTHER,name:'隔离测试的另一个项目',stage:'research',folderPath:null});
    for(const collection of COLLECTIONS){const seed=store[collection].find(item=>item.projectId===PID);store[collection].push({...copy(seed),id:`other_${collection}`,projectId:OTHER,marker:`keep_${collection}`});}
    store.tasks.push({id:'managed_local',projectId:PID,title:'本地Agent任务',status:'submitted',agentJobId:'job_current',evidence:'preserve review state'});
    store.tasks.push({id:'managed_other',projectId:OTHER,title:'另一个项目Agent任务',status:'doing',agentJobId:'job_other'});
    return true;
  });
  return {backend,dataDir};
}
function remote(backend,pid=PID){return {project:{id:pid,name:'远端更新后的项目',stage:'develop'},...Object.fromEntries(COLLECTIONS.map(key=>[key,backend.store[key].filter(item=>item.projectId===pid&&!item.agentJobId).map(item=>({...copy(item),remoteMarker:`updated_${key}`}))]))};}
function exactState(backend){return {memory:copy(backend.store),disk:fs.readFileSync(backend.dbPath,'utf8')};}
function assertUnchanged(backend,before){assert.deepEqual(backend.store,before.memory);assert.equal(fs.readFileSync(backend.dbPath,'utf8'),before.disk);}

test('remote merge replaces only its project records while every other project collection remains intact',t=>{
  const {backend}=fixture(t),before=exactState(backend),snapshot=remote(backend);
  const result=backend.mergeRemoteSnapshot(snapshot);
  assert.equal(result.project.id,PID);assert.equal(result.project.name,snapshot.project.name);
  for(const key of COLLECTIONS){
    assert.deepEqual(backend.store[key].filter(item=>item.projectId===OTHER),before.memory[key].filter(item=>item.projectId===OTHER),`${key} must preserve other project`);
    if(key==='cases')continue;
    assert.ok(backend.store[key].filter(item=>item.projectId===PID&&!item.agentJobId).every(item=>item.remoteMarker===`updated_${key}`),`${key} accepts current-project remote update`);
  }
  assert.deepEqual(backend.store.cases.filter(item=>item.projectId===PID),before.memory.cases.filter(item=>item.projectId===PID),'personal cases survive a snapshot without team scope');
  const teamSnapshot=remote(backend);teamSnapshot.cases=teamSnapshot.cases.map(item=>({...item,scope:'team'}));
  backend.mergeRemoteSnapshot(teamSnapshot);
  assert.ok(backend.store.cases.filter(item=>item.projectId===PID&&item.scope==='team').every(item=>item.remoteMarker==='updated_cases'),'team cases accept current-project remote update');
  assert.ok(backend.store.cases.some(item=>item.projectId===PID&&item.scope==='local'),'personal cases still survive after team merge');
  assert.deepEqual(backend.store.settings,before.memory.settings);
  assert.deepEqual(backend.store.projects.find(item=>item.id===OTHER),before.memory.projects.find(item=>item.id===OTHER));
  assert.deepEqual(JSON.parse(fs.readFileSync(backend.dbPath,'utf8')),backend.store);
});

test('current-project Agent-managed tasks survive absent or conflicting remote task entries',t=>{
  const {backend}=fixture(t),managed=copy(backend.store.tasks.find(item=>item.id==='managed_local'));
  const snapshot=remote(backend);snapshot.tasks.push({id:'managed_local',projectId:PID,title:'远端不得覆盖',status:'done',agentJobId:'forged-job'});
  backend.mergeRemoteSnapshot(snapshot);
  assert.deepEqual(backend.store.tasks.filter(item=>item.id==='managed_local'),[managed]);
  backend.mergeRemoteSnapshot({...remote(backend),tasks:[]});
  assert.deepEqual(backend.store.tasks.filter(item=>item.projectId===PID),[managed]);
  assert.ok(backend.store.tasks.some(item=>item.id==='managed_other'&&item.projectId===OTHER));
});

test('partial snapshot leaves omitted collections untouched and an empty collection removes only matching project',t=>{
  const {backend}=fixture(t),before=exactState(backend);
  backend.mergeRemoteSnapshot({project:{id:PID,name:'仅更新项目和案例'},cases:[]});
  assert.deepEqual(backend.store.cases,before.memory.cases,'empty cases snapshot only clears team-scope cases, personal ones survive');
  for(const key of COLLECTIONS.filter(key=>key!=='cases'))assert.deepEqual(backend.store[key],before.memory[key]);
  const teamSnapshot=remote(backend);teamSnapshot.cases=teamSnapshot.cases.map(item=>({...item,scope:'team'}));
  backend.mergeRemoteSnapshot(teamSnapshot);
  backend.mergeRemoteSnapshot({project:{id:PID,name:'清空团队案例'},cases:[]});
  assert.ok(!backend.store.cases.some(item=>item.projectId===PID&&item.scope==='team'),'team cases removed by empty snapshot');
  assert.ok(backend.store.cases.some(item=>item.projectId===PID&&item.scope==='local'),'personal cases kept after team clear');
});

test('foreign project records in each supported collection reject the entire merge atomically',t=>{
  const {backend}=fixture(t);
  for(const key of COLLECTIONS.filter(key=>key!=='cases')){
    const before=exactState(backend),snapshot=remote(backend);
    snapshot[key].push({id:`foreign_${key}`,projectId:OTHER});
    assert.throws(()=>backend.mergeRemoteSnapshot(snapshot),/foreign project record/);
    assertUnchanged(backend,before);
  }
  const before=exactState(backend),snapshot=remote(backend);
  snapshot.cases.push({id:'foreign_cases',projectId:OTHER,scope:'team'});
  backend.mergeRemoteSnapshot(snapshot);
  assert.ok(!backend.store.cases.some(item=>item.id==='foreign_cases'),'foreign case records are never persisted');
  assert.deepEqual(backend.store.cases.filter(item=>item.projectId===PID),before.memory.cases.filter(item=>item.projectId===PID));
});

test('cross-project same-id collisions in every collection reject with in-memory and disk rollback',t=>{
  const {backend}=fixture(t);
  for(const key of COLLECTIONS.filter(key=>key!=='cases')){
    const before=exactState(backend),snapshot=remote(backend);
    snapshot[key].push({id:`other_${key}`,projectId:PID});
    assert.throws(()=>backend.mergeRemoteSnapshot(snapshot),/identity collides/);
    assertUnchanged(backend,before);
  }
  const before=exactState(backend),snapshot=remote(backend);
  snapshot.cases.push({id:'other_cases',projectId:PID,scope:'team'});
  assert.throws(()=>backend.mergeRemoteSnapshot(snapshot),/identity collides/);
  assertUnchanged(backend,before);
});

test('missing project and malformed foreign entries cannot partially persist preceding collections',t=>{
  const {backend}=fixture(t);
  for(const snapshot of [null,{}, {project:{}}, {project:{id:''}},{...remote(backend),events:[null]},{...remote(backend),events:[{id:'no-project'}]}]){
    const before=exactState(backend);assert.throws(()=>backend.mergeRemoteSnapshot(snapshot));assertUnchanged(backend,before);
  }
});

test('importing a new project preserves established projects and does not silently switch current identity',t=>{
  const {backend}=fixture(t),before=exactState(backend);
  const pid='new_remote_project';
  const snapshot={project:{id:pid,name:'新远端项目',stage:'intake'},...Object.fromEntries(COLLECTIONS.map(key=>[key,[]]))};
  snapshot.members=[{id:'new_remote_member',projectId:pid,name:'新成员',role:'designer',active:true}];
  backend.mergeRemoteSnapshot(snapshot);
  assert.deepEqual(backend.store.settings,before.memory.settings);
  assert.ok(backend.store.projects.some(item=>item.id===pid));
  for(const key of COLLECTIONS)assert.deepEqual(backend.store[key].filter(item=>item.projectId!==pid),before.memory[key]);
});

test('setCurrentMember rejects inactive and foreign-project identities without touching settings or disk',t=>{
  const {backend}=fixture(t);backend.mutate(store=>{store.members.push({id:'inactive_local',projectId:PID,name:'停用成员',role:'leader',active:false});return true;});
  for(const id of ['inactive_local','other_members','unknown-member']){
    const before=exactState(backend);assert.throws(()=>backend.setCurrentMember(id),/member not found/);assertUnchanged(backend,before);
  }
  const result=backend.setCurrentMember('member_pm');assert.equal(result.currentMemberId,'member_pm');assert.equal(result.currentRole,'pm');
});
