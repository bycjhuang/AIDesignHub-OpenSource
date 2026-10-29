const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {AgentHub,SCOPES}=require('../backend/agent-hub.cjs');
const {AgentGateway}=require('../backend/agent-gateway.cjs');
const {acquireServiceLock}=require('../backend/service-lock.cjs');
function fixture(execute) {const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-core-'));const backend=new LocalBackend({dataDir});const hub=new AgentHub({backend,execute});return {backend,hub,dataDir};}
function grant(hub,scopes=SCOPES,projectId='project_jiangwan',memberId='member_designer') {const g=hub.createGrant({label:'test client',projectId,memberId,scopes});return {g,p:hub.authorize(g.token)};}
function job(hub,extra={}) {return hub.createJob({title:'研究测试',instruction:'输出有证据的设计建议',skillId:'design-brief',connectionId:'zcode',...extra});}

test('six independent presets including custom CLI and versioned skills; no model required',()=>{const {hub}=fixture();assert.equal(hub.snapshot().catalog.length,6);assert.equal(hub.snapshot().skills.length,4);assert.equal(hub.snapshot().runs.length,0);assert.equal(hub.connection('custom').mode,'handoff');});
test('tokens hashed separately, scoped, revocable and not in project backups',async()=>{const {hub,backend,dataDir}=fixture();const {g,p}=grant(hub,['project:read']);assert(!JSON.stringify(backend.exportSnapshot()).includes(g.token));assert(!fs.readFileSync(path.join(dataDir,'agent-access.json'),'utf8').includes(g.token));assert.equal(hub.listTools(p).length,1);await assert.rejects(hub.callTool('hub_task_list',{},p),/权限/);hub.revokeGrant(g.id);assert.equal(hub.authorize(g.token),null);await assert.rejects(hub.callTool('hub_project_context',{},p),/撤销/);});
test('local file paths and settings excluded from project context',async()=>{const {hub}=fixture();const {p}=grant(hub);const data=await hub.callTool('hub_project_context',{},p);assert.equal(data.project.id,'project_jiangwan');assert.equal(data.settings,undefined);assert.equal(data.project.folderPath,undefined);});
test('grant activity shows a client actually connected, without storing arguments',async()=>{
  const {hub,dataDir}=fixture();const {g,p}=grant(hub,['project:read']);
  assert.equal(hub.snapshot().grants.find(item=>item.id===g.id).callCount,undefined);
  await hub.callTool('hub_project_context',{marker:'SENSITIVE-ARG-MARKER'},p);
  const listed=hub.snapshot().grants.find(item=>item.id===g.id);
  assert.equal(listed.callCount,1);assert.equal(listed.lastTool,'hub_project_context');assert.ok(listed.lastCallAt>0);assert.equal(listed.tokenHash,undefined);
  await assert.rejects(hub.callTool('hub_task_list',{},p),/权限/);
  assert.equal(hub.snapshot().grants.find(item=>item.id===g.id).callCount,1,'a rejected scope is not counted as activity');
  assert(!fs.readFileSync(path.join(dataDir,'agent-access.json'),'utf8').includes('SENSITIVE-ARG-MARKER'));
  assert.equal(new AgentHub({backend:new LocalBackend({dataDir})}).snapshot().grants.find(item=>item.id===g.id).callCount,1);
});
test('external task create → start → claim → report → artifact → local review',async()=>{const {hub,backend}=fixture();const {p}=grant(hub);const payload={title:'外部研究',instruction:'研究测试',skillId:'design-brief',connectionId:'zcode',requestId:'first'};const j=await hub.callTool('hub_task_create',payload,p);assert.equal((await hub.callTool('hub_task_create',payload,p)).id,j.id);const run=await hub.callTool('hub_task_start',{jobId:j.id},p);assert.equal(run.status,'waiting_agent');const claimed=hub.claimRun(run.id,p);assert.equal(claimed.input.skill.version,'1.0.0');hub.reportRun(run.id,{message:'完成检索'},p);const artifact=hub.submitResult(run.id,'结论及证据','result-one',p);assert.equal(artifact.status,'awaiting_review');assert.equal(hub.submitResult(run.id,'结论及证据','result-one',p).artifactId,artifact.artifactId);assert.throws(()=>hub.submitResult(run.id,'篡改','result-one',p),/不同内容/);assert.throws(()=>backend.updateTask(j.taskId,{status:'done'}),/审核/);hub.reviewRun(run.id,true);assert.equal(hub.snapshot().jobs[0].status,'done');assert.equal(backend.store.tasks.find(t=>t.id===j.taskId).status,'done');});
test('two clients cannot claim or submit the same running task',()=>{const {hub}=fixture();const a=grant(hub),b=grant(hub);const r=hub.startJob(job(hub).id);hub.claimRun(r.id,a.p);assert.throws(()=>hub.claimRun(r.id,b.p),/不可认领/);assert.throws(()=>hub.submitResult(r.id,'冒领成果','r',b.p),/自己认领/);assert.throws(()=>hub.startJob(r.jobId),/重复启动/);});
test('cross-project grant cannot inspect/claim foreign run',async()=>{const {hub,backend}=fixture();backend.mutate(store=>{store.projects.push({id:'other',name:'其他项目'});store.members.push({id:'other-member',projectId:'other',active:true});return true;});const {p}=grant(hub,SCOPES,'other','other-member');const r=hub.startJob(job(hub).id);assert.deepEqual(await hub.callTool('hub_run_list',{},p),[]);assert.throws(()=>hub.claimRun(r.id,p),/不属于/);});
test('lease expiry and restart are interrupted, never successful',()=>{const {hub,backend,dataDir}=fixture();const {p}=grant(hub);let clock=1000000000000;hub.clock=()=>clock;const r=hub.startJob(job(hub).id);hub.claimRun(r.id,p);clock+=11*60000;hub.expireLeases();assert.equal(hub.snapshot().runs[0].status,'interrupted');assert.throws(()=>hub.submitResult(r.id,'late','late',p),/当前状态/);const next=hub.startJob(r.jobId);hub.claimRun(next.id,p);const reopened=new AgentHub({backend:new LocalBackend({dataDir})});assert.equal(reopened.snapshot().runs.find(x=>x.id===next.id).status,'interrupted');assert.equal(backend.store.agentHub.runs.length,2);});
test('dependency gate and rejected review permit an explicit retry',()=>{const {hub}=fixture();const first=job(hub);const second=job(hub,{dependsOn:[first.id]});assert.throws(()=>hub.startJob(second.id),/前置任务/);const r=hub.startJob(first.id);hub.submitResult(r.id,'成果','r',hub.localPrincipal(r.projectId));hub.reviewRun(r.id,false);const retry=hub.startJob(first.id);hub.submitResult(retry.id,'修正成果','r2',hub.localPrincipal(r.projectId));hub.reviewRun(retry.id,true);assert.equal(hub.startJob(second.id).status,'waiting_agent');});
test('safe connection config: no shell, no embedded credentials, no plaintext remote HTTP',async()=>{const {hub}=fixture();assert.throws(()=>hub.saveConnection({provider:'chatgpt',mode:'cli'}),/不支持/);assert.throws(()=>hub.saveConnection({provider:'openclaw',mode:'openclaw-http',endpoint:'http://example.com'}),/HTTPS/);assert.throws(()=>hub.saveConnection({provider:'openclaw',mode:'openclaw-http',endpoint:'https://u:p@example.com'}),/凭据/);const c=hub.saveConnection({provider:'hermes',mode:'cli',command:process.execPath,args:['--version']});assert.equal((await hub.probeConnection(c.id)).verified,false);});
test('external grant cannot cause outbound command execution',async()=>{const {hub}=fixture();const c=hub.saveConnection({provider:'hermes',mode:'cli',command:process.execPath,args:['--version']});const j=job(hub,{connectionId:c.id});const {p}=grant(hub);await assert.rejects(hub.callTool('hub_task_start',{jobId:j.id},p),/不能启动/);});
test('real adapter entry is async and results wait for review',async()=>{const {hub}=fixture(async(_c,{onEvent})=>{onEvent({message:'正在处理'});return {text:'执行结果',sessionId:'fixture'};});const c=hub.saveConnection({provider:'hermes',mode:'cli',command:process.execPath,args:[]});const r=hub.startJob(job(hub,{connectionId:c.id}).id);assert.equal(r.status,'queued');await new Promise(resolve=>setImmediate(resolve));assert.equal(hub.snapshot().runs[0].status,'awaiting_review');assert.equal(hub.snapshot().runs[0].sessionId,'fixture');assert(hub.snapshot().events.some(e=>e.message==='正在处理'));});

test('failed Gateway preflight is actionable, retryable and never becomes a research result',async()=>{
  const {hub}=fixture(async()=>{throw Object.assign(new Error('raw provider private-token'),{code:'GATEWAY_UNREACHABLE',phase:'preflight'});});
  const c=hub.saveConnection({provider:'hermes',mode:'cli',command:process.execPath,args:[]});
  const j=job(hub,{connectionId:c.id}),r=hub.startJob(j.id);await new Promise(resolve=>setImmediate(resolve));
  const saved=hub.state.runs.find(item=>item.id===r.id);
  assert.equal(saved.status,'failed');assert.equal(saved.output,null);assert.match(saved.error,/openclaw gateway run/);assert.ok(!saved.error.includes('private-token'));
  assert.deepEqual(saved.failure,{code:'GATEWAY_UNREACHABLE',category:null,phase:'preflight',taskSubmitted:false,automaticRetry:false});
  assert.equal(hub.state.jobs.find(item=>item.id===j.id).status,'todo');
  assert.equal(hub.startJob(j.id).status,'queued');
});
test('external stop is honest about unknown remote termination',()=>{const {hub}=fixture();const {p}=grant(hub);const r=hub.startJob(job(hub).id);hub.claimRun(r.id,p);assert.equal(hub.cancelRun(r.id).status,'cancel_requested');assert.throws(()=>hub.submitResult(r.id,'late','x',p),/当前状态/);});
test('service owner lock blocks second writers, releasing permits a new owner',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-lock-'));const release=acquireServiceLock(dir);assert.throws(()=>acquireServiceLock(dir),/已由/);release();acquireServiceLock(dir)();});
test('failed mutation rolls back memory and disk',()=>{const {backend}=fixture();const previous=backend.store.projects[0].name;assert.throws(()=>backend.mutate(store=>{store.projects[0].name='bad';throw new Error('failure');}));assert.equal(backend.store.projects[0].name,previous);assert.equal(JSON.parse(fs.readFileSync(backend.dbPath,'utf8')).projects[0].name,previous);});
test('real HTTP end-to-end uses actual core, not a fake service',async()=>{const {hub}=fixture();const {g}=grant(hub);const gateway=new AgentGateway({hub});const {url}=await gateway.start();try{const call=async(name,args)=>{const response=await fetch(`${url}/v1/call`,{method:'POST',headers:{Authorization:`Bearer ${g.token}`,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});assert.equal(response.status,200);return (await response.json()).result;};const j=await call('hub_task_create',{title:'HTTP研究',instruction:'返回设计资料',skillId:'design-brief',connectionId:'zcode',requestId:'http-create'});const r=await call('hub_task_start',{jobId:j.id});await call('hub_run_claim',{runId:r.id});const result=await call('hub_artifact_submit',{runId:r.id,content:'HTTP真实闭环成果',requestId:'http-result'});assert.equal(result.status,'awaiting_review');assert.equal(hub.snapshot().runs[0].output,'HTTP真实闭环成果');}finally{await gateway.stop();hub.dispose();}});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function pendingExecutor(){let resolve,reject,input,connection;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {execute:(c,i)=>{connection=c;input=i;return promise;},resolve,reject,get input(){return input;},get connection(){return connection;}};}
function outbound(hub,mode='cli',allowProjectTools=false){const c=hub.saveConnection({provider:mode==='acp'?'deepseek':'hermes',mode,command:process.execPath,args:[]});return hub.startJob(job(hub,{connectionId:c.id,allowProjectTools}).id);}
function gatewaySettings(command='node'){return {url:'http://127.0.0.1:49123',command,mcpScript:path.resolve(__dirname,'../scripts/hub-mcp.cjs'),cliScript:path.resolve(__dirname,'../scripts/hub-cli.cjs')};}
function forceRollback(backend){assert.throws(()=>backend.mutate(store=>{store.projects[0].name='must roll back';throw new Error('synthetic rollback');}),/synthetic/);}

test('asynchronous progress and completion survive unrelated store replacement',async()=>{
  const pending=pendingExecutor();const {hub,backend}=fixture(pending.execute);const run=outbound(hub);await tick();
  const stale=hub.state.runs.find(r=>r.id===run.id);forceRollback(backend);assert.notEqual(hub.state.runs.find(r=>r.id===run.id),stale);
  pending.input.onEvent({message:'after rollback progress'});pending.resolve({text:'after rollback artifact',sessionId:'fresh-session'});await tick();
  const saved=hub.snapshot().runs.find(r=>r.id===run.id);assert.equal(saved.status,'awaiting_review');assert.equal(saved.sessionId,'fresh-session');assert.equal(saved.output,'after rollback artifact');
  assert(hub.snapshot().events.some(e=>e.runId===run.id&&e.message==='after rollback progress'));
  assert.equal(JSON.parse(fs.readFileSync(backend.dbPath,'utf8')).agentHub.runs.find(r=>r.id===run.id).status,'awaiting_review');
});

test('asynchronous failure after rollback updates the current run, job and business task',async()=>{
  const pending=pendingExecutor();const {hub,backend}=fixture(pending.execute);const run=outbound(hub);await tick();forceRollback(backend);
  pending.reject(new Error('failure after rollback'));await tick();const saved=hub.snapshot().runs.find(r=>r.id===run.id);
  assert.equal(saved.status,'failed');assert.equal(saved.error,'failure after rollback');assert.equal(hub.state.jobs.find(j=>j.id===run.jobId).status,'todo');
  assert.equal(backend.store.tasks.find(t=>t.agentJobId===run.jobId).status,'todo');
});

test('cancel after rollback ignores late progress/result and cannot resurrect an old run',async()=>{
  const pending=pendingExecutor();const {hub,backend}=fixture(pending.execute);const run=outbound(hub);await tick();forceRollback(backend);
  hub.cancelRun(run.id);forceRollback(backend);pending.input.onEvent({message:'late progress must not persist'});pending.resolve({text:'late artifact'});await tick();
  const saved=hub.snapshot().runs.find(r=>r.id===run.id);assert.equal(saved.status,'cancelled');assert.equal(saved.output,null);assert(!hub.snapshot().events.some(e=>e.message.includes('late progress')));
});

test('cancellation is durable before abort listeners can replace state',async()=>{
  const pending=pendingExecutor();const {hub,backend}=fixture(pending.execute);const run=outbound(hub);await tick();
  pending.input.signal.addEventListener('abort',()=>forceRollback(backend));hub.cancelRun(run.id);pending.reject(new Error('aborted callback'));await tick();
  assert.equal(hub.state.runs.find(r=>r.id===run.id).status,'cancelled');
});

test('job request IDs reject content changes and are project scoped',()=>{
  const {hub,backend}=fixture();const first=job(hub,{requestId:'same-id'});assert.equal(job(hub,{requestId:'same-id'}).id,first.id);
  assert.throws(()=>job(hub,{requestId:'same-id',instruction:'different'}),/不同内容/);
  backend.mutate(store=>{store.projects.push({id:'other',name:'Other'});return true;});
  assert.notEqual(job(hub,{requestId:'same-id',projectId:'other'}).id,first.id);
});

test('principal fields cannot forge project, member or grant scopes; inactive members are denied',async()=>{
  const {hub,backend}=fixture();const {g,p}=grant(hub,['project:read']);
  backend.mutate(store=>{store.projects.push({id:'other',name:'Other'});return true;});
  await assert.rejects(hub.callTool('hub_project_context',{}, {...p,projectId:'other'}),/不匹配/);
  await assert.rejects(hub.callTool('hub_project_context',{}, {...p,memberId:'other'}),/不匹配/);
  await assert.rejects(hub.callTool('hub_task_list',{}, {...p,scopes:SCOPES}),/不匹配/);
  backend.mutate(store=>{store.members.find(m=>m.id===p.memberId).active=false;return true;});
  assert.equal(hub.authorize(g.token),null);assert.deepEqual(hub.listTools(p),[]);
  await assert.rejects(hub.callTool('hub_project_context',{},p),/成员已失效/);
});

test('cancel-requested leases expire at the boundary and late submissions cannot complete a retry',()=>{
  const {hub}=fixture();const {p}=grant(hub);const run=hub.startJob(job(hub).id);const claimed=hub.claimRun(run.id,p);
  hub.cancelRun(run.id);hub.clock=()=>claimed.leaseUntil;hub.expireLeases();assert.equal(hub.getRun(run.id,p).status,'interrupted');
  assert.equal(hub.state.jobs.find(j=>j.id===run.jobId).status,'todo');const retry=hub.startJob(run.jobId);hub.claimRun(retry.id,p);
  assert.throws(()=>hub.submitResult(run.id,'late old result','late-id',p),/当前状态/);assert.equal(hub.getRun(retry.id,p).status,'running');
});

test('failed external reports reset task status and completed business jobs are not silently restarted',()=>{
  const {hub,backend}=fixture();const {p}=grant(hub);const run=hub.startJob(job(hub).id);hub.claimRun(run.id,p);
  hub.reportRun(run.id,{message:'verified failure',failed:true},p);assert.equal(backend.store.tasks.find(t=>t.agentJobId===run.jobId).status,'todo');
  const retry=hub.startJob(run.jobId);hub.submitResult(retry.id,'reviewed artifact','id',hub.localPrincipal(retry.projectId));hub.reviewRun(retry.id,true);
  assert.throws(()=>hub.startJob(run.jobId),/已验收/);
});

test('incomplete or cancelled model outcomes never become reviewable artifacts',async()=>{
  for(const result of [{text:'partial',outcome:'cancelled'},{text:'partial',status:'failed'},{text:'partial',metadata:{stopReason:'max_tokens'}},{text:'partial',metadata:{exitCode:1}},{text:'partial',ok:false},{text:'partial',outcome:'unknown'}]){
    const {hub}=fixture(async()=>result);const run=outbound(hub);await tick();const current=hub.state.runs.find(r=>r.id===run.id);assert.equal(current.status,'failed');assert.equal(current.output,null);
  }
  const {hub}=fixture(async()=>({text:'complete',outcome:'completed'}));const run=outbound(hub);await tick();assert.equal(hub.state.runs.find(r=>r.id===run.id).status,'awaiting_review');
});

test('outbound credentials are temporary, readonly, scoped, redacted and revoked after completion',async()=>{
  const pending=pendingExecutor();const {hub,backend,dataDir}=fixture(pending.execute);hub.setGateway(gatewaySettings());const run=outbound(hub,'cli',true);await tick();
  const token=pending.input.env.AIDESIGNHUB_TOKEN;const principal=hub.authorize(token);assert.equal(principal.projectId,run.projectId);
  assert.deepEqual(principal.scopes,['project:read','knowledge:read','tasks:read','skills:read']);
  await assert.rejects(hub.callTool('hub_task_start',{jobId:run.jobId},principal),/权限/);assert(!pending.input.prompt.includes(token));assert.equal(pending.input.env.AIDESIGNHUB_URL,'http://127.0.0.1:49123');
  assert.equal(hub.snapshot().grants.length,0);assert(!JSON.stringify(backend.exportSnapshot()).includes(token));assert(!fs.readFileSync(path.join(dataDir,'agent-access.json'),'utf8').includes(token));
  pending.input.onEvent({message:token.slice(0,20)});pending.input.onEvent({message:token.slice(20)});pending.resolve({text:`artifact accidental ${token}`,sessionId:token});await tick();
  assert.equal(hub.authorize(token),null);assert(!JSON.stringify(hub.snapshot()).includes(token));assert(!JSON.stringify(backend.exportSnapshot()).includes(token));assert(!fs.readFileSync(backend.dbPath,'utf8').includes(token));
  assert(!JSON.stringify(hub.snapshot().events).includes(token.slice(0,20)));assert.match(hub.state.runs.find(r=>r.id===run.id).output,/凭据已隐藏/);
});

test('ACP receives an ephemeral stdio bridge and Electron mode only in bridge env',async()=>{
  const pending=pendingExecutor();const {hub}=fixture(pending.execute);const settings=gatewaySettings(path.join('C:\\Hub','electron.exe'));hub.setGateway(settings);const run=outbound(hub,'acp',true);await tick();
  const bridge=pending.connection.mcpServers.find(server=>server.name==='AIDesignHub');assert.equal(bridge.command,settings.command);assert.deepEqual(bridge.args,[settings.mcpScript]);
  assert.equal(bridge.env.find(item=>item.name==='ELECTRON_RUN_AS_NODE').value,'1');assert.equal(bridge.env.find(item=>item.name==='AIDESIGNHUB_TOKEN').value,pending.input.env.AIDESIGNHUB_TOKEN);
  assert.deepEqual(Object.keys(pending.input.env).sort(),['AIDESIGNHUB_TOKEN','AIDESIGNHUB_URL']);assert.equal(hub.connection(run.connectionId).mcpServers,undefined);
  pending.resolve({text:'ACP output'});await tick();assert.equal(hub.authorize(pending.input.env.AIDESIGNHUB_TOKEN),null);
});

test('cancel, gateway shutdown and disposal immediately revoke temporary run grants',async()=>{
  for(const operation of ['cancel','gateway','dispose']){
    const pending=pendingExecutor();const {hub}=fixture(pending.execute);hub.setGateway(gatewaySettings());const run=outbound(hub,'cli',true);await tick();const token=pending.input.env.AIDESIGNHUB_TOKEN;
    if(operation==='cancel')hub.cancelRun(run.id);else if(operation==='gateway')assert.deepEqual(hub.setGateway(null),{url:null});else hub.dispose();
    assert.equal(hub.authorize(token),null);pending.resolve({text:'late output'});await tick();
    if(operation!=='gateway')assert.notEqual(hub.state.runs.find(r=>r.id===run.id).status,'awaiting_review');
  }
});

test('startup revokes orphaned temporary grants while preserving regular grants',()=>{
  const {hub,dataDir}=fixture();const regular=grant(hub,['project:read']);const orphan=hub.createGrant({label:'orphaned invocation',projectId:'project_jiangwan',memberId:'member_designer',scopes:['project:read'],temporary:true});
  assert(hub.authorize(orphan.token));const reopened=new AgentHub({backend:new LocalBackend({dataDir})});assert.equal(reopened.authorize(orphan.token),null);assert(reopened.authorize(regular.g.token));
  assert.equal(reopened.snapshot().grants.length,1);assert(JSON.parse(fs.readFileSync(path.join(dataDir,'agent-access.json'),'utf8')).grants.find(g=>g.id===orphan.id).revokedAt);
});

test('temporary credentials are removed from failures and no stale successful state is recorded',async()=>{
  const pending=pendingExecutor();const {hub,backend}=fixture(pending.execute);hub.setGateway(gatewaySettings());const run=outbound(hub,'cli',true);await tick();const token=pending.input.env.AIDESIGNHUB_TOKEN;forceRollback(backend);
  pending.reject(new Error(`adapter failed ${token}`));await tick();assert.equal(hub.state.runs.find(r=>r.id===run.id).status,'failed');assert.equal(hub.authorize(token),null);assert(!JSON.stringify(hub.snapshot()).includes(token));
});

test('late executor cleanup after disposal cannot overwrite grants created by the next service owner',async()=>{
  const pending=pendingExecutor();const {hub,dataDir}=fixture(pending.execute);hub.setGateway(gatewaySettings());outbound(hub,'cli',true);await tick();hub.dispose();
  const next=new AgentHub({backend:new LocalBackend({dataDir})});const current=grant(next,['project:read']);
  pending.resolve({text:'late result'});await tick();
  const persisted=JSON.parse(fs.readFileSync(path.join(dataDir,'agent-access.json'),'utf8'));
  assert(persisted.grants.some(item=>item.id===current.g.id));assert(next.authorize(current.g.token));next.dispose();
});

test('OpenClaw configuration refuses static sessions and external-message delivery',()=>{
  const {hub}=fixture();const base={provider:'openclaw',mode:'cli',command:process.execPath};
  for(const args of [[],['agent','--session-id','fixed'],['agent','--session-id','{sessionId}','--session-key','shared'],['agent','--session-id','{sessionId}','--deliver']])assert.throws(()=>hub.saveConnection({...base,args}));
  const saved=hub.saveConnection({...base,args:['agent','--agent','architect','--session-id','{sessionId}','--message-file','{promptFile}']});assert.equal(saved.agentId,'architect');
  assert.throws(()=>hub.saveConnection({provider:'openclaw',mode:'openclaw-http',endpoint:'http://127.0.0.1:18789',agentId:'bad\r\nheader'}));
  assert.throws(()=>hub.saveConnection({provider:'openclaw',mode:'openclaw-http',endpoint:'http://127.0.0.1:18789',sessionKey:'shared'}),/固定历史会话/);
});

test('every OpenClaw run has a unique session and an exact per-run prompt file, not inline credentials',async()=>{
  const inputs=[];const {hub}=fixture(async(c,input)=>{inputs.push({connection:c,input});return {text:'独立成果'};});
  hub.setGateway(gatewaySettings());const c=hub.saveConnection({provider:'openclaw',mode:'cli',command:process.execPath,args:['agent','--agent','architect','--session-id','{sessionId}','--message-file','{promptFile}']});
  const first=hub.startJob(job(hub,{connectionId:c.id,allowProjectTools:true}).id);await tick();const second=hub.startJob(job(hub,{connectionId:c.id,allowProjectTools:true}).id);await tick();
  assert.notEqual(first.executionContext.sessionId,second.executionContext.sessionId);assert.notEqual(inputs[0].input.sessionKey,inputs[1].input.sessionKey);assert.match(inputs[0].input.sessionKey,/^agent:architect:aidesignhub:/);
  for(const {input} of inputs){assert.equal(fs.readFileSync(input.promptFile,'utf8'),input.prompt);assert.equal(path.dirname(input.promptFile),path.join(hub.outputDir,input.runId));assert(!input.prompt.includes(input.env.AIDESIGNHUB_TOKEN));}
  assert.equal(hub.state.runs.filter(r=>r.status==='awaiting_review').length,2);hub.dispose();
});

test('HTTP Agent ID survives configuration and legacy fixed CLI sessions cannot start',()=>{
  const {hub}=fixture();const c=hub.saveConnection({provider:'openclaw',mode:'openclaw-http',endpoint:'http://127.0.0.1:18789',agentId:'architect'});assert.equal(hub.connection(c.id).agentId,'architect');
  hub.change(s=>{s.connections.push({id:'legacy-claw',provider:'openclaw',mode:'cli',command:process.execPath,args:['agent','--session-id','shared']});return true;});
  assert.throws(()=>hub.startJob(job(hub,{connectionId:'legacy-claw'}).id),/不要填写固定会话/);assert.equal(hub.state.runs.length,0);
});
