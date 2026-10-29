'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {ProjectHub}=require('../backend/project-hub.cjs');
const {HubChat,BOT_ID}=require('../backend/hub-chat.cjs');
const PID='project_jiangwan';
function fixture(t,reply=async()=>({reply:'这是基于当前资料的答复。',summary:'无管理变更',actions:[]})){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-hub-chat-'));
  t.after(()=>{assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('aidesignhub-hub-chat-'));fs.rmSync(dataDir,{recursive:true,force:true});});
  const backend=new LocalBackend({dataDir}),projectHub=new ProjectHub({backend}),calls=[];
  const modelService={status:()=>({configured:true}),reply:async payload=>{calls.push(payload);return reply(payload);}};
  const chat=new HubChat({backend,projectHub,modelService});
  const send=payload=>chat.send({projectId:PID,view:'dashboard',text:'解释当前工作',requestId:crypto.randomUUID(),useModel:true,...payload});
  return {backend,projectHub,chat,calls,send,dataDir};
}
test('snapshot has stable assistant channel, bounded context and no network or channel writes',t=>{
  const {chat,backend,calls}=fixture(t),count=backend.store.channels.length;
  const a=chat.snapshot({projectId:PID}),b=chat.snapshot({projectId:PID,view:'cases'});
  assert.equal(a.assistantChannelId,b.assistantChannelId);assert.match(b.context.scopeLabel,/案例/);assert.equal(count,backend.store.channels.length);assert.equal(calls.length,0);
  assert.ok(!JSON.stringify(a.context).includes('480000'));assert.ok(!JSON.stringify(a.context).includes('folderPath'));
});

test('project context page combines formal project records with source metadata without pending suggestions',async t=>{
  const {chat,backend,projectHub,calls}=fixture(t);
  backend.mutate(store=>{store.knowledgeDocs.push({id:'source-doc',projectId:PID,name:'项目任务书',status:'indexed',extension:'.pdf',storedPath:'C:\\private\\source.pdf'});return true;});
  const draft=await projectHub.prepare({projectId:PID,text:'仅为候选：改为另一阶段'});
  backend.mutate(store=>{store.projectHub.drafts.find(d=>d.id===draft.id).actions=[{type:'task.create',data:{title:'UNAPPROVED_CANDIDATE'}}];return true;});
  const before=JSON.stringify(backend.store),snapshot=chat.snapshot({projectId:PID,view:'files'});
  assert.equal(snapshot.context.page.label,'项目上下文');assert.match(snapshot.context.scopeLabel,/项目上下文/);
  assert.ok(snapshot.context.project.tasks.length);assert.ok(snapshot.context.project.decisions.length);assert.ok(snapshot.context.project.risks.length);
  assert.ok(snapshot.context.page.items.some(item=>item.id==='source-doc'));assert.match(snapshot.context.page.notices.join('\n'),/context\.project/);
  assert.ok(!JSON.stringify(snapshot.context).includes('UNAPPROVED_CANDIDATE'));assert.ok(!JSON.stringify(snapshot.context).includes('storedPath'));
  assert.equal(JSON.stringify(backend.store),before);assert.equal(calls.length,0);
});
test('ordinary group message never invokes model even when checkbox enabled',async t=>{
  const {send,calls,backend}=fixture(t);const before=backend.store.messages.length;
  const result=await send({channelId:'channel_general',text:'大家好'});
  assert.equal(result.status,'recorded');assert.equal(result.assistantMessage,null);assert.equal(calls.length,0);assert.equal(backend.store.messages.length,before+1);
});
test('assistant or mention requires explicit consent, keeps raw text and current identity',async t=>{
  const {send,calls}=fixture(t);
  const result=await send({text:'  @DesignHub 帮我分析\n',channelId:'channel_general',useModel:false,senderId:'member_finance',type:'assistant'});
  assert.equal(result.userMessage.body,'  @DesignHub 帮我分析\n');assert.equal(result.userMessage.senderId,'member_designer');assert.equal(result.userMessage.type,'text');assert.equal(calls.length,0);assert.equal(result.assistantMessage.senderId,BOT_ID);
});
test('genuine answer persists in assistant channel without a fake pending task',async t=>{
  const {send,calls,backend}=fixture(t);const count=backend.store.tasks.length;
  const result=await send({view:'cases'});
  assert.equal(result.status,'succeeded');assert.match(result.assistantMessage.body,/当前资料/);assert.equal(result.draft,null);assert.equal(backend.store.tasks.length,count);assert.equal(calls.length,1);assert.equal(backend.store.projectHub.drafts[0].status,'dismissed');
});
test('model proposals keep source evidence and require existing explicit confirm path',async t=>{
  const {send,backend,projectHub}=fixture(t,async()=>({reply:'建议新增任务，待你确认。',summary:'新增复核任务',actions:[{type:'task.create',data:{title:'复核大堂方案'}}]}));
  const count=backend.store.tasks.length,result=await send();
  assert.equal(result.draft.status,'pending');assert.equal(result.draft.source.sourceMessageId,result.userMessage.id);assert.equal(result.draft.source.sourceView,'dashboard');assert.equal(backend.store.tasks.length,count);
  assert.throws(()=>projectHub.confirm({id:result.draft.id,actions:result.draft.actions}),e=>e.code==='PROJECT_APPROVAL_DENIED');assert.equal(backend.store.tasks.length,count);backend.setCurrentMember('member_pm');
  projectHub.confirm({id:result.draft.id,actions:result.draft.actions});assert.equal(backend.store.tasks.length,count+1);
});
test('idempotent completed request neither bills twice nor creates duplicate messages',async t=>{
  const {send,calls,backend}=fixture(t);const a=await send({requestId:'idempotent'}),count=backend.store.messages.length,b=await send({requestId:'idempotent'});
  assert.equal(b.duplicate,true);assert.equal(a.userMessage.id,b.userMessage.id);assert.equal(count,backend.store.messages.length);assert.equal(calls.length,1);
  await assert.rejects(send({requestId:'idempotent',text:'different'}),e=>e.code==='HUB_CHAT_REQUEST_CONFLICT');
});
test('pending duplicate cannot trigger another model call',async t=>{
  let finish;const {send,calls}=fixture(t,()=>new Promise(resolve=>finish=resolve));const pending=send({requestId:'pending'});await new Promise(resolve=>setImmediate(resolve));
  const duplicate=await send({requestId:'pending'});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.status,'processing');assert.equal(calls.length,1);
  finish({reply:'完成问答',actions:[]});await pending;
});
test('knowledge search uses current-project excerpts with source locator, not stored paths',async t=>{
  const {backend,send,calls}=fixture(t);
  backend.mutate(store=>{store.knowledgeDocs.push({id:'doc-a',projectId:PID,name:'大厅设计说明',storedPath:'C:\\secret\\data.pdf',originalPath:'D:\\owner\\data.pdf',chunks:[{text:'大厅照明采用自然采光，设计强调通透。',locator:'第2页'}]},{id:'doc-other',projectId:'another',name:'其他项目秘密',chunks:[{text:'大厅另一个项目机密',locator:'第1页'}]},{id:'doc-private',projectId:PID,name:'保密合同',chunks:[{text:'大厅报价999万元',locator:'第3页'}]});return true;});
  await send({view:'knowledge',text:'大厅采光说明'});const text=JSON.stringify(calls[0]);assert.match(text,/自然采光/);assert.match(text,/第2页/);assert.ok(!text.includes('storedPath'));assert.ok(!text.includes('999万元'));assert.ok(!text.includes('其他项目秘密'));
});
test('cross project/channel/selection context rejected',async t=>{
  const {chat,send,backend}=fixture(t);backend.mutate(store=>{store.cases.push({id:'case-other',projectId:'another',name:'其他'});return true;});
  assert.throws(()=>chat.snapshot({projectId:'another'}),e=>e.code==='HUB_CHAT_ACCESS_DENIED');
  await assert.rejects(send({channelId:'elsewhere'}),e=>e.code==='HUB_CHAT_INVALID_CHANNEL');
  await assert.rejects(send({view:'cases',selectionId:'case-other'}),e=>e.code==='HUB_CHAT_INVALID_SELECTION');
});
test('finance context follows actual member role, not presentation role or global setting',async t=>{
  const {send,chat,calls,backend}=fixture(t);backend.setRole('leader');
  const restricted=chat.snapshot({projectId:PID,view:'contracts'});assert.equal(restricted.context.page.access,'restricted');assert.equal(restricted.context.page.items.length,0);
  await send({view:'contracts'});assert.equal(calls.length,0);
  backend.setCurrentMember('member_finance');await send({view:'contracts'});assert.equal(calls.length,1);assert.match(JSON.stringify(calls[0].pageContext),/480000/);
});
test('financial group messages are not shown to designer snapshot',t=>{
  const {chat}=fixture(t);const snapshot=chat.snapshot({projectId:PID,channelId:'channel_general'});assert.ok(!snapshot.messages.some(m=>m.senderId==='member_finance'));assert.ok(!JSON.stringify(snapshot.messages).includes('48 万元'));
});
test('assistant history remains on same project, page, channel and member; group history never auto-injected',async t=>{
  const {send,calls,backend}=fixture(t);
  await send({view:'cases',text:'案例first'});await send({view:'cases',text:'案例second'});assert.equal(calls[1].history.length,2);
  await send({view:'knowledge',text:'规范'});assert.equal(calls[2].history.length,0);
  backend.setCurrentMember('member_pm');await send({view:'cases',text:'PM案例'});assert.equal(calls[3].history.length,0);
  await send({channelId:'channel_general',text:'@DesignHub 帮我解释'});assert.equal(calls[4].history.length,0);assert.ok(!JSON.stringify(calls[4]).includes('48 万元'));
});
test('late response lands in original project without changing newly selected project',async t=>{
  let finish;const {backend,send}=fixture(t,()=>new Promise(resolve=>finish=resolve));const pending=send();await new Promise(resolve=>setImmediate(resolve));
  backend.mutate(store=>{store.projects.push({id:'second',name:'Second',stage:'research'});store.members.push({id:'second-member',projectId:'second',role:'designer',name:'Other'});store.settings.currentProjectId='second';store.settings.currentMemberId='second-member';return true;});
  finish({reply:'原项目完成问答',actions:[{type:'task.create',data:{title:'原项目建议'}}]});const result=await pending;
  assert.equal(result.projectId,PID);assert.equal(result.draft.projectId,PID);assert.equal(result.assistantMessage.projectId,PID);assert.equal(backend.store.settings.currentProjectId,'second');assert.equal(backend.store.tasks.some(t=>t.title==='原项目建议'),false);
});
test('unconfigured or unsafe model errors retain input and never echo provider secrets',async t=>{
  const {send,backend}=fixture(t,async()=>{const e=new Error('sk-VERYSECRET request body');e.code='MODEL_NOT_CONFIGURED';throw e;});
  const result=await send();assert.equal(result.status,'failed');assert.match(result.assistantMessage.body,/尚未配置/);assert.ok(!JSON.stringify(backend.store).includes('sk-VERYSECRET'));assert.equal(result.userMessage.body,'解释当前工作');
});
test('invalid actions cannot perform foreign task or permission writes',async t=>{
  const {send,backend}=fixture(t,async()=>({reply:'完成',actions:[{type:'member.update',data:{role:'leader'}}]}));const role=backend.store.members[0].role;
  const result=await send();assert.equal(result.status,'failed');assert.equal(backend.store.members[0].role,role);assert.equal(result.draft,null);
});
test('dispose suppresses late model writeback and retains interrupted message',async t=>{
  let finish;const {send,chat,backend}=fixture(t,()=>new Promise(resolve=>finish=resolve));const pending=send();await new Promise(resolve=>setImmediate(resolve));chat.dispose();finish({reply:'不要显示的迟到响应',actions:[]});const result=await pending;
  assert.equal(result.status,'failed');assert.ok(!JSON.stringify(backend.store).includes('不要显示的迟到响应'));
});
test('agent page never launches external execution',async t=>{
  const {send,calls}=fixture(t);await send({view:'agents'});assert.match(calls[0].pageContext.notices.join(''),/不会替代或启动/);assert.equal(calls.length,1);
});
test('email addresses and embedded tokens are not mentions, explicit punctuation is',async t=>{
  const {send,calls}=fixture(t);
  for(const text of ['user@DesignHub.com','foo@DesignHub','@DesignHub.example','@DesignHubX'])await send({channelId:'channel_general',text});
  assert.equal(calls.length,0);await send({channelId:'channel_general',text:'请确认：@DesignHub，解释一下'});assert.equal(calls.length,1);
});
test('role downgrade removes prior finance conversation from visible snapshot and model history',async t=>{
  const {backend,send,chat}=fixture(t,async()=>({reply:'本轮应收480000元',actions:[]}));backend.setCurrentMember('member_finance');await send({view:'contracts',text:'当前应收'});
  backend.mutate(store=>{store.members.find(m=>m.id==='member_finance').role='designer';return true;});
  const snapshot=chat.snapshot({projectId:PID,view:'contracts'});assert.equal(snapshot.context.page.access,'restricted');assert.equal(snapshot.context.history.length,0);assert.equal(snapshot.messages.length,0);assert.ok(!JSON.stringify(snapshot).includes('480000'));
});
test('legacy assistant channel aliases are merged for display and still invoke the assistant',async t=>{
  const {backend,send,chat,calls}=fixture(t);backend.mutate(store=>{store.channels.push({id:'random-assistant',projectId:PID,type:'assistant',name:'项目助手'});store.messages.push({id:'old-assistant-note',projectId:PID,channelId:'random-assistant',senderId:'member_designer',body:'旧助手记录',createdAt:1});return true;});
  const snapshot=chat.snapshot({projectId:PID,channelId:'random-assistant'});assert.equal(snapshot.channels.filter(c=>c.type==='assistant').length,1);assert.ok(snapshot.messages.some(m=>m.id==='old-assistant-note'));
  const result=await send({channelId:'random-assistant'});assert.equal(result.channelId,snapshot.assistantChannelId);assert.equal(calls.length,1);
});
test('proposal optimism is frozen before asynchronous model returns',async t=>{
  let finish;const {backend,send,projectHub}=fixture(t,()=>new Promise(resolve=>finish=resolve));const pending=send();await new Promise(resolve=>setImmediate(resolve));
  backend.mutate(store=>{store.tasks.find(t=>t.id==='task_1').title='其他人已修改';return true;});finish({reply:'建议更新',actions:[{type:'task.update',id:'task_1',data:{title:'模型旧建议'}}]});const result=await pending;
  backend.setCurrentMember('member_pm');
  assert.throws(()=>projectHub.confirm({id:result.draft.id,actions:result.draft.actions}),e=>e.code==='STALE_DRAFT');
});
