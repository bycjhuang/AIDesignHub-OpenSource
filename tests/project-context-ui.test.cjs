'use strict';

// Unit tests run the real renderer modules against a deliberately small DOM
// double. No Electron process, user database, network or model is opened.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const uiSource=fs.readFileSync(path.join(__dirname,'..','project-context-ui.js'),'utf8');
const demoSource=fs.readFileSync(path.join(__dirname,'..','context-review-demo.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function projectData(projectId='p1',memberId='designer'){
  return {
    project:{id:projectId,name:`项目 ${projectId}`,city:'上海',type:'公共建筑',stage:'concept',stageRound:2,progress:69},
    settings:{currentMemberId:memberId,currentRole:'leader'},
    members:[{id:'designer',projectId,name:'陈设计',role:'designer',active:true},{id:'manager',projectId,name:'林经理',role:'pm',active:true}],
    tasks:[{id:'task-one',projectId,title:'复核方案面积',phase:'concept',status:'doing',ownerId:'designer'}],
    risks:[{id:'risk-one',projectId,title:'未关闭风险',description:'还没有拿到书面确认',severity:'medium',status:'open',ownerId:'manager'}],
    decisions:[{id:'decision-one',projectId,title:'确定保留中庭',summary:'本轮按已经确认的方向继续',status:'confirmed',ownerId:'manager'}],
  };
}
function projectSnapshot(projectId='p1'){
  return {
    projectId,approval:{canApprove:false,reviewerIds:['manager'],policy:'project_manager_or_leader'},
    drafts:[{id:'draft-one',projectId,text:'下一轮设计安排',status:'pending',createdBy:'designer',actions:[{type:'task.create'}],createdAt:1700000000000}],
    audits:[],
  };
}

function fixture(options={}){
  const listeners=new Map(),domListeners=new Map(),dialogs=[],calls=[],openedDrafts=[],pending=[];
  let messageSequence=0;
  const state={projectId:'p1',memberId:'designer',hold:false,dataTransform:options.dataTransform||((value)=>value),snapshotTransform:options.snapshotTransform||((value)=>value)};
  const notice={hidden:true,textContent:''};
  const demo={innerHTML:'',querySelectorAll:()=>[]};
  const root={
    innerHTML:'',
    querySelector(selector){if(selector==='[data-pc-demo]')return this.innerHTML.includes('data-pc-demo')?demo:null;if(selector==='[data-pc-notice]')return notice;return null;},
    contains(button){return Boolean(button?.inRoot);},
  };
  function emit(type,detail){for(const fn of listeners.get(type)||[])fn({type,detail});}
  function createDialog(){
    const controls=new Map(),handlers=new Map();
    const dialog={dataset:{},innerHTML:'',open:false,className:'',
      querySelector(selector){if(!controls.has(selector))controls.set(selector,{disabled:false,textContent:'',onclick:null});return controls.get(selector);},
      querySelectorAll(selector){return selector==='button'?[...controls.values()]:[];},
      addEventListener(type,fn){handlers.set(type,fn);},
      showModal(){this.open=true;},
      close(){this.open=false;handlers.get('close')?.();},
      remove(){const index=dialogs.indexOf(this);if(index>=0)dialogs.splice(index,1);},
    };
    return dialog;
  }
  const document={
    getElementById:id=>id==='projectContextWorkspace'?root:null,
    querySelectorAll:selector=>selector==='dialog[data-project-context-dialog]'?[...dialogs]:[],
    addEventListener:(type,fn)=>domListeners.set(type,fn),
    createElement(tag){assert.equal(tag,'dialog');return createDialog();},
    body:{append:dialog=>dialogs.push(dialog)},
  };
  function read(kind){
    calls.push(kind);
    const projectId=state.projectId,memberId=state.memberId;
    const value=structuredClone(kind==='bootstrap'?state.dataTransform(projectData(projectId,memberId)):state.snapshotTransform(projectSnapshot(projectId)));
    if(state.hold)return new Promise((resolve,reject)=>pending.push({kind,projectId,memberId,value,resolve,reject}));
    return Promise.resolve(value);
  }
  const bridge=new Proxy({bootstrap:()=>read('bootstrap'),projectSnapshot:()=>read('projectSnapshot')},{get(target,key){if(!(key in target))throw new Error(`Unexpected backend API: ${String(key)}`);return target[key];}});
  const window={
    bycjWorkbench:bridge,
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
    dispatchEvent:event=>emit(event.type,event.detail),
    aidesignProjectUI:{openDraft:async id=>{openedDrafts.push(id);}},
  };
  class CustomEvent{constructor(type,init={}){this.type=type;this.detail=init.detail;}}
  const context=vm.createContext({window,document,console,Date,Map,Promise,String,Number,CustomEvent,Event:CustomEvent});
  vm.runInContext(demoSource,context,{filename:'context-review-demo.js'});
  vm.runInContext(uiSource,context,{filename:'project-context-ui.js'});
  function click(dataset){const button={dataset,inRoot:true,closest:()=>button,hasAttribute:name=>name==='data-pc-refresh'&&Object.hasOwn(dataset,'pcRefresh')};domListeners.get('click')({target:button});}
  function propose(text='@DesignHub 已确认由陈设计在周五完成总图复核',input={}){return window.aidesignContextReviewDemo.propose({projectId:state.projectId,memberId:state.memberId,source:'group',sourceMessageId:`synthetic-${++messageSequence}`,text,...input});}
  function section(title){const start=root.innerHTML.indexOf(`<h2>${title}</h2>`);assert(start>=0,`Missing section ${title}`);return root.innerHTML.slice(start,root.innerHTML.indexOf('</section>',start));}
  function settleWhere(predicate=()=>true){for(const item of [...pending])if(predicate(item)){pending.splice(pending.indexOf(item),1);item.resolve(item.value);}}
  return {state,root,demo,notice,window,dialogs,calls,openedDrafts,pending,click,propose,section,emit,settleWhere,ready:tick()};
}

test('context page reads registered project facts without legacy progress percentages or writes',async()=>{
  const f=fixture();await f.ready;
  assert.match(f.root.innerHTML,/项目 p1/);assert.match(f.section('项目基础信息'),/上海/);
  assert.match(f.root.innerHTML,/当前阶段：[\s\S]*概念设计[\s\S]*人工维护/);
  assert.match(f.section('进度计划'),/复核方案面积/);assert.match(f.section('进度计划'),/进行中 1/);
  assert.doesNotMatch(f.root.innerHTML,/69%|69<|progress/);
  assert.deepEqual([...new Set(f.calls)].sort(),['bootstrap','projectSnapshot']);
});

test('formal decisions are confirmed only and every collection rejects foreign project records',async()=>{
  const f=fixture({dataTransform:d=>{d.decisions.push({projectId:d.project.id,title:'proposed-sentinel',status:'proposed'},{projectId:'foreign',title:'foreign-decision',status:'confirmed'});d.tasks.push({projectId:'foreign',title:'foreign-task'});d.risks.push({projectId:'foreign',title:'foreign-risk',status:'open'},{projectId:d.project.id,title:'closed-risk',status:'closed'});return d;},snapshotTransform:s=>{s.drafts.push({id:'foreign-draft',projectId:'foreign',text:'foreign-draft',status:'pending'});s.audits.push({projectId:'foreign',text:'foreign-audit'});return s;}});await f.ready;
  assert.match(f.section('重要决策'),/确定保留中庭/);assert.match(f.section('风险提醒'),/未关闭风险/);
  assert.doesNotMatch(f.root.innerHTML,/proposed-sentinel|foreign-|closed-risk/);
  assert.match(f.section('重要决策'),/历史登记不等同于均已通过新审批流程/);
});

test('only confirmed communication records enter meeting and communication history',async()=>{
  const f=fixture({snapshotTransform:s=>{s.drafts.push({id:'meeting',projectId:s.projectId,text:'会议纪要：已确认原文',status:'confirmed',confirmedBy:'manager',confirmedAt:1700000000000},{id:'dismissed',projectId:s.projectId,text:'dismissed-sentinel',status:'dismissed'});return s;}});await f.ready;
  assert.match(f.section('会议纪要与已确认沟通'),/会议纪要：已确认原文/);
  assert.match(f.section('会议纪要与已确认沟通'),/林经理/);
  assert.doesNotMatch(f.section('会议纪要与已确认沟通'),/下一轮设计安排|dismissed-sentinel/);
});

test('ordinary members can view candidates but a leader display perspective cannot grant approval',async()=>{
  const f=fixture();await f.ready;
  assert.match(f.section('待审批的上下文更新'),/>查看候选</);
  assert.doesNotMatch(f.section('待审批的上下文更新'),/>审批候选</);
  f.click({pcDraft:'draft-one'});await tick();assert.deepEqual(f.openedDrafts,['draft-one']);
  assert.deepEqual([...new Set(f.calls)].sort(),['bootstrap','projectSnapshot']);
});

test('an explicit backend approval capability enables the candidate approval entry',async()=>{
  const f=fixture({snapshotTransform:s=>({...s,approval:{...s.approval,canApprove:true}})});await f.ready;
  assert.match(f.section('待审批的上下文更新'),/>审批候选</);
  assert.doesNotMatch(f.section('待审批的上下文更新'),/>查看候选</);
});

test('missing approval metadata is fail-closed even if the current member has a manager role',async()=>{
  const f=fixture({dataTransform:d=>{d.members[0].role='pm';return d;},snapshotTransform:s=>{delete s.approval;return s;}});await f.ready;
  assert.match(f.section('待审批的上下文更新'),/>查看候选</);assert.doesNotMatch(f.section('待审批的上下文更新'),/>审批候选</);
});

test('bootstrap and project snapshot with different project IDs never produce mixed facts',async()=>{
  const f=fixture({snapshotTransform:s=>({...s,projectId:'foreign'})});await f.ready;
  assert.doesNotMatch(f.root.innerHTML,/项目 p1|复核方案面积|下一轮设计安排/);
});

test('project switching clears old facts immediately and ignores late old-project responses',async()=>{
  const f=fixture();await f.ready;f.propose();assert.match(f.demo.innerHTML,/总图复核/);
  f.state.hold=true;f.window.aidesignProjectContextUI.refresh();
  f.state.projectId='p2';f.emit('hub-project-changed',{projectId:'p2'});
  assert.doesNotMatch(f.root.innerHTML,/项目 p1|复核方案面积/);assert.equal(f.root.querySelector('[data-pc-demo]'),null);
  f.settleWhere(item=>item.projectId==='p1');await tick();assert.doesNotMatch(f.root.innerHTML,/项目 p1/);
  f.settleWhere();await tick();assert.match(f.root.innerHTML,/项目 p2/);assert.doesNotMatch(f.demo.innerHTML,/总图复核/);
});

test('the newest same-project refresh wins if older reads resolve afterward',async()=>{
  const f=fixture();await f.ready;f.state.hold=true;
  f.state.dataTransform=d=>({...d,project:{...d.project,name:'older-response'}});f.window.aidesignProjectContextUI.refresh();
  f.state.dataTransform=d=>({...d,project:{...d.project,name:'newest-response'}});f.window.aidesignProjectContextUI.refresh();
  const old=f.pending.splice(0,2);f.settleWhere();await tick();assert.match(f.root.innerHTML,/newest-response/);
  old.forEach(item=>item.resolve(item.value));await tick();assert.match(f.root.innerHTML,/newest-response/);assert.doesNotMatch(f.root.innerHTML,/older-response/);
});

test('a clarification-needed demo item has no approval button and forged clicks cannot open review',async()=>{
  const f=fixture();await f.ready;const item=f.propose('@DesignHub 业主可能调整总图，还不确定');
  assert.equal(item.status,'needs_clarification');assert.match(f.demo.innerHTML,/等待澄清/);assert.match(f.demo.innerHTML,/请回到群聊补充信息/);
  assert.doesNotMatch(f.demo.innerHTML,/data-pc-demo-review=/);
  f.click({pcDemoReview:item.id});assert.equal(f.dialogs.length,0);
  assert.equal(f.window.aidesignContextReviewDemo.snapshot({projectId:'p1',memberId:'designer'}).approved.length,0);
});

test('pending demo approval explicitly simulates a manager and never writes formal decisions or risks',async()=>{
  const f=fixture();await f.ready;const formalBefore=f.root.innerHTML,callsBefore=[...f.calls];
  const item=f.propose('@DesignHub 已确认保留外立面独有演示标记 DEMO_ONLY_CONTEXT');
  assert.equal(item.status,'pending');assert.match(f.demo.innerHTML,/模拟项目负责人审批/);
  f.click({pcDemoReview:item.id});assert.equal(f.dialogs.length,1);const dialog=f.dialogs[0];
  assert.match(dialog.innerHTML,/模拟项目负责人审批/);assert.match(dialog.innerHTML,/不会获得真实权限/);assert.match(dialog.innerHTML,/DEMO_ONLY_CONTEXT/);
  await dialog.querySelector('[data-pc-demo-approve]').onclick();
  assert.equal(f.dialogs.length,0);assert.match(f.demo.innerHTML,/已批准（演示）/);assert.match(f.demo.innerHTML,/DEMO_ONLY_CONTEXT/);
  assert.doesNotMatch(f.section('重要决策'),/DEMO_ONLY_CONTEXT/);assert.doesNotMatch(f.section('风险提醒'),/DEMO_ONLY_CONTEXT/);assert.doesNotMatch(f.section('待审批的上下文更新'),/DEMO_ONLY_CONTEXT/);
  assert.equal(f.root.innerHTML,formalBefore);assert.deepEqual(f.calls,callsBefore);
  assert.equal(f.window.aidesignContextReviewDemo.snapshot({projectId:'p1',memberId:'designer'}).approved.length,1);
});

test('demo rejection stays in the demo archive and cannot be approved with a stale button',async()=>{
  const f=fixture();await f.ready;const item=f.propose();f.click({pcDemoReview:item.id});
  await f.dialogs[0].querySelector('[data-pc-demo-reject]').onclick();
  assert.match(f.demo.innerHTML,/已退回（演示）/);assert.doesNotMatch(f.demo.innerHTML,/data-pc-demo-review=/);
  f.click({pcDemoReview:item.id});assert.equal(f.dialogs.length,0);
  assert.equal(f.window.aidesignContextReviewDemo.snapshot({projectId:'p1',memberId:'designer'}).approved.length,0);
});

test('demo candidate records remain isolated by both project and current member',async()=>{
  const f=fixture();await f.ready;
  f.propose('@DesignHub 当前身份可见记录 LOCAL_DEMO');f.propose('@DesignHub 另一成员独有记录 OTHER_MEMBER',{memberId:'manager'});f.propose('@DesignHub 另一项目独有记录 OTHER_PROJECT',{projectId:'p2'});
  assert.match(f.demo.innerHTML,/LOCAL_DEMO/);assert.doesNotMatch(f.demo.innerHTML,/OTHER_MEMBER|OTHER_PROJECT/);
  f.state.memberId='manager';await f.window.aidesignProjectContextUI.refresh();
  assert.match(f.demo.innerHTML,/OTHER_MEMBER/);assert.doesNotMatch(f.demo.innerHTML,/LOCAL_DEMO|OTHER_PROJECT/);
});

test('changing project or actual member closes open simulated approval dialogs',async()=>{
  const f=fixture();await f.ready;const item=f.propose();f.click({pcDemoReview:item.id});const first=f.dialogs[0];
  f.state.memberId='manager';await f.window.aidesignProjectContextUI.refresh();assert.equal(f.dialogs.length,0);assert.equal(first.open,false);
  const secondItem=f.propose();f.click({pcDemoReview:secondItem.id});const second=f.dialogs[0];
  f.state.hold=true;f.state.projectId='p2';f.emit('hub-project-changed',{projectId:'p2'});assert.equal(f.dialogs.length,0);assert.equal(second.open,false);
  await second.querySelector('[data-pc-demo-approve]').onclick();
  assert.equal(f.window.aidesignContextReviewDemo.snapshot({projectId:'p1',memberId:'manager'}).approved.length,0);
  f.settleWhere();await tick();
});

test('older audit records absent from the recent draft list open as read-only evidence',async()=>{
  const f=fixture({snapshotTransform:s=>{s.audits.push({id:'audit-old',projectId:s.projectId,draftId:'draft-old',actorId:'manager',text:'历史会议回执原文',changes:[{type:'task.create'}],createdAt:1700000000000});return s;}});await f.ready;
  f.click({pcDraft:'draft-old'});assert.equal(f.dialogs.length,1);assert.match(f.dialogs[0].innerHTML,/历史会议回执原文/);assert.match(f.dialogs[0].innerHTML,/这里只读查看/);
  assert.doesNotMatch(f.dialogs[0].innerHTML,/data-pc-demo-approve|projectConfirm/);assert.deepEqual(f.openedDrafts,[]);
});

test('untrusted source text is escaped in formal cards and demo approval dialogs',async()=>{
  const raw='<img src=x onerror="boom()">';
  const f=fixture({dataTransform:d=>{d.project.name=raw;d.decisions[0].summary=raw;return d;}});await f.ready;
  assert.doesNotMatch(f.root.innerHTML,/<img/);assert.match(f.root.innerHTML,/&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/);
  const item=f.propose(`@DesignHub 已确认演示 ${raw}`);f.click({pcDemoReview:item.id});assert.doesNotMatch(f.demo.innerHTML,/<img/);assert.doesNotMatch(f.dialogs[0].innerHTML,/<img/);
});

test('empty project sections guide recording work without inventing completion or decisions',async()=>{
  const f=fixture({dataTransform:d=>({...d,tasks:[],risks:[],decisions:[]}),snapshotTransform:s=>({...s,drafts:[],audits:[]})});await f.ready;
  assert.match(f.section('进度计划'),/这不代表项目尚未开展/);assert.match(f.section('风险提醒'),/不代表项目已完成风险排查/);
  assert.match(f.section('重要决策'),/尚无已确认的决定/);assert.match(f.section('会议纪要与已确认沟通'),/尚无已确认的会议纪要/);
  assert.match(f.demo.innerHTML,/@DesignHub/);assert.doesNotMatch(f.root.innerHTML,/69%|100%/);
});

test('navigation and Hub update events refresh read-only facts while demo events avoid bridge calls',async()=>{
  const f=fixture();await f.ready;const count=f.calls.length;
  f.emit('hub-view-changed',{view:'cases'});assert.equal(f.calls.length,count);
  f.emit('hub-view-changed',{view:'files'});await tick();assert.equal(f.calls.length,count+2);
  f.emit('project-hub-changed');await tick();assert.equal(f.calls.length,count+4);
  f.emit('hub-context-demo-changed',{projectId:'p1',memberId:'designer'});assert.equal(f.calls.length,count+4);
});
