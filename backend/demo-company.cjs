'use strict';

// Synthetic company fixtures only. Never call this against an ordinary user
// database: the helper requires an explicit fresh-store opt-in and also checks
// that no existing project content would be replaced.
const crypto=require('node:crypto');
const {seedStore}=require('./local-backend.cjs');
const {ProjectHub}=require('./project-hub.cjs');
const DEMO_ID='aidesignhub_demo_company';
const VERSION=1;
const DAY=86400000;
const copy=value=>JSON.parse(JSON.stringify(value));
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const demo={isDemo:true,provenance:'synthetic_company_fixture'};
const PEOPLE=[
  {key:'leader',name:'许知行',title:'公司负责人',role:'leader',skills:['公司经营','资源协调','项目审批']},
  {key:'pm',name:'林澜',title:'项目经理',role:'pm',skills:['进度计划','业主沟通','成果审批']},
  {key:'director',name:'周远',title:'设计总监',role:'director',skills:['设计方向','概念评审','空间品质']},
  {key:'architect',name:'陈设计',title:'建筑设计师',role:'designer',skills:['总图','方案设计','Rhino']},
  {key:'bim',name:'沈亦舟',title:'BIM负责人',role:'designer',skills:['Revit','图模一致','专业协同']},
  {key:'landscape',name:'顾青禾',title:'景观与室内设计师',role:'designer',skills:['景观设计','室内界面','公共空间']},
  {key:'reviewer',name:'赵工',title:'校审负责人',role:'reviewer',skills:['规范复核','技术校审','质量检查']},
  {key:'finance',name:'方敏',title:'经营财务',role:'finance',skills:['合同台账','回款跟踪','范围变更']},
];
const PROJECTS=[
  {
    key:'riverfront',name:'江湾文化商业中心',code:'DEMO-C01',city:'上海',type:'商业综合体',stage:'concept',stageRound:2,
    focus:'演示：第二轮概念比较；保持滨水公共通廊，入口雨棚只做两案比较，未确认前不进入正式深化。',
    topic:'业主电话提出延长入口雨棚，但范围尚未书面确认。请先比较两种入口方案。',
    baseline:'滨水公共通廊作为本轮概念比较的基准',
    boundary:'演示背景：两案均保留滨水公共通廊，不把待讨论的入口雨棚当作已批准要求。',
    openDecision:'入口雨棚长度仍待业主书面确认',
    risk:'入口变化影响概念汇报范围',riskDetail:'演示风险：口头要求未形成书面边界，先留存比较，不直接替换基准方案。',
    tasks:['协调商业与住宅两组汇报资源','取得雨棚范围的书面确认','组织第二轮概念内部评审','完成两种入口空间比较','校对总图与体量版本','比较雨棚下的景观与铺地关系','复核入口消防车道表达','整理概念阶段请款条件'],
    statuses:['todo','doing','todo','doing','submitted','todo','blocked','todo'],
    amounts:[300000,200000,250000],
  },
  {
    key:'garden',name:'云栖庭院住宅社区',code:'DEMO-R02',city:'杭州',type:'改善型住宅',stage:'develop',stageRound:1,
    focus:'演示：方案深化；先复核标准层、车库与机电净高，保持已选户型配比，不因模型更新自动认定通过校审。',
    topic:'住宅深化周会发现车库坡道与机电净高协调不足。BIM先做碰撞核对，校审确认后再出图。',
    baseline:'维持本轮标准层与户型配比进行专业协调',
    boundary:'演示背景：户型配比作为深化输入；车库净高校核仍未完成，不能把模型上传当作验收。',
    openDecision:'车库坡道标高调整待专业复核',
    risk:'车库坡道与机电净高存在协调缺口',riskDetail:'演示风险：BIM协调结果尚待校审，不应提前发布正式技术图。',
    tasks:['协调BIM与校审资源安排','确认深化出图顺序与负责人','复核住宅入口与首层界面','更新标准层平面深化稿','完成车库坡道与机电碰撞核对','协调架空层和庭院景观标高','校审车库净高与疏散表达','核对深化阶段付款触发证据'],
    statuses:['doing','todo','submitted','doing','blocked','doing','todo','todo'],
    amounts:[240000,320000,240000],
  },
  {
    key:'culture',name:'青岚地方文化中心',code:'DEMO-P03',city:'苏州',type:'公共文化建筑',stage:'research',stageRound:1,
    focus:'演示：项目前期研究；优先澄清展陈、社区活动与公共开放边界，现场资料不足时不锁定建筑体量。',
    topic:'文化中心任务书未明确常设展与临展比例，也缺少完整现状照片。先组织问题清单与现场踏勘。',
    baseline:'以开放式文化客厅作为研究假设而非定案',
    boundary:'演示背景：研究假设可用于访谈和案例筛选，不代表业主已批准建筑方案。',
    openDecision:'常设展与临展面积比例待业主补充',
    risk:'场地与展陈任务资料缺项',riskDetail:'演示风险：面积分配及现场条件不完整，过早锁定体量可能造成返工。',
    tasks:['明确文化项目前研服务边界','汇总业主任务书缺项清单','梳理地方文化线索与叙事方向','制定现场踏勘与访谈提纲','整理前期模型信息需求清单','调研公共开放与活动场地案例','列出前研阶段需核实的技术条件','复核前期服务合同资料清单'],
    statuses:['todo','doing','doing','todo','todo','submitted','todo','doing'],
    amounts:[90000,120000,90000],
  },
];
const projectId=key=>`demo_project_${key}`;
const memberId=(project,key)=>`${project}_member_${key}`;
function fail(code,message){const error=new Error(message);error.code=code;return error;}
function time(value){const result=value===undefined?Date.now():value;if(!Number.isSafeInteger(result)||result<100*DAY||result>8640000000000000-100*DAY)throw fail('DEMO_INVALID_TIME','演示时间必须为有效的毫秒时间戳。');return result;}
function templateHash(store){const {demoCompany,...body}=store;return digest(body);}

function createDemoCompanyStore({now}={}){
  const at=time(now),store=seedStore();
  for(const [key,value]of Object.entries(store))if(Array.isArray(value))store[key]=[];
  store.settings={currentProjectId:projectId('riverfront'),currentMemberId:memberId(projectId('riverfront'),'architect'),currentRole:'designer',createdAt:at};
  store.projectHub={version:1,drafts:[],audits:[],notifications:[]};
  store.teamDirectory={version:1,audits:[]};
  store.demoCompany={id:DEMO_ID,version:VERSION,name:'未名设计事务所 · 演示公司',initialized:false,createdAt:at,notice:'全部为虚拟项目、成员与剧情；不代表真实项目状态、企业账号认证、已发送通知或已实际审批。'};
  for(const spec of PROJECTS){
    const pid=projectId(spec.key),mid=key=>memberId(pid,key),general=`${pid}_channel_general`,decisionChannel=`${pid}_channel_decision`,ownerChannel=`${pid}_channel_owner`,technical=`${pid}_channel_technical`;
    store.projects.push({id:pid,name:spec.name,code:spec.code,city:spec.city,type:spec.type,stage:spec.stage,stageRound:spec.stageRound,focus:spec.focus,folderPath:null,createdAt:at-30*DAY,updatedAt:at,...demo});
    for(const person of PEOPLE)store.members.push({id:mid(person.key),personId:`demo_person_${person.key}`,projectId:pid,name:person.name,title:person.title,role:person.role,skills:[...person.skills],avatar:person.name[0],active:true,createdAt:at-30*DAY,...demo});
    for(const [id,name,type,description]of [[general,'项目群聊','project','虚拟项目组沟通记录'],[`hub_assistant_${pid}`,'项目助手','assistant','内置项目助手；候选须负责人审批'],[decisionChannel,'设计决策','decision','虚拟背景与待确认要求'],[ownerChannel,'业主沟通','external','虚拟业主意见与服务边界'],[technical,'模型与图纸','technical','虚拟专业协调记录']])store.channels.push({id,projectId:pid,name,type,description,createdAt:at-30*DAY,...demo});
    const messageId=`${pid}_message_brief`,baselineMessage=`${pid}_message_baseline`;
    store.messages.push(
      {id:messageId,projectId:pid,channelId:general,senderId:mid('pm'),body:`【虚拟演示】${spec.topic}`,type:'text',attachments:[],createdAt:at-90*60000,editedAt:null,...demo},
      {id:baselineMessage,projectId:pid,channelId:decisionChannel,senderId:mid('director'),body:`【虚拟背景，非真实审批记录】${spec.boundary}`,type:'text',attachments:[],createdAt:at-70*60000,editedAt:null,...demo},
      {id:`${pid}_message_reply`,projectId:pid,channelId:general,senderId:mid('architect'),body:'收到。我会先保留现有工作基准，把未明确的要求整理成候选，请项目负责人审批后再更新上下文。',type:'text',attachments:[],createdAt:at-50*60000,editedAt:null,...demo}
    );
    store.decisions.push(
      {id:`${pid}_decision_baseline`,projectId:pid,channelId:decisionChannel,title:`演示背景：${spec.baseline}`,summary:spec.boundary,status:'confirmed',ownerId:mid('director'),sourceMessageIds:[baselineMessage],createdAt:at-2*DAY,confirmedAt:at-2*DAY,dueAt:null,...demo},
      {id:`${pid}_decision_pending`,projectId:pid,channelId:ownerChannel,title:spec.openDecision,summary:`【虚拟待定事项】${spec.topic}`,status:'proposed',ownerId:mid('pm'),sourceMessageIds:[messageId],createdAt:at-90*60000,confirmedAt:null,dueAt:at+2*DAY,...demo}
    );
    PEOPLE.forEach((person,index)=>store.tasks.push({id:`${pid}_task_${person.key}`,projectId:pid,phase:spec.stage,title:spec.tasks[index],ownerId:mid(person.key),status:spec.statuses[index],priority:['pm','bim','reviewer'].includes(person.key)?'high':'medium',dueAt:at+(spec.statuses[index]==='blocked'?-1:index%4+1)*DAY,source:person.key==='finance'?'contract':'demo_fixture',...(person.key==='finance'?{businessSensitive:true}:{}),createdAt:at-3*DAY,updatedAt:at-60000,...demo}));
    store.risks.push({id:`${pid}_risk_open`,projectId:pid,title:spec.risk,description:spec.riskDetail,severity:spec.key==='culture'?'medium':'high',status:'open',ownerId:mid(spec.key==='garden'?'reviewer':'pm'),sourceMessageIds:[messageId],createdAt:at-DAY,...demo});
    ['启动款（演示）','当前阶段确认款（演示）','后续成果款（演示）'].forEach((title,index)=>store.contractMilestones.push({id:`${pid}_milestone_${index+1}`,projectId:pid,title,condition:index===0?'虚拟合同起始条件':'以负责人核验约定的成果确认依据为触发条件',amount:spec.amounts[index],status:index===0?'paid':index===1?'pending-trigger':'future',dueAt:index===0?at-10*DAY:null,paidAt:index===0?at-9*DAY:null,ownerId:mid('finance'),...demo}));
    store.scopeChanges.push({id:`${pid}_scope_pending`,projectId:pid,title:spec.openDecision,status:'potential',estimatedDays:null,ownerId:mid('pm'),sourceMessageIds:[messageId],createdAt:at-DAY,...demo});
    store.events.push({id:`${pid}_event_brief`,projectId:pid,type:'meeting',title:'演示项目周会背景已建立',detail:spec.topic,createdAt:at-90*60000,...demo});
  }
  store.demoCompany.templateHash=templateHash(store);
  return store;
}

// LocalBackend constructs this known prototype when a new directory is empty.
// Compare every field and timestamp offset: a renamed file/project, changed
// due date, added draft, grant, sync token or any extra key must fail closed.
function untouchedPrototype(store){
  const expected=seedStore();for(const item of expected.cases)item.scope='local';
  const base=store?.settings?.createdAt,expectedBase=expected.settings.createdAt;
  if(!Number.isSafeInteger(base))return false;
  const timestamps=new Set(['createdAt','updatedAt','dueAt','paidAt','confirmedAt']);
  function same(a,b,key){
    if(typeof a==='number'&&typeof b==='number'&&timestamps.has(key))return Math.abs((a-base)-(b-expectedBase))<=50;
    if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return a===b;
    if(Array.isArray(a)!==Array.isArray(b))return false;
    const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&bk.every(k=>Object.hasOwn(a,k)&&same(a[k],b[k],k));
  }
  return same(store,expected,'');
}
function summaryResult(store,initialized){return {initialized,existing:!initialized,company:copy(store.demoCompany),projectCount:store.projects.length,personCount:new Set(store.members.map(m=>m.personId)).size};}

async function ensureDemoCompany(backend,{now,fresh=false}={}){
  if(!backend?.store||typeof backend.mutate!=='function')throw fail('DEMO_INVALID_BACKEND','需要独立演示数据库。');
  const previous=backend.store,marker=previous.demoCompany;
  if(marker){
    if(marker.id!==DEMO_ID||marker.version!==VERSION)throw fail('DEMO_MARKER_MISMATCH','不能迁移未识别版本的演示数据库。');
    if(marker.initialized===true)return summaryResult(previous,false);
    if(marker.initialized!==false||marker.templateHash!==templateHash(previous))throw fail('DEMO_DATA_EXISTS','演示模板已被修改，不会覆盖其内容。');
  }else{
    if(fresh!==true)throw fail('DEMO_FRESH_REQUIRED','仅允许在明确新建的专用演示数据库初始化，请显式提供 fresh:true。');
    if(Object.keys(previous).length&&!untouchedPrototype(previous))throw fail('DEMO_DATA_EXISTS','已有项目内容不是空库或未改动的原型种子，拒绝覆盖。');
  }
  const initialHash=digest(previous),at=marker?time(marker.createdAt):time(now),store=marker?copy(previous):createDemoCompanyStore({now:at});
  const memory={store,mutate(fn){return copy(fn(this.store));}},hub=new ProjectHub({backend:memory,clock:()=>at});
  const selected=copy(store.settings),draftIds=[];
  try{
    for(const spec of PROJECTS){
      const pid=projectId(spec.key),submitter=memberId(pid,'architect');
      Object.assign(store.settings,{currentProjectId:pid,currentMemberId:submitter,currentRole:'designer'});
      const raw=`【虚拟演示 · 员工提交，未审批】${spec.topic}\n请项目负责人核对后决定是否将以下事项加入正式工作要求。`;
      const prepared=await hub.prepare({projectId:pid,text:raw,useModel:false});
      const actions=[{type:'task.create',data:{title:`待审批：${spec.tasks[3]}`,phase:spec.stage,ownerId:submitter,priority:'high',status:'todo',dueAt:at+3*DAY}},{type:'decision.create',data:{title:`本轮待审批工作边界：${spec.name}`,summary:spec.boundary,status:'confirmed',ownerId:memberId(pid,'pm')}}];
      const entry=store.projectHub.drafts.find(d=>d.id===prepared.id);
      Object.assign(entry,{summary:`演示待审批：${spec.openDecision}`,actions:hub.normalizeActions(actions,store,pid),...demo});
      draftIds.push(entry.id);
    }
  }finally{Object.assign(store.settings,selected);hub.dispose();}
  Object.assign(store.demoCompany,{initialized:true,initializedAt:at,candidateDraftIds:draftIds});delete store.demoCompany.templateHash;
  // No approval audit, notification, real file path, model key or network is
  // created. The user must actually approve a pending draft to create a receipt.
  backend.mutate(current=>{
    if(digest(current)!==initialHash)throw fail('DEMO_STORE_CHANGED','初始化期间数据库已改变，不会覆盖并发写入。');
    for(const key of Object.keys(current))delete current[key];Object.assign(current,copy(store));return true;
  });
  return summaryResult(backend.store,true);
}

module.exports={createDemoCompanyStore,ensureDemoCompany};
