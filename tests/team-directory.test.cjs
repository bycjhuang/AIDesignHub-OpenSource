'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {TeamDirectory}=require('../backend/team-directory.cjs');
const PID='project_jiangwan';
function fixture(){const backend=new LocalBackend({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-team-'))});return {backend,team:new TeamDirectory({backend,clock:()=>5000})};}
function other(backend){backend.mutate(store=>{store.projects.push({id:'other',name:'另一个项目',stage:'research'});store.members.push({id:'other_designer',projectId:'other',name:'陈设计',role:'designer',active:true});return true;});}
function manager(backend){backend.setCurrentMember('member_pm');}

test('portfolio uses registered projects and tasks, never legacy load percentages',()=>{
 const {backend,team}=fixture();backend.mutate(store=>{store.tasks.push({id:'late',projectId:PID,ownerId:'member_designer',title:'逾期',status:'blocked',dueAt:1000},{id:'finished',projectId:PID,ownerId:'member_designer',status:'done',dueAt:1000},{id:'cancelled',projectId:PID,ownerId:'member_designer',status:'cancelled',dueAt:1000});return true;});
 const s=team.snapshot(),p=s.people.find(x=>x.key==='member:member_designer');assert.equal(s.projects.length,1);assert.equal(p.projectCount,1);assert.equal(p.workload.total,5);assert.equal(p.workload.open,3);assert.equal(p.workload.doing,1);assert.equal(p.workload.blocked,1);assert.equal(p.workload.overdue,1);assert.equal(p.workload.done,1);assert(!JSON.stringify(s).includes('"load"'));assert(!JSON.stringify(s).includes('82%'));assert.match(s.workloadNotice,/不.*百分比/);
});
test('identically named members remain separate until an explicit personId links memberships',()=>{
 const {backend,team}=fixture();other(backend);let s=team.snapshot();assert.equal(s.people.filter(p=>p.name==='陈设计').length,2);assert(s.people.filter(p=>p.name==='陈设计').every(p=>p.projectCount===1));
 backend.mutate(store=>{for(const m of store.members.filter(m=>m.id==='member_designer'||m.id==='other_designer'))m.personId='known_person';store.tasks.push({id:'other-task',projectId:'other',ownerId:'other_designer',status:'doing',dueAt:1000});return true;});
 s=team.snapshot();const person=s.people.find(p=>p.personId==='known_person');assert.equal(s.people.filter(p=>p.name==='陈设计').length,1);assert.equal(person.projectCount,2);assert.equal(person.workload.open,3);assert.equal(person.workload.overdue,1);assert.equal(person.memberships[1].role,'designer');
});
test('project task count includes unassigned tasks without inventing an employee assignment',()=>{
 const {backend,team}=fixture();backend.mutate(store=>{store.tasks.push({id:'unassigned',projectId:PID,title:'未分配',status:'todo'});return true;});const s=team.snapshot();assert.equal(s.projects[0].workload.open,6);assert.equal(s.people.reduce((n,p)=>n+p.workload.open,0),5);
});
test('changing display role does not grant administrator capability',()=>{
 const {backend,team}=fixture();backend.setRole('leader');assert.equal(team.snapshot().currentProjectCanManage,false);assert.throws(()=>team.setRole({projectId:PID,memberId:'member_designer',role:'leader',expectedRole:'designer'}),e=>e.code==='ROLE_MANAGEMENT_DENIED');assert.equal(backend.store.members[0].role,'designer');assert.equal(backend.store.teamDirectory,undefined);
});
test('authorized role update only changes one project membership and adds an audit trail',()=>{
 const {backend,team}=fixture();other(backend);manager(backend);const result=team.setRole({projectId:PID,memberId:'member_designer',role:'director',expectedRole:'designer'});assert.equal(result.member.role,'director');assert.equal(result.member.title,'建筑设计师');assert.equal(backend.store.members.find(m=>m.id==='other_designer').role,'designer');assert.equal(team.snapshot().audits[0].actorId,'member_pm');assert.equal(team.snapshot().audits[0].before,'designer');assert.equal(backend.store.events[0].type,'team');assert.equal(team.setRole({projectId:PID,memberId:'member_designer',role:'director',expectedRole:'director'}).unchanged,true);assert.equal(team.snapshot().audits.length,1);
});
test('role updates reject stale, foreign, unknown and last-administrator changes atomically',()=>{
 const {backend,team}=fixture();other(backend);manager(backend);const before=JSON.stringify(backend.store);
 for(const [payload,code] of [[{projectId:PID,memberId:'member_designer',role:'director',expectedRole:'pm'},'ROLE_CONFLICT'],[{projectId:'other',memberId:'other_designer',role:'pm',expectedRole:'designer'},'PROJECT_ACCESS_DENIED'],[{projectId:PID,memberId:'other_designer',role:'pm',expectedRole:'designer'},'INVALID_MEMBER'],[{projectId:PID,memberId:'member_designer',role:'admin',expectedRole:'designer'},'INVALID_ROLE'],[{projectId:PID,memberId:'member_pm',role:'designer',expectedRole:'pm'},'LAST_ADMIN']])assert.throws(()=>team.setRole(payload),e=>e.code===code);
 assert.equal(JSON.stringify(backend.store),before);
});
test('create project isolates records and preserves a person across distinct project roles',()=>{
 const {backend,team}=fixture(),before=backend.bootstrap(),created=team.createProject({name:' 新建项目 ',city:'成都',type:'商业'});assert.equal(created.project.name,'新建项目');assert.equal(created.project.stage,'intake');assert.equal(created.project.progress,undefined);assert.equal(created.member.role,'leader');assert.notEqual(created.member.id,'member_designer');assert.equal(backend.store.members.find(m=>m.id==='member_designer').role,'designer');assert.equal(backend.store.settings.currentProjectId,created.project.id);assert.equal(backend.bootstrap().tasks.length,0);assert.equal(backend.bootstrap().messages.length,0);assert.equal(backend.bootstrap().channels.length,5);assert.equal(backend.bootstrap().channels.filter(c=>c.type==='assistant').length,1);assert.deepEqual(backend.bootstrap(PID).tasks,before.tasks);assert.equal(team.snapshot().people.find(p=>p.personId===created.member.personId).projectCount,2);
 team.switchProject({projectId:PID});assert.equal(backend.store.settings.currentMemberId,'member_designer');assert.equal(backend.store.settings.currentRole,'designer');assert.equal(team.snapshot().currentProjectCanManage,false);
});
test('project switching requires an explicit identity when there is no exact person association',()=>{
 const {backend,team}=fixture();other(backend);backend.mutate(store=>{store.members.find(m=>m.id==='other_designer').role='leader';return true;});const settings=structuredClone(backend.store.settings);assert.throws(()=>team.switchProject({projectId:'other'}),e=>e.code==='PROJECT_MEMBER_REQUIRED');assert.deepEqual(backend.store.settings,settings);assert.throws(()=>team.switchProject({projectId:'other',memberId:'member_pm'}),e=>e.code==='INVALID_MEMBER');assert.deepEqual(backend.store.settings,settings);
 const switched=team.switchProject({projectId:'other',memberId:'other_designer'});assert.equal(switched.member.id,'other_designer');assert.equal(switched.settings.currentRole,'leader');assert.equal(team.snapshot().audits[0].explicitMember,true);assert.equal(backend.bootstrap().messages.length,0);
});
test('same-person automatic switching never carries the role from the source project',()=>{
 const {backend,team}=fixture();other(backend);manager(backend);backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').personId='person_pm';store.members.find(m=>m.id==='other_designer').personId='person_pm';return true;});team.switchProject({projectId:'other'});assert.equal(backend.store.settings.currentRole,'designer');assert.equal(team.snapshot().currentProjectCanManage,false);assert.equal(team.snapshot().audits[0].explicitMember,false);
});
test('ambiguous same-person memberships require an explicit selection',()=>{
 const {backend,team}=fixture();other(backend);backend.mutate(store=>{store.members[0].personId='person_a';store.members.find(m=>m.id==='other_designer').personId='person_a';store.members.push({id:'other_second',projectId:'other',personId:'person_a',name:'另一身份',role:'pm',active:true});return true;});assert.throws(()=>team.switchProject({projectId:'other'}),e=>e.code==='PROJECT_MEMBER_REQUIRED');assert.equal(backend.store.settings.currentProjectId,PID);
});
test('inactive identities cannot administer or be selected and do not inflate active staffing counts',()=>{
 const {backend,team}=fixture();other(backend);backend.mutate(store=>{store.members.find(m=>m.id==='other_designer').active=false;return true;});assert.equal(team.snapshot().projects.find(p=>p.id==='other').memberCount,0);assert.throws(()=>team.switchProject({projectId:'other',memberId:'other_designer'}),e=>e.code==='INVALID_MEMBER');manager(backend);backend.mutate(store=>{store.members.find(m=>m.id==='member_pm').active=false;return true;});assert.equal(team.snapshot().currentProjectCanManage,false);assert.throws(()=>team.createProject({name:'no'}),e=>e.code==='INVALID_MEMBER');assert.throws(()=>team.setRole({projectId:PID,memberId:'member_designer',role:'pm',expectedRole:'designer'}),e=>e.code==='INVALID_MEMBER');
});
test('team clients cannot mutate or switch the local project registry',()=>{
 const {backend,team}=fixture();other(backend);manager(backend);backend.setTeamSyncConfig({mode:'client'});for(const action of [()=>team.createProject({name:'new'}),()=>team.switchProject({projectId:'other',memberId:'other_designer'}),()=>team.setRole({projectId:PID,memberId:'member_designer',role:'pm',expectedRole:'designer'})])assert.throws(action,e=>e.code==='LOCAL_WRITE_ONLY');
});
test('invalid input and failed persistence leave project registry and roles unchanged',()=>{
 const {backend,team}=fixture();manager(backend);for(const payload of [{name:''},{name:'x'.repeat(121)},{name:'ok',city:12}])assert.throws(()=>team.createProject(payload),e=>e.code==='INVALID_INPUT');const before=JSON.stringify(backend.store),persist=backend.persist;backend.persist=()=>{throw new Error('synthetic disk failure');};assert.throws(()=>team.createProject({name:'new'}),/disk failure/);assert.equal(JSON.stringify(backend.store),before);assert.throws(()=>team.setRole({projectId:PID,memberId:'member_designer',role:'pm',expectedRole:'designer'}),/disk failure/);assert.equal(JSON.stringify(backend.store),before);backend.persist=persist;
});
