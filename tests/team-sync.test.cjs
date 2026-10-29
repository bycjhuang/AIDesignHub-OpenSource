const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { TeamSyncServer, TeamSyncClient } = require('../backend/team-sync.cjs');

async function run() {
  const root = path.resolve(__dirname, '..');
  const runRoot = path.join(root, '.test-data', `team-sync-${Date.now()}`);
  const hostBackend = new LocalBackend({ dataDir:path.join(runRoot, 'host') });
  const clientBackend = new LocalBackend({ dataDir:path.join(runRoot, 'client') });
  const server = new TeamSyncServer(hostBackend);

  try {
    const status = await server.start({ host:'127.0.0.1', port:0, token:'test-project-token' });
    assert.equal(status.running, true);
    assert.match(status.addresses[0], /^http:\/\/127\.0\.0\.1:/);

    const client = new TeamSyncClient({ url:status.addresses[0], token:status.token });
    const health = await client.health();
    assert.equal(health.ok, true);

    const remoteInitial = await client.bootstrap();
    assert.equal(remoteInitial.settings, undefined);
    assert.equal(remoteInitial.knowledgeDocs, undefined);
    const member = await client.addMember({
      projectId:remoteInitial.project.id,
      name:'同步测试成员',
      title:'建筑设计师',
      role:'designer',
      skills:['Rhino'],
    });
    assert.equal(member.name, '同步测试成员');
    const channel=await client.addChannel({projectId:remoteInitial.project.id,name:'同步测试频道',description:'跨电脑频道'});

    const fixture = path.join(__dirname, 'fixtures', '项目规划条件.txt');
    const uploaded = await client.uploadAttachments({
      projectId:remoteInitial.project.id,
      files:[{ name:'同步附件.txt', contentBase64:fs.readFileSync(fixture).toString('base64') }],
    });
    assert.equal(uploaded.length, 1);
    assert.ok(fs.existsSync(uploaded[0].storedPath));

    const message = await client.sendMessage({
      projectId:remoteInitial.project.id,
      channelId:'channel_general',
      senderId:member.id,
      body:'跨电脑同步测试：请复核消防车道。',
      attachments:uploaded,
    });
    assert.match(message.body, /跨电脑同步测试/);

    const decision = await client.createDecision({
      projectId:remoteInitial.project.id,
      channelId:'channel_general',
      ownerId:member.id,
      title:'完成消防车道复核',
      summary:'本周内完成并在项目群确认。',
      sourceMessageIds:[message.id],
      status:'confirmed',
    });
    const task = await client.addTask({
      projectId:remoteInitial.project.id,
      ownerId:member.id,
      title:'复核消防车道',
      phase:'concept',
      source:'chat',
    });
    await client.updateTask(task.id,{status:'done'});
    await client.updateDecision(decision.id,{status:'confirmed'});
    const remoteCase=await client.addCase({projectId:remoteInitial.project.id,name:'团队同步案例',type:'commercial'});
    await client.removeCase(remoteCase.id);
    await client.updateRisk(remoteInitial.risks[0].id,{status:'closed'});
    await client.updateMilestone(remoteInitial.contractMilestones[1].id,{status:'paid'});

    const remoteFinal = await client.bootstrap(remoteInitial.project.id);
    assert.ok(remoteFinal.channels.some((item)=>item.id===channel.id));
    const downloaded = await client.downloadAttachment(uploaded[0].id);
    const localAttachment = clientBackend.storeSyncedAttachment(downloaded, remoteInitial.project.id);
    const remoteMessage = remoteFinal.messages.find((item) => item.id === message.id);
    remoteMessage.attachments[0] = localAttachment;
    clientBackend.mergeRemoteSnapshot(remoteFinal);
    clientBackend.setCurrentMember(member.id);
    const localMirror = clientBackend.bootstrap(remoteInitial.project.id);
    assert.ok(localMirror.messages.some((item) => item.id === message.id));
    assert.ok(localMirror.decisions.some((item) => item.id === decision.id));
    assert.equal(localMirror.tasks.find((item) => item.id === task.id).status,'done');
    assert.equal(localMirror.risks.find((item)=>item.id===remoteInitial.risks[0].id).status,'closed');
    assert.equal(localMirror.contractMilestones.find((item)=>item.id===remoteInitial.contractMilestones[1].id).status,'paid');
    assert.ok(!localMirror.cases.some((item)=>item.id===remoteCase.id));
    assert.ok(fs.existsSync(localMirror.messages.find((item) => item.id === message.id).attachments[0].storedPath));
    assert.equal(localMirror.settings.currentMemberId, member.id);

    const badClient = new TeamSyncClient({ url:status.addresses[0], token:'wrong-token' });
    await assert.rejects(() => badClient.bootstrap(), /UNAUTHORIZED/);

    process.stdout.write(JSON.stringify({
      ok:true,
      server:status.addresses[0],
      messages:remoteFinal.messages.length,
      decisions:remoteFinal.decisions.length,
      tasks:remoteFinal.tasks.length,
      attachmentBytes:uploaded[0].size,
    }, null, 2));
  } finally {
    await server.stop();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode=1;
});
