(() => {
  'use strict';

  const roles = {
    designer: {
      label: '项目设计师', short: '设计师', drawer: '面向项目设计师',
      description: '聚焦今天要完成的设计任务、技术规定、成果完整度和模型图纸一致性。',
      subline: 'AI优先显示技术任务、规范依据和今日交付。',
      briefs: [
        { level: 'high', icon: '!', title: '先处理模型与指标表的版本差异', body: '总图模型已到 V23，但面积指标表仍对应 V21；继续出图会扩大返工。', action: '定位差异' },
        { level: 'medium', icon: '规', title: '补充消防车转弯包络检查', body: '第 2 轮总图调整了裙房转角，消防车道需要重新复核。', action: '查看依据' },
        { level: 'info', icon: '图', title: '效果图还缺 4 个关键视点', body: '建议优先完成主入口、中央广场、屋顶花园和沿江界面。', action: '生成任务' },
      ],
    },
    pm: {
      label: '项目经理', short: '项目经理', drawer: '面向项目经理',
      description: '聚焦里程碑、团队依赖、业主决策、范围变化和项目失控风险。',
      subline: 'AI优先显示进度偏差、未确认决策、责任人与范围变化。',
      briefs: [
        { level: 'high', icon: '!', title: '概念阶段存在 1 项阻断问题', body: '业主提出高度调整但尚未书面确认，设计团队已开始返工。', action: '发起确认' },
        { level: 'medium', icon: '◷', title: '概念里程碑预计滞后 2 天', body: '效果图和指标复核依赖最新总图，当前关键路径已出现冲突。', action: '调整计划' },
        { level: 'info', icon: '会', title: '本周会议仍有 6 项行动未关闭', body: '其中 2 项没有责任人，建议在今日站会中明确。', action: '查看行动' },
      ],
    },
    director: {
      label: '设计总监', short: '设计总监', drawer: '面向设计总监',
      description: '聚焦产品定位、设计方向、空间与造型品质以及阶段门决策。',
      subline: 'AI优先显示设计方向偏差、关键评审事项和对标案例。',
      briefs: [
        { level: 'high', icon: '!', title: '高度调整可能削弱已确认的城市界面', body: '沿江塔楼比例和中央广场围合关系发生明显变化，需要方向复审。', action: '查看对比' },
        { level: 'medium', icon: '案', title: '为主入口准备了 8 个高相关案例', body: '均为同规模开放式商业街，已按入口层次和雨棚策略分类。', action: '打开案例板' },
        { level: 'info', icon: '评', title: '建议周四进行概念阶段门评审', body: '核心成果已完成 69%，指标复核后即可进入总监评审。', action: '安排评审' },
      ],
    },
    reviewer: {
      label: '校审负责人', short: '校审', drawer: '面向校审负责人',
      description: '聚焦规范、指标、图模一致、阶段成果完整性和问题关闭。',
      subline: 'AI优先显示规范校核、指标异常、版本冲突和待关闭问题。',
      briefs: [
        { level: 'high', icon: '!', title: '指标表与模型存在 3 项潜在不一致', body: '计容面积、屋顶机房和商业连廊口径需要人工复核。', action: '开始校核' },
        { level: 'medium', icon: '消', title: '消防车道需要重新形成校审证据', body: '最新裙房轮廓已变化，但消防分析图未同步更新。', action: '打开清单' },
        { level: 'info', icon: '✓', title: '概念阶段 18 项成果已具备校审条件', body: 'AI已按概念100预检查表整理文件入口。', action: '进入校审' },
      ],
    },
    finance: {
      label: '经营 / 财务', short: '经营财务', drawer: '面向经营与财务',
      description: '聚焦合同边界、范围变更、开票条件、应收节点和经营证据。',
      subline: 'AI优先显示付款条件、范围变化、应收账款和商务证据。',
      briefs: [
        { level: 'high', icon: '¥', title: '概念确认将触发 48 万元应收', body: '需准备阶段成果确认记录，并在确认后 7 日内完成请款。', action: '准备请款' },
        { level: 'medium', icon: '＋', title: '识别到 2 项潜在范围变更', body: '高度与产品组合变化预计新增 11.5 人日，尚未形成书面商务确认。', action: '查看证据' },
        { level: 'info', icon: '同', title: '合同中有 1 项表述建议人工复核', body: '“多轮修改”未定义轮次上限，可能影响后续范围管理。', action: '查看条款' },
      ],
    },
    leader: {
      label: '公司负责人', short: '公司负责人', drawer: '面向公司负责人',
      description: '只接收需要公司介入的项目健康度、资源冲突、利润和现金流风险。',
      subline: 'AI只升级重大项目、资源和经营风险，不推送普通画图事项。',
      briefs: [
        { level: 'high', icon: '!', title: '本项目需要关注范围失控趋势', body: '近两周已出现 3 次方向性调整，预计投入正在超过计划。', action: '查看经营影响' },
        { level: 'medium', icon: '人', title: '效果图资源与另一重点项目冲突', body: '两项目在 8 月 12–16 日同时需要主创与表现团队。', action: '调整资源' },
        { level: 'info', icon: '¥', title: '未来 30 天预计形成 3 笔应收', body: '合计 126 万元，其中本项目为 48 万元。', action: '查看现金流' },
      ],
    },
  };

  const phases = [
    { id:'intake', no:'00', name:'项目接收', status:'done', desc:'任务书、基础资料与合同进入统一项目档案。', progress:100, tasks:['任务书结构化','基础资料完整性检查','合同节点提取'], gate:['资料缺项已确认','合同范围已明确','项目团队已组建'], tools:['知识解析','合同助手'] },
    { id:'research', no:'01', name:'项目解读与研究', status:'done', desc:'建立项目身份证，完成定位、市场、法规、竞品和场地研究。', progress:100, tasks:['建立项目身份证','地方规范矩阵','竞品与对标案例板'], gate:['产品定位确认','适用规范明确','关键设计边界锁定'], tools:['知识中心','案例库','地图场地'] },
    { id:'massing', no:'02', name:'强排与测算', status:'done', desc:'推演总图和产品形态，校核指标、日照或货值。', progress:100, tasks:['三版总图强排','面积指标测算','日照与货值比较'], gate:['容积率与密度成立','产品组合确认','强排方向通过'], tools:['Rhino','Archicad','指标引擎'] },
    { id:'concept', no:'03', name:'概念设计', status:'current', desc:'围绕文脉、产品与市场形成概念方向，并把模型、图像、文本和汇报组织成阶段成果。', progress:69, tasks:['概念叙事与关键词','总图模型 V23','主入口与广场效果图','设计分析图 6/9','概念汇报文本','面积指标复核'], gate:['设计方向书面确认','指标与模型一致','核心效果图完成','内部总监评审通过'], tools:['Rhino','AI生图','Illustrator','InDesign','PowerPoint'] },
    { id:'develop', no:'04', name:'方案深化', status:'next', desc:'深化造型、平立剖与技术策略，推进图模一体和专业协调。', progress:0, tasks:['模型深化','平立剖协调','技术策略','规范复核'], gate:['图模一致','专业条件闭合','重大规范问题关闭'], tools:['Rhino','Archicad','Illustrator'] },
    { id:'concept100', no:'05', name:'概念100', status:'next', desc:'形成可正式汇报的完整平立剖、分析图、效果图与文本。', progress:0, tasks:['正式技术图','总图分析','流线分析','效果图与文本'], gate:['成果清单完整','内部校审通过','业主提交确认'], tools:['Archicad','Illustrator','InDesign','PowerPoint'] },
    { id:'approval', no:'06', name:'报规与报件', status:'next', desc:'根据规划沟通与政府要求完成指标复核、调整和正式报规成果。', progress:0, tasks:['规划沟通记录','报规指标复核','正式图纸与文本'], gate:['政府清单完整','规划边界明确','报规版本锁定'], tools:['Archicad','Illustrator','InDesign'] },
    { id:'archive', no:'07', name:'归档与复盘', status:'next', desc:'沉淀成果、工时、经营数据、问题与案例，回到企业知识库。', progress:0, tasks:['项目成果归档','工时与成本复盘','案例卡片生成'], gate:['归档完整','经验可检索','权限已复核'], tools:['知识中心','案例库','项目复盘'] },
  ];

  const baseCases = [
    { id:1, name:'成都麓湖天府美食岛', type:'commercial', typeLabel:'开放式商业', location:'成都', designer:'万华 / 设计团队', tags:['滨水商业','街区尺度','夜间场景'], source:'公开案例', saved:true },
    { id:2, name:'上海蟠龙天地', type:'commercial', typeLabel:'商业街区', location:'上海', designer:'瑞安 / Benoy', tags:['江南文脉','小尺度街巷','更新'], source:'公开案例', saved:true },
    { id:3, name:'阿那亚礼堂与社区', type:'culture', typeLabel:'文化与社区', location:'秦皇岛', designer:'直向建筑', tags:['目的地','精神性','社群运营'], source:'公开案例', saved:true },
    { id:4, name:'深圳万象前海', type:'commercial', typeLabel:'商业综合体', location:'深圳', designer:'Lead8 / 华润置地', tags:['多首层','立体动线','城市界面'], source:'公开案例', saved:true },
    { id:5, name:'杭州天目里', type:'commercial', typeLabel:'混合社区', location:'杭州', designer:'Renzo Piano', tags:['低密园区','文化商业','灰空间'], source:'公开案例', saved:true },
    { id:6, name:'苏州金鸡湖凯悦酒店', type:'hotel', typeLabel:'城市酒店', location:'苏州', designer:'综合团队', tags:['城市客厅','滨水界面','公共空间'], source:'内部案例', saved:true },
    { id:7, name:'重庆山地改善住区', type:'residential', typeLabel:'改善住宅', location:'重庆', designer:'内部研究', tags:['山地住区','景观视线','高差'], source:'内部案例', saved:true },
    { id:8, name:'广州永庆坊', type:'commercial', typeLabel:'历史街区商业', location:'广州', designer:'规划设计团队', tags:['微更新','在地文化','街巷活力'], source:'公开案例', saved:true },
    { id:9, name:'北京城市副中心图书馆', type:'culture', typeLabel:'文化建筑', location:'北京', designer:'Snøhetta', tags:['公共文化','结构表达','共享大厅'], source:'公开案例', saved:true },
  ];

  const tools = [
    { id:'rhino', name:'Rhino', monogram:'R', color:'#4f73c8', role:'体量、曲面与参数化模型', caps:['读取模型版本','发送建模任务','回收面积与几何数据'], level:'计划：插件桥接' },
    { id:'archicad', name:'Archicad', monogram:'AC', color:'#3486cf', role:'BIM、图模一体与技术图纸', caps:['项目与视图识别','指标校核','图纸成果回收'], level:'计划：Add-On/API' },
    { id:'indesign', name:'Adobe InDesign', monogram:'Id', color:'#b51f57', role:'正式文本与报规文本排版', caps:['章节结构','图片与图纸置入','版式批量更新'], level:'计划：UXP/脚本' },
    { id:'illustrator', name:'Adobe Illustrator', monogram:'Ai', color:'#c86c13', role:'分析图、矢量表达与后期整理', caps:['图层命名','图形替换','风格与色板同步'], level:'计划：UXP/脚本' },
    { id:'powerpoint', name:'Microsoft PowerPoint', monogram:'P', color:'#c55a2d', role:'会议汇报与快速阶段汇报', caps:['自动生成页面','素材替换','讲述逻辑与备注'], level:'计划：Office Add-in' },
    { id:'obsidian', name:'Obsidian / 网页汇报', monogram:'O', color:'#7257c9', role:'研究记录、项目记忆与轻量汇报', caps:['双向链接','项目纪要','网页成果发布'], level:'原型可用' },
  ];

  const team = [
    { name:'陈设计', role:'项目设计师', skill:'总图、概念、Rhino', load:'82%', avatar:'陈' },
    { name:'林澜', role:'项目经理', skill:'计划、沟通、交付', load:'76%', avatar:'林' },
    { name:'周远', role:'设计总监', skill:'方向、产品、品质', load:'61%', avatar:'周' },
    { name:'赵工', role:'校审负责人', skill:'规范、指标、图模校审', load:'68%', avatar:'赵' },
  ];

  const roleResponses = [
    ['设计师','更新模型、总图、平立剖和指标表。'],['项目经理','记录业主确认，重排任务、依赖和工期。'],['设计总监','判断城市界面、概念方向和产品定位影响。'],['校审','复核限高、消防、日照、层数与面积。'],['经营财务','判断范围变更，保存证据并评估追加费用。'],
  ];

  const state = {
    role: localStorage.getItem('bycj-workbench-role') || 'designer',
    currentView: 'dashboard',
    currentPhase: 'concept',
    caseFilter: 'all',
    caseQuery: '',
    cases: (() => { try { return [...baseCases, ...JSON.parse(localStorage.getItem('bycj-workbench-cases') || '[]')]; } catch { return [...baseCases]; } })(),
    detectedApps: [],
    folder: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }

  function toast(message) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    $('#toastRegion').append(node);
    window.setTimeout(() => node.remove(), 2800);
  }

  function setView(view) {
    state.currentView = view;
    $$('.page-view').forEach((node) => node.classList.toggle('is-active', node.id === `view-${view}`));
    $$('.nav-item[data-view]').forEach((node) => node.classList.toggle('is-active', node.dataset.view === view));
    const main = $('.main-area');
    if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderBrief() {
    const role = roles[state.role] || roles.designer;
    $('#sidebarRole').textContent = role.label;
    $('#headerRole').textContent = role.label;
    $('#teamCurrentRole').textContent = role.label;
    $('#drawerRole').textContent = role.drawer;
    $('#dashboardGreeting').textContent = `早上好，陈设计`;
    $('#dashboardSubline').textContent = `你正在以${role.label}身份工作。${role.subline}`;
    $('#briefTitle').textContent = `给${role.label}的今日简报`;
    $('#briefList').innerHTML = role.briefs.map((item) => `
      <div class="brief-item">
        <span class="brief-priority ${item.level}">${escapeHtml(item.icon)}</span>
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></div>
        <button data-brief-action>${escapeHtml(item.action)}</button>
      </div>`).join('');
    $$('.role-option').forEach((node) => node.classList.toggle('is-selected', node.dataset.role === state.role));
    $$('[data-brief-action]').forEach((button) => button.addEventListener('click', () => toast(`已打开：${button.textContent}`)));
  }

  function renderRoleOptions() {
    $('#roleOptions').innerHTML = Object.entries(roles).map(([id, role]) => `<button class="role-option ${state.role === id ? 'is-selected' : ''}" data-role="${id}"><strong>${escapeHtml(role.label)}</strong><p>${escapeHtml(role.description)}</p></button>`).join('');
    $$('.role-option').forEach((button) => button.addEventListener('click', () => {
      state.role = button.dataset.role;
      localStorage.setItem('bycj-workbench-role', state.role);
      renderBrief();
      closeModal($('#roleModal'));
      toast(`已切换为${roles[state.role].label}视角`);
    }));
  }

  function openModal(modal) { modal.classList.add('is-open'); modal.setAttribute('aria-hidden', 'false'); }
  function closeModal(modal) { modal.classList.remove('is-open'); modal.setAttribute('aria-hidden', 'true'); }

  function renderPhases() {
    $('#phaseRail').innerHTML = phases.map((phase) => `<button class="phase-button ${phase.status === 'done' ? 'is-done' : ''} ${state.currentPhase === phase.id ? 'is-active' : ''}" data-phase="${phase.id}"><span class="phase-number">${phase.status === 'done' ? '✓' : phase.no}</span><span><strong>${escapeHtml(phase.name)}</strong><small>${phase.status === 'done' ? '阶段门已通过' : phase.status === 'current' ? '当前阶段' : '尚未开始'}</small></span><em class="phase-status">${phase.progress}%</em></button>`).join('');
    $$('.phase-button').forEach((button) => button.addEventListener('click', () => { state.currentPhase = button.dataset.phase; renderPhases(); }));
    const phase = phases.find((item) => item.id === state.currentPhase) || phases[3];
    $('#phaseWorkspace').innerHTML = `
      <div class="phase-title"><div><span class="section-kicker">PHASE ${phase.no}</span><h2>${escapeHtml(phase.name)}</h2><p>${escapeHtml(phase.desc)}</p></div><div class="phase-progress" style="background:conic-gradient(var(--violet) ${phase.progress}%,#eceff5 0)"><span>${phase.progress}%</span></div></div>
      <div class="workspace-grid">
        <div class="workspace-block"><h3>阶段任务与成果</h3><div class="task-list">${phase.tasks.map((task, index) => `<div class="task-row"><span class="task-state ${phase.progress === 100 || index < Math.ceil(phase.tasks.length * phase.progress / 100) ? 'done' : ''}">${phase.progress === 100 || index < Math.ceil(phase.tasks.length * phase.progress / 100) ? '✓' : '○'}</span><div><strong>${escapeHtml(task)}</strong><small>${phase.progress === 100 ? '已确认' : index < Math.ceil(phase.tasks.length * phase.progress / 100) ? '已形成成果' : '待完成'}</small></div><em>${index % 2 ? '林澜' : '陈设计'}</em></div>`).join('')}</div></div>
        <div class="workspace-block gate-panel"><h3>阶段门检查</h3><div class="gate-checks">${phase.gate.map((item, index) => `<div class="gate-check"><span class="task-state ${phase.progress === 100 || index === 0 && phase.progress > 50 ? 'done' : ''}">${phase.progress === 100 || index === 0 && phase.progress > 50 ? '✓' : '○'}</span><p><strong>${escapeHtml(item)}</strong><small>${phase.progress === 100 ? '已有确认记录' : '需要负责人确认'}</small></p></div>`).join('')}</div></div>
        <div class="workspace-block"><h3>本阶段AI工作入口</h3><div class="tool-actions">${phase.tools.map((tool) => `<button class="secondary-button" data-stage-tool>${escapeHtml(tool)}</button>`).join('')}</div></div>
        <div class="workspace-block"><h3>阶段管理提醒</h3><p class="subline">AI将结合文件变化、会议决策、成果清单和质量检查给出候选进度，最终由项目负责人确认。</p><button class="primary-button" data-stage-review>${phase.status === 'current' ? '准备阶段门评审' : '查看阶段档案'}</button></div>
      </div>`;
    $$('[data-stage-tool]').forEach((button) => button.addEventListener('click', () => toast(`已打开${button.textContent}工作入口`)));
    $('[data-stage-review]').addEventListener('click', () => toast('阶段门检查清单已准备'));
  }

  function renderCases() {
    const query = state.caseQuery.toLowerCase().trim();
    const filtered = state.cases.filter((item) => (state.caseFilter === 'all' || item.type === state.caseFilter) && (!query || `${item.name} ${item.location} ${item.designer} ${item.tags.join(' ')}`.toLowerCase().includes(query)));
    $('#caseGrid').innerHTML = filtered.length ? filtered.map((item, index) => `<article class="case-card"><div class="case-cover"><span>${escapeHtml(item.typeLabel)}</span><span class="case-source">${escapeHtml(item.source)}</span></div><div class="case-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.location)} · ${escapeHtml(item.designer)}</p><div class="case-tags">${item.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div><div class="case-meta"><span>AI相关度 ${92 - index * 3}%</span><button class="text-button" data-case-open>加入项目案例板 →</button></div></div></article>`).join('') : '<article class="card"><h2>没有找到匹配案例</h2><p>可以调整筛选条件，或者收集一个新案例。</p></article>';
    $$('[data-case-open]').forEach((button) => button.addEventListener('click', () => toast('已加入当前项目案例板')));
  }

  function saveNewCase() {
    const item = {
      id: Date.now(), name: $('#caseNameInput').value.trim() || '未命名案例', type: $('#caseTypeInput').value,
      typeLabel: $('#caseTypeInput').selectedOptions[0].textContent, location: $('#caseLocationInput').value.trim() || '待补充',
      designer: 'AI等待补充设计单位', tags:['待AI分析','来源已记录'], source: $('#caseUrlInput').value.trim() ? '用户收集' : '本地资料', saved:true,
    };
    const userCases = (() => { try { return JSON.parse(localStorage.getItem('bycj-workbench-cases') || '[]'); } catch { return []; } })();
    userCases.unshift(item);
    localStorage.setItem('bycj-workbench-cases', JSON.stringify(userCases));
    state.cases.unshift(item);
    renderCases(); closeModal($('#caseModal')); toast('案例已加入本地案例库原型');
  }

  function renderTools() {
    const detectedMap = new Map(state.detectedApps.map((item) => [item.id, item]));
    $('#toolGrid').innerHTML = tools.map((tool) => {
      const found = detectedMap.get(tool.id);
      const status = found ? (found.installed ? '本机已检测' : '未检测到') : '等待检测';
      return `<article class="tool-card"><div class="tool-head"><span class="tool-logo" style="background:${tool.color}">${escapeHtml(tool.monogram)}</span><div><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.role)}</small></div><span class="tool-status ${found?.installed ? 'installed' : ''}">${status}</span></div><p>${escapeHtml(tool.role)}。Agent在得到授权后传递任务与上下文，成果仍由专业软件生成。</p><div class="capability-list">${tool.caps.map((cap) => `<span>${escapeHtml(cap)}</span>`).join('')}</div><div class="tool-footer"><small>${escapeHtml(tool.level)}</small><button data-tool-detail="${tool.id}">${found?.installed ? '配置连接' : '查看方案'}</button></div></article>`;
    }).join('');
    $$('[data-tool-detail]').forEach((button) => button.addEventListener('click', () => toast('已打开连接方案说明；原型不会直接操作本机软件')));
  }

  async function detectApps() {
    const button = $('#detectAppsButton');
    button.disabled = true; button.textContent = '正在检测…';
    try {
      state.detectedApps = window.bycjWorkbench ? await window.bycjWorkbench.detectInstalledApps() : [];
      renderTools();
      const installed = state.detectedApps.filter((item) => item.installed).length;
      toast(`检测完成：发现 ${installed} 个支持的软件`);
    } catch (error) { toast(`软件检测失败：${error.message}`); }
    finally { button.disabled = false; button.textContent = '重新检测本机软件'; }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B','KB','MB','GB','TB']; let value = bytes; let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function renderFolder(folder) {
    state.folder = folder;
    $('#folderEmpty').classList.add('is-hidden'); $('#folderDashboard').classList.remove('is-hidden');
    $('#folderProjectName').textContent = folder.projectName; $('#folderPath').textContent = folder.rootPath;
    $('#topProjectName').textContent = folder.projectName; $('#fileNavCount').textContent = folder.fileCount;
    $('#scanTimestamp').textContent = `扫描于 ${new Date(folder.scannedAt).toLocaleString('zh-CN')}`;
    const stats = [ ['模型',folder.summary.model],['图纸/排版',folder.summary.drawing],['图片',folder.summary.image],['文本/表格',folder.summary.document],['目录总量',folder.fileCount] ];
    $('#fileStats').innerHTML = stats.map(([label,value]) => `<div class="file-stat"><small>${label}</small><strong>${value}</strong></div>`).join('');
    const iconMap = { model:'3D',drawing:'图',image:'IMG',document:'文',other:'FILE' };
    $('#recentFiles').innerHTML = folder.recent.length ? folder.recent.map((file) => `<div class="file-row"><span class="file-type">${iconMap[file.category] || 'FILE'}</span><div><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.category)}</small></div><small class="file-path">${escapeHtml(file.relativePath)}</small><small>${formatBytes(file.size)}</small><time>${new Date(file.modifiedAt).toLocaleString('zh-CN')}</time></div>`).join('') : '<p>这个文件夹中暂未识别到文件。</p>';
    $('#syncText').textContent = `${folder.projectName} 已连接`;
  }

  async function bindFolder() {
    if (!window.bycjWorkbench) { toast('请通过桌面原型启动器运行，才能选择本地文件夹'); return; }
    try {
      const result = await window.bycjWorkbench.selectProjectFolder();
      if (!result) return;
      renderFolder(result); toast(`已只读扫描 ${result.fileCount} 个文件`);
    } catch (error) { toast(`文件夹读取失败：${error.message}`); }
  }

  function renderSchedule() {
    const ganttRows = [
      ['前期研究','0%','16%','16%','已确认',false],['强排测算','13%','18%','18%','已确认',false],['概念设计','28%','30%','23%','滞后 2 天',true],['方案深化','54%','20%','0%','未开始',false],['概念100','72%','15%','0%','未开始',false],['正式报规','87%','13%','0%','未开始',false],
    ];
    $('#gantt').innerHTML = ganttRows.map(([name,start,width,actual,label,risk]) => `<div class="gantt-row ${risk ? 'is-risk' : ''}"><strong>${name}</strong><div class="gantt-track"><span class="gantt-plan" style="--start:${start};--width:${width}"></span><span class="gantt-actual" style="--start:${start};--width:${actual}"></span></div><span>${label}</span></div>`).join('');
    const risks = [
      ['high','高度调整尚无书面确认','设计团队已开始返工；可能同时影响工期和合同范围。','项目经理 · 今日'],
      ['high','模型与指标表差 2 个版本','继续出图将造成面积与技术图纸失配。','校审 · 今日'],
      ['','效果图关键资源冲突','表现团队与另一项目在同一周达到峰值。','设计总监 · 周三'],
    ];
    $('#riskList').innerHTML = risks.map(([level,title,body,footer]) => `<div class="risk-item ${level}"><strong>${title}</strong><p>${body}</p><footer><span>${footer}</span><button class="text-button" data-risk-open>处理 →</button></footer></div>`).join('');
    $$('[data-risk-open]').forEach((button) => button.addEventListener('click', () => toast('风险处理卡已打开')));
  }

  function renderContracts() {
    const rows = [
      ['done','启动款 30%','合同签订后 7 日内','¥720,000','已到账'],['current','概念确认款 20%','概念成果书面确认后 7 日内','¥480,000','待触发'],['','方案深化款 25%','概念100成果确认','¥600,000','未到期'],['','报规款 20%','正式报规提交','¥480,000','未到期'],['','尾款 5%','约定服务完成','¥120,000','未到期'],
    ];
    $('#paymentTimeline').innerHTML = rows.map(([stateClass,title,condition,amount,status],index) => `<div class="payment-row ${stateClass}"><span class="payment-dot">${stateClass === 'done' ? '✓' : index + 1}</span><p><strong>${title}</strong><small>${condition}</small></p><div class="payment-amount"><strong>${amount}</strong><span>${status}</span></div></div>`).join('');
  }

  function renderTeam() {
    $('#teamGrid').innerHTML = team.map((member) => `<article class="team-card"><header><span class="avatar">${member.avatar}</span><div><strong>${member.name}</strong><small>${member.role}</small></div></header><p>${member.skill}</p><footer><span>当前负荷 ${member.load}</span><button>查看身份卡</button></footer></article>`).join('');
    $('#roleMatrix').innerHTML = roleResponses.map(([role,response]) => `<div class="role-response"><strong>${role}</strong><p>${response}</p></div>`).join('');
  }

  function openAiDrawer() { $('#aiDrawer').classList.add('is-open'); $('#aiDrawer').setAttribute('aria-hidden','false'); }
  function closeAiDrawer() { $('#aiDrawer').classList.remove('is-open'); $('#aiDrawer').setAttribute('aria-hidden','true'); }

  function bindEvents() {
    $$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    $$('[data-view-target]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewTarget)));
    $$('[data-open-role-menu]').forEach((button) => button.addEventListener('click', () => openModal($('#roleModal'))));
    $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
    $$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop); }));
    $('#askAiButton').addEventListener('click', openAiDrawer); $('#closeAiDrawer').addEventListener('click', closeAiDrawer);
    $('#globalSearchButton').addEventListener('click', () => { openAiDrawer(); $('#aiInput').focus(); });
    $('#notificationButton').addEventListener('click', () => toast('3 项高优先级提醒，已按当前角色筛选'));
    $('#projectSwitcher').addEventListener('click', () => toast('原型当前展示一个项目；正式版支持公司项目列表'));
    $('#explainBrief').addEventListener('click', () => { openAiDrawer(); $('#aiInput').value = '解释今日简报每一项的判断依据'; });
    $('#bindFolderButton').addEventListener('click', bindFolder); $('#bindFolderButtonSecondary').addEventListener('click', bindFolder); $('#rescanFolderButton').addEventListener('click', bindFolder);
    $('#knowledgeAsk').addEventListener('click', () => { const button=$('#knowledgeAsk'); button.disabled=true; button.textContent='正在检索本地依据…'; window.setTimeout(() => { button.disabled=false; button.textContent='检索项目知识'; $('#knowledgeAnswer').animate([{opacity:.5,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:220}); toast('已找到 3 条可追溯依据'); },650); });
    $('#caseSearch').addEventListener('input', (event) => { state.caseQuery=event.target.value; renderCases(); });
    $$('[data-case-filter]').forEach((button) => button.addEventListener('click', () => { state.caseFilter=button.dataset.caseFilter; $$('[data-case-filter]').forEach((node)=>node.classList.toggle('is-active',node===button)); renderCases(); }));
    $('#openCaseCollector').addEventListener('click', () => openModal($('#caseModal'))); $('#saveCaseButton').addEventListener('click', saveNewCase);
    $('#detectAppsButton').addEventListener('click', detectApps);
    $('#aiComposer').addEventListener('submit', (event) => { event.preventDefault(); const input=$('#aiInput'); const value=input.value.trim(); if(!value)return; $('#drawerMessages').insertAdjacentHTML('beforeend',`<div class="user-message">${escapeHtml(value)}</div><div class="ai-message"><span class="ai-orb small">✦</span><div><p>原型已经收到这项工作。正式版本会先确认项目、角色、阶段和可用工具，再生成带依据的行动或调用受控软件连接器。</p></div></div>`); input.value=''; $('#drawerMessages').scrollTop=$('#drawerMessages').scrollHeight; });
    $$('.suggestion-list button').forEach((button) => button.addEventListener('click', () => { $('#aiInput').value=button.textContent; $('#aiInput').focus(); }));
    document.addEventListener('keydown', (event) => { if(event.key==='Escape'){ closeAiDrawer(); $$('.modal-backdrop.is-open').forEach(closeModal); } });
  }

  async function init() {
    renderRoleOptions(); renderBrief(); renderPhases(); renderCases(); renderTools(); renderSchedule(); renderContracts(); renderTeam(); bindEvents();
    if (window.bycjWorkbench) {
      try {
        const info = await window.bycjWorkbench.runtimeInfo();
        document.documentElement.dataset.runtime = `electron-${info.electronVersion}`;
        state.detectedApps = await window.bycjWorkbench.detectInstalledApps();
        renderTools();
      } catch { /* Prototype remains usable without runtime metadata. */ }
    }
  }

  init();
})();
