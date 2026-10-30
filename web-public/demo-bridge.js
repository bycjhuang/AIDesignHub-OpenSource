/* Browser-only adapter for the unmodified desktop renderer. No IPC, local
   filesystem, model provider, or production project endpoint is available. */
(() => {
  'use strict';
  const clone=value=>structuredClone(value);
  const fixture=window.ADH_PUBLIC_FIXTURE;
  let store=clone(fixture.store);
  const now=()=>Date.now();
  const uid=prefix=>prefix+'_'+crypto.randomUUID();
  const project=()=>store.projects.find(p=>p.id===store.settings.currentProjectId);
  const scoped=key=>clone((store[key]||[]).filter(x=>x.projectId===project().id));
  const say=()=>{throw new Error('此操作需要桌面版。网页仅演示界面与样例流程，请点击顶部“下载桌面版”。');};
  const bootstrap=()=>({project:clone(project()),settings:clone(store.settings),demoCompany:clone(store.demoCompany),members:scoped('members'),channels:scoped('channels'),messages:scoped('messages'),decisions:scoped('decisions'),tasks:scoped('tasks'),risks:scoped('risks'),cases:scoped('cases'),contractMilestones:scoped('contractMilestones'),scopeChanges:scoped('scopeChanges'),knowledgeDocs:scoped('knowledgeDocs'),events:scoped('events'),connectorSettings:[],dataDir:'网页演示（虚构案例）'});
  function directory(){
    const result=clone(fixture.directory);
    result.currentProjectId=project().id;result.currentMemberId=store.settings.currentMemberId;
    result.projects.forEach(p=>p.isCurrent=p.id===project().id);
    return result;
  }
  const model={configured:false,enabled:false,provider:'网页演示',model:'演示模式',modelId:'演示模式',displayName:'演示模式',textModels:[],models:[],profiles:[],hasKey:false,warning:'下载桌面版后配置自己的模型；网页不会调用付费模型。'};
  const skill={id:'demo-case-research',name:'建筑案例研究',title:'建筑案例研究',description:'将案例资料整理为可追溯的设计参考。',content:'先明确研究目的，再整理空间、材料、结构和来源。\n\n网页中只展示技能内容。',scope:'local',enabled:true};
  const library={id:'demo-brief',name:'项目研究资料',description:'公开的虚构项目资料',sourceCount:3,chunkCount:8,status:'ready',createdAt:now(),updatedAt:now()};
  const sources=()=>[['brief','设计任务书（演示）.txt',project().focus],['meeting','设计周会纪要（演示）.txt',scoped('decisions').map(x=>x.summary).join('\n')],['boundary','工作边界（演示）.txt',scoped('risks').map(x=>x.description).join('\n')]].map(([id,name,text])=>({id:project().id+'_'+id,name,text,status:'indexed',state:'indexed',relativePath:'项目资料/'+name,chunkCount:3,createdAt:now(),size:text.length*3}));
  const callbacks=new Map();
  function syncAgentTheme(theme=document.documentElement.dataset.theme){
    document.querySelector('.website-agent-frame')?.contentWindow?.postMessage(
      {type:'adh-public-theme',theme:['light','dark','minimal'].includes(theme)?theme:'light'},location.origin);
  }
  const methods={
    bootstrap, runtimeInfo:()=>({electronVersion:'网页演示',platform:'browser',isPackaged:false}),
    detectInstalledApps:()=>[],getTheme:()=>localStorage.getItem('adh-theme')||'light',setTheme:theme=>{syncAgentTheme(theme);return theme;},
    teamSyncStatus:()=>({mode:'off',enabled:false,connected:false}),teamSyncNow:bootstrap,
    teamDirectory:directory,
    teamSwitchProject:({projectId})=>{const item=store.projects.find(p=>p.id===projectId);if(!item)throw new Error('示例项目不存在。');store.settings.currentProjectId=item.id;const member=store.members.find(m=>m.projectId===item.id&&m.role==='designer');store.settings.currentMemberId=member.id;store.settings.currentRole=member.role;return {projectId:item.id,project:item,...directory()};},
    setCurrentMember:id=>{const member=store.members.find(m=>m.id===id&&m.projectId===project().id);if(member){store.settings.currentMemberId=id;store.settings.currentRole=member.role;}return bootstrap();},
    setRole:role=>{store.settings.currentRole=role;return bootstrap();},
    addTask:payload=>{const task={...payload,id:uid('task'),projectId:project().id,status:'todo',createdAt:now()};store.tasks.push(task);return clone(task);},
    updateTask:(id,patch)=>{const task=store.tasks.find(t=>t.id===id&&t.projectId===project().id);if(!task)throw new Error('示例任务不存在。');Object.assign(task,patch,{updatedAt:now()});return clone(task);},
    updateDecision:(id,patch)=>{const row=store.decisions.find(x=>x.id===id);if(row)Object.assign(row,patch);return clone(row||{});},
    updateRisk:(id,patch)=>{const row=store.risks.find(x=>x.id===id);if(row)Object.assign(row,patch);return clone(row||{});},
    addCase:payload=>{const row={...payload,id:uid('case'),projectId:project().id,scope:'local',createdAt:now()};store.cases.push(row);return clone(row);},
    removeCase:id=>{store.cases=store.cases.filter(x=>x.id!==id);return {ok:true};},
    caseArticle:id=>{const item=store.cases.find(x=>x.id===id&&x.projectId===project().id);if(!item)throw new Error('当前项目没有此示例案例。');return {available:true,status:'ready',url:new URL('/demo-case.html?'+new URLSearchParams({name:item.name}),location.origin).href,title:item.name,imageCount:0};},
    casePreview:()=>({available:false,status:'empty',images:[]}),
    openExternalUrl:url=>{const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol))return say();window.open(parsed.href,'_blank','noopener,noreferrer');return {ok:true};},
    projectSnapshot:()=>({projectId:project().id,project:clone(project()),members:scoped('members'),tasks:scoped('tasks'),decisions:scoped('decisions'),risks:scoped('risks'),drafts:[],audits:[],context:{project:clone(project()),tasks:scoped('tasks'),decisions:scoped('decisions'),risks:scoped('risks')},permissions:{canConfirm:false,canPrepare:true},model:clone(model)}),
    projectModelStatus:()=>clone(model), getKnowledgeModelStatus:()=>({...clone(model),configured:true,enabled:true}), mediaModelSettings:()=>({text:[],image:[],video:[],profiles:[],models:[]}),
    projectResearchList:()=>({items:[],profiles:[]}),
    imageCollectionList:()=>({items:[]}),
    skillSnapshot:()=>({skills:[clone(skill)],local:{skills:[clone(skill)],mcpServers:[],instructions:[]},team:{skills:[],mcpServers:[],instructions:[]},sync:{},rtk:null}),
    agentSnapshot:()=>({agents:[],jobs:[],runs:[],grants:[],connections:[],gateway:{enabled:false},settings:{}}),
    agentConfigList:()=>[],agentDiscoverRuntimes:()=>[],agentAutoPair:()=>({paired:[],discovered:[],errors:[]}),
    listKnowledgeLibraries:()=>({libraries:[clone(library)]}),
    listKnowledgeSources:()=>({sources:sources()}),getKnowledgeHistory:()=>({history:[]}),
    searchKnowledgeLibrary:(_pid,_lid,query)=>({query,sources:sources(),results:sources().map(s=>({...s,sourceId:s.id,excerpt:s.text,content:s.text,score:1})),coverage:{text:'当前项目的公开演示资料，共 3 份'}}),
    answerKnowledgeLibrary:(_pid,_lid,input)=>({answer:'【预置演示回答】\n\n'+project().name+'\n\n'+project().focus+'\n\n'+scoped('risks').map(x=>x.description).join('\n')+'\n\n当前展示回答与来源的组织方式，没有调用模型。',sources:sources(),coverage:{text:'根据当前项目的 3 份公开演示资料回答'},requestId:input.requestId}),
    aiDesignOpen:()=>({url:new URL('/home?hubProjectId='+encodeURIComponent(project().id),location.origin).href,projectId:project().id}),
    dshGetState:()=>({status:'running',running:true,ready:true,phase:'ready',webUrl:'/agent/',projectId:project().id}),
    dshAttachView:()=>{for(const cb of callbacks.get('dshOnViewLoaded')||[])setTimeout(()=>cb(),20);return {ok:true};},
    dshSetViewHidden:()=>{},dshDetachView:()=>{},dshSetViewInsetLeft:()=>{},dshSetViewInsetTop:()=>{},dshSetViewInsetRight:()=>{},dshSetViewBounds:()=>{},
    dshGetModels:()=>({models:[]}),dshStart:()=>({status:'running',running:true,ready:true,phase:'ready'}),
    getReleaseInfo:()=>({version:'0.3.2',license:'AGPL-3.0-only',platform:'网页演示',repository:'https://github.com/bycjhuang/AIDesignHub-OpenSource'}),
  };
  window.bycjWorkbench=new Proxy({platform:'browser'}, {get(target,name){
    if(name in target)return target[name];
    if(typeof name!=='string'||name==='then')return undefined;
    if(/^on[A-Z]|On[A-Z]/.test(name))return cb=>{const set=callbacks.get(name)||new Set();set.add(cb);callbacks.set(name,set);return ()=>set.delete(cb);};
    return async(...args)=>{const fn=methods[name];if(!fn){console.info('[public-demo] desktop action:',name);return say();}return fn(...args);};
  }});
  for(const button of document.querySelectorAll('.nav-item[data-view]')){const label=button.querySelector('span:nth-child(2)')?.textContent?.trim();if(label){button.setAttribute('aria-label',label);button.title=label;}}
  const protectKeys=()=>{for(const input of document.querySelectorAll('input[type="password"], input[id*="apikey" i], input[id*="modelkey" i]'))if(!input.closest('.website-dialog')){input.disabled=true;input.placeholder='网页演示不接收模型密钥，请在桌面版配置';input.title=input.placeholder;}};
  new MutationObserver(protectKeys).observe(document.body,{childList:true,subtree:true});protectKeys();
  window.addEventListener('hub-view-changed',event=>{
    requestAnimationFrame(()=>{const drawer=document.getElementById('aiDrawer');drawer?.classList.remove('is-open');drawer?.setAttribute('aria-hidden','true');});
    if(event.detail?.view!=='adh-agent')return;
    const container=document.getElementById('dshViewContainer');
    if(!container.querySelector('iframe')){
      const frame=document.createElement('iframe');frame.className='website-agent-frame';frame.title='Agent Hub 网页演示';frame.src='/agent/?'+new URLSearchParams({projectId:project().id,projectName:project().name});frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads');frame.addEventListener('load',()=>syncAgentTheme());container.append(frame);
    }
  });
  window.addEventListener('hub-project-changed',()=>document.querySelector('.website-agent-frame')?.remove());
  window.addEventListener('load',()=>{document.title='AI Design Hub · 在线工作台体验';window.aidesignApp?.setView('dashboard');},{once:true});
})();
