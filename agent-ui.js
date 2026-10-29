(() => {
  'use strict';

  const api = window.bycjWorkbench;
  const page = document.getElementById('view-agents');
  if (!page) return;
  const $ = id => document.getElementById(id);
  const state = { snapshot:null, context:null, selectedRunId:null, refreshPromise:null, generation:0, targetProjectId:null, connectionReady:false, connectionDirty:false, discovery:null, discoveryPromise:null, autoPairPromise:null, pairDialog:null, busy:new Map(), clientConfigContainsToken:false, clientConfigPendingSensitive:false, clientConfigEpoch:0, tokenEpoch:0, tokenRequestEpoch:null, tokenGrantId:null };
  let tokenVisibilityObserver=null;
  const modeLabels = { inbound:'外部 Agent 调用 Hub · MCP', cli:'主动派单 · CLI', acp:'主动派单 · ACP', 'openclaw-http':'主动派单 · OpenClaw Gateway', handoff:'文件交接 · 人工传递' };
  const modeNotes = {
    inbound:'Hub 提供项目工具，任务等待外部 Agent 认领。需要在该客户端完成 MCP 接入；不会接管已打开的桌面聊天窗口。',
    cli:'Hub 将启动你指定的已安装程序。登录、版本与参数需自行核实；只有点击任务的“开始执行”后才会运行。',
    acp:'Hub 通过 ACP 与提供该协议的执行器通信。配置存在不代表协议、模型登录或真实任务已验证。',
    'openclaw-http':'Hub 向已配置的 OpenClaw Gateway 派单。模型认证由 Gateway 管理，未执行任务前不标记为联调通过。',
    handoff:'导出固定任务包，人工交给外部 Agent，再按任务包中的 resultTemplate 导入成果 JSON。文件交接不是自动派单。',
  };
  const statusLabels = { todo:'待开始', doing:'进行中', done:'已验收', queued:'排队中', waiting_agent:'等待外部 Agent', running:'执行中', cancel_requested:'取消待确认', cancelled:'已取消', awaiting_review:'待人工验收', succeeded:'已验收通过', rejected:'已退回', failed:'执行失败', interrupted:'已中断' };
  const activeStatuses = new Set(['queued','waiting_agent','running','cancel_requested']);
  const scopeLabels = { 'project:read':'项目信息', 'tasks:read':'任务与运行', 'skills:read':'专业 Skill', 'knowledge:read':'知识摘录', 'tasks:write':'创建任务', 'runs:write':'提交成果', 'cases:read':'读取案例', 'cases:write':'采集案例' };
  const formatDate = value => value ? new Date(value).toLocaleString('zh-CN', { month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit' }) : '—';
  const el = (tag, className, value) => { const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=String(value);return node; };
  const text = (id, value) => { $(id).textContent=value ?? ''; };
  const connection = id => state.snapshot?.connections.find(item=>item.id===id);
  const currentRun = () => state.snapshot?.runs.find(item=>item.id===state.selectedRunId);
  const automaticMode = mode => ['cli','acp','openclaw-http'].includes(mode);
  const validationLabel = item => {
    const model=item?.modelValidation||(item?.validation?.level==='task'?item.validation:null);
    const run=item?.runtimeVerification;
    const newestTaskTime=Math.max(model?.checkedAt||0,run?.checkedAt||0);
    if(item?.validation?.ok===false&&(item.validation.checkedAt||0)>=newestTaskTime)return '最近检查未通过';
    if(model?.ok===false&&(model.checkedAt||0)>=(run?.checkedAt||0))return '模型测试未通过';
    if(run||model?.verified||item?.verifiedAt)return '已返回测试 / 执行成果';
    if(item?.validation?.ok&&item.validation.level==='protocol')return '协议已响应 · 模型未验证';
    if(item?.validation?.ok&&item.validation.level==='cli')return 'CLI 可启动 · 模型未验证';
    return automaticMode(item?.mode)?'待检查与试运行':'等待外部 Agent 接入';
  };
  const notice = (message, error=false) => { for(const id of ['agentNotice','agentHistoryNotice']){text(id,message);$(id).classList.toggle('is-error',error);} $('agentHistoryNotice').hidden=!$('agentHistoryDialog').open; };
  const statusBadge = status => { const badge=el('span','agent-status',statusLabels[status]||status);badge.dataset.status=status;return badge; };

  function selectOptions(select, items, label, preferred) {
    const selected = preferred ?? select.value;
    select.replaceChildren(...items.map(item=>{const option=el('option','',label(item));option.value=item.id;return option;}));
    if(items.some(item=>item.id===selected)) select.value=selected;
  }

  async function action(button, callback, key=button?.id || 'operation') {
    if(state.busy.has(key))return;
    const token={generation:state.generation,button};const isCurrent=()=>token.generation===state.generation;
    state.busy.set(key,token);if(button)button.disabled=true;
    try { return await callback(isCurrent); }
    catch(error) { if(isCurrent())notice(error?.message || '操作未完成，请重试。',true); }
    finally { if(state.busy.get(key)===token)state.busy.delete(key);if(isCurrent()&&button?.isConnected){button.disabled=false;if(button.id==='agentCancelRun'&&currentRun()?.status==='cancel_requested')button.disabled=true;} }
  }

  function modeFields() {
    const mode=$('agentMode').value;
    const executable=['cli','acp'].includes(mode);
    const automatic=executable||mode==='openclaw-http';
    $('agentCommandFields').hidden=!executable;
    $('agentHttpFields').hidden=mode!=='openclaw-http';
    $('agentExecutionFields').hidden=!automatic;
    $('agentCommand').required=executable;
    $('agentEndpoint').required=mode==='openclaw-http';
    $('agentTestConnection').hidden=!automatic;$('agentTestNote').hidden=!automatic;
    for(const id of ['agentCommandFields','agentHttpFields','agentExecutionFields'])for(const field of $(id).querySelectorAll('input,textarea,select'))field.disabled=$(id).hidden;
    text('agentModeNote',modeNotes[mode]||'请选择接入方式。');
    const openclaw=$('agentProvider').value==='openclaw'&&mode==='cli';
    text('agentCliTemplateNote',mode==='acp'?'ACP 参数仅用于启动已安装的协议服务；任务输入由 ACP 会话传入，不需要把任务全文放入启动参数。外部执行器的文件与网络权限仍由其配置和操作系统控制。':`${openclaw?'OpenClaw CLI 必须包含 --session-id {sessionId}，为每次运行使用不同会话标识。长案例推荐 --message-file {promptFile}，不要把全文塞进命令行。 ':''}CLI 参数支持 {runId} / {projectId} / {sessionId} / {sessionKey} / {promptFile} / {prompt} 占位符，运行时由 Hub 替换；{promptFile} 指向本次受管任务文件。这不是文件系统沙箱，其他 CLI 是否使用独立会话取决于其参数与实现。`);
  }

  function editConnection(id) {
    const item=connection(id);
    if(!item)return;
    const provider=state.snapshot.catalog.find(entry=>entry.id===item.provider);
    $('agentConnectionId').value=item.id;
    $('agentProvider').value=item.provider;
    $('agentConnectionLabel').value=item.label||provider?.name||item.provider;
    selectOptions($('agentMode'),(provider?.modes||['inbound']).map(id=>({id})),entry=>modeLabels[entry.id]||entry.id,item.mode);
    $('agentCommand').value=item.command||'';
    $('agentArgs').value=JSON.stringify(item.args||[],null,2);
    $('agentCwd').value=item.cwd||'';
    $('agentEndpoint').value=item.endpoint||'';
    $('agentConfigAgentId').value=item.agentId||'main';
    $('agentTokenEnv').value=item.tokenEnv||'';
    $('agentTimeout').value=String(item.timeoutMs||300000);
    text('agentConnectionState',validationLabel(item));
    text('agentProbeResult',item.validation?`${formatDate(item.validation.checkedAt)} · ${item.validation.message}`:'保存配置不会启动执行器。协议检查不调用模型；最小测试才会调用模型。');
    modeFields();state.connectionReady=true;state.connectionDirty=false;
  }

  function renderRuntimes() {
    const candidates=state.discovery?.candidates||[];
    const products=[['deepseek','DeepSeek Harness','DS'],['openclaw','OpenClaw','OC'],['hermes','Hermes Agent','He'],['chatgpt','ChatGPT 桌面版','Ch'],['zcode','ZCode','ZC']];
    const badge=(label,kind='')=>el('span',`agent-device-badge ${kind}`,label);
    $('agentRuntimeList').replaceChildren(...products.map(([provider,label,mark])=>{
      const found=candidates.filter(candidate=>candidate.provider===provider);
      const installed=found.filter(candidate=>candidate.installed);
      const pairable=installed.filter(candidate=>candidate.config&&candidate.pairable!==false&&candidate.pairingSupported!==false);
      const providerConnections=(state.snapshot?.connections||[]).filter(item=>item.provider===provider);
      const conn=providerConnections.find(item=>item.modelValidation?.verified||item.runtimeVerification)||providerConnections.find(item=>item.validation?.ok&&['protocol','cli'].includes(item.validation.level))||providerConnections[0];
      const paired=conn?.validation?.ok&&['protocol','cli'].includes(conn.validation.level);
      const modelVerified=Boolean(conn?.runtimeVerification||conn?.modelValidation?.verified||conn?.verifiedAt);
      const card=el('article','agent-device-card');card.dataset.agentDevice=provider;
      const detectedProduct=installed.find(candidate=>candidate.kind==='desktop'&&candidate.product);
      const header=el('header');header.append(el('span','agent-provider-mark',mark),el('h3','',detectedProduct?.label||label));
      const badges=el('div','agent-device-badges');
      badges.append(badge(!state.discovery?'等待检测':installed.length?'已发现安装':'本次未找到安装',installed.length?'is-found':''));
      if(paired||modelVerified)badges.append(badge(modelVerified?'已有模型执行记录':'接口已配对','is-paired'));
      else if(installed.length&&!pairable.length)badges.append(badge(found.some(c=>c.connectionState==='client-authorization-required')?'需客户端授权':'需补充启动入口','is-pending'));
      else if(pairable.length)badges.append(badge('待配对','is-pending'));
      if(pairable.length&&!modelVerified)badges.append(badge('模型待验证'));
      card.append(header,badges);
      const note=paired?'接口已响应，可以回到对话派单；也可以先运行不含项目资料的模型测试。':pairable.length?'已找到启动入口。点击上方「自动检测并配对」，由 Hub 完成接口配置与检查。':installed.length?'已发现桌面应用，但安装不等于有可派单接口。需要在该客户端完成其支持的 MCP 配置与授权。':state.discovery?'本次没有找到可验证的安装入口。自动配置会汇总检测依据，不需要你先手工查找路径。':'打开本页后自动查找本机应用与 CLI，不启动模型。';
      card.append(el('p','',note));
      const evidence=el('details','agent-device-evidence');evidence.append(el('summary','','安装位置与检测依据'));
      for(const candidate of found){
        evidence.append(el('p','',candidate.label),el('p','',candidate.note||''));
        if(candidate.source||candidate.config?.command)evidence.append(el('code','',candidate.config?.command||candidate.source));
        for(const item of candidate.evidence||[])if(item.path&&item.path!==candidate.source)evidence.append(el('code','',item.path));
        for(const limitation of candidate.limitations||[])evidence.append(el('p','',limitation));
      }
      if(pairable.length){
        const pair=el('button','text-button','高级：手动核对入口');pair.type='button';pair.disabled=state.busy.has('runtime-pair');pair.onclick=()=>openPairing(pairable);evidence.append(pair);
      }
      const manual=el('button','text-button','高级连接设置');manual.type='button';manual.onclick=()=>openAdvanced(conn?.id);evidence.append(manual);
      card.append(evidence);
      const actions=el('div','agent-device-actions');
      if(pairable.length&&(paired||modelVerified)){
        const test=el('button','secondary-button','测试模型');test.type='button';test.onclick=()=>runModelTest(conn,test);actions.append(test);
      }else if(installed.length&&['chatgpt','zcode'].includes(provider)){
        const setup=el('button','secondary-button','查看客户端接入步骤');setup.type='button';setup.onclick=()=>openClientSetup(provider);actions.append(setup);
      }
      card.append(actions);
      return card;
    }));
  }

  function openAdvanced(id){$('agentAdvancedConnection').open=true;if(id)editConnection(id);$('agentAdvancedConnection').scrollIntoView({block:'start',behavior:'smooth'});}
  function openClientSetup(provider){
    const conn=state.snapshot?.connections.find(item=>item.provider===provider);if(conn)editConnection(conn.id);
    $('agentMcpSettings').open=true;$('agentMcpSettings').scrollIntoView({block:'start',behavior:'smooth'});
    notice(provider==='chatgpt'?'已识别 ChatGPT 桌面版。请使用客户端支持的 MCP / 私有连接入口；Hub 的本机地址不能直接当公网地址。先在下方明确当前项目的授权范围。':'已识别 ZCode。请在下方开启本机入口、选择当前项目授权，再生成客户端配置。安装发现不会自动授权项目资料。');
  }
  async function discoverRuntimes(){
    if(state.discoveryPromise)return state.discoveryPromise;
    if(!api.agentDiscoverRuntimes)throw new Error('请重启最新版 AIDesignHub 主进程以使用执行器检测。');
    $('agentDetectRuntimes').disabled=true;
    const work=(async()=>{state.discovery=await api.agentDiscoverRuntimes();renderRuntimes();return state.discovery;})();state.discoveryPromise=work;
    try{return await work;}finally{if(state.discoveryPromise===work)state.discoveryPromise=null;$('agentDetectRuntimes').disabled=false;}
  }
  function renderAutoPairResult(result){
    if(result.discovery)state.discovery=result.discovery;
    const panel=$('agentAutoPairState');panel.hidden=false;panel.dataset.busy='false';panel.replaceChildren();
    panel.append(el('strong','',result.summary||'自动配置已结束'));
    if(result.results?.length){
      const details=el('details','agent-setup-report');details.append(el('summary','','查看检测与配对报告'));
      const names={deepseek:'DeepSeek Harness',openclaw:'OpenClaw',hermes:'Hermes Agent',chatgpt:'OpenAI 桌面客户端',zcode:'ZCode'};
      for(const item of result.results)details.append(el('p',item.ok?'':'agent-setup-action',`${item.ok?'✓':'○'} ${item.label||names[item.provider]||item.provider}：${item.message||item.validation?.message||'请查看接口状态'}`));
      panel.append(details);
    }else for(const item of result.needsUserAction||[])panel.append(el('p','agent-setup-action',typeof item==='string'?item:item.message||item.label||'部分客户端仍需确认授权。'));
    renderRuntimes();
  }
  function renderSetupProgress(progress){
    if(!progress||progress.stage==='idle')return;
    const panel=$('agentAutoPairState');panel.hidden=false;
    if(progress.stage==='complete'){
      renderAutoPairResult({...progress,summary:progress.message});
      $('agentAutoPair').disabled=false;$('agentAutoPair').textContent='自动检测并配对';return;
    }
    const active=!['failed','complete'].includes(progress.stage);
    panel.dataset.busy=String(active);$('agentAutoPair').disabled=active;$('agentAutoPair').textContent=active?'正在自动配置…':'自动检测并配对';
    const labels={discovering:'发现本机 Agent',planning:'DesignHub 辅助规划',pairing:'检查连接接口',repairing:'检查兼容入口',failed:'自动配置未完成'};
    panel.replaceChildren(el('strong','',labels[progress.stage]||'正在自动配置'),el('p','',progress.message||''));
  }
  async function autoPair(){
    if(state.autoPairPromise)return state.autoPairPromise;
    document.querySelector('[data-view="agents"]')?.click();openSettings(null,{discover:false});
    const button=$('agentAutoPair'),panel=$('agentAutoPairState');button.disabled=true;button.textContent='正在自动配置…';panel.hidden=false;panel.dataset.busy='true';
    panel.replaceChildren(el('strong','','正在查找本机 Agent 并检查可用接口'),el('p','','发现安装 → 准备连接 → 检查接口 → 汇总结果。不会读取或发送项目资料，也不会自动调用外部模型。'));
    const work=(async()=>{
      if(!api.agentAutoPair)throw new Error('请重启新版 AIDesignHub，加载自动配置功能。');
      const model=await api.projectModelStatus?.().catch(()=>null);
      const result=await api.agentAutoPair({confirmed:true,useModel:Boolean(model?.configured)});
      await refresh({background:true});
      const preferred=result.results?.find(item=>item.ok&&item.connection)?.connection;
      if(preferred){editConnection(preferred.id);$('agentJobConnection').value=preferred.id;skillNote();window.dispatchEvent(new CustomEvent('agent-prefer-connection',{detail:{connectionId:preferred.id}}));}
      renderAutoPairResult(result);window.dispatchEvent(new Event('agent-hub-changed'));return result;
    })();state.autoPairPromise=work;
    try{return await work;}catch(error){panel.dataset.busy='false';panel.replaceChildren(el('strong','','自动配置暂未完成'),el('p','',error.message));notice(error.message,true);throw error;}
    finally{if(state.autoPairPromise===work)state.autoPairPromise=null;button.disabled=false;button.textContent='自动检测并配对';}
  }
  function openPairing(candidates){
    state.pairDialog?.close();
    const generation=state.generation;const d=el('dialog','agent-pair-dialog');d.id='agentPairingDialog';state.pairDialog=d;
    const title=el('h2','','确认安装入口，开始配对');title.id='agentPairingTitle';d.setAttribute('aria-labelledby',title.id);
    const picker=el('select');picker.setAttribute('aria-label','选择本机安装入口');
    for(const c of candidates){const option=el('option','',`${c.label}${c.version?` · ${c.version}`:''}`);option.value=c.id;picker.append(option);}
    const path=el('code','agent-pair-path');const updatePath=()=>{const c=candidates.find(item=>item.id===picker.value);path.textContent=[c.config.command,JSON.stringify(c.config.args||[])].join('\n');};picker.onchange=updatePath;updatePath();
    const result=el('p','agent-pair-result');result.setAttribute('role','status');
    const actions=el('div','setup-welcome-actions');const close=el('button','secondary-button','取消');close.type='button';close.onclick=()=>d.close();
    const confirm=el('button','primary-button','信任此入口并配对');confirm.type='button';
    confirm.onclick=()=>action(confirm,async isCurrent=>{
      if(!api.agentPairRuntime)throw new Error('请重启新版 AIDesignHub，加载一键配对功能。');
      if(generation!==state.generation){d.close();return;}
      picker.disabled=true;close.disabled=true;result.textContent='正在保存入口并检查接口…不会调用模型。';result.classList.remove('is-error');
      try{
        const outcome=await api.agentPairRuntime({candidateId:picker.value,confirmLaunch:true});
        if(!isCurrent()||generation!==state.generation)return;
        await refresh({background:true});if(!isCurrent())return;
        if(outcome.connection){editConnection(outcome.connection.id);$('agentJobConnection').value=outcome.connection.id;skillNote();}
        const message=outcome.message||outcome.validation?.message||'配对流程结束，请查看接口状态。';
        result.textContent=message;result.classList.toggle('is-error',!outcome.ok);confirm.textContent=outcome.ok?'配对完成':'重新检查';confirm.hidden=Boolean(outcome.ok);close.textContent='完成';
        notice(message,!outcome.ok);renderRuntimes();window.dispatchEvent(new Event('agent-hub-changed'));
      }catch(error){result.textContent=error.message;result.classList.add('is-error');}
      finally{if(generation===state.generation){picker.disabled=false;close.disabled=false;}}
    },'runtime-pair');
    actions.append(close,confirm);d.append(title,el('p','','仅启动你确认的本机程序，进行 CLI 帮助检查或 ACP 协议握手。不登录账号、不读取项目、不调用模型。'),picker,path,el('div','agent-pair-steps','1. 保存本机连接入口\n2. 检查 CLI / ACP 接口\n3. 配对成功后，可单独选择「测试模型」'),result,actions);
    d.addEventListener('close',()=>{d.remove();if(state.pairDialog===d)state.pairDialog=null;});document.body.append(d);d.showModal();
  }
  function runModelTest(item,button){return action(button,async()=>{
    if(!item||!automaticMode(item.mode))return;
    if(!window.confirm(`使用“${item.label}”测试模型？只发送固定测试文字，不读取项目、不挂载 Hub 工具。可能消耗执行器的模型额度，最长等待 60 秒。`))return;
    notice('正在测试执行器模型；没有发送项目资料。');
    const result=await api.agentTestConnection(item.id);await refresh({background:true});notice(`${item.label}：${result.message}`,!result.ok);renderRuntimes();
  },'connection-test');}

  function renderProviders() {
    const {catalog,connections,runs}=state.snapshot;
    $('agentProviderGrid').replaceChildren(...catalog.map(provider=>{
      const item=connections.find(entry=>entry.provider===provider.id);
      const card=el('article','agent-provider-card');card.dataset.agentProvider=provider.id;
      const header=el('header');header.append(el('span','agent-provider-mark',provider.name.slice(0,2)),el('h3','',provider.name));
      const completed=runs.filter(run=>run.provider===provider.id&&run.status==='succeeded').length;
      card.append(header,el('span','agent-provider-mode',modeLabels[item?.mode]||'尚未配置'),el('p','',provider.note||''));
      const footer=el('footer');footer.append(el('small','',`${validationLabel(item)}${completed?` · ${completed} 次人工验收`:''}`));
      const button=el('button','text-button','配置');button.type='button';button.disabled=!item;
      button.addEventListener('click',()=>{openAdvanced(item.id);$('agentConnectionLabel').focus({preventScroll:true});});
      footer.append(button);card.append(footer);return card;
    }));
  }

  function renderGrants() {
    const gateway=state.snapshot.gateway||{running:false};
    text('agentGatewayState',gateway.running?'本机入口已开启':'本机入口已关闭');
    $('agentGatewayState').dataset.status=gateway.running?'running':'todo';
    $('agentGatewayUrl').value=gateway.url||'';
    text('agentGatewayToggle',gateway.running?'关闭本机入口':'开启本机入口');
    $('agentGrantList').replaceChildren(...state.snapshot.grants.map(grant=>{
      const revoked=Boolean(grant.revokedAt);const expired=grant.expiresAt&&grant.expiresAt<Date.now();
      const row=el('div','agent-grant-row');const detail=el('div');
      detail.append(el('strong','',grant.label),el('small','',(grant.scopes||[]).map(scope=>scopeLabels[scope]||scope).join(' · ')),el('small','',revoked?'已撤销':expired?'已过期':`有效至 ${formatDate(grant.expiresAt)}`),el('small','',grant.callCount?`已调用 ${grant.callCount} 次 · 最近 ${formatDate(grant.lastCallAt)}（${grant.lastTool||'未知工具'}）`:'尚无调用记录'));
      const button=el('button','text-button agent-danger',revoked?'已撤销':'撤销');button.type='button';button.disabled=revoked;
      button.addEventListener('click',()=>action(button,async()=>{if(!window.confirm(`撤销“${grant.label}”的项目工具权限？外部 Agent 已经获取的数据不会因此被删除。`))return;clearToken('正在撤销授权，新密钥与含密钥模板已清除。');await api.agentRevokeGrant(grant.id);await refresh();notice('项目授权已撤销。');},`revoke:${grant.id}`));
      row.append(detail,button);return row;
    }));
    if(!state.snapshot.grants.length)$('agentGrantList').append(el('p','agent-empty','尚未授权外部客户端；项目工具默认不向它们开放。'));
  }

  function renderJobs() {
    const {jobs,runs}=state.snapshot;
    text('agentJobCount',`${jobs.length} 项任务`);
    text('agentNavCount',runs.filter(run=>activeStatuses.has(run.status)||run.status==='awaiting_review').length);
    const ordered=[...jobs].sort((a,b)=>b.createdAt-a.createdAt);
    $('agentJobList').replaceChildren(...ordered.map(job=>{
      const jobRuns=runs.filter(run=>run.jobId===job.id).sort((a,b)=>b.createdAt-a.createdAt);
      const latest=jobRuns[0];const card=el('section','agent-job-card');card.dataset.agentJob=job.id;
      const header=el('header');header.append(el('h3','',job.title),statusBadge(latest?.status||job.status||'todo'));
      const conn=connection(job.connectionId);
      card.append(header,el('p','agent-job-meta',`${conn?.label||'执行器未找到'} · ${modeLabels[conn?.mode]||'未知接入方式'} · ${formatDate(job.createdAt)}`));
      const controls=el('div','agent-actions');const blocked=jobRuns.some(run=>activeStatuses.has(run.status)||run.status==='awaiting_review');
      const start=el('button','secondary-button',jobRuns.length?'新建执行尝试':automaticMode(conn?.mode)?'派单执行':'建立待认领运行');start.type='button';start.dataset.agentStart=job.id;start.disabled=blocked||state.busy.has(`start:${job.id}`);
      start.addEventListener('click',()=>action(start,async isCurrent=>{
        if(automaticMode(conn?.mode)&&!window.confirm(dispatchConfirmation(conn,job.allowProjectTools)))return;
        const run=await api.agentStartJob(job.id);if(!isCurrent())return;state.selectedRunId=run.id;await refresh();if(!isCurrent())return;
        notice(['inbound','handoff'].includes(run.mode)?'运行已建立，正在等待外部 Agent 或人工交接；没有自动启动模型。':'运行已建立，请留意执行状态与成果验收。');
      },`start:${job.id}`));
      controls.append(start);
      if(latest){const open=el('button','text-button','查看最新运行');open.type='button';open.addEventListener('click',()=>{state.selectedRunId=latest.id;renderRun();});controls.append(open);}
      card.append(controls);
      if(jobRuns.length){const history=el('div','agent-run-history');for(const run of jobRuns){const button=el('button',run.id===state.selectedRunId?'is-selected':'',`${formatDate(run.createdAt)} · ${statusLabels[run.status]||run.status}`);button.type='button';button.dataset.agentRun=run.id;button.addEventListener('click',()=>{state.selectedRunId=run.id;renderJobs();renderRun();});history.append(button);}card.append(history);}
      return card;
    }));
    if(!jobs.length)$('agentJobList').append(el('p','agent-empty','还没有 Agent 任务。先建立一项工作，再选择开始。'));
  }

  function renderRun() {
    const run=currentRun();$('agentRunContent').hidden=!run;
    if(!run){text('agentRunTitle','运行详情');text('agentRunStatus','待选择');text('agentRunMeta','选择一项执行记录，查看固定输入、进度与待验收成果。');return;}
    const job=state.snapshot.jobs.find(item=>item.id===run.jobId);
    text('agentRunTitle',job?.title||run.input?.title||'运行详情');
    text('agentRunStatus',statusLabels[run.status]||run.status);$('agentRunStatus').dataset.status=run.status;
    text('agentRunMeta',`${connection(run.connectionId)?.label||run.provider} · ${formatDate(run.createdAt)} · ${run.id}`);
    text('agentRunInput',JSON.stringify(run.input||{},null,2));
    text('agentRunOutput',run.output==null?(run.error?`尚无可验收成果。\n${run.error}`:'尚无成果。Agent 的执行完成不等于业务验收通过。'):typeof run.output==='string'?run.output:JSON.stringify(run.output,null,2));
    const waiting=['inbound','handoff'].includes(run.mode);
    $('agentImportResult').hidden=!waiting||!['waiting_agent','running'].includes(run.status);
    $('agentCancelRun').hidden=!activeStatuses.has(run.status);
    $('agentCancelRun').disabled=run.status==='cancel_requested';
    $('agentReviewPanel').hidden=run.status!=='awaiting_review';
    text('agentRunModeNote',run.status==='cancel_requested'?'取消请求已登记；外部任务是否真正停止仍需确认。':waiting?modeNotes[run.mode]:'每次尝试保留独立记录；失败或中断后先核实外部状态，再建立新的尝试。');
    const events=(state.snapshot.events||[]).filter(event=>event.runId===run.id);
    $('agentRunEvents').replaceChildren(...events.map(event=>{const item=el('li');item.append(el('time','',formatDate(event.createdAt)),el('span','',event.message));return item;}));
    if(!events.length)$('agentRunEvents').append(el('li','agent-empty','暂无事件。'));
  }

  function skillNote() {
    const skill=state.snapshot?.skills.find(item=>item.id===$('agentJobSkill').value);
    const conn=connection($('agentJobConnection').value);
    text('agentJobSkillNote',`${skill?`${skill.description} · v${skill.version}。`:''}${automaticMode(conn?.mode)?`${validationLabel(conn)}。点击“建立并派单”后直接启动执行器。`:'当前是外部调用 / 人工交接路线。请先配置 CLI / ACP 执行器才能主动派单。'}`);
    $('agentDispatchJob').disabled=!automaticMode(conn?.mode)||state.busy.has('create-job');
  }

  function dispatchConfirmation(conn,allowProjectTools) {
    return `向“${conn.label}”派单？\n\n发送：本次指令、项目基本信息、专业 Skill。\n项目工具：${allowProjectTools?'允许只读检索本项目知识与任务':'不挂载 Hub 项目工具'}。\n\n执行器将使用它自己的模型与登录，可能消耗额度；它已有的本机文件与网络权限不由 Hub 沙箱隔离。成果返回后仍需你验收。`;
  }

  async function refresh({background=false}={}) {
    if(!background)clearToken('已刷新页面，新密钥与含密钥模板已清除。需要时请重新创建授权。');
    if(!api?.agentSnapshot) {notice('当前桌面版本尚未提供 Agent 接口。项目管理仍可使用，请更新桌面主进程后重启。',true);return;}
    if(state.refreshPromise)return state.refreshPromise;
    const generation=state.generation;
    const work=(async()=>{
      const [snapshot,context]=await Promise.all([api.agentSnapshot(),api.bootstrap()]);
      if(generation!==state.generation)return;
      if(snapshot.projectId&&snapshot.projectId!==context.project.id)throw new Error('项目正在切换，请刷新读取匹配的项目状态。');
      if(state.targetProjectId&&context.project.id!==state.targetProjectId)return;
      state.targetProjectId=context.project.id;
      state.snapshot={...snapshot,catalog:snapshot.catalog||[],connections:snapshot.connections||[],skills:snapshot.skills||[],jobs:snapshot.jobs||[],runs:snapshot.runs||[],grants:snapshot.grants||[]};state.context=context;
      validateVisibleToken();
      if(state.selectedRunId&&!state.snapshot.runs.some(run=>run.id===state.selectedRunId))state.selectedRunId=null;
      if(!state.selectedRunId&&state.snapshot.runs.length)state.selectedRunId=state.snapshot.runs[state.snapshot.runs.length-1].id;
      selectOptions($('agentProvider'),state.snapshot.catalog,item=>item.name);
      selectOptions($('agentJobSkill'),state.snapshot.skills,item=>`${item.name} · v${item.version}`);
      selectOptions($('agentJobConnection'),state.snapshot.connections,item=>`${item.label} · ${modeLabels[item.mode]||item.mode}`);
      selectOptions($('agentGrantMember'),context.members.filter(item=>item.active!==false),item=>`${item.name} · ${item.title||item.role}`, $('agentGrantMember').value||context.settings.currentMemberId);
      text('agentProjectLabel',context.project.name);
      renderProviders();renderRuntimes();renderGrants();renderJobs();renderRun();skillNote();renderSetupProgress(snapshot.deviceSetup?.progress);
      if(state.connectionReady&&!state.connectionDirty)text('agentConnectionState',validationLabel(connection($('agentConnectionId').value)));
      if(!state.connectionReady&&state.snapshot.connections.length)editConnection(state.snapshot.connections[0].id);
      page.dataset.agentLoaded='true';
      window.dispatchEvent(new CustomEvent('agent-snapshot-ready',{detail:{snapshot:state.snapshot,context}}));
    })();
    state.refreshPromise=work;
    try {await work;}catch(error){if(generation===state.generation){clearToken('无法确认授权状态，新密钥与含密钥模板已清除。');throw error;}}finally {if(state.refreshPromise===work)state.refreshPromise=null;}
  }

  function resetProject(projectId){
    state.pairDialog?.close();
    state.generation++;state.targetProjectId=projectId||null;state.refreshPromise=null;state.snapshot=null;state.context=null;state.selectedRunId=null;state.connectionReady=false;state.connectionDirty=false;
    for(const operation of state.busy.values())if(operation.button?.isConnected)operation.button.disabled=false;state.busy.clear();
    clearToken('项目已切换，新密钥与含密钥模板已清除。');clearClientConfig('项目已切换，请在当前项目重新生成配置。');
    $('agentSettingsDialog').close();$('agentHistoryDialog').close();
    for(const id of ['agentJobTitle','agentJobInstruction','agentGrantLabel','agentConnectionId'])$(id).value='';
    $('agentJobProjectTools').checked=false;
    for(const id of ['agentJobList','agentGrantList','agentProviderGrid','agentRunEvents','agentGrantMember','agentJobSkill','agentJobConnection'])$(id).replaceChildren();
    text('agentRunInput','');text('agentRunOutput','');text('agentNavCount','0');text('agentJobCount','载入中');text('agentProjectLabel','正在切换项目…');renderRun();notice('正在载入当前项目的任务、运行与授权…');
  }
  window.addEventListener('hub-project-changed',event=>{resetProject(event.detail?.projectId);refresh().catch(error=>notice(error.message,true));});

  function clearClientConfig(message='模板显示已清除。') {
    state.clientConfigEpoch+=1;state.clientConfigPendingSensitive=false;
    $('agentClientConfigPreview').value='';$('agentClientConfigOutput').hidden=true;
    state.clientConfigContainsToken=false;text('agentClientConfigState','尚未生成');
    text('agentClientConfigWarning','');text('agentClientConfigNote',message);
  }
  function clearSensitiveConfig(message) {
    if(!state.clientConfigContainsToken&&!state.clientConfigPendingSensitive)return;
    clearClientConfig(message);$('agentClientIncludeToken').checked=false;
  }
  function agentPageVisible() {
    const style=getComputedStyle(page);
    return page.classList.contains('is-active')&&!page.hidden&&page.getAttribute('aria-hidden')!=='true'&&document.visibilityState!=='hidden'&&style.display!=='none'&&style.visibility!=='hidden';
  }
  function sensitiveSettingsVisible() {
    if(!agentPageVisible()||!$('agentSettingsDialog').open||!$('agentMcpSettings').open)return false;
    for(let node=$('agentTokenPanel').parentElement;node&&node!==page;node=node.parentElement){
      const style=getComputedStyle(node);
      if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||(node.tagName==='DETAILS'&&!node.open))return false;
    }
    return true;
  }
  function closeSettings() { clearToken('设置已关闭，新密钥与含密钥模板已清除；已有授权不会被撤销。');$('agentSettingsDialog').close(); }
  function openSettings(id,{discover=true}={}) { $('agentHistoryDialog').close();if(!$('agentSettingsDialog').open)$('agentSettingsDialog').showModal();if(id)editConnection(id);if(discover&&!state.discovery)discoverRuntimes().catch(error=>notice(error.message,true)); }
  function openHistory() { closeSettings();if(!$('agentHistoryDialog').open)$('agentHistoryDialog').showModal(); }
  $('agentOpenSettings').addEventListener('click',()=>openSettings());
  $('agentCloseSettings').addEventListener('click',closeSettings);
  $('agentSettingsDialog').addEventListener('cancel',()=>clearToken());
  $('agentSettingsDialog').addEventListener('close',()=>clearToken());
  $('agentOpenHistory').addEventListener('click',openHistory);
  $('agentCloseHistory').addEventListener('click',()=>$('agentHistoryDialog').close());
  $('agentMcpSettings').addEventListener('toggle',()=>{if(!$('agentMcpSettings').open)clearToken('MCP 设置已收起，新密钥与含密钥模板已清除。');});
  const settingsVisibilityObserver=new MutationObserver(()=>{if(!sensitiveSettingsVisible())clearToken();});
  settingsVisibilityObserver.observe($('agentSettingsDialog'),{attributes:true,attributeFilter:['open','hidden','style','class','aria-hidden']});
  settingsVisibilityObserver.observe($('agentMcpSettings'),{attributes:true,attributeFilter:['open','hidden','style','class','aria-hidden']});
  window.addEventListener('agent-open-settings',event=>openSettings(event.detail?.connectionId));
  window.addEventListener('agent-open-history',openHistory);
  function activeGrant(id) {
    return state.snapshot?.grants.find(grant=>grant.id===id&&!grant.revokedAt&&Number(grant.expiresAt)>Date.now()&&grant.projectId===state.context?.project.id);
  }
  function validateVisibleToken() {
    if((state.tokenGrantId||state.tokenRequestEpoch!==null)&&!sensitiveSettingsVisible())clearToken('授权设置不可见，新密钥与含密钥模板已清除。');
    else if(state.tokenGrantId&&!activeGrant(state.tokenGrantId))clearToken('显示的授权已失效，新密钥与含密钥模板已清除。');
  }
  function clearToken(message='新授权密钥已隐藏，含密钥模板已清除。') {
    state.tokenEpoch+=1;state.tokenRequestEpoch=null;state.tokenGrantId=null;
    clearSensitiveConfig(message);
    tokenVisibilityObserver?.disconnect();
    $('agentNewToken').value='';$('agentTokenPanel').hidden=true;$('agentClientIncludeToken').checked=false;$('agentClientIncludeToken').disabled=true;
    tokenVisibilityObserver?.observe($('agentTokenPanel'),{attributes:true,attributeFilter:['hidden','class','style','aria-hidden']});
  }
  $('agentProvider').addEventListener('change',()=>{const item=state.snapshot.connections.find(entry=>entry.provider===$('agentProvider').value);if(item)editConnection(item.id);});
  $('agentMode').addEventListener('change',modeFields);
  $('agentConnectionForm').addEventListener('input',()=>{state.connectionDirty=true;});
  $('agentConnectionForm').addEventListener('change',event=>{if(event.target.id!=='agentProvider')state.connectionDirty=true;});
  $('agentDetectRuntimes').addEventListener('click',event=>action(event.currentTarget,async()=>{
    await discoverRuntimes();notice('检测完成。点击“自动检测并配对”，由 Hub 准备可用接口。尚未调用模型。');
  }));
  $('agentAutoPair').addEventListener('click',()=>autoPair().catch(()=>{}));
  window.addEventListener('agent-setup-complete',event=>{if(event.detail){renderAutoPairResult(event.detail);refresh({background:true}).catch(error=>notice(error.message,true));}});
  const unsubscribeSetup=api.agentSetupOnChanged?.(progress=>{renderSetupProgress(progress);if(progress.stage==='complete')refresh({background:true}).catch(error=>notice(error.message,true));});
  window.addEventListener('beforeunload',()=>{if(typeof unsubscribeSetup==='function')unsubscribeSetup();});
  window.aidesignAgentSetupUI={autoPair,openSettings,refresh:discoverRuntimes};
  $('agentJobSkill').addEventListener('change',skillNote);$('agentJobConnection').addEventListener('change',skillNote);
  $('agentRefresh').addEventListener('click',event=>action(event.currentTarget,async()=>{state.context=null;await refresh();notice('已读取最新任务、运行和授权状态。');}));
  $('agentConnectionForm').addEventListener('submit',event=>{event.preventDefault();action($('agentSaveConnection'),async()=>{
    let args=[];const mode=$('agentMode').value;
    if(['cli','acp'].includes(mode)){try{args=JSON.parse($('agentArgs').value||'[]');}catch{throw new Error('参数需要有效 JSON，例如 ["入口脚本路径", "参数"]。');}if(!Array.isArray(args)||args.some(item=>typeof item!=='string'))throw new Error('命令参数必须是 JSON 字符串数组。');}
    const previous=connection($('agentConnectionId').value)||{};
    const item=await api.agentSaveConnection({...previous,id:$('agentConnectionId').value||undefined,provider:$('agentProvider').value,label:$('agentConnectionLabel').value.trim(),mode,command:['cli','acp'].includes(mode)?$('agentCommand').value.trim():'',args,cwd:['cli','acp'].includes(mode)?$('agentCwd').value.trim():'',endpoint:mode==='openclaw-http'?$('agentEndpoint').value.trim():'',agentId:$('agentConfigAgentId').value.trim()||'main',tokenEnv:['cli','acp','openclaw-http'].includes(mode)?$('agentTokenEnv').value.trim():'',timeoutMs:Number($('agentTimeout').value)||300000});
    await refresh();editConnection(item.id);notice('连接配置已保存，尚未启动或验证真实任务。');
  });});
  $('agentProbeConnection').addEventListener('click',event=>action(event.currentTarget,async()=>{
    const id=$('agentConnectionId').value;if(!id||state.connectionDirty)throw new Error('请先保存连接的修改，再检查。');
    const item=connection(id);text('agentProbeResult','正在检查已保存的执行器。ACP 将启动协议进程进行握手，不发送模型任务…');
    const result=await api.agentProbeConnection(id);await refresh({background:true});
    if($('agentConnectionId').value===id)text('agentProbeResult',`${result.ok?'检查完成':'检查未通过'}：${result.message}`);
    notice(`${item.label}：${result.message}${result.stale?' 配置已变化，请重新检查。':''}`,!result.ok);
  },'connection-test'));
  $('agentTestConnection').addEventListener('click',event=>action(event.currentTarget,async()=>{
    const id=$('agentConnectionId').value;if(!id||state.connectionDirty)throw new Error('请先保存连接的修改，再试运行。');
    const item=connection(id);if(!automaticMode(item?.mode))throw new Error('当前不是主动派单模式。');
    if(!window.confirm(`使用“${item.label}”运行最小测试？只发送固定测试文字，不读取项目、知识库或文件，不挂载 Hub 工具。执行器仍保有其自身权限。会调用当前模型，可能消耗额度；最长等待 60 秒。`))return;
    text('agentProbeResult','正在等待真实执行器返回测试结果（最多 60 秒）…');notice('最小测试已开始，没有发送项目资料。');
    const result=await api.agentTestConnection(id);await refresh({background:true});
    if($('agentConnectionId').value===id)text('agentProbeResult',`${result.ok?'试运行完成':'试运行未通过'}：${result.message}`);
    notice(`${item.label}：${result.message}${result.stale?' 配置已变化，请重新测试。':''}`,!result.ok);
  },'connection-test'));
  $('agentGatewayToggle').addEventListener('click',event=>action(event.currentTarget,async()=>{const enabled=!state.snapshot?.gateway?.running;if(!enabled&&!window.confirm('关闭本机工具入口后，外部 Agent 暂时无法调用 Hub。已运行的外部任务不一定会停止。确认关闭？'))return;await api.agentGatewayToggle(enabled);await refresh();notice(enabled?'本机工具入口已开启；外部客户端仍需配置项目授权。':'本机工具入口已关闭。');}));
  $('agentGrantForm').addEventListener('submit',event=>{event.preventDefault();action($('agentCreateGrant'),async()=>{
    if($('agentNewToken').value&&!window.confirm('上一个新密钥仍在显示。继续将清除旧密钥的显示，请确认已经保存。'))return;
    const scopes=[...page.querySelectorAll('input[name="agentScope"]:checked')].map(input=>input.value);if(!scopes.length)throw new Error('至少选择一项授权能力。');
    clearToken('正在创建新授权，先前密钥与含密钥模板已清除。');
    if(!sensitiveSettingsVisible())throw new Error('请展开执行器设置中的 MCP 与项目授权后创建授权。');
    const requestEpoch=state.tokenEpoch;state.tokenRequestEpoch=requestEpoch;
    try{
      const result=await api.agentCreateGrant({label:$('agentGrantLabel').value.trim(),projectId:state.context.project.id,memberId:$('agentGrantMember').value,scopes});
      if(requestEpoch!==state.tokenEpoch||!sensitiveSettingsVisible())return;
      if(state.refreshPromise)await state.refreshPromise;
      if(requestEpoch!==state.tokenEpoch||!sensitiveSettingsVisible())return;
      await refresh({background:true});
      if(requestEpoch!==state.tokenEpoch||!sensitiveSettingsVisible())return;
      if(typeof result.token!=='string'||!result.token||!activeGrant(result.id)){clearToken('新授权状态无法确认，密钥未显示。请核实授权列表后重新创建。');throw new Error('新授权已失效或状态无法确认，密钥未显示。');}
      state.tokenGrantId=result.id;$('agentNewToken').value=result.token;$('agentTokenPanel').hidden=false;$('agentClientIncludeToken').disabled=false;
      notice('项目授权已建立。密钥只在本次显示，可单独复制或明确选择包含到 MCP 配置中。');
    }finally{if(state.tokenRequestEpoch===requestEpoch)state.tokenRequestEpoch=null;}
  });});
  $('agentCopyToken').addEventListener('click',event=>action(event.currentTarget,async()=>{const value=$('agentNewToken').value;if(!value)throw new Error('当前没有可复制的新密钥。');try{await navigator.clipboard.writeText(value);}catch{throw new Error('系统剪贴板不可用。请重新尝试复制；不要把密钥粘贴到日志或聊天中。');}notice('密钥已复制到系统剪贴板，请妥善保管并清除界面显示。');}));
  $('agentClearToken').addEventListener('click',()=>{clearToken();notice('密钥已从当前界面清除。系统剪贴板不会自动清空。');});
  $('agentClientTransport').addEventListener('change',()=>clearClientConfig('传输方式已改变，请重新生成对应配置。'));
  $('agentClientIncludeToken').addEventListener('change',()=>clearClientConfig('密钥选项已改变，请重新生成配置。'));
  $('agentGenerateClientConfig').addEventListener('click',event=>action(event.currentTarget,async()=>{
    if(typeof api?.agentClientConfig!=='function')throw new Error('当前主进程尚未提供客户端配置接口，请重启更新后的桌面程序。');
    const includeToken=$('agentClientIncludeToken').checked;
    if(!sensitiveSettingsVisible())throw new Error('请先展开 MCP 接入设置。');
    if(includeToken&&!$('agentNewToken').value)throw new Error('本次新授权密钥已经清除。请使用占位模板，或重新创建授权。');
    const token=includeToken?$('agentNewToken').value:undefined;
    clearClientConfig('正在生成客户端配置…');
    const requestEpoch=state.clientConfigEpoch;state.clientConfigPendingSensitive=includeToken;
    let result;
    try{result=await api.agentClientConfig({transport:$('agentClientTransport').value,...(includeToken?{token}:{})});}
    finally{if(state.clientConfigEpoch===requestEpoch)state.clientConfigPendingSensitive=false;}
    if(state.clientConfigEpoch!==requestEpoch||!sensitiveSettingsVisible()||(includeToken&&(!$('agentClientIncludeToken').checked||$('agentNewToken').value!==token)))return;
    const config=typeof result.config==='string'?result.config:JSON.stringify(result.config,null,2);
    if(!config)throw new Error('Hub 没有返回配置内容。');
    const sensitive=Boolean(result.containsToken||(token&&config.includes(token)));
    if(sensitive&&!includeToken)throw new Error('配置意外包含密钥，已阻止显示。请重新生成不含密钥的模板。');
    state.clientConfigContainsToken=sensitive;$('agentClientConfigPreview').value=config;$('agentClientConfigOutput').hidden=false;
    text('agentClientConfigState',sensitive?'含项目密钥':'密钥占位模板');
    text('agentClientConfigNote',sensitive?'此配置含本次授权密钥。刷新、撤销授权或隐藏密钥时会清除显示；剪贴板不会自动清空。':'此模板不含真实密钥。请在可信客户端中替换 <AIDESIGNHUB_TOKEN>，或明确选择包含本次新授权。');
    text('agentClientConfigWarning',result.warning||'不会自动修改客户端配置，也不会自动写入剪贴板。请确认客户端支持此配置格式。');
  }));
  $('agentCopyClientConfig').addEventListener('click',event=>action(event.currentTarget,async()=>{
    const config=$('agentClientConfigPreview').value;if(!config)throw new Error('请先生成客户端配置。');
    try{await navigator.clipboard.writeText(config);}catch{throw new Error('系统剪贴板不可用。请在配置预览中手动选择并复制。');}
    notice(state.clientConfigContainsToken?'含密钥配置已复制。请仅粘贴到受信任客户端，并妥善处理系统剪贴板。':'不含密钥的配置模板已复制，请在受信任客户端补入项目授权。');
  }));
  $('agentClearClientConfig').addEventListener('click',()=>clearClientConfig());
  $('agentJobForm').addEventListener('submit',event=>{event.preventDefault();const dispatch=event.submitter?.id==='agentDispatchJob';action(event.submitter||$('agentCreateJob'),async isCurrent=>{
    if(!state.context||!state.snapshot)throw new Error('当前项目仍在载入，请稍后派单。');
    const conn=connection($('agentJobConnection').value);const allowProjectTools=$('agentJobProjectTools').checked;
    if(dispatch&&!automaticMode(conn?.mode))throw new Error('请选择主动派单执行器；MCP 接入需由外部 Agent 认领。');
    if(dispatch&&!window.confirm(dispatchConfirmation(conn,allowProjectTools)))return;
    const job=await api.agentCreateJob({projectId:state.context.project.id,title:$('agentJobTitle').value.trim(),instruction:$('agentJobInstruction').value.trim(),skillId:$('agentJobSkill').value,connectionId:conn.id,allowProjectTools,requestId:crypto.randomUUID()});
    if(!isCurrent())return;
    $('agentJobTitle').value='';$('agentJobInstruction').value='';$('agentJobProjectTools').checked=false;
    let run;
    try{if(dispatch){run=await api.agentStartJob(job.id);if(!isCurrent())return;state.selectedRunId=run.id;}}
    catch(error){if(!isCurrent())return;await refresh();throw new Error(`任务已保存，但派单未启动：${error.message}。可以在下方任务卡片重试，不必重复建立任务。`);}
    await refresh();if(!isCurrent())return;window.dispatchEvent(new Event('agent-hub-changed'));
    if(run)$('agentRunTitle').scrollIntoView({block:'center',behavior:'smooth'});
    notice(dispatch?'已从 Hub 派单。请在运行详情查看进度与成果，完成后人工验收。':'任务已保存，尚未调用执行器。');
  },'create-job').finally(()=>skillNote());});
  $('agentExportRun').addEventListener('click',event=>action(event.currentTarget,async()=>{const run=currentRun();if(!run)return;const result=await api.agentExportRun(run.id);if(!result?.canceled)notice('任务包已导出。请仅交给获得本项目授权的执行器。');}));
  $('agentImportResult').addEventListener('click',event=>action(event.currentTarget,async()=>{const run=currentRun();if(!run)return;const result=await api.agentImportResult(run.id);if(!result?.canceled){await refresh();notice('成果已导入，仍需人工验收。');}}));
  $('agentCancelRun').addEventListener('click',event=>action(event.currentTarget,async()=>{const run=currentRun();if(!run||!window.confirm('请求取消本次运行？外部 Agent 的实际停止状态可能需要另行确认。'))return;await api.agentCancelRun(run.id);await refresh();notice('取消请求已登记，请查看运行状态。');}));
  for(const [id,approved] of [['agentApproveRun',true],['agentRejectRun',false]])$(id).addEventListener('click',event=>action(event.currentTarget,async()=>{const run=currentRun();if(!run||!window.confirm(approved?'确认已核对成果、来源和验收要求？通过后关联业务任务将标记完成。':'将本次成果退回？历史记录会保留，可重新建立执行尝试。'))return;await api.agentReviewRun(run.id,approved);await refresh();window.dispatchEvent(new Event('agent-hub-changed'));notice(approved?'人工验收通过，业务任务已更新。':'成果已退回，原运行与输出仍然保留。');}));
  let refreshTimer;
  const changed=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refresh({background:true}).catch(error=>notice(error.message,true));window.dispatchEvent(new Event('agent-hub-changed'));},120);};
  const unsubscribe=typeof api?.agentOnChanged==='function'?api.agentOnChanged(changed):null;
  document.querySelector('[data-view="agents"]')?.addEventListener('click',()=>refresh().catch(error=>notice(error.message,true)));
  window.addEventListener('agent-focus-run',event=>{const runId=event.detail?.runId;if(typeof runId!=='string'||!state.snapshot?.runs.some(run=>run.id===runId))return;const generation=state.generation;state.selectedRunId=runId;openHistory();refresh().then(()=>{if(generation!==state.generation)return;renderJobs();renderRun();$('agentRunTitle').scrollIntoView({block:'center',behavior:'smooth'});}).catch(error=>{if(generation===state.generation)notice(error.message,true);});});
  for(const navigation of document.querySelectorAll('[data-view],[data-view-target]'))navigation.addEventListener('click',()=>{const destination=navigation.dataset.view||navigation.dataset.viewTarget;if(destination!=='agents'){closeSettings();$('agentHistoryDialog').close();}});
  const pageVisibilityObserver=new MutationObserver(()=>{if(!agentPageVisible())clearToken('Agent 页面已隐藏，新密钥与含密钥模板已清除。');});
  pageVisibilityObserver.observe(page,{attributes:true,attributeFilter:['class','hidden','style','aria-hidden']});
  tokenVisibilityObserver=new MutationObserver(()=>{const panel=$('agentTokenPanel');const style=getComputedStyle(panel);if((state.tokenGrantId||state.tokenRequestEpoch!==null)&&(panel.hidden||panel.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'))clearToken();});
  tokenVisibilityObserver.observe($('agentTokenPanel'),{attributes:true,attributeFilter:['hidden','class','style','aria-hidden']});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clearToken('窗口已隐藏，新密钥与含密钥模板已清除。');});
  window.addEventListener('beforeunload',()=>{clearToken();clearTimeout(refreshTimer);pageVisibilityObserver.disconnect();tokenVisibilityObserver.disconnect();settingsVisibilityObserver.disconnect();if(typeof unsubscribe==='function')unsubscribe();});
  refresh().then(()=>{if(state.snapshot)notice('本机配置已载入。预设客户端尚需真实连接验证；项目数据不会随执行器更换。');}).catch(error=>notice(error.message,true));
})();
