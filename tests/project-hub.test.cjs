'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {ProjectHub}=require('../backend/project-hub.cjs');
const PID='project_jiangwan';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(model){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-project-'));const backend=new LocalBackend({dataDir});const hub=new ProjectHub({backend,model});return {hub,backend,dataDir};}
function prepare(hub,extra={}){return hub.prepare({projectId:PID,text:'今天完成总图，明天复核消防；请记录问题。',...extra});}
const task=()=>({type:'task.create',data:{title:'复核消防转弯',ownerId:'member_reviewer',priority:'high'}});

test('prepare stores the exact original note but never calls a model or changes business state by default',async()=>{
  let calls=0;const {hub,backend}=fixture(async()=>{calls++;return {summary:'test',actions:[task()]};}),before=backend.store.tasks.length;
  const raw='  口述原文\n保持换行与空格  ',draft=await prepare(hub,{text:raw});assert.equal(draft.text,raw);assert.equal(draft.status,'pending');assert.equal(draft.modelStatus,'not_requested');assert.deepEqual(draft.actions,[]);assert.equal(calls,0);assert.equal(backend.store.tasks.length,before);assert.equal(hub.snapshot(PID).drafts[0].text,raw);assert.equal(hub.snapshot(PID).drafts[0].base,undefined);hub.dispose();
});
test('explicit model draft remains a proposal until the human confirms, with private business context excluded',async()=>{
  let input;const {hub,backend}=fixture(async value=>{input=value;return {summary:'待人工确认',actions:[task()]};}),before=backend.store.tasks.length;
  const draft=await prepare(hub,{useModel:true});assert.equal(draft.modelStatus,'succeeded');assert.equal(draft.status,'pending');assert.equal(draft.actions.length,1);assert.equal(backend.store.tasks.length,before);assert.equal(input.projectId,PID);assert.equal(input.context.project.stage,'concept');assert(!JSON.stringify(input.context).includes('请款'));assert(!('folderPath'in input.context.project));assert(!('contractMilestones'in input.context));hub.dispose();
});
test('missing model and provider failure preserve raw editable drafts without leaking credentials or mutating tasks',async()=>{
  for(const model of [null,async()=>{throw new Error('SECRET_BEARER_TOKEN');},async()=>({summary:'bad',actions:[{type:'shell.exec',data:{title:'rm'}}]})]){
    const {hub,backend}=fixture(model),before=backend.store.tasks.length;const draft=await prepare(hub,{useModel:true});assert.equal(draft.status,'pending');assert(['unconfigured','failed'].includes(draft.modelStatus));assert(draft.error);assert(!JSON.stringify(draft).includes('SECRET_BEARER'));assert.deepEqual(draft.actions,[]);assert.equal(backend.store.tasks.length,before);hub.dispose();
  }
});
test('one confirmation atomically writes tasks risks decisions stage focus audit and local-only notices',async()=>{
  const {hub,backend}=fixture(),draft=await prepare(hub);const actions=[task(),{type:'risk.create',data:{title:'面积口径待确认',description:'等待专业负责人核对',severity:'high'}},{type:'decision.create',data:{title:'入口方向',summary:'采用广场界面',status:'confirmed'}},{type:'project.update',data:{stage:'develop',stageRound:1,focus:'先完成图模一致'}}];
  backend.setCurrentMember('member_pm');
  assert.throws(()=>hub.confirm({id:draft.id,actions}),error=>error.code==='IMPORTANT_CONFIRMATION_REQUIRED');
  const before=backend.store.messages.length,result=hub.confirm({id:draft.id,actions,notifyMemberIds:['member_pm'],acknowledgeImportant:true});
  assert.equal(result.status,'confirmed');assert.equal(result.changes.length,4);assert.equal(result.duplicate,false);const project=backend.store.projects.find(p=>p.id===PID);assert.equal(project.stage,'develop');assert.equal(project.stageRound,1);assert.equal(project.focus,'先完成图模一致');assert.equal(project.progress,69);
  const snapshot=hub.snapshot(PID);assert.equal(snapshot.audits.length,1);assert.equal(snapshot.audits[0].text,draft.text);assert.equal(snapshot.audits[0].actorId,'member_pm');assert.equal(snapshot.audits[0].source.memberId,'member_designer');assert.equal(snapshot.notifications.length,1);assert.equal(snapshot.notifications[0].status,'local_pending');assert.equal(backend.store.messages.length,before);assert.equal(snapshot.drafts[0].createdBy,'member_designer');assert.equal(snapshot.drafts[0].confirmedBy,'member_pm');assert.equal(result.changes.at(-1).before.stage,'concept');assert.equal(result.changes.at(-1).after.stage,'develop');hub.dispose();
});
test('confirm is idempotent and rejects a changed payload on the same confirmed draft',async()=>{
  const {hub,backend}=fixture(),draft=await prepare(hub),actions=[task()];backend.setCurrentMember('member_pm');const first=hub.confirm({id:draft.id,actions,notifyMemberIds:['member_pm']});const count=backend.store.tasks.length;const duplicate=hub.confirm({id:draft.id,actions,notifyMemberIds:['member_pm']});assert.equal(duplicate.auditId,first.auditId);assert.equal(duplicate.duplicate,true);assert.equal(backend.store.tasks.length,count);assert.equal(hub.snapshot(PID).notifications.length,1);assert.throws(()=>hub.confirm({id:draft.id,actions:[{...task(),data:{title:'不同内容'}}]}),error=>error.code==='CONFIRMATION_CONFLICT');hub.dispose();
});
test('confirmation retry returns the immutable receipt even after its target is removed or recipient deactivated',async()=>{
  const {hub,backend}=fixture(),draft=await prepare(hub),actions=[{type:'task.update',id:'task_1',data:{title:'人工确认标题'}}];backend.setCurrentMember('member_pm');const first=hub.confirm({id:draft.id,actions,notifyMemberIds:['member_reviewer']});
  backend.mutate(store=>{store.tasks=store.tasks.filter(t=>t.id!=='task_1');store.members.find(m=>m.id==='member_reviewer').active=false;return true;});const again=hub.confirm({id:draft.id,actions,notifyMemberIds:['member_reviewer']});assert.equal(again.duplicate,true);assert.equal(again.auditId,first.auditId);assert.equal(hub.snapshot(PID).audits.length,1);hub.dispose();
});
test('invalid last action or persistence failure leaves every collection and draft unchanged',async()=>{
  const {hub,backend,dataDir}=fixture(),draft=await prepare(hub);backend.setCurrentMember('member_pm');const before=JSON.stringify(backend.store),disk=fs.readFileSync(path.join(dataDir,'store.json'),'utf8');
  assert.throws(()=>hub.confirm({id:draft.id,actions:[task(),{type:'risk.create',data:{title:'风险',ownerId:'other-project-member'}}]}),/本项目/);assert.equal(JSON.stringify(backend.store),before);
  const persist=backend.persist;backend.persist=()=>{throw new Error('synthetic disk full');};assert.throws(()=>hub.confirm({id:draft.id,actions:[task()]}),/disk full/);backend.persist=persist;assert.equal(JSON.stringify(backend.store),before);assert.equal(fs.readFileSync(path.join(dataDir,'store.json'),'utf8'),disk);hub.dispose();
});
test('current active project membership is authoritative and caller cannot forge another project or assignee',async()=>{
  const {hub,backend}=fixture();backend.mutate(store=>{store.projects.push({id:'other',name:'other',stage:'intake'});store.members.push({id:'foreign',projectId:'other',active:true,role:'pm'});return true;});
  for(const call of [()=>hub.snapshot('other'),()=>hub.context('other')])assert.throws(call,/跨项目/);await assert.rejects(()=>prepare(hub,{projectId:'other'}),/跨项目/);
  const draft=await prepare(hub);backend.setCurrentMember('member_pm');assert.throws(()=>hub.confirm({id:draft.id,actions:[task()],notifyMemberIds:['foreign']}),/本项目/);backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').active=false;return true;});assert.throws(()=>hub.confirm({id:draft.id,actions:[task()]}),/有效成员/);assert.throws(()=>hub.dismiss(draft.id),/有效成员/);hub.dispose();
});
test('stale updates reject the whole batch while unchanged records can be updated deliberately',async()=>{
  const {hub,backend}=fixture(),draft=await prepare(hub);backend.setCurrentMember('member_pm');const actions=[task(),{type:'task.update',id:'task_1',data:{title:'新标题'}}];backend.updateTask('task_1',{title:'其他人已经改过'});const before=backend.store.tasks.length;assert.throws(()=>hub.confirm({id:draft.id,actions}),error=>error.code==='STALE_DRAFT');assert.equal(backend.store.tasks.length,before);
  const second=await prepare(hub);hub.confirm({id:second.id,actions:[{type:'task.update',id:'task_1',data:{status:'done'}}],acknowledgeImportant:true});assert.equal(backend.store.tasks.find(t=>t.id==='task_1').status,'done');hub.dispose();
});
test('Agent-managed task completion cannot bypass its result review even with important-action acknowledgement',async()=>{
  const {hub,backend}=fixture();backend.mutate(store=>{store.tasks[0].agentJobId='agent_job';return true;});const draft=await prepare(hub);backend.setCurrentMember('member_pm');assert.throws(()=>hub.confirm({id:draft.id,actions:[{type:'task.update',id:'task_1',data:{status:'done'}}],acknowledgeImportant:true}),error=>error.code==='AGENT_REVIEW_REQUIRED');assert.equal(backend.store.tasks[0].status,'todo');hub.dispose();
});
test('dismissed or disposed pending model calls cannot reactivate a draft or change business state',async()=>{
  for(const disposition of ['dismiss','dispose']){
    let resolve;const {hub,backend}=fixture(()=>new Promise(done=>{resolve=done;}));const pending=prepare(hub,{useModel:true});await tick();const id=backend.store.projectHub.drafts[0].id;
    if(disposition==='dismiss')hub.dismiss(id);else hub.dispose();resolve({summary:'late',actions:[task()]});await pending;const draft=backend.store.projectHub.drafts[0];assert.equal(draft.status,disposition==='dismiss'?'dismissed':'pending');assert.equal(draft.actions.length,0);assert.equal(backend.store.tasks.length,5);hub.dispose();
  }
});
test('reopening after interrupted preparation restores an editable draft without rerunning the model',async()=>{
  const {hub,backend,dataDir}=fixture();const draft=await prepare(hub);backend.mutate(store=>{store.projectHub.drafts[0].status='preparing';return true;});hub.dispose();let calls=0;const reopened=new ProjectHub({backend:new LocalBackend({dataDir}),model:async()=>{calls++;}});const saved=reopened.snapshot(PID).drafts[0];assert.equal(saved.id,draft.id);assert.equal(saved.status,'pending');assert.equal(saved.modelStatus,'failed');assert.equal(calls,0);reopened.dispose();
});
test('context is bounded revisioned and excludes private records tentative decisions and closed risks',()=>{
  const {hub,backend}=fixture();backend.mutate(store=>{for(let i=0;i<30;i++)store.tasks.push({id:`extra${i}`,projectId:PID,title:'a'.repeat(1000),status:'todo'});store.tasks.push({id:'secret',projectId:PID,title:'secret thing',private:true});store.decisions.push({id:'unconfirmed',projectId:PID,title:'尚未确认',status:'proposed'});store.risks.push({id:'closed',projectId:PID,title:'已关闭',status:'closed'});return true;});const context=hub.context(PID);assert.equal(context.tasks.length,20);assert(context.tasks.every(t=>t.title.length<=300));assert(context.truncated.tasks>0);assert(!JSON.stringify(context).includes('secret thing'));assert(!context.decisions.some(d=>d.id==='unconfirmed'));assert(!context.risks.some(r=>r.id==='closed'));const same=hub.context(PID);assert.equal(context.revision,same.revision);backend.updateTask('extra29',{title:'changed'});assert.notEqual(hub.context(PID).revision,context.revision);hub.dispose();
});
test('strict size fields state enums and duplicate-target checks reject malformed management batches',async()=>{
  const {hub,backend}=fixture();await assert.rejects(()=>prepare(hub,{text:'x'.repeat(20001)}),/超限/);const draft=await prepare(hub);backend.setCurrentMember('member_pm');
  for(const actions of [[{type:'project.update',data:{progress:99}}],[{type:'task.create',data:{title:'bad',status:'approved'}}],[{type:'project.update',data:{stage:'invented'}}],[{type:'project.update',data:{stageRound:0}}],[{type:'task.update',id:'task_1',data:{status:'doing'}},{type:'task.update',id:'task_1',data:{title:'duplicate'}}],Array.from({length:31},task)])assert.throws(()=>hub.confirm({id:draft.id,actions,acknowledgeImportant:true}));hub.dispose();
});
test('human tasks support blocked submitted and changes-requested states and superseded decisions leave current context',async()=>{
  const {hub,backend}=fixture();backend.setCurrentMember('member_pm');for(const status of ['blocked','submitted','changes_requested']){const draft=await prepare(hub);hub.confirm({id:draft.id,actions:[{type:'task.update',id:'task_1',data:{status}}]});assert.equal(backend.store.tasks.find(t=>t.id==='task_1').status,status);}
  const draft=await prepare(hub);hub.confirm({id:draft.id,actions:[{type:'decision.update',id:'decision_1',data:{status:'superseded'}}]});assert.equal(backend.store.decisions.find(d=>d.id==='decision_1').status,'superseded');assert(!hub.context(PID).decisions.some(d=>d.id==='decision_1'));assert(hub.snapshot(PID).schema.decisionStatuses.includes('superseded'));hub.dispose();
});
