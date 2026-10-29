'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {AgentHub}=require('../backend/agent-hub.cjs');
const {probeAgentConnection,executeAgent}=require('../backend/agent-executors.cjs');
function fixture(execute,probe){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-validation-'));const backend=new LocalBackend({dataDir});const hub=new AgentHub({backend,execute,probe});return {hub,backend,dataDir};}
function connection(hub,extra={}){return hub.saveConnection({provider:'deepseek',mode:'acp',command:process.execPath,args:[path.join(__dirname,'fixtures/fake-agent.cjs'),'acp'],...extra});}
function create(hub,c,extra={}){return hub.createJob({title:'synthetic',instruction:'synthetic',skillId:'design-brief',connectionId:c.id,...extra});}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('ACP initialize-only returns protocol evidence without session or model output',async()=>{
  const result=await probeAgentConnection({mode:'acp',command:process.execPath,args:[path.join(__dirname,'fixtures/fake-agent.cjs'),'acp'],timeoutMs:3000},{cwd:__dirname});
  assert.deepEqual(result,{level:'protocol',code:'ACP_READY',protocolVersion:1,modelCalled:false,sessionCreated:false});
});
test('connection protocol check persists protocol-only state and never marks model verified',async()=>{
  const {hub}=fixture();const c=connection(hub);const result=await hub.probeConnection(c.id);assert.equal(result.ok,true);assert.equal(result.level,'protocol');assert.equal(result.verified,false);assert.equal(hub.connection(c.id).verifiedAt,null);assert.equal(hub.connection(c.id).validation.code,'ACP_READY');assert.equal(hub.state.jobs.length,0);
});

test('protocol rechecks preserve separate model evidence including failure until configuration changes',async()=>{
  const {hub}=fixture(async()=>({text:'AIDESIGNHUB_READY'}),async()=>({level:'protocol',code:'ACP_READY'}));const c=connection(hub);
  await hub.testConnection(c.id);await hub.probeConnection(c.id);assert.equal(hub.connection(c.id).validation.level,'protocol');assert.equal(hub.connection(c.id).modelValidation.verified,true);
  hub.execute=async()=>({text:'unexpected'});await hub.testConnection(c.id);await hub.probeConnection(c.id);assert.equal(hub.connection(c.id).modelValidation.ok,false);assert.equal(hub.connection(c.id).verifiedAt,null);
  hub.saveConnection({...c,label:'changed'});assert.equal(hub.connection(c.id).modelValidation,undefined);
});
test('synthetic model test uses dedicated cwd and never project grants, context or business jobs',async()=>{
  let captured;const {hub}=fixture(async(c,input)=>{captured={c,input};return {text:'AIDESIGNHUB_READY'};});const c=connection(hub,{cwd:__dirname,timeoutMs:300000});
  hub.setGateway({url:'http://127.0.0.1:49123',command:process.execPath,mcpScript:path.resolve(__dirname,'../scripts/hub-mcp.cjs'),cliScript:path.resolve(__dirname,'../scripts/hub-cli.cjs')});
  const result=await hub.testConnection(c.id);assert.equal(result.verified,true);assert.equal(captured.c.timeoutMs,60000);assert.notEqual(captured.input.cwd,__dirname);assert(captured.input.cwd.startsWith(path.join(hub.outputDir,'connection-tests')));assert.equal(captured.input.env,undefined);assert.equal(captured.c.mcpServers,undefined);assert(!captured.input.prompt.includes('江湾'));assert.equal(hub.access.grants.length,0);assert.equal(hub.state.jobs.length,0);assert.equal(hub.state.runs.length,0);
});
test('wrong marker and safe error categories do not become successful checks or leak provider error text',async()=>{
  const {hub}=fixture(async()=>({text:'Some other answer'}));const c=connection(hub);assert.equal((await hub.testConnection(c.id)).code,'UNEXPECTED_TEST_REPLY');assert.equal(hub.connection(c.id).verifiedAt,null);
  hub.execute=async()=>{throw Object.assign(new Error('private-token-123'),{code:'AGENT_FAILED',category:'authentication-failed'});};const result=await hub.testConnection(c.id);assert.equal(result.ok,false);assert.match(result.message,/认证失败/);assert(!JSON.stringify(hub.snapshot()).includes('private-token-123'));
});
test('configuration edits invalidate success and late check cannot paint replacement green',async()=>{
  let resolve;const {hub}=fixture(()=>new Promise(done=>{resolve=done;}));const c=connection(hub);const waiting=hub.testConnection(c.id);assert.equal((await hub.testConnection(c.id)).code,'BUSY');
  const replacement=hub.saveConnection({...c,label:'edited'});resolve({text:'AIDESIGNHUB_READY'});const result=await waiting;assert.equal(result.stale,true);assert.equal(hub.connection(replacement.id).validation,undefined);assert.equal(hub.connection(replacement.id).verifiedAt,null);
});
test('actual task success marks only matching connection and remains awaiting human review',async()=>{
  const {hub}=fixture(async()=>({text:'real business result'}));const c=connection(hub);const run=hub.startJob(create(hub,c).id);await tick();assert.equal(hub.state.runs[0].status,'awaiting_review');assert.equal(hub.connection(c.id).runtimeVerification.runId,run.id);
  hub.saveConnection({...c,label:'new settings'});assert.equal(hub.connection(c.id).runtimeVerification,undefined);
});
test('gateway does not silently authorize outbound project knowledge without task opt-in',async()=>{
  let captured;const {hub}=fixture(async(c,input)=>{captured={c,input};return {text:'ok'};});const c=connection(hub);
  hub.setGateway({url:'http://127.0.0.1:49123',command:process.execPath,mcpScript:path.resolve(__dirname,'../scripts/hub-mcp.cjs'),cliScript:path.resolve(__dirname,'../scripts/hub-cli.cjs')});
  const job=create(hub,c);const run=hub.startJob(job.id);await tick();assert.equal(run.input.allowProjectTools,false);assert.equal(captured.input.env,undefined);assert.equal(captured.c.mcpServers,undefined);assert.equal(hub.access.grants.length,0);
  assert.throws(()=>create(hub,c,{allowProjectTools:'yes'}),/布尔值/);
  const first=create(hub,c,{requestId:'same-access'});assert.throws(()=>create(hub,c,{requestId:'same-access',allowProjectTools:true}),/不同内容/);assert.equal(first.allowProjectTools,false);
});
test('synthetic marker cannot override failure, cancellation or nonzero exit metadata',async()=>{
  for(const extra of [{ok:false},{error:'failure'},{stopReason:'cancelled'},{status:'running'},{metadata:{exitCode:1}},{metadata:{stopReason:'max_tokens'}}]){
    const {hub}=fixture(async()=>({text:'AIDESIGNHUB_READY',...extra}));const c=connection(hub);assert.equal((await hub.testConnection(c.id)).verified,false);assert.equal(hub.connection(c.id).verifiedAt,null);
  }
});
test('connection check cleanup cannot write after disposal and a replacement owner loads',async()=>{
  let finish;const {hub,backend}=fixture(()=>new Promise(resolve=>{finish=resolve;}));const c=connection(hub);const pending=hub.testConnection(c.id);hub.dispose();const persisted=fs.readFileSync(backend.dbPath,'utf8');finish({text:'AIDESIGNHUB_READY'});assert.equal((await pending).stale,true);assert.equal(fs.readFileSync(backend.dbPath,'utf8'),persisted);
});
test('custom CLI missing executable fails a read-only probe without launching anything',async()=>{
  const {hub}=fixture();const c=connection(hub,{provider:'custom',mode:'cli',args:[]});hub.change(state=>{state.connections.find(item=>item.id===c.id).command=path.join(__dirname,'missing-agent.exe');return true;});assert.equal((await hub.probeConnection(c.id)).code,'SPAWN_FAILED');
});
test('generic CLI uses plain output and migration adds missing custom preset without editing existing connections',async()=>{
  const {hub,backend}=fixture(executeAgent);const c=connection(hub,{id:'custom',provider:'custom',mode:'cli',args:[path.join(__dirname,'fixtures/fake-agent.cjs'),'echo']});const run=hub.startJob(create(hub,c).id);
  for(let i=0;i<60&&['queued','running'].includes(hub.state.runs[0].status);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(hub.state.runs.find(item=>item.id===run.id).status,'awaiting_review');assert.match(hub.state.runs[0].output,/AIDesignHub 任务/);
  backend.mutate(store=>{store.agentHub.connections=store.agentHub.connections.filter(item=>item.provider!=='custom');store.agentHub.connections[0].label='keep user name';return true;});
  const reopened=new AgentHub({backend,execute:executeAgent});assert.equal(reopened.state.connections[0].label,'keep user name');assert.equal(reopened.state.connections.filter(item=>item.provider==='custom').length,1);assert.equal(reopened.connection('custom').mode,'handoff');
});
