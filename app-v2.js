(() => {
  'use strict';

  const api = window.bycjWorkbench;
  // Windows hides the native caption (its icon cannot be removed separately from
  // the taskbar icon); the renderer title strip takes its place.
  if (api?.platform === 'win32') document.documentElement.classList.add('win-frameless');
  // Renderer-owned strip kept at the window's left edge in agent mode so the
  // collapsed sidebar can still catch hover (the native view swallows the rest).
  const DSH_EDGE_INSET = api?.dshEdgeInset || 12;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const roleLabels = { designer:'项目设计师', pm:'项目经理', director:'设计总监', reviewer:'校审负责人', finance:'经营 / 财务', leader:'公司负责人' };
  const roleDescriptions = {
    designer:'聚焦设计任务、技术规定、成果完整度和模型图纸一致性。', pm:'聚焦里程碑、团队依赖、业主决策、范围变化和项目风险。',
    director:'聚焦产品定位、设计方向、空间与造型品质和阶段门决策。', reviewer:'聚焦规范、指标、图模一致和问题关闭。',
    finance:'聚焦合同边界、范围变更、开票条件和应收节点。', leader:'只接收需要公司介入的项目、资源和经营风险。',
  };
  const phaseTemplates = [
    {id:'intake',no:'00',name:'项目接收',desc:'任务书、基础资料与合同进入统一项目档案。',gate:['资料缺项已确认','合同范围已明确','项目团队已组建'],tools:['知识中心','合同与回款']},
    {id:'research',no:'01',name:'项目解读与研究',desc:'建立项目身份证，完成定位、市场、法规、竞品和场地研究。',gate:['产品定位确认','适用规范明确','关键设计边界锁定'],tools:['知识中心','案例与素材']},
    {id:'massing',no:'02',name:'强排与测算',desc:'推演总图和产品形态，校核指标、日照或货值。',gate:['容积率与密度成立','产品组合确认','强排方向通过'],tools:['Rhino','Archicad','指标引擎']},
    {id:'concept',no:'03',name:'概念设计',desc:'围绕文脉、产品与市场形成概念方向，并把模型、图像、文本和汇报组织成阶段成果。',gate:['设计方向书面确认','指标与模型一致','核心效果图完成','内部总监评审通过'],tools:['Rhino','AI生图','Illustrator','InDesign','PowerPoint']},
    {id:'develop',no:'04',name:'方案深化',desc:'深化造型、平立剖与技术策略，推进图模一体和专业协调。',gate:['图模一致','专业条件闭合','重大规范问题关闭'],tools:['Rhino','Archicad','Illustrator']},
    {id:'concept100',no:'05',name:'概念100',desc:'形成可正式汇报的完整平立剖、分析图、效果图与文本。',gate:['成果清单完整','内部校审通过','业主提交确认'],tools:['Archicad','Illustrator','InDesign','PowerPoint']},
    {id:'approval',no:'06',name:'报规与报件',desc:'根据规划沟通与政府要求完成指标复核、调整和正式报规成果。',gate:['政府清单完整','规划边界明确','报规版本锁定'],tools:['Archicad','Illustrator','InDesign']},
    {id:'archive',no:'07',name:'归档与复盘',desc:'沉淀成果、工时、经营数据、问题与案例，回到企业知识库。',gate:['归档完整','经验可检索','权限已复核'],tools:['知识中心','案例与素材','项目复盘']},
  ];
  const toolCatalog = [
    {id:'rhino',name:'Rhino',monogram:'R',color:'#4f73c8',role:'体量、曲面与参数化模型',caps:['模型版本','建模任务','几何与面积数据']},
    {id:'archicad',name:'Archicad',monogram:'AC',color:'#3486cf',role:'BIM、图模一体与技术图纸',caps:['项目视图','指标校核','图纸成果']},
    {id:'indesign',name:'Adobe InDesign',monogram:'Id',color:'#b51f57',role:'正式文本与报规文本排版',caps:['章节结构','素材置入','批量更新']},
    {id:'illustrator',name:'Adobe Illustrator',monogram:'Ai',color:'#c86c13',role:'分析图、矢量表达与后期整理',caps:['图层整理','图形替换','色板同步']},
    {id:'powerpoint',name:'Microsoft PowerPoint',monogram:'P',color:'#c55a2d',role:'会议汇报与快速阶段汇报',caps:['生成页面','素材替换','讲述备注']},
    {id:'obsidian',name:'Obsidian / 网页汇报',monogram:'O',color:'#7257c9',role:'研究记录、项目记忆与轻量汇报',caps:['双向链接','项目纪要','网页成果']},
  ];
  const roleMatrix = [['设计师','更新模型、总图、平立剖和指标表。'],['项目经理','记录业主确认，重排任务、依赖和工期。'],['设计总监','判断城市界面、概念方向和产品定位影响。'],['校审','复核限高、消防、日照、层数与面积。'],['经营财务','判断范围变更，保存证据并评估追加费用。']];
  const state = { data:null, role:'designer', currentView:'dashboard', currentPhase:'concept', currentChannelId:'', detectedApps:[], folder:null, caseFilter:'all', caseQuery:'', knowledgeFilter:'project', attachments:[], decisionSourceMessageId:null, messageSearch:'', teamSync:{mode:'off'}, syncBusy:null, projectGeneration:0, refreshGeneration:0, expectedProjectId:null, knowledgeSequence:0, importSequence:0, folderSequence:0, messageSearchSequence:0, dshViewLoaded:false, dshStatus:'' };

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
  function toast(message, kind='normal') { const node=document.createElement('div');node.className=`toast ${kind==='error'?'toast-error':''}`;node.textContent=message;$('#toastRegion').append(node);setTimeout(()=>node.remove(),3200); }
  const THEMES=['light','dark','minimal'];
  function applyTheme(name){ const theme=THEMES.includes(name)?name:'light';document.documentElement.dataset.theme=theme;try{localStorage.setItem('adh-theme',theme);}catch{}$$('[data-theme-choice]').forEach((button)=>button.classList.toggle('is-active',button.dataset.themeChoice===theme));return theme; }
  function setupTheme(){ $$('[data-theme-choice]').forEach((button)=>button.addEventListener('click',()=>{ const theme=applyTheme(button.dataset.themeChoice);api?.setTheme?.(theme).catch(()=>{}); })); }
  function formatDate(value, withTime=true) { if(!value)return '—';return new Date(value).toLocaleString('zh-CN',withTime?{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}:{year:'numeric',month:'numeric',day:'numeric'}); }
  function formatMoney(value) { return `¥${Number(value||0).toLocaleString('zh-CN')}`; }
  function formatBytes(bytes) { if(!Number.isFinite(bytes)||bytes<=0)return '0 B';const units=['B','KB','MB','GB'];let value=bytes,index=0;while(value>=1024&&index<units.length-1){value/=1024;index+=1;}return `${value.toFixed(value>=10||index===0?0:1)} ${units[index]}`; }
  function memberById(id) { return state.data?.members.find((item)=>item.id===id) || {name:'未知成员',avatar:'?',role:'designer'}; }
  function currentProjectId() { return state.data?.project.id; }
  function projectRequest(){return {generation:state.projectGeneration,projectId:currentProjectId()};}
  function requestIsCurrent(request){return request.generation===state.projectGeneration&&request.projectId===currentProjectId();}
  function openModal(modal) { modal.classList.add('is-open');modal.setAttribute('aria-hidden','false'); }
  function closeModal(modal) { if(modal.id==='caseModal'){window.aidesignCaseUI?.closeDetail();return;}modal.classList.remove('is-open');modal.setAttribute('aria-hidden','true'); }
  let dshModalHidden = null;
  function syncDshModalVisibility() {
    if (!api?.dshSetViewHidden) return;
    const hidden = Boolean(document.querySelector('dialog[open], .modal-backdrop.is-open'));
    if (hidden === dshModalHidden) return;
    dshModalHidden = hidden;
    api.dshSetViewHidden(hidden).catch(() => { dshModalHidden = null; });
  }
  let knowledgeWorkbench = null;
  function knowledgeView() {
    if (!knowledgeWorkbench && window.createKnowledgeWorkbench) knowledgeWorkbench = window.createKnowledgeWorkbench({ api, getProject: () => state.data?.project, toast });
    return knowledgeWorkbench;
  }
  function setView(view) {
    if(view==='skills'){window.aidesignAIHub?.openSkills();return;}
    if(view==='agents'){window.aidesignAIHub?.openCollaboration({tab:'settings'});return;}
    if(view==='assistant'||view==='chat'){window.aidesignHubChatUI?.open(view==='chat'?'group':'assistant');return;}
    if(view!=='cases')window.aidesignCaseUI?.closeDetail(false);
    const previousView=state.currentView;
    state.currentView=view;
    $$('.nav-item[data-view]').forEach((node)=>node.classList.toggle('is-active',node.dataset.view===view));
    const appShell=$('.app-shell'),sidebar=$('.sidebar'),dshContainer=$('#dshViewContainer');
    if(view==='adh-agent'){
      $$('.page-view').forEach(node=>node.classList.remove('is-active'));
      // The hub chat dock is position:fixed and would float above the native
      // view during the reveal; close it so nothing bleeds through the flash.
      window.aidesignHubChatUI?.close();
      state.dshViewLoaded=false;
      if(dshContainer){dshContainer.classList.remove('is-hidden');}
      sidebar?.classList.add('is-collapsed');
      sidebar?.classList.remove('is-hovering');
      appShell?.classList.add('dsh-agent-mode');
      // Keep a thin renderer-owned strip at the left edge so the collapsed
      // sidebar can still catch hover; the native view starts just right of it.
      window.bycjWorkbench?.dshSetViewInsetLeft?.(DSH_EDGE_INSET).catch(()=>{});
      // Yield the topbar row to the renderer so the shell chrome (project
      // switcher + chat icon) stays visible and clickable above the native view.
      updateAgentTopInset();
      requestAnimationFrame(()=>updateAgentRightInset());
      if(window.bycjWorkbench?.dshAttachView){
        // Main process lazy-starts the sidecar and attaches once ready.
        syncDshModalVisibility();
        window.bycjWorkbench.dshAttachView().catch(error=>toast(error.message,'error'));
      }
      requestAnimationFrame(()=>updateDshViewBounds());
      if(window.bycjWorkbench?.dshGetState){
        window.bycjWorkbench.dshGetState().then(renderDshState).catch(()=>{});
      }
    } else {
      if(previousView==='adh-agent'){
        if(window.bycjWorkbench?.dshDetachView){window.bycjWorkbench.dshDetachView().catch(()=>{});}
        if(window.bycjWorkbench?.dshSetViewInsetLeft){window.bycjWorkbench.dshSetViewInsetLeft(0).catch(()=>{});}
        if(window.bycjWorkbench?.dshSetViewInsetRight){window.bycjWorkbench.dshSetViewInsetRight(0).catch(()=>{});}
        if(window.bycjWorkbench?.dshSetViewInsetTop){window.bycjWorkbench.dshSetViewInsetTop(0).catch(()=>{});}
        if(dshContainer){dshContainer.classList.add('is-hidden');}
        sidebar?.classList.remove('is-collapsed','is-hovering');
        appShell?.classList.remove('dsh-agent-mode');
      }
      $$('.page-view').forEach((node)=>node.classList.toggle('is-active',node.id===`view-${view}`));
      $('.main-area')?.scrollTo({top:0,behavior:'smooth'});
    }
    if (view === 'knowledge') { const knowledge = knowledgeView(); knowledge?.setVisible?.(true); void knowledge?.refresh?.(); }
    else knowledgeWorkbench?.setVisible?.(false);
    window.dispatchEvent(new CustomEvent('hub-view-changed',{detail:{view}}));
  }
  function renderDshState(dshState){
    const overlay=$('#dshBootOverlay');
    if(!overlay||!dshState)return;
    state.dshStatus=dshState.status;
    const status=dshState.status;
    // Only lift the overlay once the runtime is ready AND the native view has
    // finished painting; otherwise a half-drawn frame flashes through.
    const revealed=status==='ready'&&state.dshViewLoaded===true;
    overlay.classList.toggle('is-hidden',revealed);
    const copy={missing:['Agent Hub 尚未启动','点击"重试启动"准备本地 Agent 运行时。'],downloading:['正在下载独立运行时','首次使用需要下载 Node 与 DSH，请稍候…'],starting:['正在启动 Agent Hub','本地主机解析服务地址中…'],stopped:['Agent Hub 已停止','点击"重试启动"重新拉起本地运行时。'],error:['AI 运行时异常',dshState.message||'启动过程中出错，请重试。'],ready:['正在加载 AI 界面','本地视图渲染中…']};
    const [title,detail]=copy[status]||['',''];
    const titleNode=$('#dshBootTitle'),detailNode=$('#dshBootDetail'),retry=$('#dshBootRetry'),progress=$('#dshBootProgress'),fill=$('#dshBootProgressFill');
    if(titleNode)titleNode.textContent=title;
    if(detailNode)detailNode.textContent=detail;
    if(retry)retry.hidden=!(status==='missing'||status==='error'||status==='stopped');
    if(progress)progress.classList.toggle('is-hidden',status!=='downloading');
    if(fill&&status==='downloading')fill.style.width=`${Math.max(2,Math.min(100,Number(dshState.progress)||0))}%`;
  }
  function markDshViewLoaded(){
    state.dshViewLoaded=true;
    if(state.currentView==='adh-agent')renderDshState({status:state.dshStatus||'ready'});
  }
  function updateDshViewBounds(){
    const container=$('#dshViewContainer');
    if(!container||!window.bycjWorkbench?.dshSetViewBounds)return;
    const rect=container.getBoundingClientRect();
    window.bycjWorkbench.dshSetViewBounds({x:Math.round(rect.left),y:Math.round(rect.top),width:Math.round(rect.width),height:Math.round(rect.height)}).catch(()=>{});
  }
  // In agent mode the native view covers everything below the topbar, so the
  // open chat dock only stays usable if the native view yields its strip.
  function updateAgentRightInset(){
    if(!window.bycjWorkbench?.dshSetViewInsetRight)return;
    if(state.currentView!=='adh-agent'){window.bycjWorkbench.dshSetViewInsetRight(0).catch(()=>{});return;}
    const dockOpen=$('.app-shell')?.classList.contains('has-hub-chat');
    const dock=dockOpen?$('#hubChatDock'):null;
    const inset=dock?Math.round(dock.getBoundingClientRect().width):0;
    window.bycjWorkbench.dshSetViewInsetRight(Math.max(0,inset)).catch(()=>{});
  }
  function updateAgentTopInset(){
    if(!window.bycjWorkbench?.dshSetViewInsetTop)return;
    if(state.currentView!=='adh-agent'){window.bycjWorkbench.dshSetViewInsetTop(0).catch(()=>{});return;}
    const topbar=$('.topbar');
    // The native view is anchored to the shell top, so yield everything above
    // the topbar's bottom edge (title strip + topbar).
    const inset=topbar?Math.round(topbar.getBoundingClientRect().bottom):0;
    window.bycjWorkbench.dshSetViewInsetTop(Math.max(0,inset)).catch(()=>{});
  }
  async function refreshData(options={}) {
    const generation=state.projectGeneration,sequence=++state.refreshGeneration;
    const data=await api.bootstrap();
    if(generation!==state.projectGeneration||sequence!==state.refreshGeneration)return;
    if(state.expectedProjectId&&data.project.id!==state.expectedProjectId)return;
    if(state.data&&state.data.project.id!==data.project.id){window.dispatchEvent(new CustomEvent('hub-project-changed',{detail:{projectId:data.project.id}}));return;}
    state.data=data;state.expectedProjectId=data.project.id;state.role=isCompanyDemo()?memberById(data.settings.currentMemberId).role:data.settings.currentRole||'designer';
    if(!state.currentChannelId||!data.channels.some(c=>c.id===state.currentChannelId))state.currentChannelId=data.channels.find(c=>c.type==='project')?.id||data.channels[0]?.id||'';
    renderDataViews();$('.view-stack').inert=false;if(options.toast)toast(options.toast);
    return data;
  }
  function resetProject(projectId){
    state.projectGeneration++;state.refreshGeneration++;state.expectedProjectId=projectId||null;state.data=null;state.folder=null;state.attachments=[];state.currentChannelId='';state.messageSearch='';state.caseFilter='all';state.caseQuery='';state.knowledgeFilter='project';state.decisionSourceMessageId=null;state.currentPhase='intake';state.syncBusy=null;state.knowledgeSequence++;state.importSequence++;state.folderSequence++;state.messageSearchSequence++;
    $('.view-stack').inert=true;window.aidesignCaseUI?.closeDetail(false);window.aidesignCaseUI?.render([],{project:{id:projectId},cases:[]});
    $$('.modal-backdrop.is-open').forEach(closeModal);$$('dialog[open]').forEach(d=>d.close());
    $('#aiDrawer').classList.remove('is-open');$('#aiDrawer').setAttribute('aria-hidden','true');
    for(const id of ['teamChatInput','messageSearchInput','caseSearch','knowledgeQuery','aiInput','decisionTitleInput','decisionSummaryInput','memberNameInput','memberTitleInput','memberSkillsInput']){const element=$(`#${id}`);if(element)element.value='';}
    for(const id of ['messageList','channelList','chatMemberList','decisionList','drawerMessages','recentFiles','fileStats','folderPath','folderProjectName','scanTimestamp','knowledgeDocList']){const element=$(`#${id}`);if(element)element.replaceChildren();}
    $('#knowledgeAnswer').innerHTML='<div class="knowledge-empty">已切换项目，请检索当前项目的资料。</div>';$('#folderEmpty').classList.remove('is-hidden');$('#folderDashboard').classList.add('is-hidden');$('#fileNavCount').textContent='—';$('#knowledgeImportType').value='project';$('#messageSearchBar').classList.add('is-hidden');renderAttachmentPreview();
    $$('[data-case-filter]').forEach(button=>button.classList.toggle('is-active',button.dataset.caseFilter==='all'));
    for(const [id,label] of [['knowledgeAsk','检索项目知识'],['importKnowledgeButton','＋ 导入本地资料'],['sendTeamMessage','发送']]){const button=$(`#${id}`);if(button){button.disabled=false;button.textContent=label;}}
    $('#topProjectName').textContent='正在切换项目…';
  }
  window.addEventListener('hub-project-changed',event=>{resetProject(event.detail?.projectId);refreshData().then(data=>{if(data){state.currentPhase=data.project.stage||'intake';renderPhases();window.dispatchEvent(new CustomEvent('hub-view-changed',{detail:{view:state.currentView}}));}}).catch(error=>toast(error.message,'error'));});

  window.addEventListener('agent-hub-changed', () => { if(state.data)refreshData().catch(error=>toast(error.message,'error')); });
  window.addEventListener('case-hub-changed', () => { if(state.data)refreshData().catch(error=>toast(error.message,'error')); });
  window.addEventListener('project-hub-changed', () => { if(state.data)refreshData().catch(error=>toast(error.message,'error')); });

  function renderDataViews() {
    renderRole();renderRoleOptions();renderDashboard();renderPhases();renderCases();renderSchedule();renderContracts();renderTeam();renderKnowledgeDocuments();renderChat();renderTeamSync();
    const demo=isCompanyDemo();document.title=demo?'AIDesignHub · 演示公司':'AIDesignHub';
    if(demo){$('.privacy-note strong').textContent='演示公司工作区';$('.privacy-note div>span').textContent='独立数据，不改原项目';}
  }

  function roleBriefs() {
    const tasks=state.data.tasks,risks=state.data.risks.filter((item)=>item.status==='open'),decisions=state.data.decisions;
    if(state.role==='pm')return risks.slice(0,3).map((item,index)=>({level:index<2?'high':'medium',icon:'!',title:item.title,body:item.description,action:'进入风险'}));
    if(state.role==='director')return decisions.slice(0,3).map((item)=>({level:item.status==='confirmed'?'info':'medium',icon:'决',title:item.title,body:item.summary,action:'查看决策'}));
    if(state.role==='reviewer')return [...tasks.filter((item)=>item.ownerId===state.data.settings.currentMemberId),...risks].slice(0,3).map((item)=>({level:item.priority==='high'||item.severity==='high'?'high':'medium',icon:'校',title:item.title,body:item.description||`任务状态：${item.status}`,action:'开始校核'}));
    if(state.role==='finance')return state.data.contractMilestones.slice(0,3).map((item)=>({level:item.status==='pending-trigger'?'high':'info',icon:'¥',title:item.title,body:`${item.condition} · ${formatMoney(item.amount)}`,action:'查看节点'}));
    if(state.role==='leader'){const payment=state.data.contractMilestones.find(m=>m.status==='pending-trigger');return [{level:risks.length?'high':'info',icon:'!',title:`当前已登记 ${risks.length} 项未关闭风险`,body:'基于项目已录入记录，不代表自动完成风险排查。',action:'查看风险'},...(payment?[{level:'medium',icon:'¥',title:payment.title,body:`${payment.condition} · 已登记 ${formatMoney(payment.amount)}`,action:'查看现金流'}]:[])];}
    return tasks.filter((item)=>item.ownerId===state.data.settings.currentMemberId&&item.status!=='done').slice(0,3).map((item)=>({level:item.priority==='high'?'high':'medium',icon:item.source==='review'?'规':'图',title:item.title,body:`截止：${formatDate(item.dueAt)} · 当前状态 ${item.status==='doing'?'进行中':'待开始'}`,action:'更新任务'}));
  }

  function isCompanyDemo(){return state.data?.demoCompany?.id==='aidesignhub_demo_company'&&state.data.demoCompany.initialized===true;}

  function renderRole() {
    const label=roleLabels[state.role]||roleLabels.designer;const member=memberById(state.data.settings.currentMemberId);const briefs=roleBriefs();
    const profile=$('.profile-mini');if(profile){$('strong',profile).textContent=member.name;$('.avatar',profile).textContent=member.avatar||String(member.name||'?')[0];}
    const roleAvatar=$('.role-chip .avatar');if(roleAvatar)roleAvatar.textContent=member.avatar||String(member.name||'?')[0];
    $('#sidebarRole').textContent=label;$('#headerRole').textContent=label;$('#teamCurrentRole').textContent=label;$('#drawerRole').textContent=`面向${label}`;
    $('#dashboardGreeting').textContent=`早上好，${member.name}`;$('#dashboardSubline').textContent=`你正在以${label}身份工作。${roleDescriptions[state.role]}`;$('#briefTitle').textContent=`给${label}的今日简报`;
    if(isCompanyDemo()){$('#sidebarRole').textContent=member.title||label;$('#dashboardSubline').textContent=`演示身份：${member.name} · ${member.title||label}。当前项目权限：${label}。${roleDescriptions[state.role]}`;profile?.setAttribute('aria-label',`切换演示身份，当前 ${member.name}`);}
    $('#briefList').innerHTML=(briefs.length?briefs:[{level:'info',icon:'✓',title:'暂无已登记待处理事项',body:'尚未登记不代表没有风险；请通过项目聊天补充情况。',action:'查看项目'}]).map((item)=>`<div class="brief-item"><span class="brief-priority ${item.level}">${escapeHtml(item.icon)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></div><button data-brief-action>${escapeHtml(item.action)}</button></div>`).join('');
  }

  function renderRoleOptions() { $('#roleOptions').innerHTML=Object.entries(roleLabels).map(([id,label])=>`<button class="role-option ${state.role===id?'is-selected':''}" data-role="${id}"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(roleDescriptions[id])}</p></button>`).join(''); }

  function renderDashboard() {
    const project=state.data.project;$('#topProjectName').textContent=project.name;$('#chatProjectName').textContent=project.name;$('#drawerContext').textContent=`${project.name} · ${phaseTemplates.find(p=>p.id===project.stage)?.name||'阶段待确认'}`;
    $('.project-logo').textContent=String(project.name||'项')[0];
    const openRisks=state.data.risks.filter((item)=>item.status==='open');const pending=state.data.contractMilestones.find((item)=>item.status==='pending-trigger');
    const metrics=$$('#view-dashboard .metric-card strong');if(metrics[0])metrics[0].textContent=`${phaseTemplates.find(p=>p.id===project.stage)?.name||'待确认'} · 第 ${project.stageRound||1} 轮`;if(metrics[1])metrics[1].textContent=`${state.data.tasks.filter((item)=>item.status==='done').length} / ${state.data.tasks.length} 项任务标记完成`;if(metrics[2])metrics[2].textContent=`${openRisks.length} 项待处理`;if(metrics[3])metrics[3].textContent=pending?.title||'暂无待触发节点';
    const subtitles=$$('#view-dashboard .metric-card p');if(subtitles[0])subtitles[0].textContent=project.focus||'由负责人维护阶段与本轮重点';if(subtitles[1])subtitles[1].textContent='任务状态统计，不等于设计完成度';if(subtitles[2])subtitles[2].textContent='基于已录入的风险，不代表自动全面排查';if(subtitles[3])subtitles[3].textContent=pending?`已登记金额 ${formatMoney(pending.amount)} · 条件待人工核对`:'尚无记录';
    $$('#view-dashboard .ring').forEach(node=>node.remove());
    $('#dashboardStageFlow').innerHTML=phaseTemplates.map((p,index)=>`${index?'<i></i>':''}<button class="stage ${p.id===project.stage?'is-current':''}" data-dashboard-phase="${p.id}"><span>${p.no}</span><strong>${p.name}</strong><small>${p.id===project.stage?'人工设定的当前阶段':'未登记阶段确认'}</small></button>`).join('');
    $('#dashboardStageFlow').style.gridTemplateColumns=phaseTemplates.map((_,index)=>`${index?'20px ':''}minmax(90px,1fr)`).join(' ');
    $('#dashboardStageFlow').style.overflowX='auto';
    const delivery=$('.deliverable-card');if(delivery){const confirmed=state.data.decisions.filter(d=>d.status==='confirmed');delivery.innerHTML=`<div class="card-heading"><div><span class="section-kicker">PROJECT MEMORY</span><h2>当前有效决定</h2></div><span>${confirmed.length} 项</span></div>${confirmed.slice(0,4).map(d=>`<div class="hub-record"><strong>${escapeHtml(d.title)}</strong><p>${escapeHtml(d.summary)}</p><small>来自项目决定记录 · ${formatDate(d.confirmedAt||d.createdAt)}</small></div>`).join('')||'<p class="hub-muted">尚无确认决定。请通过项目助手记录并确认。</p>'}`;}
    const riskCount=$('.nav-item[data-view="schedule"] .nav-count');if(riskCount)riskCount.textContent=openRisks.length;
    const eventList=$('.event-list');if(eventList)eventList.innerHTML=state.data.events.slice(0,5).map((item)=>`<div class="event-row"><span class="event-icon ${item.type==='risk'?'amber':item.type==='decision'?'violet':item.type==='knowledge'?'green':'blue'}">${item.type==='chat'?'聊':item.type==='decision'?'决':item.type==='knowledge'?'知':item.type==='risk'?'!':'项'}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail||'')} · ${formatDate(item.createdAt)}</p></div><span class="event-tag">${escapeHtml(item.type)}</span></div>`).join('');
    $('#chatNavCount').textContent=state.data.messages.length;
  }

  function renderPhases() {
    $('#phaseRail').innerHTML=phaseTemplates.map((phase)=>`<button class="phase-button ${state.currentPhase===phase.id?'is-active':''}" data-phase="${phase.id}"><span class="phase-number">${phase.no}</span><span><strong>${phase.name}</strong><small>${state.data.project.stage===phase.id?'当前阶段 · 人工设定':'查看本阶段事项'}</small></span></button>`).join('');
    const phase=phaseTemplates.find((item)=>item.id===state.currentPhase)||phaseTemplates[3];
    window.aidesignProjectUI?.renderStage(phase,state.data);
  }

  function renderCases() {
    const query=state.caseQuery.toLowerCase().trim();const cases=state.data.cases.filter((item)=>(state.caseFilter==='all'||item.type===state.caseFilter)&&(!query||`${item.name} ${item.location} ${item.designer} ${(item.tags||[]).join(' ')}`.toLowerCase().includes(query)));
    window.aidesignCaseUI?.render(cases,state.data);
  }

  function renderTools() {
    const detected=new Map(state.detectedApps.map((item)=>[item.id,item]));$('#toolGrid').innerHTML=toolCatalog.map((tool)=>{const found=detected.get(tool.id);return`<article class="tool-card"><div class="tool-head"><span class="tool-logo" style="background:${tool.color}">${tool.monogram}</span><div><strong>${tool.name}</strong><small>${tool.role}</small></div><span class="tool-status ${found?.installed?'installed':''}">${found?(found.installed?'本机已检测':'未检测到'):'等待检测'}</span></div><p>${tool.role}。成果仍由专业软件生成并回收到项目大脑。</p><div class="capability-list">${tool.caps.map((cap)=>`<span>${cap}</span>`).join('')}</div><div class="tool-footer"><small>${found?.installed?'可安全启动':'尚未发现安装路径'}</small><button data-tool-detail="${tool.id}">${found?.installed?'打开软件':'查看安装建议'}</button></div></article>`;}).join('');
  }

  function renderSchedule() {
    const unfinished=state.data.tasks.filter(t=>t.status!=='done');const late=unfinished.filter(t=>t.dueAt&&t.dueAt<Date.now());
    $('.schedule-card .health-badge').textContent=`${late.length} 项任务超过已登记截止时间`;
    $('#gantt').innerHTML=unfinished.map(t=>`<div class="hub-record"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(memberById(t.ownerId).name)} · ${escapeHtml(window.aidesignProjectUI?.taskStates[t.status]||t.status)} · ${t.dueAt?`截止 ${formatDate(t.dueAt)}`:'未设截止时间'}${t.dueAt&&t.dueAt<Date.now()?' · 请核对延期原因':''}</small></div>`).join('')||'<p class="hub-muted">暂无未完成任务记录。这不等于项目已全部完成。</p>';
    const risks=state.data.risks.filter((item)=>item.status==='open');$('#riskList').innerHTML=risks.length?risks.map((item)=>`<div class="risk-item ${item.severity==='high'?'high':''}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p><footer><span>${escapeHtml(memberById(item.ownerId).name)}</span><button class="text-button" data-risk-close="${item.id}">标记已处理 →</button></footer></div>`).join(''):'<p class="knowledge-empty">当前没有未关闭风险。</p>';
    $('.risk-card .card-heading > span').textContent=`${risks.length} 项`;
  }

  function renderContracts() {
    $('#paymentTimeline').innerHTML=state.data.contractMilestones.map((item,index)=>`<div class="payment-row ${item.status==='paid'?'done':item.status==='pending-trigger'?'current':''}"><span class="payment-dot">${item.status==='paid'?'✓':index+1}</span><p><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.condition)}</small></p><div class="payment-amount"><strong>${formatMoney(item.amount)}</strong><span>${item.status==='paid'?'已到账':item.status==='pending-trigger'?'待触发':'未到期'}</span>${item.status!=='paid'?`<button class="text-button" data-milestone-paid="${item.id}">登记回款</button>`:''}</div></div>`).join('');
    const cards=$$('.contract-summary .metric-card strong');const total=state.data.contractMilestones.reduce((sum,item)=>sum+item.amount,0);const paid=state.data.contractMilestones.filter((item)=>item.status==='paid').reduce((sum,item)=>sum+item.amount,0);const next=state.data.contractMilestones.find((item)=>item.status==='pending-trigger');if(cards[0])cards[0].textContent=formatMoney(total);if(cards[1])cards[1].textContent=formatMoney(paid);if(cards[2])cards[2].textContent=formatMoney(next?.amount||0);if(cards[3])cards[3].textContent=`${state.data.scopeChanges.length} 项待确认`;
  }

  function renderTeam() {
    window.aidesignTeamUI?.refresh().catch(error=>toast(error.message,'error'));
    $('#teamGrid').innerHTML=state.data.members.map((member)=>`<article class="team-card"><header><span class="avatar">${escapeHtml(member.avatar)}</span><div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(roleLabels[member.role]||member.title)}</small></div></header><p>${escapeHtml((member.skills||[]).join('、')||member.title)}</p><footer><span>${state.data.tasks.filter(t=>t.ownerId===member.id&&t.status!=='done').length} 项已登记待办</span><button data-member-chat="${member.id}">发消息</button></footer></article>`).join('');$('#roleMatrix').innerHTML=roleMatrix.map(([role,response])=>`<div class="role-response"><strong>${role}</strong><p>${response}</p></div>`).join('');
  }

  function knowledgeDocRow(doc){return `<div class="knowledge-doc"><span>${escapeHtml((doc.extension||'文').toUpperCase().slice(0,3))}</span><p><strong>${escapeHtml(doc.name)}</strong><small>${doc.status==='indexed'?`${doc.chunkCount} 个索引片段`:(doc.warning||'仅元数据')}${doc.scope==='team'&&doc.teamAuthorName?` · 来自 ${escapeHtml(doc.teamAuthorName)}`:''}</small></p><span><button data-doc-reveal="${doc.id}" aria-label="打开位置">⌕</button><button data-doc-remove="${doc.id}" aria-label="删除">×</button></span></div>`;}
  function renderKnowledgeDocuments() {
    if (knowledgeWorkbench && state.currentView === 'knowledge') void knowledgeWorkbench.refresh();
    const all=state.data.knowledgeDocs;$$('[data-knowledge-count]').forEach((node)=>{node.textContent=`${all.filter((doc)=>(doc.sourceType||'project')===node.dataset.knowledgeCount).length} 份`;});
    $$('[data-knowledge-filter]').forEach((button)=>button.classList.toggle('is-selected',button.dataset.knowledgeFilter===state.knowledgeFilter));
    const documents=all.filter((doc)=>(doc.sourceType||'project')===state.knowledgeFilter);
    const localDocs=documents.filter((doc)=>doc.scope!=='team'),teamDocs=documents.filter((doc)=>doc.scope==='team');
    $('#knowledgeDocCount').textContent=`${documents.length} 份资料`;
    $('#knowledgeDocList').innerHTML=`<div class="resource-section"><h3>本机资源 <span class="hub-muted">${localDocs.length} 份</span></h3>${localDocs.length?localDocs.map(knowledgeDocRow).join(''):'<p class="hub-muted">这个分类还没有本机资料。选择资料类型后点击“导入本地资料”。</p>'}</div><div class="resource-section"><h3>团队共享 <span class="hub-muted">${teamDocs.length} 份</span></h3>${teamDocs.length?teamDocs.map(knowledgeDocRow).join(''):'<p class="hub-muted">暂无团队共享资料。导入时选择“导入到团队共享”，同步后团队成员都能看到。</p>'}</div>`;
  }

  function renderKnowledgeAnswer(result) {
    const citations=result.hits||[];$('#knowledgeAnswer').innerHTML=`<div class="answer-head"><span class="ai-orb">✦</span><div><strong>本地项目知识助手</strong><small>抽取式回答，不会把资料上传云端</small></div><span class="evidence-badge">${citations.length} 条依据</span></div><div class="answer-content"><pre>${escapeHtml(result.answer)}</pre></div><div class="citation-list">${citations.map((hit,index)=>`<button class="is-real" data-citation-doc="${hit.documentId}"><span>${String(index+1).padStart(2,'0')}</span><p><strong>${escapeHtml(hit.documentName)}</strong><small>${escapeHtml(hit.excerpt)}</small></p><em>${escapeHtml(hit.locator)}</em></button>`).join('')}</div>`;
  }

  function renderChat(messagesOverride=null) {
    const channels=state.data.channels;const channel=channels.find((item)=>item.id===state.currentChannelId)||channels[0];if(!channel)return;state.currentChannelId=channel.id;
    $('#channelList').innerHTML=channels.map((item)=>`<button class="channel-button ${item.id===channel.id?'is-active':''}" data-channel="${item.id}"><span class="channel-symbol">#</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description)}</small></span></button>`).join('');
    $('#chatMemberList').innerHTML=state.data.members.map((member)=>`<div class="chat-member"><span class="avatar">${escapeHtml(member.avatar)}</span><span><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(roleLabels[member.role]||member.title)}</small></span><i class="presence"></i></div>`).join('');
    $('#conversationTitle').textContent=messagesOverride?'聊天搜索结果':channel.name;$('#conversationDescription').textContent=messagesOverride?`找到 ${messagesOverride.length} 条消息`:channel.description;
    const messages=messagesOverride||state.data.messages.filter((item)=>item.channelId===channel.id);const currentId=state.data.settings.currentMemberId;
    $('#messageList').innerHTML=messages.length?`<div class="message-day">项目消息永久保存在本地项目数据库中</div>${messages.map((message)=>{const sender=memberById(message.senderId);const own=message.senderId===currentId;return`<article class="team-message ${own?'is-own':''} ${message.type==='decision'?'is-decision':''}" data-message-id="${message.id}"><span class="message-avatar">${escapeHtml(sender.avatar)}</span><div class="message-content"><div class="message-meta"><strong>${escapeHtml(sender.name)}</strong><time>${formatDate(message.createdAt)}</time></div><div class="message-bubble">${escapeHtml(message.body)}${(message.attachments||[]).length?`<div class="message-attachments">${message.attachments.map((file)=>`<button class="message-attachment" data-reveal-path="${escapeHtml(file.storedPath)}"><span>${escapeHtml((file.extension||'FILE').slice(0,4).toUpperCase())}</span>${escapeHtml(file.name)} · ${formatBytes(file.size)}</button>`).join('')}</div>`:''}</div><div class="message-tools"><button data-message-decision="${message.id}">标记为决策</button><button data-message-task="${message.id}">转为任务</button></div></div></article>`;}).join('')}`:'<div class="empty-chat"><strong>这个频道还没有消息</strong><p>发出第一条项目消息，后续可沉淀为决策或任务。</p></div>';
    $('#decisionCount').textContent=state.data.decisions.length;$('#decisionList').innerHTML=state.data.decisions.map((item)=>`<article class="decision-card"><header><h3>${escapeHtml(item.title)}</h3><span class="decision-status ${item.status==='confirmed'?'confirmed':''}">${item.status==='confirmed'?'已确认':'待确认'}</span></header><p>${escapeHtml(item.summary)}</p><footer><span>${escapeHtml(memberById(item.ownerId).name)} · ${formatDate(item.createdAt)}</span>${item.status!=='confirmed'?`<button data-decision-confirm="${item.id}">确认决策</button>`:'<button data-decision-source="'+item.id+'">查看源消息</button>'}</footer></article>`).join('');
    $('#chatNavCount').textContent=state.data.messages.length;renderAttachmentPreview();
  }

  function renderTeamSync() {
    if(!state.data)return;
    const sync=state.teamSync||{mode:'off'};const mode=sync.mode||'off';
    const label=$('#teamSyncLabel');const card=$('#teamSyncStatusCard');
    label.classList.toggle('is-host',mode==='host');label.classList.toggle('is-client',mode==='client');
    label.innerHTML=mode==='host'?'<i class="status-dot"></i> 团队主机运行中':mode==='client'?'<i class="status-dot"></i> 已连接项目主机':'<i class="status-dot"></i> 本地项目消息库';
    card.classList.toggle('is-host',mode==='host');card.classList.toggle('is-client',mode==='client');
    $('#teamSyncStatusTitle').textContent=mode==='host'?'这台电脑正在保存团队项目数据':mode==='client'?'已连接团队项目主机':'仅保存在这台电脑';
    $('#teamSyncStatusDetail').textContent=mode==='host'?`监听地址：${(sync.addresses||[]).join('、')||'正在启动'}`:mode==='client'?`服务器：${sync.url||'已连接'}${sync.lastError?` · ${sync.lastError}`:''}`:'可以直接使用本地聊天、决策和知识库。';
    $('#currentMemberSelect').innerHTML=state.data.members.map((member)=>`<option value="${member.id}">${escapeHtml(member.name)} · ${escapeHtml(member.title||roleLabels[member.role])}</option>`).join('');
    $('#currentMemberSelect').value=state.data.settings.currentMemberId;
    const invite=$('#teamInvitePanel');invite.classList.toggle('is-hidden',mode!=='host');
    if(mode==='host'){const url=(sync.addresses||[])[0]||'';$('#teamInviteUrl').value=url;$('#teamInviteToken').value=sync.token||'';}
    $('#disconnectTeamSync').classList.toggle('is-hidden',mode==='off');
  }

  async function refreshTeamSyncStatus() {
    const request=projectRequest(),result=await api.teamSyncStatus();if(requestIsCurrent(request)){state.teamSync=result;renderTeamSync();}return result;
  }

  async function syncTeamData({notify=false}={}) {
    if(state.syncBusy||!state.data)return;
    const mode=state.teamSync?.mode;if(mode!=='host'&&mode!=='client')return;
    const request=projectRequest(),operation={};state.syncBusy=operation;
    try{
      const signature=data=>JSON.stringify([data.project,data.members,data.channels,data.messages,data.decisions,data.tasks,data.risks,data.contractMilestones,data.scopeChanges,data.knowledgeDocs,data.cases,data.events,data.settings.currentMemberId,data.settings.currentRole]);
      const before=signature(state.data);
      const result=await api.teamSyncNow();const afterData=result.data;
      if(!requestIsCurrent(request)||afterData?.project.id!==request.projectId)return;
      const after=signature(afterData);
      state.data=afterData;state.role=afterData.settings.currentRole||state.role;
      if(before!==after){renderDataViews();window.dispatchEvent(new Event('project-hub-changed'));if(notify)toast('团队项目已同步到最新状态');}
      await refreshTeamSyncStatus();
    }catch(error){if(requestIsCurrent(request)){state.teamSync={...(state.teamSync||{}),lastError:error.message};renderTeamSync();if(notify)toast(`同步失败：${error.message}`,'error');}}
    finally{if(state.syncBusy===operation)state.syncBusy=null;}
  }

  async function openTeamSyncModal() {
    openModal($('#teamSyncModal'));
    try{await refreshTeamSyncStatus();}catch(error){toast(error.message,'error');}
  }

  function renderAttachmentPreview() { const panel=$('#attachmentPreview');panel.classList.toggle('is-hidden',!state.attachments.length);panel.innerHTML=state.attachments.map((file,index)=>`<div class="attachment-chip">${escapeHtml(file.name)} · ${formatBytes(file.size)}<button data-remove-attachment="${index}">×</button></div>`).join(''); }
  function scrollMessages() { const list=$('#messageList');if(list)list.scrollTop=list.scrollHeight; }
  function openDecisionModal(messageId=null) { state.decisionSourceMessageId=messageId;const message=state.data.messages.find((item)=>item.id===messageId);$('#decisionTitleInput').value=message?message.body.split(/[。！\n]/)[0].slice(0,48):'';$('#decisionSummaryInput').value=message?.body||'';$('#decisionOwnerInput').innerHTML=state.data.members.map((member)=>`<option value="${member.id}">${escapeHtml(member.name)} · ${escapeHtml(roleLabels[member.role]||member.title)}</option>`).join('');$('#decisionOwnerInput').value=state.data.settings.currentMemberId;const preview=$('#sourceMessagePreview');preview.classList.toggle('is-hidden',!message);preview.textContent=message?`源消息：${memberById(message.senderId).name} · ${message.body}`:'';openModal($('#decisionModal')); }

  function renderFolder(folder) { state.folder=folder;$('#folderEmpty').classList.add('is-hidden');$('#folderDashboard').classList.remove('is-hidden');$('#folderProjectName').textContent=folder.projectName;$('#folderPath').textContent=folder.rootPath;$('#fileNavCount').textContent=folder.fileCount;$('#scanTimestamp').textContent=`扫描于 ${new Date(folder.scannedAt).toLocaleString('zh-CN')}`;const stats=[['模型',folder.summary.model],['图纸/排版',folder.summary.drawing],['图片',folder.summary.image],['文本/表格',folder.summary.document],['目录总量',folder.fileCount]];$('#fileStats').innerHTML=stats.map(([label,value])=>`<div class="file-stat"><small>${label}</small><strong>${value}</strong></div>`).join('');const icons={model:'3D',drawing:'图',image:'IMG',document:'文',other:'FILE'};$('#recentFiles').innerHTML=folder.recent.map((file)=>`<div class="file-row"><span class="file-type">${icons[file.category]||'FILE'}</span><div><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.category)}</small></div><small class="file-path">${escapeHtml(file.relativePath)}</small><small>${formatBytes(file.size)}</small><time>${formatDate(file.modifiedAt)}</time></div>`).join(''); }

  async function detectApps() { const button=$('#detectAppsButton');button.disabled=true;button.textContent='正在检测…';try{state.detectedApps=await api.detectInstalledApps();renderTools();toast(`发现 ${state.detectedApps.filter((item)=>item.installed).length} 个支持的软件`);}catch(error){toast(error.message,'error');}finally{button.disabled=false;button.textContent='重新检测本机软件';} }
  async function bindFolder() { const request=projectRequest(),sequence=++state.folderSequence;if(!request.projectId)return;try{const result=await api.selectProjectFolder();if(requestIsCurrent(request)&&sequence===state.folderSequence&&result){renderFolder(result);toast(`已只读扫描 ${result.fileCount} 个文件`);}}catch(error){if(requestIsCurrent(request))toast(error.message,'error');} }
  async function importKnowledge() { if(window.createKnowledgeWorkbench){await knowledgeView()?.importFiles?.();return;}const request=projectRequest(),sequence=++state.importSequence;if(!request.projectId)return;const button=$('#importKnowledgeButton');button.disabled=true;button.textContent='正在解析并建立索引…';try{const type=$('#knowledgeImportType').value;const scope=$('#knowledgeImportScope')?.value==='team'?'team':'local';const docs=await api.selectKnowledgeFiles(request.projectId,type,scope);if(!requestIsCurrent(request)||sequence!==state.importSequence)return;if(docs.length){state.knowledgeFilter=type;await refreshData({toast:`已导入 ${docs.length} 份资料`});}}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}finally{if(requestIsCurrent(request)&&sequence===state.importSequence){button.disabled=false;button.textContent='＋ 导入本地资料';}} }
  async function searchKnowledge() { const query=$('#knowledgeQuery').value.trim(),request=projectRequest(),sequence=++state.knowledgeSequence;if(!query||!request.projectId)return;const button=$('#knowledgeAsk');button.disabled=true;button.textContent='正在检索本地索引…';try{const result=await api.searchKnowledge(request.projectId,query);if(!requestIsCurrent(request)||sequence!==state.knowledgeSequence)return;renderKnowledgeAnswer(result);toast(`检索完成：${result.hits.length} 条依据`);}catch(error){if(requestIsCurrent(request)&&sequence===state.knowledgeSequence)toast(error.message,'error');}finally{if(requestIsCurrent(request)&&sequence===state.knowledgeSequence){button.disabled=false;button.textContent='检索项目知识';}} }

  function bindStaticEvents() {
    $$('.nav-item[data-view]').forEach((button)=>button.addEventListener('click',()=>setView(button.dataset.view)));$$('[data-view-target]').forEach((button)=>button.addEventListener('click',()=>setView(button.dataset.viewTarget)));
    $$('[data-open-role-menu]').forEach((button)=>button.addEventListener('click',()=>{if(isCompanyDemo())window.aidesignTeamUI?.openIdentityPicker().catch(error=>toast(error.message,'error'));else openModal($('#roleModal'));}));$$('[data-close-modal]').forEach((button)=>button.addEventListener('click',()=>closeModal(button.closest('.modal-backdrop'))));$$('.modal-backdrop').forEach((backdrop)=>backdrop.addEventListener('click',(event)=>{if(event.target===backdrop)closeModal(backdrop);}));
    $('#bindFolderButton').addEventListener('click',bindFolder);$('#bindFolderButtonSecondary').addEventListener('click',bindFolder);$('#rescanFolderButton').addEventListener('click',bindFolder);$('#detectAppsButton').addEventListener('click',detectApps);
    $('#importKnowledgeButton').addEventListener('click',importKnowledge);$('#aiImportKnowledgeButton').addEventListener('click',()=>{setView('knowledge');importKnowledge();});$('#knowledgeAsk').addEventListener('click',searchKnowledge);$('#knowledgeQuery').addEventListener('keydown',(event)=>{if(event.key==='Enter')searchKnowledge();});
    $('#exportBackupButton').addEventListener('click',async()=>{const result=await api.exportBackup();if(result)toast(`备份已导出：${result.filePath}`);});
    $('#caseSearch').addEventListener('input',(event)=>{state.caseQuery=event.target.value;renderCases();});$$('[data-case-filter]').forEach((button)=>button.addEventListener('click',()=>{state.caseFilter=button.dataset.caseFilter;$$('[data-case-filter]').forEach((item)=>item.classList.toggle('is-active',item===button));renderCases();}));
    $('#caseAdvancedFilter').addEventListener('click',()=>{const query=window.prompt('输入地区、设计单位或标签关键词',state.caseQuery);if(query!==null){state.caseQuery=query.trim();$('#caseSearch').value=state.caseQuery;renderCases();}});
    $('#openCaseCollector').addEventListener('click',()=>window.aidesignCaseUI?.focusCollector());
    $('#askAiButton').addEventListener('click',()=>window.aidesignHubChatUI?.open('assistant'));$('#closeAiDrawer').addEventListener('click',()=>{$('#aiDrawer').classList.remove('is-open');$('#aiDrawer').setAttribute('aria-hidden','true');});
    $('#projectSwitcher').addEventListener('click',()=>window.aidesignTeamUI?.openProjectPicker().catch(error=>toast(error.message,'error')));$('#explainBrief').addEventListener('click',()=>setView('schedule'));
    $('#recentEventsButton').addEventListener('click',()=>toast(`当前项目已记录 ${state.data.events.length} 条最近事件`));$('#editWorkflowButton').addEventListener('click',()=>window.alert('阶段由负责人判断，不由AI读取文件猜测。选择阶段可查看任务并调整阶段、轮次和重点；修改先进入项目助手核对，再写入项目记录。Agent任务需要在Agent协作中验收。当前本机身份选择不是企业账户权限系统。'));
    $('#exportWeeklyReportButton').addEventListener('click',async()=>{try{const result=await api.exportWeeklyReport();if(result)toast(`项目周报已导出：${result.filePath}`);}catch(error){toast(error.message,'error');}});
    $('#viewContractSourceButton').addEventListener('click',async()=>{try{const doc=await api.findContractSource();if(doc)await api.revealFile(doc.storedPath);else{state.knowledgeFilter='contract';$('#knowledgeImportType').value='contract';setView('knowledge');renderKnowledgeDocuments();toast('尚未导入合同原文，请选择合同与商务资料后导入','error');}}catch(error){toast(error.message,'error');}});
    $('#generateScopeReportButton').addEventListener('click',async()=>{try{const result=await api.generateScopeReport();toast(`变更影响清单已生成：${result.filePath}`);}catch(error){toast(error.message,'error');}});
    $('#inviteMemberButton').addEventListener('click',()=>openModal($('#memberModal')));
    $('#teamSyncButton').addEventListener('click',openTeamSyncModal);
    $('#currentMemberSelect').addEventListener('change',async(event)=>{try{await api.setCurrentMember(event.target.value);window.dispatchEvent(new CustomEvent('hub-project-changed',{detail:{projectId:currentProjectId()}}));toast('当前项目身份已切换');}catch(error){toast(error.message,'error');}});
    $('#startLocalTeamServer').addEventListener('click',async()=>{try{state.teamSync=await api.startTeamServer({lan:false});renderTeamSync();toast('本机团队同步服务已启动');}catch(error){toast(error.message,'error');}});
    $('#startLanTeamServer').addEventListener('click',async()=>{try{state.teamSync=await api.startTeamServer({lan:true});renderTeamSync();toast('局域网团队协作已启动');}catch(error){toast(error.message,'error');}});
    $('#connectTeamServer').addEventListener('click',async()=>{const button=$('#connectTeamServer'),generation=state.projectGeneration;button.disabled=true;try{await api.connectTeamServer({url:$('#teamServerUrlInput').value.trim(),token:$('#teamServerTokenInput').value.trim()});const data=await api.bootstrap();if(generation!==state.projectGeneration)return;if(data.project.id!==currentProjectId())window.dispatchEvent(new CustomEvent('hub-project-changed',{detail:{projectId:data.project.id}}));else await refreshData();await refreshTeamSyncStatus();toast('已连接并同步团队项目');}catch(error){if(generation===state.projectGeneration)toast(`连接失败：${error.message}`,'error');}finally{button.disabled=false;}});
    $('#disconnectTeamSync').addEventListener('click',async()=>{try{state.teamSync=await api.disconnectTeamSync();renderTeamSync();toast('已断开团队同步，本地数据仍然保留');}catch(error){toast(error.message,'error');}});
    $('#copyTeamInvite').addEventListener('click',async()=>{const text=`BYCJ Design 团队项目邀请\n服务器：${$('#teamInviteUrl').value}\n访问密钥：${$('#teamInviteToken').value}`;try{await navigator.clipboard.writeText(text);}catch{$('#teamInviteUrl').select();document.execCommand('copy');}toast('邀请信息已复制');});
    $('#newDecisionButton').addEventListener('click',()=>openDecisionModal());$('#chatSearchButton').addEventListener('click',()=>{$('#messageSearchBar').classList.remove('is-hidden');$('#messageSearchInput').focus();});$('#messageSearchToggle').addEventListener('click',()=>{$('#messageSearchBar').classList.remove('is-hidden');$('#messageSearchInput').focus();});$('#closeMessageSearch').addEventListener('click',()=>{$('#messageSearchBar').classList.add('is-hidden');$('#messageSearchInput').value='';renderChat();});
    $('#messageSearchInput').addEventListener('input',async(event)=>{const request=projectRequest(),sequence=++state.messageSearchSequence;try{const results=await api.searchMessages(request.projectId,event.target.value);if(requestIsCurrent(request)&&sequence===state.messageSearchSequence)renderChat(results);}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}});$('#addMemberButton').addEventListener('click',()=>openModal($('#memberModal')));$('#channelMembersButton').addEventListener('click',()=>openModal($('#memberModal')));$('#channelInfoButton').addEventListener('click',async()=>{const name=window.prompt('输入新频道名称，例如：景观协调');if(!name)return;const description=window.prompt('输入频道用途说明','项目专业协作频道')||'项目专业协作频道',request=projectRequest();try{const channel=await api.addChannel({projectId:request.projectId,name,description});if(!requestIsCurrent(request))return;state.currentChannelId=channel.id;await refreshData({toast:`频道 #${channel.name} 已创建`});}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}});
    $('#attachChatFile').addEventListener('click',async()=>{const request=projectRequest();try{const files=await api.selectChatAttachments(request.projectId);if(requestIsCurrent(request)){state.attachments.push(...files);renderAttachmentPreview();}}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}});$('#insertDecisionHint').addEventListener('click',()=>{$('#teamChatInput').value='【待确认】决定：\n影响范围：\n责任人：\n截止日期：';$('#teamChatInput').focus();});
    $('#teamChatComposer').addEventListener('submit',async(event)=>{event.preventDefault();const request=projectRequest(),input=$('#teamChatInput'),body=input.value.trim();if(!request.projectId||(!body&&!state.attachments.length))return;const button=$('#sendTeamMessage');button.disabled=true;try{await api.sendMessage({projectId:request.projectId,channelId:state.currentChannelId,senderId:state.data.settings.currentMemberId,body,attachments:state.attachments});if(!requestIsCurrent(request))return;input.value='';state.attachments=[];await refreshData();scrollMessages();}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}finally{if(requestIsCurrent(request))button.disabled=false;}});
    $('#teamChatInput').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#teamChatComposer').requestSubmit();}});
    $('#saveDecisionButton').addEventListener('click',async()=>{const request=projectRequest();try{await api.createDecision({projectId:request.projectId,channelId:state.currentChannelId,title:$('#decisionTitleInput').value.trim(),summary:$('#decisionSummaryInput').value.trim(),ownerId:$('#decisionOwnerInput').value,status:$('#decisionStatusInput').value,sourceMessageIds:state.decisionSourceMessageId?[state.decisionSourceMessageId]:[]});if(!requestIsCurrent(request))return;closeModal($('#decisionModal'));await refreshData({toast:'项目决策已保存并写入频道'});if(requestIsCurrent(request))setView('chat');}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}});
    $('#saveMemberButton').addEventListener('click',async()=>{const request=projectRequest();try{await api.addMember({projectId:request.projectId,name:$('#memberNameInput').value.trim(),title:$('#memberTitleInput').value.trim(),role:$('#memberRoleInput').value,skills:$('#memberSkillsInput').value.split(/[,，]/).map((item)=>item.trim()).filter(Boolean)});if(!requestIsCurrent(request))return;closeModal($('#memberModal'));await refreshData({toast:'项目成员已添加'});window.dispatchEvent(new Event('project-hub-changed'));}catch(error){if(requestIsCurrent(request))toast(error.message,'error');}});
    $('#aiComposer').addEventListener('submit',event=>{event.preventDefault();const query=$('#aiInput').value.trim();if(!query)return;$('#aiInput').value='';window.aidesignHubChatUI?.open('assistant',{prefill:query});});
    document.addEventListener('keydown',(event)=>{if(event.key==='Escape'){$('#aiDrawer').classList.remove('is-open');$$('.modal-backdrop.is-open').forEach(closeModal);}});
  }

  function bindDelegatedEvents() {
    document.addEventListener('click',async(event)=>{const target=event.target.closest('button');if(!target)return;
      try {
        if(target.dataset.role){state.role=target.dataset.role;await api.setRole(state.role);closeModal($('#roleModal'));await refreshData({toast:`已切换为${roleLabels[state.role]}视角`});}
        else if(target.dataset.dashboardPhase){state.currentPhase=target.dataset.dashboardPhase;setView('workflow');renderPhases();}
        else if(target.dataset.phase){state.currentPhase=target.dataset.phase;renderPhases();}
        else if(target.dataset.knowledgeFilter){state.knowledgeFilter=target.dataset.knowledgeFilter;renderKnowledgeDocuments();}
        else if(target.dataset.taskToggle){const task=state.data.tasks.find((item)=>item.id===target.dataset.taskToggle);await window.aidesignProjectUI.prepareDirect(`人工更新任务：${task.title}`,[{type:'task.update',id:task.id,data:{status:task.status==='done'?'todo':'done'}}]);}
        else if(target.hasAttribute('data-add-task')){const title=window.prompt('输入新任务名称');if(title){await api.addTask({projectId:currentProjectId(),phase:state.currentPhase,title});await refreshData({toast:'任务已添加'});}}
        else if(target.dataset.stageTool){const map={'知识中心':'knowledge','案例与素材':'cases','合同与回款':'contracts','Rhino':'tools','Archicad':'tools','Illustrator':'tools','InDesign':'tools','PowerPoint':'tools'};setView(map[target.dataset.stageTool]||'tools');}
        else if(target.hasAttribute('data-stage-review'))setView('assistant');
        else if(target.dataset.caseRemove){await api.removeCase(target.dataset.caseRemove);await refreshData({toast:'案例已删除'});}
        else if(target.dataset.caseOpen)window.aidesignCaseUI?.openDetail(target.dataset.caseOpen);
        else if(target.dataset.riskClose){await window.aidesignProjectUI.prepareDirect('人工确认风险已处理，请核对后关闭。',[{type:'risk.update',id:target.dataset.riskClose,data:{status:'closed'}}]);}
        else if(target.dataset.milestonePaid){if(!window.confirm('请确认已核对实际到账凭证。本操作只登记人工确认，不会查询银行账户或自动收款。'))return;await api.updateMilestone(target.dataset.milestonePaid,{status:'paid',paidAt:Date.now()});await refreshData({toast:'已记录人工回款确认'});}
        else if(target.dataset.channel){state.currentChannelId=target.dataset.channel;state.messageSearch='';renderChat();scrollMessages();}
        else if(target.dataset.messageDecision)openDecisionModal(target.dataset.messageDecision);
        else if(target.dataset.messageTask){const message=state.data.messages.find((item)=>item.id===target.dataset.messageTask);await api.addTask({projectId:currentProjectId(),phase:'concept',title:message.body.slice(0,80),source:'chat'});await refreshData({toast:'聊天消息已转为项目任务'});}
        else if(target.dataset.removeAttachment!==undefined){state.attachments.splice(Number(target.dataset.removeAttachment),1);renderAttachmentPreview();}
        else if(target.dataset.decisionConfirm){await window.aidesignProjectUI.prepareDirect('人工确认此项要求成为项目决定。',[{type:'decision.update',id:target.dataset.decisionConfirm,data:{status:'confirmed'}}]);}
        else if(target.dataset.decisionSource){const decision=state.data.decisions.find((item)=>item.id===target.dataset.decisionSource);const source=state.data.messages.find((item)=>decision.sourceMessageIds.includes(item.id));if(source){state.currentChannelId=source.channelId;renderChat();setView('chat');setTimeout(()=>document.querySelector(`[data-message-id="${source.id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'}),50);}else toast('该决策没有关联源消息');}
        else if(target.dataset.revealPath)await api.revealFile(target.dataset.revealPath);
        else if(target.dataset.docReveal){const doc=state.data.knowledgeDocs.find((item)=>item.id===target.dataset.docReveal);await api.revealFile(doc.storedPath);}
        else if(target.dataset.docRemove){if(window.confirm('从本地知识库移除这份资料？')){await api.removeKnowledge(target.dataset.docRemove);await refreshData({toast:'知识资料已移除'});}}
        else if(target.dataset.toolDetail){const found=state.detectedApps.find((item)=>item.id===target.dataset.toolDetail);if(found?.installed){const result=await api.launchInstalledApp(target.dataset.toolDetail);toast(`${result.name} 已启动；模型写入仍需对应受控插件`);}else toast('这台电脑没有检测到该软件，请先安装或检查安装路径','error');}
        else if(target.dataset.memberChat)window.aidesignHubChatUI?.open('group',{prefill:`@${memberById(target.dataset.memberChat).name} `});
        else if(target.dataset.aiSuggestion)window.aidesignHubChatUI?.open('assistant',{prefill:target.dataset.aiSuggestion});
        else if(target.hasAttribute('data-brief-action')){state.role==='finance'?setView('contracts'):state.role==='pm'||state.role==='leader'?setView('schedule'):setView('phases');}
      } catch(error){toast(error.message||String(error),'error');}
    });
  }

  function setupDshIntegration() {
    if(!window.bycjWorkbench?.dshGetState)return;
    // HTML modal dialogs lock the shell, but a native child view otherwise
    // remains above them. Yield its surface until the last shell modal closes.
    const modalObserver = new MutationObserver(syncDshModalVisibility);
    modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class'] });
    syncDshModalVisibility();
    const appShell=$('.app-shell'),sidebar=$('.sidebar');
    let hoverTimer=null,leaveTimer=null;
    // Collapsed keeps the thin edge strip renderer-owned; expanded hands the
    // native view's left boundary to the full sidebar width so the panel itself
    // receives hover/mouseleave.
    const setSidebarInset=(expanded)=>{
      if(!window.bycjWorkbench?.dshSetViewInsetLeft)return;
      const width=expanded&&sidebar?Math.round(sidebar.getBoundingClientRect().width):DSH_EDGE_INSET;
      window.bycjWorkbench.dshSetViewInsetLeft(width).catch(()=>{});
    };
    const showSidebar=()=>{sidebar?.classList.add('is-hovering');setSidebarInset(true);};
    const hideSidebar=()=>{
      if(leaveTimer){clearTimeout(leaveTimer);leaveTimer=null;}
      if(hoverTimer){clearTimeout(hoverTimer);hoverTimer=null;}
      sidebar?.classList.remove('is-hovering');setSidebarInset(false);
    };
    appShell?.addEventListener('mousemove',(event)=>{
      if(state.currentView!=='adh-agent')return;
      if(!sidebar?.classList.contains('is-collapsed'))return;
      if(sidebar.classList.contains('is-hovering'))return;
      if(event.clientX<=DSH_EDGE_INSET){
        if(!hoverTimer){hoverTimer=setTimeout(()=>{if(state.currentView==='adh-agent')showSidebar();hoverTimer=null;},320);}
      } else if(hoverTimer){clearTimeout(hoverTimer);hoverTimer=null;}
    });
    // While expanded the native view covers everything right of the sidebar, so
    // the renderer never sees the cursor leave; main's watchdog reports it here.
    window.bycjWorkbench.dshOnHoverLeave?.(()=>{
      if(state.currentView==='adh-agent'&&sidebar?.classList.contains('is-hovering'))hideSidebar();
    });
    sidebar?.addEventListener('mouseleave',()=>{
      if(state.currentView!=='adh-agent')return;
      if(!sidebar.classList.contains('is-collapsed')||!sidebar.classList.contains('is-hovering'))return;
      if(!leaveTimer){leaveTimer=setTimeout(()=>{hideSidebar();leaveTimer=null;},220);}
    });
    sidebar?.addEventListener('mouseenter',()=>{
      if(leaveTimer){clearTimeout(leaveTimer);leaveTimer=null;}
    });
    const dshContainer=$('#dshViewContainer');
    if(dshContainer&&typeof ResizeObserver!=='undefined'){
      const observer=new ResizeObserver(()=>{if(state.currentView==='adh-agent')updateDshViewBounds();});
      observer.observe(dshContainer);
      window.addEventListener('resize',()=>{if(state.currentView==='adh-agent'){updateDshViewBounds();updateAgentRightInset();updateAgentTopInset();}});
    }
    // Opening/closing the chat dock in agent mode changes how much right edge the
    // native view must yield; recompute the inset after the layout settles.
    window.addEventListener('hub-chat-dock',()=>{requestAnimationFrame(()=>updateAgentRightInset());});
    $('#dshBootRetry')?.addEventListener('click',()=>{
      state.dshViewLoaded=false;
      window.bycjWorkbench.dshStart?.().then(renderDshState).catch(error=>toast(error.message,'error'));
    });
    window.bycjWorkbench.dshOnViewLoaded?.(()=>markDshViewLoaded());
    window.bycjWorkbench.dshOnStateChanged((dshState)=>{
      renderDshState(dshState);
      if(dshState.status==='ready'&&state.currentView==='adh-agent'){
        syncDshModalVisibility();
        window.bycjWorkbench.dshAttachView?.().then(()=>updateDshViewBounds()).catch(()=>{});
      }
    });
  }

  async function init() {
    if(!api){document.body.innerHTML='<main style="padding:40px;font-family:sans-serif"><h1>请通过桌面启动器运行</h1><p>本地后端只在Electron桌面环境中提供。</p></main>';return;}
    bindStaticEvents();bindDelegatedEvents();setupDshIntegration();setupTheme();
    try{api.getTheme?.().then((theme)=>applyTheme(theme)).catch(()=>{});}catch{}
    try{const generation=state.projectGeneration,[info,apps,sync]=await Promise.all([api.runtimeInfo(),api.detectInstalledApps(),api.teamSyncStatus()]);document.documentElement.dataset.runtime=`electron-${info.electronVersion}`;state.detectedApps=apps;if(generation===state.projectGeneration)state.teamSync=sync;renderTools();const data=await refreshData();if(data){state.currentPhase=data.project.stage||'intake';renderPhases();scrollMessages();if(isCompanyDemo()){setView('team');window.aidesignHubChatUI?.close();}}window.dispatchEvent(new CustomEvent('hub-view-changed',{detail:{view:state.currentView}}));setInterval(()=>{if(!document.hidden)syncTeamData();},4000);}
    catch(error){toast(`本地后端启动失败：${error.message}`,'error');throw error;}
  }

  window.aidesignApp={setView,refreshData};
  window.aidesignHubToast=toast;
  try{applyTheme(localStorage.getItem('adh-theme')||'light');}catch{}
  init();
})();
