'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {ProjectHub}=require('../backend/project-hub.cjs');
const PID='project_jiangwan';
const actions=[{type:'task.create',data:{title:'待负责人审批的隔离测试任务'}}];

function fixture(t,model=null){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-approval-'));
  const backend=new LocalBackend({dataDir}),hub=new ProjectHub({backend,model});
  t.after(()=>{
    hub.dispose();
    assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('aidesignhub-approval-'));
    fs.rmSync(dataDir,{recursive:true,force:true});
  });
  return {backend,hub,dataDir};
}
function prepare(hub){return hub.prepare({projectId:PID,text:'员工提交原始意见，仍待负责人审批。'});}
function deniedWithoutWrites(fixture,call,code='PROJECT_APPROVAL_DENIED'){
  const {backend,dataDir,hub}=fixture,before=JSON.stringify(backend.store),disk=fs.readFileSync(path.join(dataDir,'store.json'));
  let changed=0;const listener=()=>changed++;hub.on('changed',listener);
  try{
    assert.throws(call,error=>error.code===code);
    assert.equal(JSON.stringify(backend.store),before);
    assert.deepEqual(fs.readFileSync(path.join(dataDir,'store.json')),disk);
    assert.equal(changed,0);
  }finally{hub.off('changed',listener);}
}

test('ordinary active members may prepare but cannot approve, including a displayed leader role',async t=>{
  const f=fixture(t),{backend,hub}=f;
  for(const memberId of ['member_designer','member_director','member_reviewer','member_finance']){
    backend.setCurrentMember(memberId);backend.setRole('leader');
    const draft=await prepare(hub);
    assert.equal(draft.createdBy,memberId);assert.equal(draft.status,'pending');
    assert.deepEqual(hub.snapshot(PID).approval,{canApprove:false,reviewerIds:['member_pm'],policy:'project_manager_or_leader'});
    deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions,acknowledgeImportant:true}));
  }
});

test('only active actual project managers and leaders appear as approvers and can approve',async t=>{
  const {backend,hub}=fixture(t);
  backend.mutate(store=>{
    store.members.push(
      {id:'active-leader',projectId:PID,name:'实际负责人',role:'leader',active:true},
      {id:'inactive-pm',projectId:PID,name:'停用经理',role:'pm',active:false},
      {id:'inactive-leader',projectId:PID,name:'停用负责人',role:'leader',active:false},
      {id:'foreign-leader',projectId:'other',name:'其他项目负责人',role:'leader',active:true}
    );return true;
  });
  for(const memberId of ['member_pm','active-leader']){
    const draft=await prepare(hub);backend.setCurrentMember(memberId);backend.setRole('designer');
    assert.deepEqual(hub.snapshot(PID).approval,{canApprove:true,reviewerIds:['member_pm','active-leader'],policy:'project_manager_or_leader'});
    const receipt=hub.confirm({id:draft.id,actions});
    assert.equal(receipt.status,'confirmed');
    assert.equal(hub.snapshot(PID).drafts.find(d=>d.id===draft.id).confirmedBy,memberId);
  }
});

test('pending model suggestions remain outside formal context until a real project approver confirms',async t=>{
  const {backend,hub}=fixture(t,async()=>({summary:'候选建议，未审批',actions}));
  const before=hub.context(PID),draft=await hub.prepare({projectId:PID,text:'员工原话，不代表审批。',useModel:true});
  assert.equal(draft.status,'pending');assert.deepEqual(draft.actions,actions);
  assert.deepEqual(hub.context(PID),before);
  backend.setCurrentMember('member_pm');const receipt=hub.confirm({id:draft.id,actions:draft.actions});
  assert.ok(hub.context(PID).tasks.some(task=>task.id===receipt.changes[0].entityId));
  assert.notEqual(hub.context(PID).revision,before.revision);
  const snapshot=hub.snapshot(PID),confirmed=snapshot.drafts.find(d=>d.id===draft.id),audit=snapshot.audits[0];
  assert.equal(confirmed.createdBy,'member_designer');assert.equal(confirmed.confirmedBy,'member_pm');
  assert.equal(audit.source.memberId,'member_designer');assert.equal(audit.actorId,'member_pm');assert.equal(audit.text,'员工原话，不代表审批。');
});

test('foreign project managers cannot confirm another project draft, with no state or disk changes',async t=>{
  const f=fixture(t),{backend,hub}=f,draft=await prepare(hub);
  backend.mutate(store=>{
    store.projects.push({id:'other',name:'其他项目',stage:'intake'});
    store.members.push({id:'foreign-pm',projectId:'other',name:'其他经理',role:'pm',active:true});
    store.settings.currentMemberId='foreign-pm';return true;
  });
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}),'PROJECT_ACCESS_DENIED');
  backend.mutate(store=>{store.settings.currentProjectId='other';return true;});
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}),'PROJECT_ACCESS_DENIED');
});

test('an inactive or downgraded approver is denied before changing pending draft or business records',async t=>{
  const f=fixture(t),{backend,hub}=f,draft=await prepare(hub);backend.setCurrentMember('member_pm');
  backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').active=false;return true;});
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}),'PROJECT_ACCESS_DENIED');
  backend.mutate(store=>{Object.assign(store.members.find(m=>m.id==='member_pm'),{active:true,role:'designer'});return true;});
  assert.equal(backend.store.settings.currentRole,'pm');
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}));
});

test('identical confirmation receipt replays still require current active approver identity',async t=>{
  const f=fixture(t),{backend,hub}=f,draft=await prepare(hub);backend.setCurrentMember('member_pm');
  const first=hub.confirm({id:draft.id,actions});backend.setCurrentMember('member_designer');backend.setRole('leader');
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}));
  backend.setCurrentMember('member_pm');
  backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').active=false;return true;});
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}),'PROJECT_ACCESS_DENIED');
  backend.mutate(store=>{Object.assign(store.members.find(m=>m.id==='member_pm'),{active:true,role:'designer'});return true;});
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}));
  backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').role='pm';return true;});
  const again=hub.confirm({id:draft.id,actions});
  assert.equal(again.duplicate,true);assert.equal(again.auditId,first.auditId);assert.equal(hub.snapshot(PID).audits.length,1);
});

test('approval role is checked again inside the atomic transaction',async t=>{
  const f=fixture(t),{backend,hub}=f,draft=await prepare(hub);backend.setCurrentMember('member_pm');
  const mutate=backend.mutate;
  backend.mutate=function(callback){return mutate.call(this,store=>{store.members.find(m=>m.id==='member_pm').role='designer';return callback(store);});};
  try{deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}));}finally{backend.mutate=mutate;}
});

test('a project without eligible reviewers does not auto-promote its submitter',async t=>{
  const f=fixture(t),{backend,hub}=f;
  backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').active=false;return true;});
  const draft=await prepare(hub);
  assert.deepEqual(hub.snapshot(PID).approval,{canApprove:false,reviewerIds:[],policy:'project_manager_or_leader'});
  deniedWithoutWrites(f,()=>hub.confirm({id:draft.id,actions}));
});
