'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { setup, a, b } = require('./fixtures/native-adh-backend-fixture.cjs');
const imageFixture = require('./fixtures/smoke-case.cjs');

test('user template selection persists across sessions and HTML export cannot consume the PPT style', async t => {
  const f = setup(t);
  assert.equal((await f.request('snapshot')).presentationTemplate, 'brief');
  await assert.rejects(f.request('select_presentation_template', { template: 'editorial' }), error => error.code === 'USER_ACTION_REQUIRED');
  await assert.rejects(f.request('select_presentation_template', { template: 'report' }, { caller: 'client' }), error => error.code === 'INVALID_TEMPLATE');
  const selected = await f.request('select_presentation_template', { template: 'editorial' }, { caller: 'client' });
  assert.equal(selected.presentationTemplate, 'editorial'); assert.deepEqual(selected.presentationPagesPerCase, { min: 1, max: 3 });
  assert.equal(f.backend.store.settings.casePresentationTemplate, 'editorial');
  assert.equal((await f.request('snapshot', {}, { sessionId: 'another_session' })).presentationTemplate, 'editorial');
  const archived = await f.archive(), record = f.research.get(archived.researchId), caseId = record.cases[0].caseId;
  const plan = { title: '固定短页案例', caseIds: [caseId], slides: [{ title: '案例概览', caseId, body: '保留案例参考点。', imageAssetIds: [record.assetIds[0]] }] };
  await f.request('presentation_create', { ...plan, format: 'html' });
  const result = await f.request('presentation_create', { ...plan, format: 'pptx', template: 'brief' });
  assert.equal(result.template, 'editorial'); assert.equal(result.slideCount, 1);
  assert.equal((await f.request('snapshot')).presentationTemplate, 'editorial');
  const count = f.backend.store.adhArtifacts.length;
  await assert.rejects(f.request('presentation_create', { ...plan, slides: Array(4).fill(plan.slides[0]) }), error => error.code === 'CASE_PAGE_LIMIT');
  assert.equal(f.backend.store.adhArtifacts.length, count);
});

test('case workflow is fixed for one native ADH turn and ordinary following turns regain their normal tools', async t => {
  const f = setup(t);
  await f.request('prepare_context', { action: 'research' }, { caller: 'client' });
  const first = await f.request('prepare_context', { turnKey: 'turn-1' }, { caller: 'context' });
  assert.equal(first.workflowAction, 'research');
  assert.equal((await f.request('snapshot')).workflowAction, 'research');
  assert.equal((await f.request('prepare_context', { turnKey: 'turn-1' }, { caller: 'context' })).workflowAction, 'research');
  assert.equal((await f.request('prepare_context', { turnKey: 'turn-2' }, { caller: 'context' })).workflowAction, null);
});

async function extraAsset(f, caseId, projectId) {
  const previous=f.images.fetchImage;
  f.images.fetchImage=async url=>url==='https://assets.example.org/extra-fixture.png'?{dataUrl:imageFixture.imageDataUrl,contentType:'image/png',sourceUrl:url,finalUrl:url}:previous(url);
  const session=f.images.start({projectId,caseId,sourceUrl:a},{page:{url:a,finalUrl:a,title:'额外案例项目图',text:'额外案例的已归档原图。',imagesComplete:true,images:[{url:'https://assets.example.org/extra-fixture.png',contentScope:'article'}]}});
  let ready;
  for(let index=0;index<100;index++){ready=f.images.get(session.id);if(ready.status==='ready')break;await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(ready.status,'ready');f.images.save({sessionId:session.id,candidateIds:ready.candidates.map(item=>item.id)});
  for(let index=0;index<100;index++){const current=f.images.get(session.id),id=current.candidates[0]?.savedAssetId;if(id)return id;await new Promise(resolve=>setTimeout(resolve,2));}
  throw new Error('额外测试图片未归档。');
}

test('ADH snapshot carries the current safe project and light case catalog without external executor configuration or private task data',async t=>{
  const f=setup(t);
  f.backend.mutate(store=>{store.projects.find(item=>item.id===f.currentProjectId).researchProfile={isSynthetic:true,label:'演示假设',positioning:'滨水文化商业',siteAreaM2:42000};store.tasks.push({id:'private_task',projectId:f.currentProjectId,title:'不可带入的私密项目事项',private:true});return true;});
  const snapshot=await f.request('snapshot');
  assert.equal(snapshot.project.id,f.currentProjectId);assert.equal(snapshot.project.researchProfile.isSynthetic,true);assert.equal(snapshot.executorId,'adh');
  assert(snapshot.executors.some(item=>item.id==='adh'&&item.internal));assert(!JSON.stringify(snapshot).includes('不可带入的私密项目事项'));
  assert(!JSON.stringify(snapshot.executors).includes('command'));assert(!JSON.stringify(snapshot.executors).includes('endpoint'));assert(!JSON.stringify(snapshot).includes(f.directory));
  assert(snapshot.cases.every(item=>!Object.hasOwn(item,'text')&&!Object.hasOwn(item,'evidence')));assert.equal(f.counts().executionCalls,0);
});

test('case selection and project turns reject foreign records; fresh project preparation clears previous cases and executor',async t=>{
  const f=setup(t), own=f.backend.store.cases.find(item=>item.projectId===f.currentProjectId).id;
  await assert.rejects(f.request('select_cases',{caseIds:[own]}),error=>error.code==='USER_ACTION_REQUIRED');
  await assert.rejects(f.request('select_cases',{caseIds:[f.foreignCase]},{caller:'client'}),error=>error.code==='CASE_SCOPE');
  await f.request('select_cases',{caseIds:[own]},{caller:'client'});
  assert.deepEqual((await f.request('snapshot')).selectedCaseIds,[own]);
  f.switchProject();
  await assert.rejects(f.request('case_details',{caseId:own},{projectId:f.currentProjectId}),error=>error.code==='PROJECT_CHANGED');
  await assert.rejects(f.request('snapshot',{}, {projectId:f.currentProjectId}),error=>error.code==='PROJECT_CHANGED');
  const fresh=await f.request('prepare_context');assert.equal(fresh.project.id,f.foreignId);assert.deepEqual(fresh.selectedCaseIds,[]);assert.equal(fresh.executorId,'adh');
  await assert.rejects(f.request('case_details',{caseId:own}),error=>error.code==='CASE_SCOPE');
  assert.equal(f.hub.state.jobs.length,0);
});

test('native ADH slides and selected archived images are written in their actual model-specified order as editable PPTX',async t=>{
  const f=setup(t), archived=await f.archive(), record=f.research.get(archived.researchId), caseId=record.cases[0].caseId;
  const [first,second]=record.assetIds;
  const result=await f.request('presentation_create',{researchId:record.id,caseIds:[caseId],title:'ADH 原生逐页方案',
    imageAssetIds:[first],slides:[{title:'ADH 指定的第一张分析页',body:'结合江湾的文化节点布置步行入口。',imageAssetIds:[first],sourceUrls:[a]},
      {title:'ADH 指定的第二张分析页',body:'沿河公共步道与展厅后勤分别组织。',imageAssetIds:[second],sourceUrls:[b]}]});
  const artifact=f.backend.store.adhArtifacts.find(item=>item.id===result.artifactId);assert.equal(artifact.origin,'adh');assert.equal(artifact.sessionId,'adh_session_a');assert.equal(result.imageCount,2);
  const archive=await JSZip.loadAsync(fs.readFileSync(artifact.filePath));const firstPage=await archive.file('ppt/slides/slide1.xml').async('string'),secondPage=await archive.file('ppt/slides/slide2.xml').async('string');
  assert.match(firstPage,/ADH 指定的第一张分析页/);assert.match(firstPage,/结合江湾的文化节点布置步行入口/);assert.match(firstPage,/<p:pic>/);
  assert.match(secondPage,/ADH 指定的第二张分析页/);assert.match(secondPage,/沿河公共步道与展厅后勤分别组织/);assert.match(secondPage,/<p:pic>/);
  assert.equal(Object.keys(archive.files).filter(name=>/^ppt\/media\/.*\.png$/.test(name)).length,2);
  const sourceLinks=(await Promise.all(Object.keys(archive.files).filter(name=>/^ppt\/slides\/_rels\/.*\.rels$/.test(name)).map(name=>archive.file(name).async('string')))).join('\n');
  assert(sourceLinks.includes(a));assert(sourceLinks.includes(b));assert.equal(f.hub.state.jobs.length,0);assert.equal(f.hub.state.runs.length,0);assert.equal(f.counts().executionCalls,0);
  await assert.rejects(f.request('artifact_open',{artifactId:artifact.id}),error=>error.code==='USER_ACTION_REQUIRED');
  await assert.rejects(f.request('artifact_open',{artifactId:artifact.id},{sessionId:'adh_session_b',caller:'client'}),error=>error.code==='ARTIFACT_SCOPE');
  assert.deepEqual(await f.request('artifact_open',{artifactId:artifact.id},{caller:'client'}),{opened:true});
});

test('presentation scope rejects another ADH session research, foreign cases and images from an unchosen case',async t=>{
  const f=setup(t), archived=await f.archive(), record=f.research.get(archived.researchId), caseId=record.cases[0].caseId;
  const slides=[{title:'本会话分析',body:'围绕滨水公共空间组织案例参考。',sourceUrls:[a],imageAssetIds:[record.assetIds[0]]}];
  await assert.rejects(f.request('presentation_create',{researchId:record.id,caseIds:[caseId],slides},{sessionId:'adh_session_b'}),error=>error.code==='RESEARCH_SESSION');
  await assert.rejects(f.request('presentation_create',{caseIds:[f.foreignCase],slides}),error=>error.code==='CASE_SCOPE');
  const other=f.backend.addCase({projectId:f.currentProjectId,name:'未选中的案例',sourceUrl:'https://architecture.example.org/other',type:'culture'}), otherAsset=await extraAsset(f,other.id,f.currentProjectId);
  await assert.rejects(f.request('presentation_create',{researchId:record.id,caseIds:[caseId],slides:[{title:'错误选图',imageAssetIds:[otherAsset]}]}),error=>error.code==='IMAGE_SCOPE');
  await assert.rejects(f.request('presentation_create',{researchId:record.id,caseIds:[caseId],slides:[{title:'未选择图片',body:'有本地图片时需ADH自己选图。'}]}),error=>error.code==='IMAGE_SELECTION_REQUIRED');
  assert.equal(f.backend.store.adhArtifacts.length,0);assert.equal(f.hub.state.jobs.length,0);assert.equal(f.counts().executionCalls,0);
});

test('a pending Windows app chooser acknowledges handoff without blocking the composer and later reports failures in its own session', async t => {
  const f = setup(t), filePath = path.join(f.service.root, 'open-fixture.pptx');
  fs.mkdirSync(f.service.root, { recursive: true }); fs.writeFileSync(filePath, 'local opening fixture');
  f.backend.mutate(store => { store.adhArtifacts.push({ id: 'opening_fixture', projectId: f.currentProjectId, sessionId: 'adh_session_a', filePath, format: 'pptx', title: '打开测试' }); return true; });
  let finish, launches = 0;
  f.service.shell.openPath = () => new Promise(resolve => { launches++; finish = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.request('artifact_open', { artifactId: 'opening_fixture' }, { caller: 'client' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  t.mock.timers.tick(1200);
  assert.deepEqual(await pending, { opened: false, opening: true, message: '已交给系统打开，请完成系统提示。' });
  assert.equal((await f.request('artifact_open', { artifactId: 'opening_fixture' }, { caller: 'client' })).opening, true);
  assert.equal(launches, 1);
  assert.equal((await f.request('snapshot')).artifactOpen, null);
  finish('native application missing'); await new Promise(resolve => setImmediate(resolve));
  const snapshot = await f.request('snapshot');
  assert.equal(snapshot.artifactOpen.status, 'failed'); assert.match(snapshot.artifactOpen.message, /本机未能打开/);
  assert.equal((await f.request('snapshot', {}, { sessionId: 'adh_session_b' })).artifactOpen, null);
  f.service.shell.openPath = async () => { throw new Error('untranslated native failure'); };
  await assert.rejects(f.request('artifact_open', { artifactId: 'opening_fixture' }, { caller: 'client' }), error => error.code === 'ARTIFACT_OPEN_FAILED' && !error.message.includes('untranslated'));
  f.service.shell.openPath = async () => '';
  assert.deepEqual(await f.request('artifact_open', { artifactId: 'opening_fixture' }, { caller: 'client' }), { opened: true });
  assert.equal((await f.request('snapshot')).artifactOpen, null);
});

test('external execution requires explicit client selection and results remain confined to the originating ADH session',async t=>{
  const f=setup(t), connection=f.hub.saveConnection({id:'native-external-fixture',provider:'custom',mode:'cli',label:'外部协作测试执行器',command:process.execPath,args:[]});
  await assert.rejects(f.request('external_dispatch',{connectionId:connection.id,instruction:'读取固定的公开研究任务。'}),error=>error.code==='USER_ACTION_REQUIRED');
  await assert.rejects(f.request('select_executor',{executorId:connection.id}),error=>error.code==='USER_ACTION_REQUIRED');
  assert.equal(f.hub.state.jobs.length,0);assert.equal(f.counts().preflightCalls,0);
  await f.request('select_executor',{executorId:connection.id},{caller:'client'});
  const dispatched=await f.request('external_dispatch',{instruction:'读取固定的公开研究任务。'});await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.hub.state.jobs.length,1);assert.equal(f.hub.state.runs.length,1);assert.equal(f.counts().executionCalls,1);assert.equal(f.counts().preflightCalls,1);
  const returned=await f.request('external_status',{runId:dispatched.runId});assert.match(returned.output,/外部协作测试回传/);
  await assert.rejects(f.request('external_status',{runId:dispatched.runId},{sessionId:'adh_session_b'}),error=>error.code==='RUN_SCOPE');
});

test('switching project while external dispatch preflight waits cannot rebind the old instruction into the new project',async t=>{
  const f=setup(t), connection=f.hub.saveConnection({id:'preflight-external-fixture',provider:'custom',mode:'cli',label:'等待中的外部执行器',command:process.execPath,args:[]});
  await f.request('select_executor',{executorId:connection.id},{caller:'client'});
  let release;f.service.beforeExternalDispatch=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.request('external_dispatch',{instruction:'只属于江湾旧项目的任务内容。'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
  f.switchProject();await f.request('prepare_context');release();
  await assert.rejects(pending,error=>error.code==='PROJECT_CHANGED');
  assert.equal(f.hub.state.jobs.length,0);assert.equal(f.hub.state.runs.length,0);assert.equal(f.counts().executionCalls,0);
});

test('private loopback bridge rejects untrusted origins and decodes Chinese request text across UTF-8 packet boundaries',async t=>{
  const f=setup(t), connection=await f.service.start(), headers={'content-type':'application/json',authorization:`Bearer ${connection.token}`};
  const denied=await fetch(connection.endpoint,{method:'POST',headers:{...headers,origin:'https://untrusted.example.org'},body:JSON.stringify({action:'snapshot',sessionId:'network_session'})});assert.equal(denied.status,403);
  const missing=await fetch(connection.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(missing.status,403);
  const body=Buffer.from(JSON.stringify({action:'prepare_context',sessionId:'network_session',caller:'client',arguments:{turnKey:'中'}})), split=body.indexOf(Buffer.from('中'))+1;
  async function* chunks(){yield body.subarray(0,split);await new Promise(resolve=>setTimeout(resolve,15));yield body.subarray(split);}
  const response=await fetch(connection.endpoint,{method:'POST',headers,body:chunks(),duplex:'half'});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  assert.equal(f.service.sessions.get('network_session').turnKey,'中');assert.equal(f.hub.state.jobs.length,0);
});
