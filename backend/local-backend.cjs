const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { KnowledgeService } = require('./knowledge.cjs');

const SCHEMA_VERSION = 2;

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nowMinus(minutes) { return Date.now() - minutes * 60_000; }

function seedStore() {
  const projectId = 'project_jiangwan';
  return {
    schemaVersion:SCHEMA_VERSION,
    settings:{ currentProjectId:projectId, currentMemberId:'member_designer', currentRole:'designer', createdAt:Date.now() },
    projects:[{ id:projectId, name:'江湾文化商业中心', code:'JW-CULTURE-001', city:'上海', type:'商业综合体', stage:'concept', stageRound:2, progress:69, folderPath:null, createdAt:nowMinus(60*24*42), updatedAt:Date.now() }],
    members:[
      { id:'member_designer', projectId, name:'陈设计', title:'建筑设计师', role:'designer', skills:['总图','概念设计','Rhino','Archicad'], load:82, avatar:'陈', active:true },
      { id:'member_pm', projectId, name:'林澜', title:'项目经理', role:'pm', skills:['计划','沟通','交付'], load:76, avatar:'林', active:true },
      { id:'member_director', projectId, name:'周远', title:'设计总监', role:'director', skills:['产品定位','设计方向','品质'], load:61, avatar:'周', active:true },
      { id:'member_reviewer', projectId, name:'赵工', title:'校审负责人', role:'reviewer', skills:['规范','指标','图模校审'], load:68, avatar:'赵', active:true },
      { id:'member_finance', projectId, name:'方敏', title:'经营负责人', role:'finance', skills:['合同','变更','回款'], load:44, avatar:'方', active:true },
    ],
    channels:[
      { id:'channel_general', projectId, name:'项目群聊', description:'项目组日常沟通与跨专业协调', type:'project', createdAt:nowMinus(60*24*30) },
      { id:'channel_design', projectId, name:'设计决策', description:'需要留档和确认的设计方向', type:'decision', createdAt:nowMinus(60*24*30) },
      { id:'channel_owner', projectId, name:'业主沟通', description:'业主意见、确认与范围变化', type:'external', createdAt:nowMinus(60*24*30) },
      { id:'channel_model', projectId, name:'模型与图纸', description:'模型版本、指标和出图协调', type:'technical', createdAt:nowMinus(60*24*30) },
    ],
    messages:[
      { id:'msg_1', projectId, channelId:'channel_general', senderId:'member_pm', body:'大家早上好，今天先锁定总图 V23，再安排效果图视点。所有新的业主意见请放到“业主沟通”频道，不要只在微信里口头转述。', type:'text', attachments:[], createdAt:nowMinus(190), editedAt:null },
      { id:'msg_2', projectId, channelId:'channel_general', senderId:'member_designer', body:'收到。总图 V23 已上传，中央广场和沿江界面已按上轮意见调整。面积指标表还需要等模型复核。', type:'text', attachments:[], createdAt:nowMinus(172), editedAt:null },
      { id:'msg_3', projectId, channelId:'channel_design', senderId:'member_director', body:'本轮概念方向保持“江湾客厅”的整体叙事。主入口不再增加独立大门构筑物，重点用雨棚、铺地和两侧商业界面形成到达感。', type:'text', attachments:[], createdAt:nowMinus(145), editedAt:null },
      { id:'msg_4', projectId, channelId:'channel_owner', senderId:'member_pm', body:'业主提出塔楼高度和产品组合需要重新比较。目前只有会议口头意见，正式调整前需要业主书面确认。', type:'text', attachments:[], createdAt:nowMinus(118), editedAt:null },
      { id:'msg_5', projectId, channelId:'channel_model', senderId:'member_reviewer', body:'我检查到指标表仍对应 V21。请先不要继续出正式分析图，V23 的计容面积、连廊和屋顶机房口径需要一起复核。', type:'text', attachments:[], createdAt:nowMinus(92), editedAt:null },
      { id:'msg_6', projectId, channelId:'channel_general', senderId:'member_finance', body:'提醒：概念成果书面确认后会触发 48 万元请款。业主新增高度调整如果继续深化，需要保留返工和范围变化证据。', type:'text', attachments:[], createdAt:nowMinus(58), editedAt:null },
    ],
    decisions:[
      { id:'decision_1', projectId, channelId:'channel_design', title:'主入口采用空间界面而非独立大门', summary:'保持“江湾客厅”叙事，通过雨棚、铺地和两侧商业界面形成到达感，不增加独立大门构筑物。', status:'confirmed', ownerId:'member_director', sourceMessageIds:['msg_3'], createdAt:nowMinus(140), confirmedAt:nowMinus(136), dueAt:null },
      { id:'decision_2', projectId, channelId:'channel_owner', title:'塔楼高度调整等待书面确认', summary:'在收到业主正式书面确认前，只做影响分析，不进入正式模型和成果修改。', status:'proposed', ownerId:'member_pm', sourceMessageIds:['msg_4'], createdAt:nowMinus(110), confirmedAt:null, dueAt:Date.now()+24*60*60*1000 },
    ],
    tasks:[
      { id:'task_1', projectId, phase:'concept', title:'复核总图 V23 面积指标', ownerId:'member_reviewer', status:'todo', priority:'high', dueAt:Date.now()+6*60*60*1000, source:'model' },
      { id:'task_2', projectId, phase:'concept', title:'完成主入口效果图', ownerId:'member_designer', status:'doing', priority:'high', dueAt:Date.now()+28*60*60*1000, source:'deliverable' },
      { id:'task_3', projectId, phase:'concept', title:'补充消防车转弯包络检查', ownerId:'member_designer', status:'todo', priority:'medium', dueAt:Date.now()+30*60*60*1000, source:'review' },
      { id:'task_4', projectId, phase:'concept', title:'取得高度调整书面确认', ownerId:'member_pm', status:'doing', priority:'high', dueAt:Date.now()+8*60*60*1000, source:'decision' },
      { id:'task_5', projectId, phase:'concept', title:'整理概念阶段请款资料', ownerId:'member_finance', status:'todo', priority:'medium', dueAt:Date.now()+4*24*60*60*1000, source:'contract' },
    ],
    risks:[
      { id:'risk_1', projectId, title:'高度调整尚无书面确认', description:'设计团队已开始影响分析；若直接返工可能同时影响工期和合同范围。', severity:'high', status:'open', ownerId:'member_pm', sourceMessageIds:['msg_4'], createdAt:nowMinus(110) },
      { id:'risk_2', projectId, title:'模型与指标表差 2 个版本', description:'继续出图会造成面积与技术图纸失配。', severity:'high', status:'open', ownerId:'member_reviewer', sourceMessageIds:['msg_5'], createdAt:nowMinus(90) },
      { id:'risk_3', projectId, title:'效果图资源与另一重点项目冲突', description:'表现团队在同一周达到资源峰值。', severity:'medium', status:'open', ownerId:'member_director', sourceMessageIds:[], createdAt:nowMinus(70) },
    ],
    cases:[
      { id:'case_1', projectId, name:'成都麓湖天府美食岛', type:'commercial', typeLabel:'开放式商业', location:'成都', designer:'万华 / 设计团队', tags:['滨水商业','街区尺度','夜间场景'], source:'公开案例', sourceUrl:'', notes:'', createdAt:nowMinus(60*24*20) },
      { id:'case_2', projectId, name:'上海蟠龙天地', type:'commercial', typeLabel:'商业街区', location:'上海', designer:'瑞安 / Benoy', tags:['江南文脉','小尺度街巷','更新'], source:'公开案例', sourceUrl:'', notes:'', createdAt:nowMinus(60*24*19) },
      { id:'case_3', projectId, name:'杭州天目里', type:'commercial', typeLabel:'混合社区', location:'杭州', designer:'Renzo Piano', tags:['低密园区','文化商业','灰空间'], source:'公开案例', sourceUrl:'', notes:'', createdAt:nowMinus(60*24*18) },
      { id:'case_4', projectId, name:'深圳万象前海', type:'commercial', typeLabel:'商业综合体', location:'深圳', designer:'Lead8 / 华润置地', tags:['多首层','立体动线','城市界面'], source:'公开案例', sourceUrl:'', notes:'', createdAt:nowMinus(60*24*17) },
    ],
    contractMilestones:[
      { id:'milestone_1', projectId, title:'启动款 30%', condition:'合同签订后 7 日内', amount:720000, status:'paid', dueAt:nowMinus(60*24*35), paidAt:nowMinus(60*24*34) },
      { id:'milestone_2', projectId, title:'概念确认款 20%', condition:'概念成果书面确认后 7 日内', amount:480000, status:'pending-trigger', dueAt:null, paidAt:null },
      { id:'milestone_3', projectId, title:'方案深化款 25%', condition:'概念100成果确认', amount:600000, status:'future', dueAt:null, paidAt:null },
      { id:'milestone_4', projectId, title:'报规款 20%', condition:'正式报规提交', amount:480000, status:'future', dueAt:null, paidAt:null },
      { id:'milestone_5', projectId, title:'尾款 5%', condition:'约定服务完成', amount:120000, status:'future', dueAt:null, paidAt:null },
    ],
    scopeChanges:[
      { id:'scope_1', projectId, title:'塔楼高度与产品组合调整', status:'potential', estimatedDays:8, sourceMessageIds:['msg_4'], createdAt:nowMinus(110) },
      { id:'scope_2', projectId, title:'新增屋顶花园专项效果表达', status:'potential', estimatedDays:3.5, sourceMessageIds:[], createdAt:nowMinus(80) },
    ],
    knowledgeDocs:[],
    events:[
      { id:'event_1', projectId, type:'model', title:'总图模型 V23 已更新', detail:'Rhino · 总图组', createdAt:nowMinus(80) },
      { id:'event_2', projectId, type:'meeting', title:'第 2 轮业主沟通纪要已归档', detail:'提取 6 项行动，2 项待确认', createdAt:nowMinus(65) },
      { id:'event_3', projectId, type:'risk', title:'模型与指标表版本不一致', detail:'指标表比模型早 2 个版本', createdAt:nowMinus(50) },
    ],
    connectorSettings:[],
  };
}

class LocalBackend {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'store.json');
    this.attachmentsDir = path.join(dataDir, 'chat-attachments');
    fs.mkdirSync(dataDir, { recursive:true });
    fs.mkdirSync(this.attachmentsDir, { recursive:true });
    this.store = this.load();
    this.knowledge = new KnowledgeService({ dataDir, idFactory:id });
  }

  load() {
    if (!fs.existsSync(this.dbPath)) {
      const seeded = seedStore();
      for (const item of seeded.cases) item.scope = 'local';
      this.persist(seeded);
      return seeded;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      const seeded = seedStore();
      for (const key of Object.keys(seeded)) if (parsed[key] === undefined) parsed[key] = seeded[key];
      // Cases and knowledge docs are two-tier (personal vs team-shared). Records
      // written before the split default to personal so they never leak to team sync.
      for (const key of ['cases', 'knowledgeDocs']) for (const item of parsed[key] || []) if (item && item.scope !== 'team') item.scope = 'local';
      parsed.schemaVersion = SCHEMA_VERSION;
      this.persist(parsed);
      return parsed;
    } catch (error) {
      const backup = `${this.dbPath}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.dbPath, backup);
      const seeded = seedStore();
      this.persist(seeded);
      return seeded;
    }
  }

  persist(next = this.store) {
    const temp = `${this.dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temp, this.dbPath);
  }

  mutate(callback) {
    const previous = clone(this.store);
    try {
      const result = callback(this.store);
      this.persist();
      return clone(result);
    } catch (error) {
      this.store = previous;
      throw error;
    }
  }

  projectId(input) { return input || this.store.settings.currentProjectId; }

  bootstrap(projectId) {
    const pid = this.projectId(projectId);
    const project = this.store.projects.find((item) => item.id === pid);
    if (!project) throw new Error('Project not found.');
    const filter = (items) => items.filter((item) => item.projectId === pid);
    return clone({
      project, settings:this.store.settings, demoCompany:this.store.demoCompany?.initialized===true?this.store.demoCompany:null, members:filter(this.store.members), channels:filter(this.store.channels),
      messages:filter(this.store.messages).sort((a,b) => a.createdAt-b.createdAt), decisions:filter(this.store.decisions),
      tasks:filter(this.store.tasks), risks:filter(this.store.risks), cases:filter(this.store.cases),
      contractMilestones:filter(this.store.contractMilestones), scopeChanges:filter(this.store.scopeChanges),
      knowledgeDocs:filter(this.store.knowledgeDocs).map(({ chunks, ...document }) => document),
      events:filter(this.store.events).sort((a,b) => b.createdAt-a.createdAt).slice(0,100), connectorSettings:this.store.connectorSettings,
      dataDir:this.dataDir,
    });
  }

  setRole(role) { return this.mutate((store) => { store.settings.currentRole = role; return store.settings; }); }

  setCurrentMember(memberId) {
    return this.mutate((store) => {
      const member = store.members.find((item) => item.id === memberId && item.projectId === store.settings.currentProjectId && item.active !== false);
      if (!member) throw new Error('Project member not found.');
      store.settings.currentMemberId = member.id;
      store.settings.currentRole = member.role || store.settings.currentRole;
      return store.settings;
    });
  }

  setTeamSyncConfig(config) { return this.mutate((store)=>{store.settings.teamSync={...(store.settings.teamSync||{}),...config,updatedAt:Date.now()};return store.settings.teamSync;}); }

  mergeRemoteSnapshot(snapshot) {
    return this.mutate((store)=>{
      const pid=snapshot?.project?.id;
      if(typeof pid!=='string'||!pid)throw new Error('Remote snapshot requires a project.');
      // cases and knowledgeDocs are two-tier; they merge by team scope below, not
      // by whole-table replacement, so personal records on this machine survive.
      const collections=['members','channels','messages','decisions','tasks','risks','contractMilestones','scopeChanges','events'];
      for(const key of collections){if(Array.isArray(snapshot[key])) {
        if(snapshot[key].some(item=>!item||item.projectId!==pid))throw new Error('Remote snapshot contains a foreign project record.');
        const other=store[key].filter(item=>item.projectId!==pid);
        if(snapshot[key].some(item=>other.some(existing=>existing.id===item.id)))throw new Error('Remote record identity collides with another project.');
        const managed=key==='tasks'?store.tasks.filter(item=>item.projectId===pid&&item.agentJobId):[];
        store[key]=[...other,...snapshot[key].filter(item=>!managed.some(task=>task.id===item.id)).map((item)=>({...item}))];
        if(key==='tasks')store.tasks.push(...managed);
      }}
      this.mergeTeamScoped(snapshot,store,pid);
      if(snapshot.project){const index=store.projects.findIndex((item)=>item.id===snapshot.project.id);if(index>=0)store.projects[index]={...store.projects[index],...snapshot.project};else store.projects.push(snapshot.project);}
      if(snapshot.resourceLibrary?.team){
        if(!store.resourceLibrary)store.resourceLibrary={local:{skills:[],mcpServers:[],instructions:[],rtk:null},team:{skills:[],mcpServers:[],instructions:[]},sync:{lastSyncAt:null,lastSyncError:null,pendingPush:[],pendingPull:[]}};
        const remoteTeam=snapshot.resourceLibrary.team;
        if(Array.isArray(remoteTeam.skills))store.resourceLibrary.team.skills=remoteTeam.skills.map(item=>({...item}));
        if(Array.isArray(remoteTeam.mcpServers))store.resourceLibrary.team.mcpServers=remoteTeam.mcpServers.map(item=>({...item}));
        if(Array.isArray(remoteTeam.instructions))store.resourceLibrary.team.instructions=remoteTeam.instructions.map(item=>({...item}));
        store.resourceLibrary.sync.lastSyncAt=Date.now();
      }
      return this.bootstrap(snapshot.project?.id);
    });
  }

  updateTask(taskId, patch) {
    return this.mutate((store) => {
      const task = store.tasks.find((item) => item.id === taskId); if (!task) throw new Error('Task not found.');
      if (task.agentJobId && Object.hasOwn(patch,'status')) throw new Error('Agent 任务须在 Agent 协作页面提交成果并审核，不能直接切换完成状态。');
      const allowed = ['title','phase','ownerId','status','priority','dueAt'];
      if(Object.keys(patch).some(key=>!allowed.includes(key)))throw new Error('Task field is not editable.');
      Object.assign(task, { ...patch, updatedAt:Date.now() });
      store.events.unshift({ id:id('event'), projectId:task.projectId, type:'task', title:`任务更新：${task.title}`, detail:`状态：${task.status}`, createdAt:Date.now() });
      return task;
    });
  }

  addTask(payload) {
    return this.mutate((store) => {
      const task = { id:id('task'), projectId:this.projectId(payload.projectId), phase:payload.phase || 'concept', title:String(payload.title || '').trim(), ownerId:payload.ownerId || store.settings.currentMemberId, status:'todo', priority:payload.priority || 'medium', dueAt:payload.dueAt || null, source:payload.source || 'manual', createdAt:Date.now() };
      if (!task.title) throw new Error('Task title is required.');
      store.tasks.push(task); return task;
    });
  }

  addCase(payload) {
    return this.mutate((store) => {
      const item = { id:id('case'), projectId:this.projectId(payload.projectId), name:String(payload.name || '').trim(), type:payload.type || 'commercial', typeLabel:payload.typeLabel || '案例', location:payload.location || '待补充', designer:payload.designer || '待补充', tags:Array.isArray(payload.tags) ? payload.tags.slice(0,12) : [], source:payload.source || '用户收集', sourceUrl:payload.sourceUrl || '', notes:payload.notes || '', scope:payload.scope === 'team' ? 'team' : 'local', createdAt:Date.now() };
      if (!item.name) throw new Error('Case name is required.'); store.cases.unshift(item); return item;
    });
  }

  removeCase(caseId) { return this.mutate((store) => { const before=store.cases.length; store.cases=store.cases.filter((item)=>item.id!==caseId); return { removed:before-store.cases.length }; }); }

  addMember(payload) {
    return this.mutate((store) => {
      const member = { id:id('member'), projectId:this.projectId(payload.projectId), name:String(payload.name || '').trim(), title:payload.title || '项目成员', role:payload.role || 'designer', skills:Array.isArray(payload.skills) ? payload.skills : [], load:Number(payload.load)||0, avatar:(String(payload.name || '新').trim()[0] || '新'), active:true, createdAt:Date.now() };
      if (!member.name) throw new Error('Member name is required.'); store.members.push(member); return member;
    });
  }

  addChannel(payload) {
    return this.mutate((store) => {
      const projectId=this.projectId(payload.projectId);
      const name=String(payload.name||'').trim().replace(/^#/,'').slice(0,40);
      if(!name)throw new Error('Channel name is required.');
      if(store.channels.some((item)=>item.projectId===projectId&&item.name===name))throw new Error('A channel with this name already exists.');
      const channel={id:id('channel'),projectId,name,description:String(payload.description||'项目协作频道').trim().slice(0,120),createdAt:Date.now()};
      store.channels.push(channel);return channel;
    });
  }

  sendMessage(payload) {
    return this.mutate((store) => {
      const body = String(payload.body || '').trim();
      if (!body && !(payload.attachments || []).length) throw new Error('Message is empty.');
      const channel = store.channels.find((item) => item.id === payload.channelId); if (!channel) throw new Error('Channel not found.');
      const senderId = payload.senderId || store.settings.currentMemberId;
      if (!store.members.some((item) => item.id === senderId && item.projectId === channel.projectId)) throw new Error('Sender is not a project member.');
      const message = { id:id('msg'), projectId:channel.projectId, channelId:channel.id, senderId, body:body.slice(0,20000), type:payload.type || 'text', attachments:Array.isArray(payload.attachments) ? payload.attachments.slice(0,10) : [], replyTo:payload.replyTo || null, createdAt:Date.now(), editedAt:null };
      store.messages.push(message);
      store.events.unshift({ id:id('event'), projectId:channel.projectId, type:'chat', title:`${channel.name}有新消息`, detail:body.slice(0,100), createdAt:message.createdAt, sourceMessageId:message.id });
      return message;
    });
  }

  searchMessages(projectId, query) {
    const pid=this.projectId(projectId); const keyword=String(query||'').trim().toLowerCase();
    return clone(this.store.messages.filter((item)=>item.projectId===pid && (!keyword || item.body.toLowerCase().includes(keyword))).sort((a,b)=>b.createdAt-a.createdAt).slice(0,200));
  }

  importChatAttachments(filePaths, projectId) {
    const pid=this.projectId(projectId);
    return filePaths.slice(0,10).map((originalPath) => {
      const attachmentId=id('attachment'); const name=path.basename(originalPath); const storedPath=path.join(this.attachmentsDir, `${attachmentId}-${name.replace(/[<>:"/\\|?*]/g,'_')}`);
      fs.copyFileSync(originalPath, storedPath); const stat=fs.statSync(storedPath);
      return { id:attachmentId, projectId:pid, name, originalPath, storedPath, size:stat.size, extension:path.extname(name).slice(1).toLowerCase(), createdAt:Date.now() };
    });
  }

  importChatAttachmentBuffers(files, projectId) {
    const pid=this.projectId(projectId);
    return (files||[]).slice(0,10).map((file) => {
      const attachmentId=id('attachment');
      const name=path.basename(String(file.name||'attachment.bin'));
      const storedPath=path.join(this.attachmentsDir, `${attachmentId}-${name.replace(/[<>:"/\\|?*]/g,'_')}`);
      const buffer=Buffer.from(String(file.contentBase64||''),'base64');
      if(!buffer.length)throw new Error(`Attachment is empty: ${name}`);
      if(buffer.length>25*1024*1024)throw new Error(`Attachment exceeds 25 MB: ${name}`);
      fs.writeFileSync(storedPath,buffer);
      return { id:attachmentId, projectId:pid, name, originalPath:'team-sync', storedPath, size:buffer.length, extension:path.extname(name).slice(1).toLowerCase(), createdAt:Date.now() };
    });
  }

  storeSyncedAttachment(file, projectId) {
    const pid=this.projectId(projectId);
    const attachmentId=String(file.id||id('attachment')).replace(/[^a-zA-Z0-9_-]/g,'_');
    const name=path.basename(String(file.name||'attachment.bin'));
    const storedPath=path.join(this.attachmentsDir, `${attachmentId}-${name.replace(/[<>:"/\\|?*]/g,'_')}`);
    const buffer=Buffer.from(String(file.contentBase64||''),'base64');
    if(!buffer.length)throw new Error(`Attachment is empty: ${name}`);
    if(buffer.length>25*1024*1024)throw new Error(`Attachment exceeds 25 MB: ${name}`);
    fs.writeFileSync(storedPath,buffer);
    return { id:attachmentId, projectId:pid, name, originalPath:'team-sync', storedPath, size:buffer.length, extension:path.extname(name).slice(1).toLowerCase(), createdAt:file.createdAt||Date.now() };
  }

  getChatAttachment(attachmentId) {
    const attachment=this.store.messages.flatMap((message)=>message.attachments||[]).find((file)=>file.id===attachmentId);
    if(!attachment)throw new Error('Attachment not found.');
    const resolved=path.resolve(attachment.storedPath);const root=path.resolve(this.attachmentsDir);
    if(!(resolved===root||resolved.startsWith(`${root}${path.sep}`)))throw new Error('Attachment path is outside managed storage.');
    const buffer=fs.readFileSync(resolved);
    return { id:attachment.id, name:attachment.name, size:buffer.length, createdAt:attachment.createdAt, contentBase64:buffer.toString('base64') };
  }

  createDecision(payload) {
    return this.mutate((store) => {
      const decision={ id:id('decision'), projectId:this.projectId(payload.projectId), channelId:payload.channelId || 'channel_design', title:String(payload.title||'').trim(), summary:String(payload.summary||'').trim(), status:payload.status || 'proposed', ownerId:payload.ownerId || store.settings.currentMemberId, sourceMessageIds:Array.isArray(payload.sourceMessageIds)?payload.sourceMessageIds:[], createdAt:Date.now(), confirmedAt:payload.status==='confirmed'?Date.now():null, dueAt:payload.dueAt||null };
      if(!decision.title || !decision.summary) throw new Error('Decision title and summary are required.');
      store.decisions.unshift(decision);
      store.messages.push({ id:id('msg'), projectId:decision.projectId, channelId:decision.channelId, senderId:decision.ownerId, body:`【项目决策】${decision.title}\n${decision.summary}`, type:'decision', attachments:[], decisionId:decision.id, createdAt:Date.now(), editedAt:null });
      store.events.unshift({ id:id('event'), projectId:decision.projectId, type:'decision', title:`新项目决策：${decision.title}`, detail:decision.summary.slice(0,120), createdAt:Date.now() });
      return decision;
    });
  }

  updateDecision(decisionId, patch) {
    return this.mutate((store) => { const item=store.decisions.find((decision)=>decision.id===decisionId); if(!item)throw new Error('Decision not found.'); Object.assign(item,patch,{ updatedAt:Date.now() }); if(patch.status==='confirmed'&&!item.confirmedAt)item.confirmedAt=Date.now(); return item; });
  }

  updateRisk(riskId, patch) { return this.mutate((store)=>{const item=store.risks.find((risk)=>risk.id===riskId);if(!item)throw new Error('Risk not found.');Object.assign(item,patch,{updatedAt:Date.now()});return item;}); }
  updateMilestone(milestoneId, patch) { return this.mutate((store)=>{const item=store.contractMilestones.find((milestone)=>milestone.id===milestoneId);if(!item)throw new Error('Milestone not found.');Object.assign(item,patch,{updatedAt:Date.now()});return item;}); }

  async importKnowledge(filePaths, projectId, sourceType, scope = 'local') {
    const documents=await this.knowledge.importFiles(filePaths,this.projectId(projectId),sourceType);
    for(const document of documents)document.scope=scope==='team'?'team':'local';
    return this.mutate((store)=>{store.knowledgeDocs.unshift(...documents);for(const document of documents)store.events.unshift({id:id('event'),projectId:document.projectId,type:'knowledge',title:`知识资料已导入：${document.name}`,detail:`${document.chunkCount} 个索引片段`,createdAt:Date.now()});return documents.map(({chunks,...document})=>document);});
  }

  searchKnowledge(projectId, query) { return this.knowledge.search(this.store.knowledgeDocs,this.projectId(projectId),query); }
  removeKnowledge(documentId) { return this.mutate((store)=>{const document=store.knowledgeDocs.find((item)=>item.id===documentId);if(!document)return {removed:0};store.knowledgeDocs=store.knowledgeDocs.filter((item)=>item.id!==documentId);try{fs.unlinkSync(document.storedPath);}catch{}return {removed:1};}); }

  // Team knowledge arrives as metadata plus a separately downloaded file buffer;
  // store the file under knowledge-files so search/reveal work like a local import.
  storeSyncedKnowledgeDocument(document, file) {
    const pid=document.projectId;
    const docId=String(document.id||id('doc')).replace(/[^a-zA-Z0-9_-]/g,'_');
    const name=path.basename(String(document.name||file?.name||'document'));
    const storedPath=path.join(this.knowledge.filesDir,`${docId}-${name.replace(/[<>:"/\\|?*]/g,'_')}`);
    const buffer=Buffer.from(String(file?.contentBase64||''),'base64');
    if(buffer.length)fs.writeFileSync(storedPath,buffer);
    return {...document,id:docId,projectId:pid,name,scope:'team',storedPath,chunks:Array.isArray(document.chunks)?document.chunks:[]};
  }

  // A team client uploads raw file buffers to the host, which parses/indexes them
  // and stores them as team-scope knowledge so every client can pull them back.
  async importTeamKnowledgeFromBuffers(payload) {
    const pid=this.projectId(payload?.projectId);
    const sourceType=payload?.sourceType||'project';
    const files=Array.isArray(payload?.files)?payload.files.slice(0,20):[];
    const tmpDir=path.join(this.dataDir,'tmp-team-knowledge');
    fs.mkdirSync(tmpDir,{recursive:true});
    const paths=[];
    for(const file of files){
      const buffer=Buffer.from(String(file?.contentBase64||''),'base64');
      if(!buffer.length)continue;
      const name=path.basename(String(file?.name||'document'));
      const tmpPath=path.join(tmpDir,`${id('tmp')}-${name.replace(/[<>:"/\\|?*]/g,'_')}`);
      fs.writeFileSync(tmpPath,buffer);paths.push(tmpPath);
    }
    try{ return await this.importKnowledge(paths,pid,sourceType,'team'); }
    finally{ for(const p of paths){try{fs.unlinkSync(p);}catch{}} }
  }

  // Merge team-scoped cases/knowledge from a remote snapshot by id union: team
  // entries are added/updated (and dropped when the remote deleted them), while
  // personal (local-scope) entries on this machine are never touched.
  mergeTeamScoped(snapshot, store, pid) {
    for(const key of ['cases','knowledgeDocs']){
      if(!Array.isArray(snapshot[key]))continue;
      const incoming=snapshot[key].filter((item)=>item&&item.projectId===pid&&item.scope==='team');
      if(incoming.some((item)=>store[key].some((existing)=>existing.projectId!==pid&&existing.id===item.id)))throw new Error('Remote team record identity collides with another project.');
      // Keep every record that is not a team record of this project (other
      // projects' records + this project's personal records), then re-add the
      // remote's authoritative team set for this project.
      const preserved=store[key].filter((item)=>!(item.projectId===pid&&item.scope==='team'));
      store[key]=[...preserved,...incoming.map((item)=>({...item}))];
    }
  }

  exportSnapshot() { return clone(this.store); }
}

module.exports = { LocalBackend, seedStore };
