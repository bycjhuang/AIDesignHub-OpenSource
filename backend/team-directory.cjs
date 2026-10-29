'use strict';

const crypto = require('node:crypto');
const ROLES = Object.freeze({designer:'项目设计师',pm:'项目经理',director:'设计总监',reviewer:'校审负责人',finance:'经营 / 财务',leader:'公司负责人'});
const ADMINS = new Set(['pm','leader']);
const DONE = new Set(['done','cancelled','canceled']);
const SECURITY_NOTICE = '本版是本机项目身份管理，可手动选择成员，不是企业账号认证。角色修改按当前实际项目成员角色检查；界面视角不授予管理权限。';
const clone = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const personKey = member => member.personId ? `person:${member.personId}` : `member:${member.id}`;
function fail(code,message,details) { const error = new Error(message); error.code=code; if(details)error.details=details; return error; }
function text(value,label,max,{optional=false}={}) { if(optional && value===undefined)return ''; if(typeof value!=='string'||value.length>max||(!optional&&!value.trim()))throw fail('INVALID_INPUT',`${label}无效或长度超限。`); return value.trim(); }
function actor(store) {
  const member=store.members.find(m=>m.projectId===store.settings.currentProjectId&&m.id===store.settings.currentMemberId&&m.active!==false);
  if(!member)throw fail('INVALID_MEMBER','请先选择当前项目的有效成员。');
  return member;
}
function localWrite(syncMode) { if(syncMode==='client')throw fail('LOCAL_WRITE_ONLY','团队客户端不能在本机修改项目目录；请由项目主机管理。'); }
function audits(store) { store.teamDirectory ||= {version:1,audits:[]}; return store.teamDirectory.audits; }
function workCount(tasks,now) {
  const open=tasks.filter(t=>!DONE.has(t.status));
  return {total:tasks.length,open:open.length,doing:open.filter(t=>t.status==='doing').length,blocked:open.filter(t=>t.status==='blocked').length,submitted:open.filter(t=>t.status==='submitted').length,done:tasks.filter(t=>t.status==='done').length,overdue:open.filter(t=>Number.isFinite(t.dueAt)&&t.dueAt>0&&t.dueAt<now).length};
}

class TeamDirectory {
  constructor({backend,clock=()=>Date.now(),syncMode}) {
    if(!backend?.store||typeof backend.mutate!=='function')throw new Error('TeamDirectory requires a local backend.');
    if(syncMode!==undefined&&typeof syncMode!=='function')throw new Error('TeamDirectory syncMode must be a function.');
    this.backend=backend;this.clock=clock;
    // The desktop injects the effective runtime mode. Historical connection
    // settings stay on disk and are not proof that a client is connected.
    this.syncMode=syncMode||(()=>this.backend.store.settings.teamSync?.mode||'off');
  }
  snapshot() {
    const store=this.backend.store,now=this.clock(),current=store.members.find(m=>m.projectId===store.settings.currentProjectId&&m.id===store.settings.currentMemberId&&m.active!==false);
    const people=new Map();
    const projects=store.projects.map(project=>{
      const members=store.members.filter(m=>m.projectId===project.id&&m.active!==false);
      const projectTasks=store.tasks.filter(t=>t.projectId===project.id);
      for(const member of members) {
        const key=personKey(member),counts=workCount(projectTasks.filter(t=>t.ownerId===member.id),now);
        if(!people.has(key))people.set(key,{key,personId:member.personId||null,name:member.name,title:member.title||'',avatar:member.avatar||String(member.name||'?')[0],skills:[],memberships:[],projectCount:0,workload:{total:0,open:0,doing:0,blocked:0,submitted:0,done:0,overdue:0}});
        const person=people.get(key);
        person.skills=[...new Set([...person.skills,...(Array.isArray(member.skills)?member.skills:[])])];
        person.memberships.push({memberId:member.id,projectId:project.id,projectName:project.name,role:member.role,roleLabel:ROLES[member.role]||'未定义',workload:counts});
        for(const field of Object.keys(person.workload))person.workload[field]+=counts[field];
      }
      return {id:project.id,name:project.name,city:project.city||'',type:project.type||'',stage:project.stage||'intake',memberCount:members.length,workload:workCount(projectTasks,now),members:members.map(m=>({id:m.id,personId:m.personId||null,name:m.name,role:m.role,title:m.title||'',avatar:m.avatar||'',active:true})),isCurrent:project.id===store.settings.currentProjectId};
    });
    const rows=[...people.values()];for(const person of rows)person.projectCount=new Set(person.memberships.map(m=>m.projectId)).size;
    rows.sort((a,b)=>b.projectCount-a.projectCount||b.workload.open-a.workload.open||a.name.localeCompare(b.name,'zh-CN'));
    return clone({currentProjectId:store.settings.currentProjectId,currentMemberId:store.settings.currentMemberId,currentProjectCanManage:!!current&&ADMINS.has(current.role),demoCompany:store.demoCompany?.initialized===true?store.demoCompany:null,roles:ROLES,projects,people:rows,audits:(store.teamDirectory?.audits||[]).slice(-100).reverse(),syncMode:this.syncMode(),securityNotice:SECURITY_NOTICE,workloadNotice:'仅统计本机已登记任务，不把任务数量换算成工时、忙闲百分比或绩效；同名但没有明确身份关联的成员不会自动合并。'});
  }
  setRole(payload={}) {
    const projectId=text(payload.projectId,'项目',180),memberId=text(payload.memberId,'成员',180),role=text(payload.role,'角色',50),expectedRole=text(payload.expectedRole,'原角色',50);
    if(!Object.hasOwn(ROLES,role))throw fail('INVALID_ROLE','请选择已定义的项目角色。');
    return this.backend.mutate(store=>{
      localWrite(this.syncMode());const current=actor(store);
      if(projectId!==store.settings.currentProjectId)throw fail('PROJECT_ACCESS_DENIED','请先切换到这个项目，不能跨项目修改角色。');
      if(!ADMINS.has(current.role))throw fail('ROLE_MANAGEMENT_DENIED','只有本项目的项目经理或公司负责人可以修改项目角色；切换显示视角不会获得权限。');
      const member=store.members.find(m=>m.projectId===projectId&&m.id===memberId&&m.active!==false);
      if(!member)throw fail('INVALID_MEMBER','这个成员不在当前项目中。');
      if(member.role!==expectedRole)throw fail('ROLE_CONFLICT','成员角色已经变化，请刷新后再确认。');
      if(member.role===role)return {member:clone(member),unchanged:true};
      if(ADMINS.has(member.role)&&!ADMINS.has(role)&&!store.members.some(m=>m.projectId===projectId&&m.id!==member.id&&m.active!==false&&ADMINS.has(m.role)))throw fail('LAST_ADMIN','请保留至少一名项目经理或公司负责人，再调整这位成员。');
      const before=member.role;member.role=role;member.updatedAt=this.clock();
      if(member.id===store.settings.currentMemberId)store.settings.currentRole=role;
      const audit={id:uid('team_audit'),type:'member.role',projectId,actorId:current.id,memberId,before,after:role,createdAt:this.clock()};audits(store).push(audit);
      store.events.unshift({id:uid('event'),projectId,type:'team',title:`项目角色更新：${member.name}`,detail:`${ROLES[before]||before} → ${ROLES[role]}`,createdAt:audit.createdAt,teamAuditId:audit.id});
      return {member:clone(member),audit,unchanged:false};
    });
  }
  createProject(payload={}) {
    const name=text(payload.name,'项目名称',120),city=text(payload.city,'城市',80,{optional:true}),type=text(payload.type,'项目类型',80,{optional:true});
    return this.backend.mutate(store=>{
      localWrite(this.syncMode());const current=actor(store),now=this.clock();
      if(!current.personId)current.personId=uid('person');
      const project={id:uid('project'),name,city,type,stage:'intake',stageRound:1,focus:'',folderPath:null,createdAt:now,updatedAt:now,createdByPersonId:current.personId};
      const member={id:uid('member'),personId:current.personId,projectId:project.id,name:current.name,title:current.title||'项目发起人',role:'leader',skills:[...(current.skills||[])],avatar:current.avatar||String(current.name||'新')[0],active:true,createdAt:now};
      store.projects.push(project);store.members.push(member);
      for(const [name,description,type] of [['项目群聊','项目组日常沟通与跨专业协调','project'],['项目助手','Design Hub 内置项目助手；确认后再写入项目记录','assistant'],['设计决策','需要留档和确认的设计方向','decision'],['业主沟通','业主意见、确认与范围变化','external'],['模型与图纸','模型版本、指标和出图协调','technical']])store.channels.push({id:type==='assistant'?`hub_assistant_${project.id}`:uid('channel'),projectId:project.id,name,description,type,createdAt:now});
      const audit={id:uid('team_audit'),type:'project.create',projectId:project.id,actorId:current.id,memberId:member.id,createdAt:now};audits(store).push(audit);
      store.events.unshift({id:uid('event'),projectId:project.id,type:'project',title:'创建项目',detail:'建立独立项目、群聊和项目成员身份；未复制其他项目资料。',createdAt:now});
      store.settings.currentProjectId=project.id;store.settings.currentMemberId=member.id;store.settings.currentRole=member.role;
      return {project,member,settings:store.settings};
    });
  }
  switchProject(payload={}) {
    const projectId=text(payload.projectId,'项目',180);if(payload.memberId!==undefined)text(payload.memberId,'成员',180);
    return this.backend.mutate(store=>{
      localWrite(this.syncMode());const current=actor(store),project=store.projects.find(p=>p.id===projectId);
      if(!project)throw fail('PROJECT_NOT_FOUND','项目不存在。');
      const members=store.members.filter(m=>m.projectId===projectId&&m.active!==false);
      let member;
      if(payload.memberId) { member=members.find(m=>m.id===payload.memberId);if(!member)throw fail('INVALID_MEMBER','请选择目标项目的有效成员。'); }
      else { const matches=members.filter(m=>personKey(m)===personKey(current));if(matches.length===1)member=matches[0];else throw fail('PROJECT_MEMBER_REQUIRED','目标项目未找到唯一对应身份，请明确选择一位本机项目成员；不会自动切换为管理员。',{members:members.map(m=>({id:m.id,name:m.name,role:m.role}))}); }
      store.settings.currentProjectId=project.id;store.settings.currentMemberId=member.id;store.settings.currentRole=member.role;
      audits(store).push({id:uid('team_audit'),type:'project.switch',projectId,actorId:current.id,memberId:member.id,explicitMember:Boolean(payload.memberId),createdAt:this.clock()});
      return {project,member,settings:store.settings};
    });
  }
}

module.exports={TeamDirectory,ROLES,SECURITY_NOTICE};
