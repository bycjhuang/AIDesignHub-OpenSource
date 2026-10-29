'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {AgentHub}=require('../backend/agent-hub.cjs');
const {CaseResearchService}=require('../backend/case-research.cjs');
const PRIMARY='https://architecture.example.org/fictional-museum';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const result=extra=>({matchStatus:'matched',primarySourceUrl:PRIMARY,name:'合成美术馆',area:'12000平方米',typeLabel:'美术馆',location:null,openingDate:null,designer:null,summary:'仅合成测试，不是真实项目',evidence:[{field:'name',value:'合成美术馆',sourceUrl:PRIMARY,quote:'项目名称：合成美术馆'},{field:'area',value:'12000平方米',sourceUrl:PRIMARY,quote:'建筑面积：12000平方米'},{field:'typeLabel',value:'美术馆',sourceUrl:PRIMARY,quote:'项目类型：美术馆'}],candidates:[],...extra});
const page=(url=PRIMARY,extra={})=>({url,finalUrl:url,title:'合成美术馆',text:'项目名称：合成美术馆。建筑面积：12000平方米。项目类型：美术馆。',images:[{url:'https://images.example.org/museum.jpg',alt:'项目图片'}],retrievedAt:1234,...extra});
function fixture({output=result(),execute,fetchPage=async url=>page(url)}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-name-'));const backend=new LocalBackend({dataDir});const inputs=[];
  const hub=new AgentHub({backend,execute:execute||(async(c,input)=>{inputs.push(input);return {text:JSON.stringify(typeof output==='function'?output():output)};})});
  const connection=hub.saveConnection({id:'name-agent',provider:'custom',mode:'cli',command:process.execPath,args:[]});const cases=new CaseResearchService({backend,hub,fetchPage});
  return {backend,hub,cases,connection,inputs,dataDir};
}
function collect(cases,extra={}){return cases.collect({projectId:'project_jiangwan',query:'合成美术馆 上海',connectionId:'name-agent',...extra});}
async function settle(cases){await tick();await cases.idle();await tick();}
test('name-only collection dispatches one true job, deduplicates and fills the same case only after public-source verification',async()=>{
  const {cases,hub,inputs,dataDir}=fixture();const item=collect(cases);assert.equal(item.source,'名称调研');assert.equal(item.sourceUrl,'');assert.equal(item.research.mode,'name');assert.equal(collect(cases,{query:' 合成美术馆  上海 '}).id,item.id);
  await settle(cases);const saved=cases.find(item.id);assert.equal(saved.sourceUrl,PRIMARY);assert.equal(saved.name,'合成美术馆');assert.equal(saved.area,'12000平方米');assert.equal(saved.type,'culture');assert.equal(saved.research.status,'awaiting_review');assert.equal(saved.research.fields.name.status,'source-quoted');assert.equal(saved.research.sourceValidation.primaryIdentityVerified,true);assert.equal(hub.state.jobs.length,1);assert.equal(inputs.length,1);assert.match(inputs[0].prompt,/web_search/);assert.match(inputs[0].prompt,/web_fetch/);assert.equal(inputs[0].env,undefined);assert.equal(hub.state.runs[0].input.allowProjectTools,false);
  const cached=cases.previews.read(item.id,PRIMARY);assert.equal(cached.candidates.length,1);assert.equal(cached.candidates[0].url,'https://images.example.org/museum.jpg');assert(fs.readdirSync(path.join(dataDir,'case-pages')).some(name=>name.endsWith('.sources.json')));assert.equal(hub.state.runs[0].status,'awaiting_review');cases.review(item.id,{approved:true});assert.equal(cases.find(item.id).research.status,'verified');assert.equal(hub.state.runs[0].status,'succeeded');cases.dispose();
});
test('name collection requires local automatic execution and never piggybacks MCP-only clients',()=>{
  const {cases,hub}=fixture();for(const connectionId of [null,'zcode','custom'])assert.throws(()=>collect(cases,{connectionId}),/自动执行器/);assert.throws(()=>cases.collect({projectId:'project_jiangwan',query:'合成',connectionId:'name-agent'},{allowDispatch:false}),/本机用户/);assert.throws(()=>collect(cases,{query:''}),/项目名称/);assert.throws(()=>collect(cases,{url:PRIMARY}),/一种/);assert.equal(hub.state.jobs.length,0);cases.dispose();
});
test('source validation is asynchronous and generic Agent approval is blocked until identity is verified',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const {cases,hub}=fixture({fetchPage:async url=>{await gate;return page(url);}});const item=collect(cases);await tick();const saved=cases.find(item.id);assert.equal(saved.research.status,'validating_sources');assert.equal(saved.sourceUrl,'');assert.throws(()=>hub.reviewRun(saved.research.runId,true),/不能提前验收/);assert.throws(()=>cases.review(item.id,{approved:true}),/尚不能审核/);assert.throws(()=>cases.retry(item.id),/核验/);release();await cases.idle();assert.equal(cases.find(item.id).research.status,'awaiting_review');cases.dispose();
});
test('ambiguous output stores safe unverified candidates and explicit query retry rejects old artifact then reuses the same card',async()=>{
  let phase=0;const {cases,hub}=fixture({output:()=>phase?result():{matchStatus:'ambiguous',primarySourceUrl:null,name:null,summary:'同名项目，请补充城市',evidence:[],candidates:[{name:'合成美术馆甲',url:PRIMARY,description:'甲市'},{name:'不安全链接',url:'file:///C:/secret',description:'待确认'}]}});
  const item=collect(cases);await settle(cases);const before=cases.find(item.id);assert.equal(before.research.status,'needs_clarification');assert.equal(before.sourceUrl,'');assert.equal(before.name,'合成美术馆 上海');assert.equal(before.research.candidates[0].status,'needs_verification');assert.equal(before.research.candidates[1].url,null);assert.throws(()=>hub.reviewRun(before.research.runId,true),/歧义/);const oldRunId=before.research.runId;
  phase=1;const retry=cases.retry(item.id,{query:'合成美术馆 甲市'});assert.equal(retry.id,item.id);assert.equal(hub.state.runs.find(run=>run.id===oldRunId).status,'rejected');await settle(cases);const saved=cases.find(item.id);assert.equal(saved.research.query,'合成美术馆 甲市');assert.equal(saved.research.revision,2);assert.equal(saved.research.history.length,1);assert.equal(saved.research.status,'awaiting_review');assert.equal(cases.list('project_jiangwan').filter(c=>c.research?.mode==='name').length,1);cases.dispose();
});
test('missing web-search capability produces a visible failure and cannot invent source or approve',async()=>{
  let reads=0;const {cases,hub}=fixture({output:{matchStatus:'not_found',primarySourceUrl:null,summary:'没有可用联网搜索工具',failureReason:'web_search_unavailable',evidence:[]},fetchPage:async()=>{reads++;return page();}});const item=collect(cases);await settle(cases);const saved=cases.find(item.id);assert.equal(saved.research.status,'failed');assert.equal(saved.research.failureReason,'web_search_unavailable');assert.equal(saved.sourceUrl,'');assert.equal(reads,0);assert.throws(()=>hub.reviewRun(saved.research.runId,true),/不能提前验收/);cases.dispose();
});
test('name research fetches at most four public evidence pages and preserves unread facts as unverified',async()=>{
  const values={name:'合成美术馆',area:'12000平方米',typeLabel:'美术馆',location:'合成市',openingDate:'2024年5月',designer:'合成院'};
  const fields=Object.keys(values),evidence=fields.map((field,index)=>({field,value:values[field],sourceUrl:index===0?PRIMARY:`https://architecture.example.org/source-${index}`,quote:`${field}：${values[field]}`}));let reads=[];
  const {cases}=fixture({output:result({...values,evidence}),fetchPage:async url=>{reads.push(url);const record=evidence.find(e=>e.sourceUrl===url);return page(url,{text:record.quote});}});const item=collect(cases);await settle(cases);const saved=cases.find(item.id);assert.equal(reads.length,4);assert.equal(reads[0],PRIMARY);assert.equal(saved.research.fields.name.status,'source-quoted');assert.equal(saved.research.fields.openingDate.status,'needs_verification');assert.equal(saved.research.fields.designer.status,'needs_verification');assert.equal(saved.research.sources.filter(s=>s.status==='read').length,4);cases.dispose();
});
test('unreadable primary source never becomes the case source, even if agent claims matched',async()=>{
  const {cases,hub}=fixture({fetchPage:async()=>{throw new Error('HTTP 403');}});const item=collect(cases);await settle(cases);const saved=cases.find(item.id);assert.equal(saved.sourceUrl,'');assert.equal(saved.name,'合成美术馆 上海');assert.equal(saved.research.status,'failed');assert.equal(saved.research.fields.name.status,'needs_verification');assert.equal(saved.research.sourceValidation.primaryIdentityVerified,false);assert.equal(cases.previews.read(item.id,PRIMARY),null);assert.throws(()=>hub.reviewRun(saved.research.runId,true),/不能提前验收/);cases.dispose();
});
test('fabricated quote or contradictory numeric values are not source verified',async()=>{
  const fabricated=result();fabricated.evidence[0].quote='项目名称：不存在的项目';const {cases}=fixture({output:fabricated});const item=collect(cases);await settle(cases);assert.equal(cases.find(item.id).sourceUrl,'');assert.equal(cases.find(item.id).research.status,'failed');cases.dispose();
  const wrong=result({area:'999平方米'});wrong.evidence[1].value='999平方米';const other=fixture({output:wrong});const next=collect(other.cases);await settle(other.cases);assert.equal(other.cases.find(next.id).research.fields.area.status,'needs_verification');assert.equal(other.cases.find(next.id).sourceUrl,PRIMARY);other.cases.dispose();
});
test('unsafe primary and supplementary URLs are rejected before any source request',async()=>{
  let reads=0;const {cases}=fixture({output:result({primarySourceUrl:'http://127.0.0.1/private'}),fetchPage:async()=>{reads++;return page();}});const item=collect(cases);await settle(cases);assert.equal(reads,0);assert.equal(cases.find(item.id).research.status,'failed');assert.equal(cases.find(item.id).sourceUrl,'');cases.dispose();
});
test('deleting a case during delayed source verification cannot resurrect case data or seed previews',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const {cases,backend}=fixture({fetchPage:async url=>{await gate;return page(url);}});const item=collect(cases);await tick();assert.equal(cases.find(item.id).research.status,'validating_sources');backend.removeCase(item.id);release();await cases.idle();assert.equal(cases.find(item.id),undefined);assert.equal(cases.previews.read(item.id,PRIMARY),null);cases.dispose();
});
test('revision and run checks discard late verification results instead of overwriting a newer attempt',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const {cases}=fixture({fetchPage:async url=>{await gate;return page(url);}});const item=collect(cases);await tick();cases.update(item.id,c=>{c.research.revision++;c.research.runId='newer-run';c.research.status='researching';c.name='新尝试不能覆盖';});release();await cases.idle();assert.equal(cases.find(item.id).name,'新尝试不能覆盖');assert.equal(cases.find(item.id).sourceUrl,'');assert.equal(cases.find(item.id).research.status,'researching');cases.dispose();
});
test('dispose aborts source work and a late reader cannot mark the artifact verified',async()=>{
  let release,signal;const gate=new Promise(resolve=>{release=resolve;});const {cases}=fixture({fetchPage:async(url,options)=>{signal=options.signal;await gate;return page(url);}});const item=collect(cases);await tick();cases.dispose();assert.equal(signal.aborted,true);release();await cases.idle();assert.equal(cases.find(item.id).research.status,'failed');assert.equal(cases.find(item.id).sourceUrl,'');
});
test('query retries reject duplicate normalized queries and preserve source history after rejection',async()=>{
  const {cases,hub}=fixture();const first=collect(cases);await settle(cases);hub.reviewRun(cases.find(first.id).research.runId,false);const other=collect(cases,{query:'另一美术馆'});await settle(cases);assert.throws(()=>cases.retry(first.id,{query:' 另一美术馆 '}),/相同名称/);assert.throws(()=>cases.retry(first.id,{connectionId:'zcode'}),/自动执行器/);assert.equal(cases.find(first.id).research.revision,1);assert.equal(other.research.mode,'name');cases.dispose();
});

test('unconfigured or vanished automatic executables and empty HTTP endpoints fail before creating a case',()=>{
  const {cases,hub,backend}=fixture();const before=backend.store.cases.length;
  for(const mode of ['cli','acp','openclaw-http']){
    hub.state.connections.push({id:`empty-${mode}`,provider:'custom',mode,command:'',endpoint:''});
    assert.throws(()=>collect(cases,{connectionId:`empty-${mode}`}),/配置/);
  }
  hub.state.connections.push({id:'gone',provider:'custom',mode:'cli',command:path.join(os.tmpdir(),'missing-aidesignhub-executable.exe')});
  assert.throws(()=>collect(cases,{connectionId:'gone'}),/不存在/);
  assert.equal(backend.store.cases.length,before);assert.equal(hub.state.jobs.length,0);cases.dispose();
});

test('opening dates need explicit actual opening semantics rather than publication completion or expectations',async()=>{
  for(const quote of ['发布时间：2026年10月4日','项目竣工时间：2026年10月4日','预计于2026年10月4日开业','Opening is scheduled for 2026-10-4','The museum opened on 2026-10-4','正式开业：2026年10月4日']){
    const expected=/^The museum opened|^正式开业/.test(quote)?'source-quoted':'needs_verification';
    const output=result();output.openingDate='2026-10-4';output.evidence.push({field:'openingDate',value:'2026-10-4',sourceUrl:PRIMARY,quote});
    const {cases}=fixture({output,fetchPage:async url=>page(url,{text:`${page().text}\n${quote}`})});
    const item=collect(cases);await settle(cases);assert.equal(cases.find(item.id).research.fields.openingDate.status,expected,quote);cases.dispose();
  }
});

test('a later supported primary-name quote is preferred to an earlier unread supplemental quote',async()=>{
  const output=result();output.evidence.unshift({field:'name',value:'合成美术馆',sourceUrl:'https://unread.example.org/name',quote:'合成美术馆的项目说明'});
  const {cases}=fixture({output,fetchPage:async url=>{if(url!==PRIMARY)throw new Error('synthetic blocked');return page(url);}});
  const item=collect(cases);await settle(cases);const saved=cases.find(item.id);assert.equal(saved.research.status,'awaiting_review');assert.equal(saved.research.fields.name.sourceUrl,PRIMARY);assert.equal(saved.sourceUrl,PRIMARY);cases.dispose();
});

test('retry keeps the old immutable source snapshot and clears an obsolete failure reason',async()=>{
  const {cases,dataDir}=fixture();const item=collect(cases);await settle(cases);
  const original=cases.find(item.id).research.sourceSnapshot;const firstPath=path.join(dataDir,'case-pages',original.file),firstBytes=fs.readFileSync(firstPath,'utf8');
  cases.review(item.id,{approved:false});cases.update(item.id,c=>{c.research.failureReason='old_test_failure';});cases.retry(item.id,{query:'合成美术馆 上海 测试二'});
  assert.equal(cases.find(item.id).research.failureReason,undefined);await settle(cases);
  const saved=cases.find(item.id);assert.equal(saved.research.history[0].sourceSnapshot.file,original.file);assert.notEqual(saved.research.sourceSnapshot.file,original.file);assert.equal(fs.readFileSync(firstPath,'utf8'),firstBytes);assert.equal(fs.readdirSync(path.join(dataDir,'case-pages')).filter(name=>name.endsWith('.sources.json')).length,2);cases.dispose();
});

test('case approval cannot bypass missing primary identity even for an imported stale awaiting-review record',async()=>{
  const {cases}=fixture();const item=collect(cases);await settle(cases);cases.update(item.id,c=>{delete c.research.sourceValidation;delete c.research.runId;});
  assert.throws(()=>cases.review(item.id,{approved:true}),/身份/);cases.dispose();
});
