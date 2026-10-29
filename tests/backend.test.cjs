const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');

async function run() {
  const root = path.resolve(__dirname, '..');
  const runDir = path.join(root, '.test-data', `run-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive:true });
  const backend = new LocalBackend({ dataDir:runDir });
  const initial = backend.bootstrap();
  assert.equal(initial.projects, undefined);
  assert.equal(initial.project.name, '江湾文化商业中心');
  assert.ok(initial.members.length >= 5);
  assert.ok(initial.channels.length >= 4);
  const channel=backend.addChannel({projectId:initial.project.id,name:'测试频道',description:'自动测试'});
  assert.ok(backend.bootstrap().channels.some((item)=>item.id===channel.id));

  const message = backend.sendMessage({ channelId:'channel_general', body:'测试消息：请在周五前完成消防车道复核。' });
  assert.match(message.body, /消防车道/);
  const search = backend.searchMessages(initial.project.id, '消防车道');
  assert.ok(search.some((item) => item.id === message.id));

  const decision = backend.createDecision({ projectId:initial.project.id, channelId:'channel_general', title:'消防车道本周完成复核', summary:'由设计师在周五前完成消防车道转弯包络复核。', sourceMessageIds:[message.id], status:'confirmed' });
  assert.equal(decision.status, 'confirmed');
  assert.ok(backend.bootstrap().messages.some((item) => item.decisionId === decision.id));

  const task = backend.addTask({ projectId:initial.project.id, title:'测试新增任务', phase:'concept' });
  backend.updateTask(task.id, { status:'done' });
  assert.equal(backend.bootstrap().tasks.find((item) => item.id === task.id).status, 'done');

  const caseItem = backend.addCase({ projectId:initial.project.id, name:'测试案例', type:'commercial', tags:['测试'] });
  assert.ok(backend.bootstrap().cases.some((item) => item.id === caseItem.id));

  const fixture = path.join(__dirname, 'fixtures', '项目规划条件.txt');
  const documents = await backend.importKnowledge([fixture], initial.project.id, 'regulation');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].status, 'indexed');
  const result = backend.searchKnowledge(initial.project.id, '消防车道净宽度是多少');
  assert.ok(result.hits.length > 0);
  assert.match(result.answer, /4 米|4米/);

  const attachments = backend.importChatAttachments([fixture], initial.project.id);
  assert.equal(attachments.length, 1);
  assert.ok(fs.existsSync(attachments[0].storedPath));

  const reloaded = new LocalBackend({ dataDir:runDir }).bootstrap();
  assert.ok(reloaded.messages.some((item) => item.id === message.id));
  assert.ok(reloaded.decisions.some((item) => item.id === decision.id));
  assert.ok(reloaded.knowledgeDocs.some((item) => item.id === documents[0].id));
  process.stdout.write(JSON.stringify({ ok:true, messages:reloaded.messages.length, decisions:reloaded.decisions.length, documents:reloaded.knowledgeDocs.length, searchHits:result.hits.length }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode=1; });
