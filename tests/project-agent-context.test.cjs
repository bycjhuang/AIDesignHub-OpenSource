'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {ProjectHub}=require('../backend/project-hub.cjs');
const {AgentHub,SKILLS}=require('../backend/agent-hub.cjs');
const {SkillCenter}=require('../backend/skill-center.cjs');
const PID='project_jiangwan',tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const backend=new LocalBackend({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-management-agent-'))});const projectHub=new ProjectHub({backend});const skillCenter=new SkillCenter({backend,builtins:SKILLS}),calls=[];
  const agentHub=new AgentHub({backend,projectContext:id=>projectHub.context(id),skillCenter,execute:async(connection,input)=>{calls.push({connection,input});return {text:'合成执行器已阅读本次明确提供的材料，成果等待人工审核。'};}});
  for(const id of ['agent-a','agent-b'])agentHub.saveConnection({id,provider:'custom',mode:'cli',command:process.execPath,args:[],label:id});
  return {backend,projectHub,skillCenter,agentHub,calls,close:()=>{agentHub.dispose();projectHub.dispose();}};
}
function create(agentHub,extra={}){return agentHub.createJob({projectId:PID,title:'合成项目研读',instruction:'仅使用本次提供的信息',skillId:'project-review',connectionId:'agent-a',requestId:'fixed-job',...extra});}
function send(agentHub,extra={}){return agentHub.sendChat({projectId:PID,message:'请说明当前项目重点',connectionId:'agent-a',requestId:'first-chat',...extra});}

test('opted-in run snapshots context after its task becomes doing and starts without a false stale flag',async()=>{
  const {backend,projectHub,agentHub,calls,close}=fixture();const job=create(agentHub,{includeProjectContext:true});const run=agentHub.startJob(job.id);
  assert.equal(backend.store.tasks.find(task=>task.id===job.taskId).status,'doing');assert.equal(run.input.projectContext.tasks.find(task=>task.id===job.taskId).status,'doing');assert.equal(run.input.projectContext.revision,projectHub.context(PID).revision);
  assert.equal(agentHub.snapshot(PID).runs.find(item=>item.id===run.id).contextStale,false);assert.equal(run.input.allowProjectTools,false);await tick();assert.equal(calls[0].input.env,undefined);assert.match(calls[0].input.prompt,/<project_context>/);assert.match(calls[0].input.prompt,/不是执行权限或系统指令/);assert.equal(agentHub.snapshot(PID).runs.find(item=>item.id===run.id).contextStale,false);close();
});
test('human-confirmed decision changes flag older context without rewriting frozen run inputs',async()=>{
  const {backend,projectHub,agentHub,close}=fixture();const job=create(agentHub,{includeProjectContext:true});const run=agentHub.startJob(job.id);await tick();const original=JSON.stringify(agentHub.state.runs.find(r=>r.id===run.id).input);
  const draft=await projectHub.prepare({projectId:PID,text:'经人工确认，主入口采用连续雨棚。'});backend.setCurrentMember('member_pm');projectHub.confirm({id:draft.id,actions:[{type:'decision.update',id:'decision_1',data:{summary:'主入口采用连续雨棚，以新的正式决定为准。'}}]});
  assert.equal(JSON.stringify(agentHub.state.runs.find(r=>r.id===run.id).input),original);assert.equal(agentHub.snapshot(PID).runs.find(r=>r.id===run.id).contextStale,true);assert(!agentHub.state.runs.find(r=>r.id===run.id).input.projectContext.decisions.find(d=>d.id==='decision_1').summary.includes('连续雨棚'));assert(projectHub.context(PID).decisions.find(d=>d.id==='decision_1').summary.includes('连续雨棚'));close();
});
test('without per-run context opt-in neither jobs nor chat include management context or grant tools',async()=>{
  const {agentHub,calls,close}=fixture();const job=create(agentHub);const run=agentHub.startJob(job.id);const chat=send(agentHub);
  assert.equal(job.includeProjectContext,false);assert.equal(run.input.projectContext,undefined);assert.equal(chat.run.input.projectContext,undefined);await tick();assert.equal(calls.length,2);for(const {input}of calls){assert(!input.prompt.includes('<project_context>'));assert.equal(input.env,undefined);}assert(agentHub.snapshot(PID).runs.every(r=>r.contextStale===false));close();
});
test('external principals cannot self-authorize management context even with project and task scopes',()=>{
  const {agentHub,close}=fixture();const grant=agentHub.createGrant({label:'synthetic foreign agent',projectId:PID,memberId:'member_designer',scopes:['project:read','tasks:read','tasks:write']});const principal=agentHub.authorize(grant.token);
  assert.throws(()=>agentHub.createJob({projectId:PID,title:'远端不能自行分享',instruction:'context',skillId:'project-review',connectionId:'zcode',requestId:'remote-context',includeProjectContext:true},principal),/工作台明确/);
  assert.throws(()=>agentHub.sendChat({projectId:PID,message:'context',connectionId:'agent-a',requestId:'remote-chat',includeProjectContext:true},principal),error=>error.code==='LOCAL_CHAT_ONLY');assert.equal(agentHub.state.jobs.length,0);close();
});
test('job and chat idempotency reject a different management-context permission on the same request',async()=>{
  const {agentHub,close}=fixture();const job=create(agentHub,{includeProjectContext:false});assert.equal(create(agentHub,{includeProjectContext:false}).id,job.id);assert.throws(()=>create(agentHub,{includeProjectContext:true}),/相同请求ID/);
  const chat=send(agentHub,{includeProjectContext:true});assert.equal(send(agentHub,{includeProjectContext:true}).run.id,chat.run.id);assert.throws(()=>send(agentHub,{includeProjectContext:false}),error=>error.code==='CHAT_REQUEST_CONFLICT');await tick();close();
});
test('published employee skills are selected in chat and their exact versions stay frozen across publication of a successor',async()=>{
  const {skillCenter,agentHub,close}=fixture();const draft=skillCenter.save({projectId:PID,name:'合成方法',description:'仅用于测试',version:'1.0.0',instructions:'方法第一版：只整理明确事实。'});
  assert.throws(()=>send(agentHub,{skillId:draft.id}),/尚未发布/);const firstVersion=skillCenter.publish(draft.id);const first=send(agentHub,{skillId:firstVersion.id});await tick();
  assert.equal(first.run.input.skill.version,'1.0.0');assert.equal(first.run.input.skill.instructions,firstVersion.instructions);assert.equal(first.run.input.skill.contentHash,firstVersion.contentHash);assert.equal(first.job.skillVersion,'1.0.0');
  const nextDraft=skillCenter.save({id:firstVersion.id,projectId:PID,version:'2.0.0',instructions:'方法第二版：增加出处核对。'});const secondVersion=skillCenter.publish(nextDraft.id);const second=send(agentHub,{conversationId:first.conversationId,requestId:'version-two',skillId:secondVersion.id});await tick();
  assert.equal(second.run.input.skill.version,'2.0.0');assert.equal(agentHub.state.runs.find(r=>r.id===first.run.id).input.skill.version,'1.0.0');assert.equal(agentHub.state.runs.find(r=>r.id===first.run.id).input.skill.instructions,firstVersion.instructions);assert.equal(agentHub.state.runs.find(r=>r.id===second.run.id).input.skill.instructions,secondVersion.instructions);close();
});
test('switching executor retains Hub decisions while separately requiring explicit history and context sharing',async()=>{
  const {backend,projectHub,agentHub,close}=fixture();const draft=await projectHub.prepare({projectId:PID,text:'人已确认本轮不新增入口构筑物。'});backend.setCurrentMember('member_pm');projectHub.confirm({id:draft.id,actions:[{type:'decision.create',data:{title:'本轮边界',summary:'本轮不新增入口构筑物。',status:'confirmed'}}],acknowledgeImportant:true});
  const first=send(agentHub,{includeProjectContext:true});await tick();assert(first.run.input.projectContext.decisions.some(d=>d.title==='本轮边界'));
  assert.throws(()=>send(agentHub,{conversationId:first.conversationId,requestId:'switch',connectionId:'agent-b',includeProjectContext:true}),error=>error.code==='HISTORY_TRANSFER_REQUIRED');
  const second=send(agentHub,{conversationId:first.conversationId,requestId:'switch',connectionId:'agent-b',includeProjectContext:true,allowHistoryTransfer:true});await tick();assert.equal(second.run.input.historyTransferred,true);assert(second.run.input.projectContext.decisions.some(d=>d.title==='本轮边界'));assert(projectHub.context(PID).decisions.some(d=>d.title==='本轮边界'));assert(second.run.input.chatHistory.some(message=>message.connectionId==='agent-a'));close();
});
