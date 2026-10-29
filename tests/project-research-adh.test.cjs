'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { setup, output, a } = require('./fixtures/native-adh-backend-fixture.cjs');

test('native ADH ingestion verifies sources, stores actual local high-resolution images and never creates an external job or run', async t=>{
  const f=setup(t), before={jobs:f.hub.state.jobs.length,runs:f.hub.state.runs.length};
  const record=await f.research.ingestAdhResult({projectId:f.currentProjectId,sessionId:'adh_session_a',brief:'为江湾分析滨水文化空间',result:output()});
  assert.equal(record.origin,'adh');assert.equal(record.adhSessionId,'adh_session_a');assert.equal(record.status,'complete');
  assert.equal(record.cases.length,1);assert(record.cases[0].caseId);assert.equal(record.assetIds.length,2);
  assert(record.sources.every(source=>source.status==='read'));assert.equal(record.cases[0].fields.name.status,'source-quoted');
  assert.equal(f.hub.state.jobs.length,before.jobs);assert.equal(f.hub.state.runs.length,before.runs);assert.deepEqual(f.counts(),{executionCalls:0,preflightCalls:0});
  for(const id of record.assetIds){const asset=f.images.getAsset(id);assert(fs.statSync(asset.path).size>0);assert(Math.max(asset.width,asset.height)>=1600);assert.equal(asset.projectId,f.currentProjectId);assert(asset.caseIds.includes(record.cases[0].caseId));}
  const reopened=new LocalBackend({dataDir:f.directory});assert.equal(reopened.store.projectResearch.find(item=>item.id===record.id).origin,'adh');
  const saved=JSON.parse(fs.readFileSync(path.join(f.research.snapshotDir,`${record.id}.adh-result.json`),'utf8'));assert.equal(saved.cases[0].name,'滨水样例美术馆');
});

test('native ADH idempotency is scoped to the originating session and does not duplicate archived cases or external execution',async t=>{
  const f=setup(t), data=output();
  const first=await f.research.ingestAdhResult({projectId:f.currentProjectId,sessionId:'adh_session_a',result:data});
  const repeated=await f.research.ingestAdhResult({projectId:f.currentProjectId,sessionId:'adh_session_a',result:data});
  const another=await f.research.ingestAdhResult({projectId:f.currentProjectId,sessionId:'adh_session_b',result:data});
  assert.equal(first.id,repeated.id);assert.notEqual(first.id,another.id);assert.equal(first.cases[0].caseId,another.cases[0].caseId);
  assert.equal(f.backend.store.cases.filter(item=>item.projectId===f.currentProjectId&&item.sourceUrl===a).length,1);
  assert.equal(f.hub.state.jobs.length,0);assert.equal(f.hub.state.runs.length,0);assert.equal(f.counts().executionCalls,0);
});

test('native ADH rejects malformed results before persistence and retains uncertain source evidence without inventing images',async t=>{
  const f=setup(t), initial=f.research.list(f.currentProjectId).length;
  await assert.rejects(f.research.ingestAdhResult({projectId:f.currentProjectId,sessionId:'adh_session_a',result:{cases:[]}}),/1–6/);
  assert.equal(f.research.list(f.currentProjectId).length,initial);
  const result=output();result.cases[0].evidence[0].quote='项目名称：根本没有的项目';
  const record=await f.research.ingestAdhResult({projectId:f.currentProjectId,sessionId:'adh_session_a',result});
  assert.equal(record.status,'partial');assert.equal(record.cases[0].caseId,undefined);assert.equal(record.assetIds.length,0);
  assert.equal(f.hub.state.jobs.length,0);assert.equal(f.hub.state.runs.length,0);
});
