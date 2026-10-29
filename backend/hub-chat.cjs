'use strict';

// One project-scoped conversation, with a separately bounded context envelope
// for each page. This service cannot launch external agents or confirm changes.
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const copy=value=>JSON.parse(JSON.stringify(value));
const uid=prefix=>`${prefix}_${crypto.randomUUID()}`;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const VIEWS={dashboard:'项目驾驶舱',phases:'设计流程',files:'项目上下文',chat:'项目群聊',knowledge:'知识中心',cases:'案例与素材',skills:'技能中心',agents:'外部 Agent 协作',schedule:'进度与风险',contracts:'合同与回款',team:'团队与设置'};
const FINANCE_ROLES=new Set(['leader','finance']);
const SENSITIVE=/合同|付款|回款|应收|金额|报价|预算|成本|请款|商务|财务|薪资|工资|保密|机密|[¥￥$]|\b(?:confidential|private|payment|invoice|salary|commercial|contract|budget|cost)\b/i;
const BOT_ID='aidesignhub_assistant';
function fail(code,message){const e=new Error(message);e.code=code;return e;}
function validText(value,label,max,optional=false){if(typeof value!=='string'||value.length>max||(!optional&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail('HUB_CHAT_INVALID_INPUT',`${label}格式无效或过长。`);return value;}
function summary(value,max=1000){return String(value??'').replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s，。；;\n]+/g,'[本机路径已省略]').replace(/\b(?:sk|Bearer)[-_ ][A-Za-z0-9_-]{12,}/g,'[凭据已省略]').slice(0,max);}
function safeRecord(item){return !item.private&&!item.businessSensitive&&!['private','confidential'].includes(item.visibility)&&!['contract','finance','billing','payment'].includes(item.sourceType||item.source)&&!SENSITIVE.test([item.name,item.title,item.description,item.notes,item.summary].filter(Boolean).join('\n'));}
function assistantId(projectId){return `hub_assistant_${projectId}`;}
function normalizeChannel(store,projectId,channelId){return !channelId||channelId===assistantId(projectId)||store.channels.some(c=>c.id===channelId&&c.projectId===projectId&&c.type==='assistant')?assistantId(projectId):channelId;}
function isMention(text){return /(?:^|[\s，。！？：:（(【\[])@(?:Design\s?Hub|AIDesignHub)(?=$|[\s，。！？：:）)】\]、])/i.test(text);}
function channelFor(projectId){return {id:assistantId(projectId),projectId,name:'项目助手',description:'Design Hub 内置 AI · 项目记忆与页面问答',type:'assistant',virtual:true};}
function state(store){store.hubChat||={version:1,requests:[]};return store.hubChat;}
function current(backend,projectId){const store=backend.store,project=store.projects.find(p=>p.id===projectId),member=store.members.find(m=>m.id===store.settings.currentMemberId&&m.projectId===projectId&&m.active!==false);if(!project||store.settings.currentProjectId!==projectId||!member)throw fail('HUB_CHAT_ACCESS_DENIED','请先切换到你参与的项目。');return {project,member};}
function publicMessage(message){return copy(message);}

class HubChat extends EventEmitter{
  constructor({backend,projectHub,modelService,skillCenter,clock=()=>Date.now()}){
    super();if(!backend?.store||!projectHub)throw new Error('HubChat requires backend and ProjectHub.');
    Object.assign(this,{backend,projectHub,modelService,skillCenter,clock,disposed:false});
    if(backend.store.hubChat?.requests.some(r=>r.status==='processing'))backend.mutate(store=>{for(const request of state(store).requests)if(request.status==='processing'){request.status='failed';const bot=store.messages.find(m=>m.id===request.assistantMessageId);if(bot){bot.body='上次内置 AI 回复被中断。你的消息已保留，可重新发送。';bot.hubChat.status='failed';}const draft=store.projectHub?.drafts.find(d=>d.id===request.draftId);if(draft)Object.assign(draft,{status:'dismissed',modelStatus:'failed',actions:[]});}return true;});
  }
  active(){if(this.disposed)throw fail('HUB_CHAT_DISPOSED','聊天服务已关闭。');}
  changed(projectId){this.emit('changed',projectId);}
  page({projectId,view='dashboard',query='',selectionId=null}){
    this.active();const {project,member}=current(this.backend,projectId),store=this.backend.store;
    if(!Object.hasOwn(VIEWS,view))throw fail('HUB_CHAT_INVALID_VIEW','页面类型不受支持。');
    validText(query,'检索问题',2000,true);if(selectionId!==null)validText(selectionId,'所选条目',200);
    const page={version:1,projectId,view,label:VIEWS[view],access:'allowed',items:[],notices:[],query:query.slice(0,2000),selectionId};
    const owned=list=>(list||[]).filter(item=>item.projectId===projectId&&safeRecord(item));
    if(view==='knowledge'||view==='files'){
      const documents=owned(store.knowledgeDocs).filter(item=>!selectionId||item.id===selectionId);
      page.items=documents.slice(0,15).map(item=>({kind:'document',id:item.id,name:summary(item.name,300),status:summary(item.status,80),type:summary(item.extension,30),updatedAt:item.updatedAt||null}));
      if(view==='knowledge'&&query.trim()){
        const result=this.backend.knowledge.search(documents,projectId,query,6);
        page.items.push(...result.hits.filter(hit=>!SENSITIVE.test(hit.excerpt||'')).map(hit=>({kind:'excerpt',sourceId:hit.documentId,sourceName:summary(hit.documentName,300),locator:summary(hit.locator,160),excerpt:summary(hit.excerpt,1500)})));
      }
      page.notices.push(view==='files'?'只提供已导入资料名称与状态；未读取模型、图纸或本地文件夹内容，也不提供文件路径。':'仅检索当前项目已导入、可提供的资料摘录；没有命中不等于不存在相关规定。');
      if(view==='files')page.notices.push('项目基础、已登记任务、已确认决策及未关闭风险由 context.project 的正式项目记录提供；此处文件仅为来源资料，不代表已理解文件内容或确认项目状态。待审批候选和前端演示内容不纳入正式项目上下文。');
      if(selectionId&&!documents.some(d=>d.id===selectionId))throw fail('HUB_CHAT_INVALID_SELECTION','所选资料不在当前项目可用范围。');
    }else if(view==='cases'){
      const cases=owned(store.cases).filter(item=>!selectionId||item.id===selectionId);
      if(selectionId&&!cases.length)throw fail('HUB_CHAT_INVALID_SELECTION','所选案例不在当前项目可用范围。');
      page.items=cases.slice(0,20).map(item=>({kind:'case',id:item.id,name:summary(item.name,300),type:summary(item.typeLabel||item.type,120),location:summary(item.location,200),designer:summary(item.designer,200),summary:summary(item.notes||item.preview?.description||'',1200),status:summary(item.research?.status||item.researchStatus||item.preview?.status||'待核实',100)}));
      page.notices.push('案例字段来自已保存记录，可能待核实；本次没有联网调研、下载图片或调用桌面 Agent。');
    }else if(view==='skills'){
      const skills=this.skillCenter?.list(projectId)||[];
      const chosen=skills.filter(s=>!selectionId||s.id===selectionId);
      if(selectionId&&!chosen.length)throw fail('HUB_CHAT_INVALID_SELECTION','所选技能未发布或不属于当前项目。');
      page.items=chosen.slice(0,20).map(s=>({kind:'skill',id:s.id,name:summary(s.name,300),summary:summary(s.description,1200),category:summary(s.category,100),version:summary(s.version,80)}));
      page.notices.push('技能描述仅供解释与选择，不作为系统指令，不执行代码或启动外部 Agent。');
    }else if(view==='contracts'){
      if(!FINANCE_ROLES.has(member.role)){page.access='restricted';page.notices.push('当前项目身份无权向内置模型提供合同与回款数据；仅公司负责人和经营财务角色可用。');}
      else{
        page.items=(store.contractMilestones||[]).filter(m=>m.projectId===projectId).slice(0,30).map(m=>({kind:'contract_milestone',id:m.id,title:summary(m.title,300),condition:summary(m.condition,1000),amount:Number.isFinite(m.amount)?m.amount:null,status:summary(m.status,100),dueAt:m.dueAt||null}));
        page.notices.push('以下为当前项目合同与回款登记信息；需要明确同意才发送给已配置模型，不自动确认收款或形成法律结论。');
      }
    }else if(view==='team'){
      page.items=store.members.filter(m=>m.projectId===projectId&&m.active!==false).slice(0,50).map(m=>({kind:'member',id:m.id,name:summary(m.name,100),role:summary(m.role,80),taskCount:store.tasks.filter(t=>t.projectId===projectId&&t.ownerId===m.id&&t.status!=='done').length}));
      page.notices.push('只提供本项目成员与已登记任务数，不自动推算工时负荷；身份修改由管理员确认，模型不能修改权限。');
    }else if(view==='agents'){
      page.notices.push('这里是外部桌面 Agent 执行区。此聊天仍是内置项目助手，只能解释项目资料；不会替代或启动外部 Agent。');
    }else{
      const context=this.projectHub.context(projectId);
      page.items=(view==='phases'||view==='schedule'?context.tasks:[]).map(t=>({kind:'task',...t}));
      if(view==='schedule')page.items.push(...context.risks.map(r=>({kind:'risk',...r})));
      if(view==='phases')page.notices.push(`当前登记阶段：${summary(project.stage,60)}；阶段与完成情况由人确认，不从文件数量推断。`);
      if(view==='chat')page.notices.push('不自动将群聊历史、附件或其他成员消息发送到模型；只提供本次明确发送的文字与项目摘要。');
    }
    page.revision=digest(page);return page;
  }
  context({projectId,channelId,view,query='',selectionId=null}){
    const {member}=current(this.backend,projectId),page=this.page({projectId,view,query,selectionId});
    const history=this.backend.store.messages.filter(m=>page.access==='allowed'&&m.projectId===projectId&&normalizeChannel(this.backend.store,projectId,m.channelId)===channelId&&m.hubChat?.view===view&&m.hubChat?.actorId===member.id&&m.hubChat?.modelRequested===true&&m.hubChat?.status==='succeeded'&&(channelId===assistantId(projectId)))
      .slice(-8).map(m=>({role:m.senderId===BOT_ID?'assistant':'user',content:String(m.body).slice(0,3000)}));
    return {project:this.projectHub.context(projectId),page,history,scopeLabel:`${this.backend.store.projects.find(p=>p.id===projectId).name} · ${VIEWS[view]}`};
  }
  snapshot({projectId,view='dashboard',channelId,query='',selectionId=null}={}){
    this.active();projectId=projectId||this.backend.store.settings.currentProjectId;const {member}=current(this.backend,projectId);
    channelId=normalizeChannel(this.backend.store,projectId,channelId);
    const channels=this.backend.store.channels.filter(c=>c.projectId===projectId&&c.type!=='assistant'&&c.id!==assistantId(projectId));
    channels.unshift(this.backend.store.channels.find(c=>c.id===assistantId(projectId))||channelFor(projectId));
    if(!channels.some(c=>c.id===channelId))throw fail('HUB_CHAT_INVALID_CHANNEL','频道不属于当前项目。');
    const financeIds=new Set(this.backend.store.members.filter(m=>m.projectId===projectId&&m.role==='finance').map(m=>m.id));
    const messages=this.backend.store.messages.filter(m=>m.projectId===projectId&&normalizeChannel(this.backend.store,projectId,m.channelId)===channelId&&(FINANCE_ROLES.has(member.role)||(m.hubChat?.view!=='contracts'&&!financeIds.has(m.senderId)&&!SENSITIVE.test(m.body||'')))&&(channelId!==assistantId(projectId)||(m.hubChat?m.hubChat.actorId===member.id:m.senderId===member.id))).slice(-200).map(publicMessage);
    return copy({projectId,view,channelId,assistantChannelId:assistantId(projectId),channels,messages,members:this.backend.store.members.filter(m=>m.projectId===projectId&&m.active!==false).map(m=>({id:m.id,name:m.name,title:m.title,role:m.role})),context:this.context({projectId,channelId,view,query,selectionId}),model:this.modelService?.status?.()||{configured:false},limitations:['本地会话不代表已跨电脑同步。','模型建议必须确认后才修改正式项目记录。']});
  }
  result(request,duplicate=false){
    const messages=this.backend.store.messages;
    const draft=this.backend.store.projectHub?.drafts.find(d=>d.id===request.draftId&&d.actions?.length&&d.status!=='dismissed');
    return copy({projectId:request.projectId,channelId:request.channelId,status:request.status,duplicate,userMessage:messages.find(m=>m.id===request.userMessageId),assistantMessage:messages.find(m=>m.id===request.assistantMessageId)||null,draft:draft?this.projectHub.snapshot(request.projectId).drafts.find(d=>d.id===draft.id):null});
  }
  async send({projectId,channelId,text,view='dashboard',selectionId=null,requestId=uid('request'),useModel=false}={}){
    this.active();projectId=projectId||this.backend.store.settings.currentProjectId;const {member}=current(this.backend,projectId);
    validText(text,'消息',20000);validText(requestId,'请求标识',200);if(typeof useModel!=='boolean')throw fail('HUB_CHAT_INVALID_INPUT','请明确是否启用内置 AI。');
    channelId=normalizeChannel(this.backend.store,projectId,channelId);
    if(channelId!==assistantId(projectId)&&!this.backend.store.channels.some(c=>c.projectId===projectId&&c.id===channelId))throw fail('HUB_CHAT_INVALID_CHANNEL','频道不属于当前项目。');
    const mentioned=channelId===assistantId(projectId)||isMention(text);
    const fingerprint=digest({projectId,channelId,text,view,selectionId,useModel,actorId:member.id});
    const existing=this.backend.store.hubChat?.requests.find(r=>r.projectId===projectId&&r.actorId===member.id&&r.requestId===requestId);
    if(existing){if(existing.fingerprint!==fingerprint)throw fail('HUB_CHAT_REQUEST_CONFLICT','同一请求标识已经用于不同内容。');return this.result(existing,true);}
    const context=this.context({projectId,channelId,view,query:text.slice(0,2000),selectionId});
    const willCall=mentioned&&useModel&&context.page.access==='allowed';
    const request=this.backend.mutate(store=>{
      current(this.backend,projectId);if(channelId===assistantId(projectId)&&!store.channels.some(c=>c.id===channelId)){const {virtual,...channel}=channelFor(projectId);store.channels.unshift({...channel,createdAt:this.clock()});}
      const at=this.clock(),userMessageId=uid('msg'),assistantMessageId=mentioned?uid('msg'):null;
      store.messages.push({id:userMessageId,projectId,channelId,senderId:member.id,body:text,type:'text',attachments:[],createdAt:at,editedAt:null,hubChat:{view,actorId:member.id,modelRequested:willCall,status:willCall?'processing':'recorded'}});
      if(mentioned)store.messages.push({id:assistantMessageId,projectId,channelId,senderId:BOT_ID,senderName:'Design Hub',body:willCall?'正在使用内置模型整理答复…':context.page.access==='restricted'?context.page.notices.join('\n'):'消息已保存在项目中。尚未允许调用内置 AI；勾选后重新发送即可。',type:'assistant',attachments:[],createdAt:at+1,editedAt:null,hubChat:{view,actorId:member.id,modelRequested:willCall,status:willCall?'processing':'not_called',context:copy(context)}});
      const record={id:uid('hub_chat_request'),requestId,fingerprint,projectId,channelId,actorId:member.id,actorRole:member.role,view,status:willCall?'processing':'recorded',userMessageId,assistantMessageId,createdAt:at};state(store).requests.push(record);return record;
    });this.changed(projectId);
    if(!willCall)return this.result(request);
    let draftId;
    try{
      // Preserve the original optimistic versions before the asynchronous model
      // request. This internal candidate is not a business change or a task.
      const draft=await this.projectHub.prepare({projectId,text,useModel:false});draftId=draft.id;
      this.backend.mutate(store=>{const r=state(store).requests.find(r=>r.id===request.id);r.draftId=draftId;const d=store.projectHub.drafts.find(d=>d.id===draftId);Object.assign(d,{status:'preparing',modelStatus:'preparing',source:{...d.source,kind:'hub_chat',sourceMessageId:request.userMessageId,sourceView:view,channelId}});return true;});
      if(!this.modelService?.reply)throw fail('MODEL_NOT_CONFIGURED','尚未配置内置 AI 模型。消息已保存，请在模型设置中完成配置。');
      const reply=await this.modelService.reply({projectId,text,context:context.project,pageContext:context.page,history:context.history});
      if(this.disposed)return this.resultWithoutDraft(request);
      const actor=this.backend.store.members.find(m=>m.id===member.id&&m.projectId===projectId&&m.active!==false);
      if(!actor||(view==='contracts'&&!FINANCE_ROLES.has(actor.role)))throw fail('HUB_CHAT_ACCESS_CHANGED','请求期间项目身份已改变，回复未接纳。');
      validText(reply.reply,'模型答复',12000);const actions=this.projectHub.normalizeActions(reply.actions||[],this.backend.store,projectId);
      this.backend.mutate(store=>{
        const r=state(store).requests.find(r=>r.id===request.id),bot=store.messages.find(m=>m.id===request.assistantMessageId),user=store.messages.find(m=>m.id===request.userMessageId),d=store.projectHub.drafts.find(d=>d.id===draftId);
        r.status='succeeded';r.completedAt=this.clock();bot.body=reply.reply;bot.hubChat.status='succeeded';bot.hubChat.draftId=actions.length?draftId:null;user.hubChat.status='succeeded';
        Object.assign(d,{summary:summary(reply.summary,2000),actions,status:actions.length?'pending':'dismissed',modelStatus:actions.length?'succeeded':'no_changes',error:null,updatedAt:this.clock()});return true;
      });this.changed(projectId);this.projectHub.changed(projectId);
    }catch(error){
      if(this.disposed)return this.resultWithoutDraft(request);
      const reason=error?.code==='MODEL_NOT_CONFIGURED'?'尚未配置内置 AI 模型。消息已保存，请先完成模型设置。':error?.code==='HUB_CHAT_ACCESS_CHANGED'?'请求期间项目身份改变，本次回复未接纳。原始消息已保留。':'内置 AI 未能完成回复。消息已保留，请检查模型设置或稍后重试；未修改项目记录。';
      this.backend.mutate(store=>{const r=state(store).requests.find(r=>r.id===request.id);r.status='failed';r.errorCode=String(error?.code||'HUB_CHAT_MODEL_FAILED').slice(0,100);const bot=store.messages.find(m=>m.id===request.assistantMessageId);if(bot){bot.body=reason;bot.hubChat.status='failed';}const d=store.projectHub?.drafts.find(d=>d.id===draftId);if(d)Object.assign(d,{status:'dismissed',modelStatus:'failed',actions:[],error:reason,updatedAt:this.clock()});return true;});this.changed(projectId);
    }
    return this.resultWithoutDraft(request);
  }
  resultWithoutDraft(request){const currentRequest=this.backend.store.hubChat.requests.find(r=>r.id===request.id);const messages=this.backend.store.messages,draft=this.backend.store.projectHub?.drafts.find(d=>d.id===currentRequest.draftId);const {base,confirmationHash,...visibleDraft}=draft||{};return copy({projectId:request.projectId,channelId:request.channelId,status:currentRequest.status,duplicate:false,userMessage:messages.find(m=>m.id===request.userMessageId),assistantMessage:messages.find(m=>m.id===request.assistantMessageId)||null,draft:draft?.actions?.length&&draft.status!=='dismissed'?visibleDraft:null});}
  dispose(){if(this.disposed)return;this.disposed=true;this.backend.mutate(store=>{for(const request of store.hubChat?.requests||[])if(request.status==='processing'){request.status='failed';const bot=store.messages.find(m=>m.id===request.assistantMessageId);if(bot){bot.body='聊天服务已关闭，本次回复中断。原文已保留。';bot.hubChat.status='failed';}const d=store.projectHub?.drafts.find(d=>d.id===request.draftId);if(d)Object.assign(d,{status:'dismissed',modelStatus:'failed',actions:[]});}return true;});}
}

module.exports={HubChat,BOT_ID,VIEWS};
