'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {AgentHub}=require('../backend/agent-hub.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(execute=async()=>({text:'这是合成回复'})){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-chat-'));const backend=new LocalBackend({dataDir});const hub=new AgentHub({backend,execute});
  hub.saveConnection({id:'chat-a',provider:'custom',mode:'cli',command:process.execPath,args:[],label:'Agent A'});hub.saveConnection({id:'chat-b',provider:'custom',mode:'cli',command:process.execPath,args:[],label:'Agent B'});
  return {hub,backend,dataDir};
}
function send(hub,extra={}){return hub.sendChat({projectId:'project_jiangwan',connectionId:'chat-a',message:'讨论纯合成建筑项目',requestId:'first',...extra});}
test('local chat creates a persistent conversation, real job and run using general skill',async()=>{
  let captured;const {hub,backend,dataDir}=fixture(async(c,input)=>{captured=input;return {text:'真实adapter的合成回答'};});const first=send(hub);
  assert.equal(first.duplicate,false);assert.equal(first.run.status,'queued');assert.equal(first.job.skillId,'agent-chat');assert.equal(first.run.input.allowProjectTools,false);assert.equal(first.run.input.conversationId,first.conversationId);
  await tick();assert.equal(hub.state.runs[0].status,'awaiting_review');assert.match(captured.prompt,/本轮用户任务/);assert.equal(captured.env,undefined);
  assert.equal(hub.snapshot().projectId,'project_jiangwan');const list=hub.snapshot().conversations;assert.equal(list.length,1);assert.equal(list[0].messageCount,2);assert.equal(list[0].lastConnectionId,'chat-a');assert.equal(list[0].activeRunId,null);
  const restored=new AgentHub({backend:new LocalBackend({dataDir})});assert.equal(restored.snapshot().conversations[0].id,first.conversationId);assert.equal(backend.store.tasks[backend.store.tasks.length-1].agentJobId,first.job.id);
});
test('request ID replay returns the original run while changed content or conversation fails',async()=>{
  let calls=0;const {hub}=fixture(async()=>{calls++;return {text:'ok'};});const first=send(hub);const replay=send(hub);assert.equal(replay.duplicate,true);assert.equal(replay.run.id,first.run.id);await tick();
  assert.equal(send(hub,{conversationId:first.conversationId}).run.id,first.run.id);assert.equal(calls,1);assert.equal(hub.state.jobs.filter(j=>j.conversationId).length,1);
  assert.throws(()=>send(hub,{message:'不同消息'}),e=>e.code==='CHAT_REQUEST_CONFLICT');assert.throws(()=>send(hub,{conversationId:'different'}),e=>e.code==='CHAT_REQUEST_CONFLICT');
});
test('active run blocks new messages, but awaiting review and rejected responses allow follow-up',async()=>{
  let complete;const {hub}=fixture(()=>new Promise(resolve=>{complete=resolve;}));const first=send(hub);await tick();assert.throws(()=>send(hub,{conversationId:first.conversationId,requestId:'second'}),e=>e.code==='CHAT_BUSY');
  complete({text:'待审核草稿'});await tick();const follow=send(hub,{conversationId:first.conversationId,requestId:'second',message:'请补充'});assert.equal(follow.run.input.chatHistory.length,2);assert.equal(follow.run.input.chatHistory[1].status,'awaiting_review');assert.equal(hub.state.runs[0].status,'awaiting_review');
  await tick();complete({text:'第二轮草稿'});await tick();hub.reviewRun(follow.run.id,false);const third=send(hub,{conversationId:first.conversationId,requestId:'third',message:'请修正'});assert.equal(third.run.input.chatHistory.at(-1).status,'rejected');hub.cancelRun(third.run.id);
});
test('history snapshot remains fixed when earlier results are later reviewed or changed',async()=>{
  const {hub}=fixture();const first=send(hub);await tick();const second=send(hub,{conversationId:first.conversationId,requestId:'next'});const saved=JSON.stringify(second.run.input.chatHistory);hub.reviewRun(first.run.id,true);
  hub.change(state=>{state.runs.find(r=>r.id===first.run.id).output='changed later';return true;});assert.equal(JSON.stringify(hub.state.runs.find(r=>r.id===second.run.id).input.chatHistory),saved);hub.cancelRun(second.run.id);
});
test('switching executor requires explicit history transfer consent; new blank conversation does not',async()=>{
  const {hub}=fixture();const first=send(hub);await tick();assert.throws(()=>send(hub,{conversationId:first.conversationId,connectionId:'chat-b',requestId:'switch'}),e=>e.code==='HISTORY_TRANSFER_REQUIRED');
  assert.equal(hub.state.jobs.filter(j=>j.conversationId).length,1);const approved=send(hub,{conversationId:first.conversationId,connectionId:'chat-b',requestId:'switch',allowHistoryTransfer:true});assert.equal(approved.run.input.historyTransferred,true);assert.equal(approved.run.input.chatHistory[0].connectionId,'chat-a');await tick();
  const next=send(hub,{conversationId:first.conversationId,connectionId:'chat-b',requestId:'same-b'});assert.equal(next.run.input.historyTransferred,false);hub.cancelRun(next.run.id);
  const blank=send(hub,{connectionId:'chat-b',requestId:'new-blank'});assert.notEqual(blank.conversationId,first.conversationId);assert.equal(blank.run.input.chatHistory.length,0);hub.cancelRun(blank.run.id);
});
test('project isolation rejects foreign conversations and never copies unrelated messages or knowledge',async()=>{
  const {hub,backend}=fixture();backend.mutate(store=>{store.projects.push({id:'other',name:'Other'});store.members.push({id:'other-member',projectId:'other',name:'Other',active:true});store.unrelatedChatFixture=[{id:'unrelated',content:'never-copy-unrelated-chat'}];return true;});
  const first=send(hub);await tick();assert.throws(()=>send(hub,{projectId:'other',conversationId:first.conversationId,requestId:'foreign'}),e=>e.code==='CONVERSATION_NOT_FOUND');assert.equal(hub.snapshot('other').conversations.length,0);
  const other=send(hub,{projectId:'other',requestId:'other-new',message:'other project marker'});await tick();const next=send(hub,{conversationId:first.conversationId,requestId:'second'});const prompt=hub.promptFor(next.run);assert(!prompt.includes('other project marker'));assert(!prompt.includes('never-copy-unrelated-chat'));assert.equal(hub.snapshot('other').conversations[0].id,other.conversationId);hub.cancelRun(next.run.id);
});
test('inbound and handoff do not create pretend replies; external MCP principals cannot call local chat',()=>{
  const {hub}=fixture();for(const connectionId of ['zcode','custom'])assert.throws(()=>send(hub,{connectionId}),e=>e.code==='OUTBOUND_REQUIRED');assert.equal(hub.state.jobs.length,0);assert.equal(hub.snapshot().conversations.length,0);
  const token=hub.createGrant({label:'external',projectId:'project_jiangwan',memberId:'member_designer',scopes:['tasks:write']});assert.throws(()=>hub.sendChat({message:'hello',requestId:'external',connectionId:'chat-a'},hub.authorize(token.token)),e=>e.code==='LOCAL_CHAT_ONLY');
});
test('history is bounded, UTF-8 valid and indicates omitted or truncated prior content',async()=>{
  const {hub}=fixture(async()=>({text:'很长的建筑资料🙂'.repeat(5000)}));const first=send(hub);await tick();
  for(let i=0;i<8;i++){send(hub,{conversationId:first.conversationId,requestId:`next-${i}`,message:`第${i}轮继续`});await tick();}
  const next=send(hub,{conversationId:first.conversationId,requestId:'last'});assert(next.run.input.chatHistory.length<=12);assert(Buffer.byteLength(JSON.stringify(next.run.input.chatHistory))<=48*1024);assert(next.run.input.chatHistoryInfo.omittedMessages>0);assert(next.run.input.chatHistoryInfo.truncatedMessages>0);assert(!JSON.stringify(next.run.input.chatHistory).includes('\ufffd'));hub.cancelRun(next.run.id);
});
test('tool permission is per-turn and history does not silently carry prior authorization',async()=>{
  let inputs=[];const {hub}=fixture(async(c,input)=>{inputs.push(input);return {text:'first'};});hub.setGateway({url:'http://127.0.0.1:49123',command:process.execPath,mcpScript:path.resolve(__dirname,'../scripts/hub-mcp.cjs'),cliScript:path.resolve(__dirname,'../scripts/hub-cli.cjs')});
  const first=send(hub,{allowProjectTools:true});await tick();assert(inputs[0].env?.AIDESIGNHUB_TOKEN);const second=send(hub,{conversationId:first.conversationId,requestId:'next'});await tick();assert.equal(inputs[1].env,undefined);assert.equal(second.run.input.allowProjectTools,false);assert(!JSON.stringify(second.run.input.chatHistory).includes('AIDESIGNHUB_TOKEN'));
});
