'use strict';

const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {safeProfileForContext}=require('./project-research-profiles.cjs');

const STAGES=['intake','research','massing','concept','develop','concept100','approval','archive'];
const ACTION_TYPES=['task.create','task.update','risk.create','risk.update','decision.create','decision.update','project.update'];
const APPROVAL_ROLES=new Set(['pm','leader']);
const FIELDS={task:['title','phase','ownerId','status','priority','dueAt'],risk:['title','description','severity','status','ownerId'],decision:['title','summary','status','ownerId','dueAt'],project:['stage','stageRound','focus']};
const ENUMS={phase:STAGES,stage:STAGES,priority:['low','medium','high'],severity:['low','medium','high']};
const STATUS={task:['todo','doing','blocked','submitted','changes_requested','done'],risk:['open','closed'],decision:['proposed','confirmed','superseded']};
const PRIVATE_TEXT=/合同|付款|回款|应收|金额|报价|预算|成本|请款|商务|财务|薪资|工资|保密|机密|[¥￥$]|\b(?:confidential|private|payment|invoice|salary|commercial|contract|budget|cost)\b/i;
const clone=value=>JSON.parse(JSON.stringify(value));
const uid=prefix=>`${prefix}_${crypto.randomUUID()}`;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]??null]));
function fail(code,message){const error=new Error(message);error.code=code;return error;}
function text(value,name,max,{empty=false}={}){
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))throw fail('INVALID_INPUT',`${name}格式无效或长度超限。`);
  return value.trim();
}
function currentActor(store,projectId){
  const project=store.projects.find(p=>p.id===projectId);
  if(!project||store.settings.currentProjectId!==projectId)throw fail('PROJECT_ACCESS_DENIED','请先切换到这个项目，不能跨项目修改或读取管理记录。');
  const member=store.members.find(m=>m.id===store.settings.currentMemberId&&m.projectId===projectId&&m.active!==false);
  if(!member)throw fail('PROJECT_ACCESS_DENIED','当前身份不是此项目的有效成员。');
  return {project,member};
}
function currentApprover(store,projectId){
  const actor=currentActor(store,projectId);
  if(!APPROVAL_ROLES.has(actor.member.role))throw fail('PROJECT_APPROVAL_DENIED','只有本项目有效的项目经理或公司负责人可以审批写入；切换界面视角不会获得审批权限。');
  return actor;
}
function ownedMember(store,projectId,id){if(typeof id!=='string'||!store.members.some(m=>m.id===id&&m.projectId===projectId&&m.active!==false))throw fail('INVALID_MEMBER','责任人或通知对象必须是本项目的有效成员。');return id;}
function container(store){store.projectHub||={version:1,drafts:[],audits:[],notifications:[]};return store.projectHub;}
function publicDraft(draft){const {base,confirmationHash,...visible}=draft;return clone(visible);}
function entityHash(entity,type){return hash(pick(entity,FIELDS[type]));}
function baseVersions(store,projectId){
  const versions={project:entityHash(store.projects.find(p=>p.id===projectId),'project'),task:{},risk:{},decision:{}};
  for(const [type,key] of [['task','tasks'],['risk','risks'],['decision','decisions']])for(const item of store[key].filter(item=>item.projectId===projectId))versions[type][item.id]=entityHash(item,type);
  return versions;
}

class ProjectHub extends EventEmitter{
  constructor({backend,model=null,clock=()=>Date.now()}){super();if(!backend?.store||typeof backend.mutate!=='function')throw new Error('ProjectHub requires a local backend.');this.backend=backend;this.model=model;this.clock=clock;this.disposed=false;this.pending=new Set();
    if(backend.store.projectHub?.drafts.some(d=>d.status==='preparing'))backend.mutate(store=>{for(const draft of store.projectHub.drafts)if(draft.status==='preparing')Object.assign(draft,{status:'pending',modelStatus:'failed',actions:[],error:'上次模型整理被中断；原文已保留，可人工编辑动作。',updatedAt:this.clock()});return true;});
  }
  active(){if(this.disposed)throw fail('DISPOSED','项目管理服务已关闭。');}
  changed(projectId){this.emit('changed',projectId);}
  context(projectId){
    this.active();const store=this.backend.store,{project}=currentActor(store,projectId);
    const finance=new Set(store.members.filter(m=>m.projectId===projectId&&m.role==='finance').map(m=>m.id));
    const safe=item=>item.projectId===projectId&&!item.private&&!item.businessSensitive&&!['private','confidential'].includes(item.visibility)&&!['contract','finance','billing','payment'].includes(item.source)&&!finance.has(item.ownerId)&&!PRIVATE_TEXT.test([item.title,item.description,item.summary].filter(Boolean).join('\n'));
    const tasks=store.tasks.filter(safe),risks=store.risks.filter(item=>item.status==='open'&&safe(item)),decisions=store.decisions.filter(item=>item.status==='confirmed'&&safe(item));
    const projectData={id:project.id,name:String(project.name||'').slice(0,300),stage:project.stage,stageRound:project.stageRound||1,focus:PRIVATE_TEXT.test(project.focus||'')?'':String(project.focus||'').slice(0,2000)};
    const profile=safeProfileForContext(project);if(profile)projectData.researchProfile=profile;
    const members=store.members.filter(m=>m.projectId===projectId&&m.active!==false&&m.role!=='finance').slice(0,50).map(m=>({id:m.id,name:String(m.name||'').slice(0,100),role:m.role}));
    const body={version:1,projectId,project:projectData,members,tasks:tasks.slice(-20).map(item=>({...pick(item,['id','phase','ownerId','status','priority','dueAt']),title:String(item.title||'').slice(0,300)})),risks:risks.slice(-10).map(item=>({...pick(item,['id','severity','status','ownerId']),title:String(item.title||'').slice(0,300)})),decisions:decisions.slice(-10).map(item=>({...pick(item,['id','status','ownerId']),title:String(item.title||'').slice(0,300),summary:String(item.summary||'').slice(0,1200)})),truncated:{tasks:Math.max(0,tasks.length-20),risks:Math.max(0,risks.length-10),decisions:Math.max(0,decisions.length-10)}};
    return clone({...body,revision:hash(body)});
  }
  snapshot(projectId){
    this.active();const store=this.backend.store,{project,member}=currentActor(store,projectId),state=store.projectHub||{drafts:[],audits:[],notifications:[]};
    const approval={canApprove:APPROVAL_ROLES.has(member.role),reviewerIds:store.members.filter(m=>m.projectId===projectId&&m.active!==false&&APPROVAL_ROLES.has(m.role)).map(m=>m.id),policy:'project_manager_or_leader'};
    return clone({projectId,project:pick(project,['id','name','stage','stageRound','focus','updatedAt']),members:store.members.filter(m=>m.projectId===projectId&&m.active!==false).map(m=>pick(m,['id','name','title','role'])),approval,drafts:state.drafts.filter(d=>d.projectId===projectId).slice(-50).reverse().map(publicDraft),audits:state.audits.filter(a=>a.projectId===projectId).slice(-100).reverse(),notifications:state.notifications.filter(n=>n.projectId===projectId).slice(-100).reverse(),schema:{actionTypes:ACTION_TYPES,stages:STAGES,taskStatuses:STATUS.task,riskStatuses:STATUS.risk,decisionStatuses:STATUS.decision,priorities:ENUMS.priority},context:this.context(projectId)});
  }
  normalizeActions(actions,store,projectId,{validateReferences=true}={}){
    if(!Array.isArray(actions)||actions.length>30)throw fail('INVALID_ACTIONS','每次最多确认30项管理动作。');
    let bytes;try{bytes=Buffer.byteLength(JSON.stringify(actions),'utf8');}catch{throw fail('INVALID_ACTIONS','管理动作必须为可序列化数据。');}if(bytes>100000)throw fail('INVALID_ACTIONS','管理动作数据超限。');
    const seen=new Set();
    return actions.map(action=>{
      if(!plain(action)||Object.keys(action).some(key=>!['type','id','data'].includes(key))||!ACTION_TYPES.includes(action.type)||!plain(action.data))throw fail('INVALID_ACTIONS','管理动作类型或字段不受支持。');
      const [type,operation]=action.type.split('.'),data={};
      if(!Object.keys(action.data).length||Object.keys(action.data).some(key=>!FIELDS[type].includes(key)))throw fail('INVALID_ACTIONS','动作包含未允许的字段。');
      let id;
      if(type==='project'||operation==='create'){if(action.id!==undefined)throw fail('INVALID_ACTIONS','创建或项目更新动作不能指定对象ID。');}
      else{
        id=text(action.id,'对象ID',150);const key=`${type}:${id}`;if(seen.has(key))throw fail('DUPLICATE_TARGET','同一草稿不能多次更新同一个对象，请合并修改。');seen.add(key);
        const record=store[`${type}s`].find(item=>item.id===id&&item.projectId===projectId);if(validateReferences&&!record)throw fail('INVALID_TARGET','更新对象不存在或不属于当前项目。');
        if(validateReferences&&type==='task'&&record.agentJobId&&Object.hasOwn(action.data,'status'))throw fail('AGENT_REVIEW_REQUIRED','Agent任务必须在Agent协作中提交成果并审核，不能直接修改完成状态。');
      }
      if(type==='project'){if(seen.has('project'))throw fail('DUPLICATE_TARGET','请合并项目阶段与重点修改。');seen.add('project');}
      for(const [key,value] of Object.entries(action.data)){
        if(key==='ownerId')data[key]=validateReferences?ownedMember(store,projectId,value):text(value,'责任人ID',150);
        else if(key==='dueAt'){if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>8640000000000000))throw fail('INVALID_INPUT','截止时间必须为有效时间戳或null。');data[key]=value;}
        else if(key==='stageRound'){if(!Number.isInteger(value)||value<1||value>1000)throw fail('INVALID_INPUT','轮次必须为1至1000的整数。');data[key]=value;}
        else if(key==='status'){if(!STATUS[type].includes(value))throw fail('INVALID_INPUT','状态无效。');data[key]=value;}
        else if(ENUMS[key]){if(!ENUMS[key].includes(value))throw fail('INVALID_INPUT','阶段或优先级无效。');data[key]=value;}
        else data[key]=text(value,key,key==='title'?300:key==='focus'?2000:4000,{empty:key!=='title'});
      }
      if(operation==='create'&&!data.title)throw fail('INVALID_INPUT','新建记录必须有标题。');
      return {type:action.type,...(id?{id}:{}),data};
    });
  }
  async prepare({projectId,text:raw,useModel=false}){
    this.active();if(typeof useModel!=='boolean')throw fail('INVALID_INPUT','请明确是否使用模型整理。');text(raw,'原始输入',20000);if(Buffer.byteLength(raw,'utf8')>64000)throw fail('INVALID_INPUT','原始输入字节数超限。');
    const {member}=currentActor(this.backend.store,projectId),context=this.context(projectId),draftId=uid('project_draft'),createdAt=this.clock();
    const hasModel=typeof this.model==='function',willUseModel=useModel&&hasModel;
    const draft=this.backend.mutate(store=>{currentActor(store,projectId);const entry={id:draftId,projectId,text:raw,source:{kind:'local_note',memberId:member.id,createdAt},createdBy:member.id,createdAt,updatedAt:createdAt,status:willUseModel?'preparing':'pending',modelStatus:willUseModel?'preparing':useModel?'unconfigured':'not_requested',summary:'',actions:[],error:useModel&&!hasModel?'尚未配置整理模型；原文已保存，可人工编辑动作。':null,contextRevision:context.revision,base:baseVersions(store,projectId)};container(store).drafts.push(entry);return publicDraft(entry);});
    this.changed(projectId);if(!willUseModel)return draft;
    this.pending.add(draftId);
    try{
      const result=await this.model({projectId,text:raw,context:clone(context)});
      if(this.disposed)return this.resultAfterModel(draftId,projectId);
      currentActor(this.backend.store,projectId);
      const current=this.backend.store.projectHub.drafts.find(d=>d.id===draftId);if(current.status!=='preparing')return publicDraft(current);
      if(!plain(result)||Object.keys(result).some(key=>!['summary','actions'].includes(key)))throw fail('INVALID_MODEL_RESULT','模型未返回有效管理草稿。');
      const summary=text(result.summary??'','摘要',2000,{empty:true}),actions=this.normalizeActions(result.actions,this.backend.store,projectId);
      const updated=this.backend.mutate(store=>{currentActor(store,projectId);const entry=container(store).drafts.find(d=>d.id===draftId);if(entry.status!=='preparing')return publicDraft(entry);Object.assign(entry,{status:'pending',modelStatus:'succeeded',summary,actions,error:null,updatedAt:this.clock()});return publicDraft(entry);});this.changed(projectId);return updated;
    }catch{
      if(this.disposed)return this.resultAfterModel(draftId,projectId);
      const updated=this.backend.mutate(store=>{const entry=container(store).drafts.find(d=>d.id===draftId);if(entry?.status==='preparing')Object.assign(entry,{status:'pending',modelStatus:'failed',actions:[],error:'模型整理未完成；原文已保存。可人工编辑动作或重新整理，不会自动修改项目。',updatedAt:this.clock()});return entry?publicDraft(entry):null;});
      currentActor(this.backend.store,projectId);this.changed(projectId);return updated;
    }finally{this.pending.delete(draftId);}
  }
  resultAfterModel(id,projectId){currentActor(this.backend.store,projectId);const draft=this.backend.store.projectHub?.drafts.find(d=>d.id===id);return draft?publicDraft(draft):null;}
  important(action){return action.type==='project.update'&&('stage'in action.data||'stageRound'in action.data)||action.type.startsWith('decision.')&&action.data.status==='confirmed'||action.type.startsWith('task.')&&action.data.status==='done'||action.type.startsWith('risk.')&&action.data.status==='closed';}
  confirm({id,actions,notifyMemberIds=[],acknowledgeImportant=false}){
    this.active();text(id,'草稿ID',150);const draft=this.backend.store.projectHub?.drafts.find(d=>d.id===id);if(!draft)throw fail('DRAFT_NOT_FOUND','草稿不存在。');
    // Check the actual project role even for idempotent receipt replays.
    const projectId=draft.projectId;currentApprover(this.backend.store,projectId);
    const alreadyConfirmed=draft.status==='confirmed';const normalized=this.normalizeActions(actions,this.backend.store,projectId,{validateReferences:!alreadyConfirmed});if(!normalized.length)throw fail('EMPTY_ACTIONS','至少添加一项需要确认的动作。');
    if(!Array.isArray(notifyMemberIds)||notifyMemberIds.length>50||new Set(notifyMemberIds).size!==notifyMemberIds.length)throw fail('INVALID_MEMBER','通知成员列表无效。');
    const recipients=notifyMemberIds.map(memberId=>alreadyConfirmed?text(memberId,'通知成员ID',150):ownedMember(this.backend.store,projectId,memberId)).sort();
    const fingerprint=hash({actions:normalized,notifyMemberIds:recipients});
    if(draft.status==='confirmed'){if(draft.confirmationHash!==fingerprint)throw fail('CONFIRMATION_CONFLICT','这个草稿已确认，不能用不同内容再次提交。');return clone({...draft.receipt,duplicate:true});}
    if(draft.status!=='pending')throw fail('DRAFT_NOT_READY','草稿尚在整理或已取消，不能确认。');
    if(normalized.some(action=>this.important(action))&&acknowledgeImportant!==true)throw fail('IMPORTANT_CONFIRMATION_REQUIRED','切换阶段、完成任务、关闭风险或确认决策，需要明确勾选重要操作确认。');
    const result=this.backend.mutate(store=>{
      const {project,member}=currentApprover(store,projectId),state=container(store),entry=state.drafts.find(d=>d.id===id);
      if(entry.status!=='pending')throw fail('DRAFT_NOT_READY','草稿状态已改变。');
      // Validate the entire batch and optimistic versions before applying any item.
      for(const action of normalized){const [type,operation]=action.type.split('.');if(operation==='update'){const record=type==='project'?project:store[`${type}s`].find(item=>item.id===action.id&&item.projectId===projectId);const expected=type==='project'?entry.base.project:entry.base[type][action.id];if(!record||!expected||entityHash(record,type)!==expected)throw fail('STALE_DRAFT','相关记录已在草稿生成后发生变化，请重新整理，避免覆盖最新状态。');}}
      const at=this.clock(),auditId=uid('project_audit'),changes=[],source={kind:'project_hub',draftId:id,auditId,confirmedBy:member.id,confirmedAt:at};
      for(const action of normalized){
        const [type,operation]=action.type.split('.');let record;const previous=type==='project'?project:operation==='update'?store[`${type}s`].find(item=>item.id===action.id):null;const before=previous?clone(pick(previous,FIELDS[type])):null;
        if(type==='project'){record=project;Object.assign(record,action.data,{updatedAt:at,managementSource:source});}
        else if(operation==='create'){
          const defaults=type==='task'?{phase:project.stage,status:'todo',priority:'medium',dueAt:null,source:'project_hub'}:type==='risk'?{description:'',severity:'medium',status:'open',sourceMessageIds:[]}:{summary:'',status:'proposed',channelId:store.channels.find(c=>c.projectId===projectId&&c.type==='decision')?.id||null,sourceMessageIds:[],dueAt:null};
          record={id:uid(type),projectId,...defaults,ownerId:member.id,...action.data,createdAt:at,updatedAt:at,managementSource:source};store[`${type}s`].push(record);
        }else{record=store[`${type}s`].find(item=>item.id===action.id);Object.assign(record,action.data,{updatedAt:at,managementSource:source});}
        if(type==='decision'&&record.status==='confirmed')record.confirmedAt=at;
        if(type==='risk')record.closedAt=record.status==='closed'?at:null;
        changes.push({type:action.type,entityId:record.id,before,after:clone(pick(record,FIELDS[type]))});
      }
      const audit={id:auditId,projectId,draftId:id,actorId:member.id,text:entry.text,source:clone(entry.source),actions:normalized,changes,contextRevision:entry.contextRevision,createdAt:at};state.audits.push(audit);
      const notificationIds=recipients.map(memberId=>{const notification={id:uid('project_notice'),projectId,memberId,status:'local_pending',auditId,draftId:id,title:`${member.name}确认了${changes.length}项项目管理动作`,createdAt:at};state.notifications.push(notification);return notification.id;});
      store.events.unshift({id:uid('event'),projectId,type:'management',title:`已人工确认${changes.length}项项目管理动作`,detail:'原文与确认记录已保存；通知仅为本地待通知，不代表已发送。',createdAt:at,sourceDraftId:id,auditId});
      const receipt={id,projectId,status:'confirmed',auditId,changes,notificationIds};Object.assign(entry,{status:'confirmed',confirmedBy:member.id,confirmedAt:at,updatedAt:at,confirmedActions:normalized,confirmationHash:fingerprint,receipt});return {...receipt,duplicate:false};
    });this.changed(projectId);return result;
  }
  dismiss(id){
    this.active();text(id,'草稿ID',150);const draft=this.backend.store.projectHub?.drafts.find(d=>d.id===id);if(!draft)throw fail('DRAFT_NOT_FOUND','草稿不存在。');currentActor(this.backend.store,draft.projectId);
    if(draft.status==='confirmed')throw fail('ALREADY_CONFIRMED','已确认记录不能取消，需创建新草稿纠正。');
    const result=this.backend.mutate(store=>{const {member}=currentActor(store,draft.projectId),entry=container(store).drafts.find(d=>d.id===id);if(entry.status!=='dismissed')Object.assign(entry,{status:'dismissed',dismissedBy:member.id,dismissedAt:this.clock(),updatedAt:this.clock()});return publicDraft(entry);});this.changed(draft.projectId);return result;
  }
  dispose(){if(this.disposed)return;this.disposed=true;if(this.pending.size)this.backend.mutate(store=>{for(const draft of store.projectHub?.drafts||[])if(this.pending.has(draft.id)&&draft.status==='preparing')Object.assign(draft,{status:'pending',modelStatus:'failed',actions:[],error:'服务已关闭，模型整理中断；原文已保留，可人工编辑动作。',updatedAt:this.clock()});return true;});}
}
module.exports={ProjectHub,STAGES,ACTION_TYPES};
