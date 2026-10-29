const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');const {AgentHub,SCOPES}=require('../backend/agent-hub.cjs');const {CaseResearchService}=require('../backend/case-research.cjs');
const URL_SOURCE='https://projects.example.org/building?source=user#details';
const page={url:URL_SOURCE,finalUrl:'https://projects.example.org/building',title:'江湾美术馆',text:'项目名称：江湾美术馆。建筑面积：12000平方米。项目类型：美术馆。项目地址：上海市黄浦区。开业时间：2024年5月。设计单位：测试设计院。',retrievedAt:123456};
const facts={name:'江湾美术馆',area:'建筑面积 12000平方米',typeLabel:'美术馆',location:'上海市黄浦区',openingDate:'2024年5月',designer:'测试设计院',summary:'测试公开案例',evidence:[{field:'area',value:'建筑面积 12000平方米',sourceUrl:page.finalUrl,quote:'建筑面积：12000平方米'}]};
function fixture({execute,fetchPage=async()=>page,extractFacts=()=>facts,archiveArticle}={}){const backend=new LocalBackend({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-case-'))});const hub=new AgentHub({backend,execute});const cases=new CaseResearchService({backend,hub,fetchPage,extractFacts,archiveArticle});return {backend,hub,cases};}
function collect(cases,extra={}){return cases.collect({projectId:'project_jiangwan',url:URL_SOURCE,...extra});}
test('public link persists verbatim, extracts fields, deduplicates, requires human verification',async()=>{const {backend,cases}=fixture();const item=collect(cases);assert(['queued','fetching'].includes(item.research.status));await cases.idle();const saved=cases.find(item.id);assert.equal(saved.sourceUrl,URL_SOURCE);assert.equal(saved.research.finalUrl,page.finalUrl);assert.equal(saved.area,'建筑面积 12000平方米');assert.equal(saved.openingDate,'2024年5月');assert.equal(saved.research.status,'page_extracted');assert.equal(collect(cases).id,item.id);assert.equal(cases.review(item.id,{approved:true}).research.status,'verified');const reopened=new LocalBackend({dataDir:backend.dataDir});assert.equal(reopened.store.cases.find(c=>c.id===item.id).sourceUrl,URL_SOURCE);cases.dispose();});
test('pasting a public link into the name field is collected as a link, not a project name',async()=>{const {cases}=fixture();const item=cases.collect({projectId:'project_jiangwan',query:URL_SOURCE});assert.notEqual(cases.find(item.id).research.mode,'name');assert.equal(cases.find(item.id).research.query,undefined);assert.equal(item.sourceUrl,URL_SOURCE);await cases.idle();assert.equal(cases.find(item.id).research.status,'page_extracted');cases.dispose();});
test('retrying an old name research with a long public link works without selecting an Agent',async()=>{const {backend,cases,hub}=fixture();const longUrl=`https://mp.weixin.qq.com/s/article?detail=${'x'.repeat(600)}`;backend.mutate(store=>{store.cases.push({id:'case_name_retry',projectId:'project_jiangwan',name:longUrl,source:'名称调研',sourceUrl:'',type:'other',typeLabel:'待调研',location:'待核实',designer:'待核实',scope:'local',notes:'',research:{mode:'name',query:longUrl,status:'failed',fields:cases.emptyFields(),sources:[],candidates:[],connectionId:'zcode',allowDispatch:true,revision:1,createdAt:Date.now(),error:'旧的名称调研失败'}});return true;});const retried=cases.retry('case_name_retry',{query:longUrl,connectionId:null});assert.notEqual(retried.research.mode,'name');assert.equal(retried.sourceUrl,longUrl);assert.equal(retried.research.query,undefined);await cases.idle();assert.equal(cases.find('case_name_retry').research.status,'page_extracted');assert.equal(cases.find('case_name_retry').research.history[0].query,longUrl);assert.equal(hub.state.runs.length,0);cases.dispose();});
test('unknown facts remain null and publication date is not fabricated into opening',async()=>{const {cases}=fixture({extractFacts:()=>({name:'未知项目',summary:'发表于2026年，不代表开业',evidence:[]})});const item=collect(cases);await cases.idle();assert.equal(cases.find(item.id).area,null);assert.equal(cases.find(item.id).openingDate,null);assert.equal(cases.find(item.id).research.fields.openingDate.status,'not_found');cases.dispose();});
test('external research queued via the real Hub, structured evidence returns to same case',async()=>{const {hub,cases}=fixture();const item=collect(cases,{connectionId:'zcode'});await cases.idle();const saved=cases.find(item.id);assert.equal(saved.research.status,'waiting_agent');const grant=hub.createGrant({label:'external-case-agent',projectId:'project_jiangwan',memberId:'member_designer',scopes:SCOPES});const p=hub.authorize(grant.token);hub.claimRun(saved.research.runId,p);hub.submitResult(saved.research.runId,JSON.stringify({...facts,evidence:[...facts.evidence,{field:'name',value:facts.name,sourceUrl:page.finalUrl,quote:'项目名称：江湾美术馆'},{field:'openingDate',value:facts.openingDate,sourceUrl:page.finalUrl,quote:'开业时间：2024年5月'}]}),'research-result',p);assert.equal(cases.find(item.id).research.status,'awaiting_review');assert.equal(cases.find(item.id).research.fields.area.status,'source-quoted');assert.equal(cases.find(item.id).research.fields.designer.status,'unsupported');cases.review(item.id,{approved:true});assert.equal(hub.state.runs[0].status,'succeeded');assert.equal(cases.find(item.id).sourceUrl,URL_SOURCE);cases.dispose();});
test('malformed model output remains preserved and cannot bypass case validation via generic review',async()=>{const {hub,cases}=fixture();const item=collect(cases,{connectionId:'zcode'});await cases.idle();const runId=cases.find(item.id).research.runId;hub.submitResult(runId,'I did the research, trust me.','invalid',hub.localPrincipal('project_jiangwan'));assert.equal(cases.find(item.id).research.status,'failed');assert.throws(()=>hub.reviewRun(runId,true),/格式或来源/);assert.match(hub.state.runs[0].output,/trust me/);hub.reviewRun(runId,false);cases.retry(item.id,{connectionId:null});await cases.idle();assert.equal(cases.find(item.id).research.status,'page_extracted');cases.dispose();});
test('unseen external citations are labelled unverified and unsafe schemes not made clickable',async()=>{const {hub,cases}=fixture();const item=collect(cases,{connectionId:'zcode'});await cases.idle();const id=cases.find(item.id).research.runId;hub.submitResult(id,JSON.stringify({name:'新名称',location:'北京',area:'999㎡',evidence:[{field:'location',sourceUrl:'https://another.example.org/case',quote:'位于北京'},{field:'area',sourceUrl:'javascript:alert(1)',quote:'999㎡'}]}),'sources',hub.localPrincipal('project_jiangwan'));const fields=cases.find(item.id).research.fields;assert.equal(fields.location.status,'needs_verification');assert.equal(fields.area.sourceUrl,null);assert.equal(fields.area.status,'unsupported');assert.equal(cases.find(item.id).sourceUrl,URL_SOURCE);cases.dispose();});
test('blocked page surfaces recoverable failure and never creates invented facts',async()=>{const {cases}=fixture({fetchPage:async()=>{throw new Error('HTTP 403: 页面拒绝公开访问');}});const item=collect(cases);await cases.idle();assert.equal(cases.find(item.id).research.status,'failed');assert.match(cases.find(item.id).research.error,/403/);assert.equal(cases.find(item.id).research.fields.area.value,null);assert.equal(cases.find(item.id).sourceUrl,URL_SOURCE);cases.dispose();});
test('page and image archive survive an Agent launch failure and remain separate from research success',async()=>{
  let release,seenOptions,seenPayload,dispatches=0;const gate=new Promise(resolve=>{release=resolve;});
  const {cases,hub,backend}=fixture({fetchPage:async(url,options)=>{seenOptions=options;return {...page,images:[{url:'https://images.example.org/original.png'}],imagesComplete:true};},archiveArticle:async(payload,{page:received,onProgress})=>{seenPayload=payload;assert.equal(received.imagesComplete,true);onProgress({id:'article_fixture',articleId:'article_persisted_fixture',savedCount:1,candidates:[{}]});await gate;return {sessionId:'article_fixture',articleId:'article_persisted_fixture',status:'saved',savedCount:1,discoveredCount:1,failedCount:0,complete:true};}});
  hub.startJob=()=>{dispatches++;throw new Error('OpenClaw gateway-unreachable: 请先启动网关');};
  try{
    const item=collect(cases,{connectionId:'zcode'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(dispatches,1,'Agent dispatch must not wait for a whole image archive to finish.');
    assert.equal(cases.find(item.id).research.status,'page_extracted');assert.equal(cases.find(item.id).research.agentStatus,'failed');
    assert.equal(cases.find(item.id).research.pageStatus,'saved');assert.match(cases.find(item.id).research.agentError,/gateway-unreachable/);
    assert.equal(cases.find(item.id).imageArchive.status,'collecting');assert.equal(cases.find(item.id).imageArchive.savedCount,1);assert.equal(cases.find(item.id).imageArchive.sessionId,'article_fixture');assert.equal(cases.find(item.id).imageArchive.discoveredCount,1);
    assert.equal(seenOptions.maxImages,600);assert.equal(seenOptions.includeSmallImages,true);assert.equal(seenPayload.caseId,item.id);
    assert.throws(()=>cases.retry(item.id,{connectionId:null}),/仍在读取/,'A still active archive must not be duplicated.');
    release();await cases.idle();const saved=cases.find(item.id);assert.equal(saved.imageArchive.complete,true);assert.equal(saved.imageArchive.sessionId,'article_fixture');
    assert.match(fs.readFileSync(path.join(backend.dataDir,'case-pages',`${item.id}.txt`),'utf8'),/江湾美术馆/);
    const reopened=new LocalBackend({dataDir:backend.dataDir}).store.cases.find(c=>c.id===item.id);assert.equal(reopened.imageArchive.savedCount,1);assert.equal(reopened.imageArchive.articleId,'article_persisted_fixture');assert.equal(reopened.research.agentStatus,'failed');
    assert.equal(saved.research.status,'page_extracted','Image saving must never claim that Agent research succeeded.');
  }finally{release();await cases.idle();cases.dispose();}
});
test('a failed Agent run preserves extracted facts and can be reviewed without approving that run',async()=>{
  const {cases,hub}=fixture();try{
    const item=collect(cases,{connectionId:'zcode'});await cases.idle();const run=hub.state.runs.find(r=>r.id===cases.find(item.id).research.runId);
    run.status='failed';run.error='gateway-unreachable';cases.syncRuns();
    assert.equal(cases.find(item.id).research.status,'page_extracted');assert.equal(cases.find(item.id).area,facts.area);assert.equal(cases.find(item.id).research.agentStatus,'failed');
    cases.review(item.id,{approved:true});cases.syncRuns();assert.equal(cases.find(item.id).research.status,'verified');assert.equal(run.status,'failed','Manual page review does not turn a failed Agent run into success.');
  }finally{cases.dispose();}
});
test('image archive failure does not discard the article and late archive completion cannot resurrect a deleted case',async()=>{
  const {cases}=fixture({archiveArticle:async()=>{throw new Error('图片服务器拒绝读取');}});
  try{const item=collect(cases);await cases.idle();assert.equal(cases.find(item.id).research.status,'page_extracted');assert.equal(cases.find(item.id).imageArchive.status,'failed');assert.match(cases.find(item.id).imageArchive.error,/图片服务器/);}finally{cases.dispose();}
  let release;const gate=new Promise(resolve=>{release=resolve;});const second=fixture({archiveArticle:async()=>{await gate;return {sessionId:'deleted_late',status:'saved',savedCount:1};}});
  try{const item=collect(second.cases);await new Promise(resolve=>setImmediate(resolve));second.backend.removeCase(item.id);release();await second.cases.idle();assert.equal(second.cases.find(item.id),undefined);}finally{release();await second.cases.idle();second.cases.dispose();}
});
test('closing during an image archive cancels it and preserves the saved article and partial counts',async()=>{
  const {cases,backend,hub}=fixture({archiveArticle:async(payload,{signal,onProgress})=>{onProgress({sessionId:'partial_close',discoveredCount:5,savedCount:2});await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
  const item=collect(cases);await new Promise(resolve=>setImmediate(resolve));cases.dispose();await cases.idle();
  const saved=cases.find(item.id);assert.equal(saved.research.status,'page_extracted');assert.equal(saved.research.pageStatus,'saved');assert.equal(saved.imageArchive.status,'interrupted');assert.equal(saved.imageArchive.savedCount,2);assert.equal(saved.imageArchive.sessionId,'partial_close');
  backend.mutate(store=>{store.cases.find(c=>c.id===item.id).imageArchive.status='collecting';return true;});
  const restarted=new CaseResearchService({backend,hub});assert.equal(restarted.find(item.id).imageArchive.status,'interrupted');assert.equal(restarted.find(item.id).imageArchive.savedCount,2);assert.equal(restarted.find(item.id).research.status,'page_extracted');restarted.dispose();
});
test('concurrency bounded at three and deleting an in-flight case does not resurrect it',async()=>{let inFlight=0,max=0;let release;const gate=new Promise(resolve=>{release=resolve;});const {cases,backend}=fixture({fetchPage:async()=>{inFlight++;max=Math.max(max,inFlight);await gate;inFlight--;return page;}});const items=Array.from({length:7},(_,i)=>collect(cases,{url:`https://projects.example.org/${i}`}));backend.removeCase(items[0].id);release();await cases.idle();assert.equal(max,3);assert.equal(cases.find(items[0].id),undefined);assert.equal(cases.list('project_jiangwan').filter(c=>c.research).length,6);cases.dispose();});
test('MCP case tools are project-scoped and cannot launch a configured outbound executable',async()=>{const {cases,hub,backend}=fixture();const c=hub.saveConnection({provider:'hermes',mode:'cli',command:process.execPath,args:[]});const grant=hub.createGrant({label:'collector',projectId:'project_jiangwan',memberId:'member_designer',scopes:['cases:read','cases:write']});const p=hub.authorize(grant.token);await assert.rejects(hub.callTool('hub_case_collect',{url:URL_SOURCE,connectionId:c.id},p),/主动派单/);await hub.callTool('hub_case_collect',{url:URL_SOURCE},p);await cases.idle();assert((await hub.callTool('hub_case_list',{},p)).some(c=>c.sourceUrl===URL_SOURCE));backend.mutate(store=>{store.cases.push({id:'foreign',projectId:'another',name:'不可见'});return true;});assert(!(await hub.callTool('hub_case_list',{},p)).some(c=>c.id==='foreign'));cases.dispose();});
test('retry does not retain obsolete area when the new source no longer gives it',async()=>{let turn=0;const {cases}=fixture({extractFacts:()=>++turn===1?facts:{name:'江湾美术馆',evidence:[]}});const item=collect(cases);await cases.idle();assert(cases.find(item.id).area);cases.retry(item.id);await cases.idle();assert.equal(cases.find(item.id).area,null);assert.equal(cases.find(item.id).research.history.length,1);cases.dispose();});
test('multiple area bases retain their separate source excerpts in the saved field',async()=>{const {cases}=fixture({extractFacts:()=>({...facts,area:'建筑面积：12000平方米；用地面积：9000平方米',evidence:[{field:'area',quote:'建筑面积：12000平方米',sourceUrl:page.finalUrl},{field:'area',quote:'用地面积：9000平方米',sourceUrl:page.finalUrl}]})});const item=collect(cases);await cases.idle();assert.match(cases.find(item.id).research.fields.area.quote,/建筑面积.*\n用地面积/);cases.dispose();});

test('inbound MCP collection cannot gain outbound execution permission while its page is fetching',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let outboundCalls=0;
  const {backend,hub,cases}=fixture({
    fetchPage:async()=>{await gate;return page;},
    execute:async()=>{outboundCalls++;return {text:JSON.stringify(facts)};},
  });
  try {
    const grant=hub.createGrant({label:'inbound-collector',projectId:'project_jiangwan',memberId:'member_designer',scopes:['cases:write']});
    const principal=hub.authorize(grant.token);
    const item=await hub.callTool('hub_case_collect',{url:URL_SOURCE,connectionId:'hermes'},principal);
    assert.equal(cases.find(item.id).research.status,'fetching');
    hub.saveConnection({id:'hermes',provider:'hermes',mode:'cli',command:process.execPath,args:[]});
    release();await cases.idle();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(outboundCalls,0,'Changing connection mode must not authorize an external request to launch a local agent.');
    assert.equal(hub.state.runs.some(run=>run.mode==='cli'),false);
    const reopened=new LocalBackend({dataDir:backend.dataDir});
    assert.equal(reopened.store.cases.find(entry=>entry.id===item.id).research.allowDispatch,false,'The incoming request authorization must survive persistence.');
  } finally {release();await cases.idle();cases.dispose();}
});

test('retry refuses a queued case without duplicating fetches or changing its revision',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const calls=new Map();
  const {cases}=fixture({fetchPage:async url=>{calls.set(url,(calls.get(url)||0)+1);await gate;return page;}});
  try {
    const items=Array.from({length:4},(_,index)=>collect(cases,{url:`https://projects.example.org/queued-${index}`}));
    const queued=cases.find(items[3].id);const revision=queued.research.revision;
    assert.equal(queued.research.status,'queued');
    assert.throws(()=>cases.retry(queued.id),'A case waiting behind the concurrency limit must not be queued again.');
    assert.equal(cases.find(queued.id).research.revision,revision);
    release();await cases.idle();
    for(const item of items){
      assert.equal(calls.get(item.sourceUrl),1,'Every collected URL must be fetched exactly once.');
      assert.equal(cases.find(item.id).research.status,'page_extracted');
    }
  } finally {release();await cases.idle();cases.dispose();}
});

test('quoted evidence must support the reported value and every area or opening-date number',async()=>{
  const {cases}=fixture();
  try {
    const item=collect(cases);await cases.idle();const saved=cases.find(item.id);
    const variants=[
      {label:'Evidence value contradicts a non-numeric field',field:'location',value:'北京市',evidenceValue:'上海市黄浦区',quote:'项目地址：上海市黄浦区',status:'needs_verification'},
      {label:'Area number is absent from the matching quote',field:'area',value:'999平方米',evidenceValue:'999平方米',quote:'建筑面积：12000平方米',status:'needs_verification'},
      {label:'GSF must not validate against the same number of square meters',field:'area',value:'12000 GSF',evidenceValue:'12000 GSF',quote:'建筑面积：12000平方米',status:'needs_verification'},
      {label:'SF must not validate against the same number of square meters',field:'area',value:'12000 SF',evidenceValue:'12000 SF',quote:'建筑面积：12000平方米',status:'needs_verification'},
      {label:'A GSF unit adjacent to its number must not bypass unit checks',field:'area',value:'12000GSF',evidenceValue:'12000GSF',quote:'建筑面积：12000平方米',status:'needs_verification'},
      {label:'A substring of a larger number is not matching numeric evidence',field:'area',value:'120平方米',evidenceValue:'120平方米',quote:'建筑面积：12000平方米',status:'needs_verification'},
      {label:'Opening year differs from the quote',field:'openingDate',value:'2025年5月',evidenceValue:'2025年5月',quote:'开业时间：2024年5月',status:'needs_verification'},
      {label:'Matching year alone cannot validate a different opening month',field:'openingDate',value:'2024年6月',evidenceValue:'2024年6月',quote:'开业时间：2024年5月',status:'needs_verification'},
      {label:'Matching value and number preserve valid evidence',field:'area',value:'建筑面积 12000平方米',evidenceValue:'建筑面积 12000平方米',quote:'建筑面积：12000平方米',status:'source-quoted'},
      {label:'Optional evidence value may be omitted when the quote supports the numbers',field:'openingDate',value:'2024年5月',quote:'开业时间：2024年5月',status:'source-quoted'},
    ];
    for(const variant of variants){
      const evidence={field:variant.field,sourceUrl:page.finalUrl,quote:variant.quote};
      if(variant.evidenceValue!==undefined)evidence.value=variant.evidenceValue;
      const parsed=cases.parseAgentResult(saved,{output:JSON.stringify({[variant.field]:variant.value,evidence:[evidence]})});
      assert.equal(parsed.fields[variant.field].status,variant.status,variant.label);
      assert.equal(parsed.fields[variant.field].value,variant.value,'Keep the candidate visible for human review instead of silently rewriting it.');
    }
  } finally {cases.dispose();}
});

test('extracted and agent-reported case categories match the existing UI filter values',async()=>{
  const variants=[
    ['博物馆','culture'],['天文馆','culture'],['美术馆','culture'],['museum','culture'],['gallery','culture'],
    ['酒店及商业配套','hotel'],['hotel with retail','hotel'],['住宅','residential'],['housing','residential'],
    ['商业综合体','commercial'],['office','commercial'],['学校','other'],['未注明','other'],
  ];
  let extractedType='';const {backend,hub,cases}=fixture({extractFacts:()=>({...facts,typeLabel:extractedType})});
  try {
    for(const [index,[typeLabel,expected]] of variants.entries()){
      extractedType=typeLabel;
      const item=collect(cases,{url:`https://projects.example.org/category-${index}`,connectionId:'zcode'});
      await cases.idle();let saved=cases.find(item.id);
      assert.equal(saved.type,expected,`Page extraction category: ${typeLabel}`);
      assert.equal(saved.research.status,'waiting_agent');
      const [agentType,agentExpected]=variants[(index+1)%variants.length];
      hub.submitResult(saved.research.runId,JSON.stringify({typeLabel:agentType,evidence:[]}),`category-${index}`,hub.localPrincipal('project_jiangwan'));
      saved=cases.find(item.id);
      assert.equal(saved.type,agentExpected,`Agent result category: ${agentType}`);
      assert.equal(saved.research.fields.typeLabel.status,'unsupported','Categorization must not turn an unsupported value into verified evidence.');
      assert.equal(saved.research.status,'awaiting_review');
    }
    const reopened=new LocalBackend({dataDir:backend.dataDir});
    for(const item of cases.list('project_jiangwan').filter(entry=>entry.research))assert.equal(reopened.store.cases.find(entry=>entry.id===item.id).type,item.type);
  } finally {cases.dispose();}
});

test('explicit null clears extracted facts and evidence while omitted fields remain unchanged',async()=>{
  const {backend,hub,cases}=fixture();
  try {
    const item=collect(cases,{connectionId:'zcode'});await cases.idle();
    const before=structuredClone(cases.find(item.id));
    const output={area:null,openingDate:null,evidence:[...facts.evidence,{field:'openingDate',sourceUrl:page.finalUrl,quote:'开业时间：2024年5月'}]};
    hub.submitResult(before.research.runId,JSON.stringify(output),'null-facts',hub.localPrincipal('project_jiangwan'));
    const saved=cases.find(item.id);
    for(const key of ['area','openingDate']){
      assert.equal(saved[key],null);
      assert.deepEqual(saved.research.fields[key],{value:null,quote:null,sourceUrl:null,status:'not_found'},`Explicit null must also clear stale evidence for ${key}.`);
    }
    for(const key of ['name','typeLabel','location','designer'])assert.deepEqual(saved.research.fields[key],before.research.fields[key],`Omitted ${key} must retain the existing partial-result behavior.`);
    assert.equal(saved.research.status,'awaiting_review','Null corrections are still subject to human review.');
    const reopened=new LocalBackend({dataDir:backend.dataDir});const persisted=reopened.store.cases.find(entry=>entry.id===item.id);
    assert.deepEqual(persisted.research.fields,saved.research.fields);
    assert.equal(persisted.sourceUrl,URL_SOURCE);
  } finally {cases.dispose();}
});

test('an all-null agent result remains unknown and cannot be approved as verified facts',async()=>{
  const {hub,cases}=fixture();
  try {
    const item=collect(cases,{connectionId:'zcode'});await cases.idle();const saved=cases.find(item.id);
    const output={name:null,area:null,typeLabel:null,location:null,openingDate:null,designer:null,evidence:[]};
    hub.submitResult(saved.research.runId,JSON.stringify(output),'all-unknown',hub.localPrincipal('project_jiangwan'));
    const result=cases.find(item.id);
    for(const field of Object.values(result.research.fields))assert.deepEqual(field,{value:null,quote:null,sourceUrl:null,status:'not_found'});
    assert.equal(result.type,'other');
    assert.equal(result.research.status,'awaiting_review');
    assert.throws(()=>cases.review(item.id,{approved:true}),/没有可核实/);
    assert.throws(()=>hub.reviewRun(result.research.runId,true),/没有可核实/,'Generic Agent review must not bypass the case field guard.');
    assert.equal(hub.state.runs.find(run=>run.id===result.research.runId).status,'awaiting_review');
  } finally {cases.dispose();}
});
