(() => {
  'use strict';
  const api=window.bycjWorkbench;
  const mount=()=>document.getElementById('projectContextWorkspace');
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stages={intake:'项目接收',research:'项目解读与研究',massing:'强排与测算',concept:'概念设计',develop:'方案深化',concept100:'概念100',approval:'报规与报件',archive:'归档与复盘'};
  const taskStates={todo:'待开始',doing:'进行中',blocked:'受阻',submitted:'已提交',changes_requested:'需修改',done:'本人标记完成'};
  const demoStates={needs_clarification:'等待澄清',pending:'演示待审批',approved:'已批准（演示）',rejected:'已退回（演示）'};
  const state={projectId:null,memberId:null,generation:0,data:null,snapshot:null,loading:false,error:'',focusDemoId:null};
  const list=value=>Array.isArray(value)?value:[];
  const date=value=>{if(!value)return '未记录';const d=new Date(value);return Number.isNaN(d.getTime())?'未记录':d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
  const short=value=>String(value||'').length>160?`${String(value).slice(0,160)}…`:String(value||'');
  const inProject=items=>list(items).filter(item=>item.projectId===state.projectId);
  const name=id=>list(state.data?.members).find(member=>member.id===id&&member.projectId===state.projectId)?.name||'未登记成员';
  const empty=text=>`<p class="pc-empty">${esc(text)}</p>`;
  function section(title,count,source,body,classes=''){return `<section class="pc-card ${classes}"><header class="pc-section-heading"><h2>${esc(title)}</h2>${count!==null?`<span class="pc-count">${esc(count)}</span>`:''}</header><p class="pc-source">${esc(source)}</p>${body}</section>`;}
  function collection(items,renderItem,limit=5){const html=items.slice(0,limit).map(renderItem).join('');return `${html}${items.length>limit?`<details class="pc-more"><summary>展开其余 ${items.length-limit} 条</summary>${items.slice(limit).map(renderItem).join('')}</details>`:''}`;}
  function closeDialogs(){document.querySelectorAll('dialog[data-project-context-dialog]').forEach(dialog=>dialog.close());}
  function notice(text){const target=mount()?.querySelector('[data-pc-notice]');if(target){target.hidden=!text;target.textContent=text;}}
  function getDemo(){
    if(!state.projectId||!state.memberId)return {items:[],approved:[]};
    const snapshot=window.aidesignContextReviewDemo?.snapshot({projectId:state.projectId,memberId:state.memberId});
    const relevant=items=>list(items).filter(item=>item.projectId===state.projectId&&item.memberId===state.memberId);
    return {items:relevant(snapshot?.items),approved:relevant(snapshot?.approved)};
  }
  function demoCard(item){return `<article class="pc-entry pc-demo-entry" data-pc-demo-item="${esc(item.id)}"><header><strong>${esc(short(item.text)||'群聊内容')}</strong><span class="pc-badge pc-badge-demo">${esc(demoStates[item.status]||'演示候选')}</span></header><p>${esc(item.clarification||item.question||'等待模拟项目负责人核对原文和整理内容。')}</p><footer><small>${date(item.createdAt)} · 群聊演示</small>${item.status==='pending'?`<button type="button" class="text-button" data-pc-demo-review="${esc(item.id)}">模拟项目负责人审批</button>`:item.status==='needs_clarification'?'<small>请回到群聊补充信息</small>':''}</footer></article>`;}
  function renderDemo(){
    const root=mount()?.querySelector('[data-pc-demo]');if(!root||!state.data)return;
    const demo=getDemo(),pending=demo.items.filter(item=>['pending','needs_clarification'].includes(item.status));
    const approved=[...new Map([...demo.approved,...demo.items.filter(item=>item.status==='approved')].map(item=>[item.id,item])).values()];
    const rejected=demo.items.filter(item=>item.status==='rejected');
    root.innerHTML=`<header class="pc-section-heading"><div><span class="pc-kicker">独立演示区</span><h2>体验一次上下文审批</h2></div><span class="pc-badge pc-badge-demo">Demo · 不写入项目</span></header><div class="pc-demo-columns"><section><h3>演示待审批 <span>${pending.length}</span></h3>${pending.length?collection(pending,demoCard,3):empty('在项目群聊输入 @DesignHub，提出一条需要留在项目中的信息，即可体验澄清和负责人审批。')}</section><section><h3>已批准（演示） <span>${approved.length}</span></h3>${approved.length?collection(approved,item=>`<article class="pc-entry" data-pc-demo-item="${esc(item.id)}"><strong>${esc(short(item.text))}</strong>${item.clarification?`<p>${esc(item.clarification)}</p>`:''}<small>${date(item.reviewedAt)} · ${esc(item.reviewerLabel||'模拟项目负责人')}</small></article>`,3):empty('演示候选经过模拟审批后显示在这里；不会混入正式项目上下文。')}</section></div>${rejected.length?`<details class="pc-more"><summary>已退回（演示） · ${rejected.length}</summary>${rejected.map(item=>`<article class="pc-entry" data-pc-demo-item="${esc(item.id)}"><strong>${esc(short(item.text))}</strong><small>${date(item.reviewedAt)} · ${esc(item.reviewerLabel||'模拟项目负责人')}</small></article>`).join('')}</details>`:''}`;
    if(state.focusDemoId){const target=[...root.querySelectorAll('[data-pc-demo-item]')].find(node=>node.dataset.pcDemoItem===state.focusDemoId);if(target){target.closest('details')?.setAttribute('open','');target.classList.add('is-context-focus');target.scrollIntoView({block:'nearest'});state.focusDemoId=null;}}
  }
  function render(){
    const root=mount();if(!root)return;
    if(!state.data||!state.snapshot){root.innerHTML=`<div class="pc-card pc-loading" role="status"><h2>${state.error?'项目上下文暂未加载':'正在读取项目上下文…'}</h2><p>${esc(state.error||'只读取当前项目已登记的资料与记录。')}</p>${state.error?'<button type="button" class="secondary-button" data-pc-refresh>重新加载</button>':''}</div>`;return;}
    const d=state.data,s=state.snapshot,project=d.project;
    const tasks=inProject(d.tasks),risks=inProject(d.risks).filter(item=>item.status==='open'),decisions=inProject(d.decisions).filter(item=>item.status==='confirmed');
    const drafts=inProject(s.drafts),pending=drafts.filter(item=>item.status==='pending'),preparing=drafts.filter(item=>item.status==='preparing');
    const confirmed=drafts.filter(item=>item.status==='confirmed').sort((a,b)=>(b.confirmedAt||b.createdAt)-(a.confirmedAt||a.createdAt));
    const audits=inProject(s.audits).sort((a,b)=>b.createdAt-a.createdAt);
    const ownerMembers=list(d.members).filter(member=>member.projectId===state.projectId&&member.active!==false&&['pm','leader'].includes(member.role));
    const busyTasks=tasks.filter(task=>task.status==='doing').length,blockedTasks=tasks.filter(task=>task.status==='blocked').length;
    const openTasks=tasks.filter(task=>task.status!=='done').length;
    root.innerHTML=`<p data-pc-notice class="pc-notice" role="status" hidden></p><div class="pc-overview"><div><span class="pc-kicker">项目记忆 · 持续维护</span><h2>${esc(project.name)}</h2><p>当前阶段：<strong>${esc(stages[project.stage]||project.stage||'未登记')}</strong>${project.stageRound?` · 第 ${esc(project.stageRound)} 轮`:''} · 人工维护</p></div><button type="button" class="secondary-button" data-pc-refresh ${state.loading?'disabled':''}>刷新资料</button></div><div class="pc-process" aria-label="项目上下文更新流程"><span>沟通与资料</span><i>→</i><span>Design Hub 整理 / 澄清</span><i>→</i><span>项目负责人审批</span><i>→</i><strong>进入项目上下文</strong></div><div class="pc-summary"><div><strong>${pending.length}</strong><span>真实待审批候选</span></div><div><strong>${tasks.length}</strong><span>登记任务 · 非完成率</span></div><div><strong>${decisions.length}</strong><span>已确认的重要决策</span></div><div><strong>${risks.length}</strong><span>未关闭的风险</span></div></div><div class="pc-grid">${section('项目基础信息',null,'来源：当前项目档案；空缺信息不会由 AI 猜测。',`<dl class="pc-facts"><div><dt>项目名称</dt><dd>${esc(project.name||'未登记')}</dd></div><div><dt>项目编号</dt><dd>${esc(project.code||'未登记')}</dd></div><div><dt>所在城市</dt><dd>${esc(project.city||'未登记')}</dd></div><div><dt>项目类型</dt><dd>${esc(project.type||'未登记')}</dd></div><div class="pc-fact-wide"><dt>项目负责人 / 可审批身份</dt><dd>${ownerMembers.length?ownerMembers.map(member=>esc(member.name)).join('、'):'尚未登记项目经理或公司负责人'}</dd></div><div class="pc-fact-wide"><dt>本轮重点与限制</dt><dd>${esc(project.focus||'尚未登记本轮重点')}</dd></div></dl>`)}${section('待审批的上下文更新',pending.length,'候选与正式记录分开保存。只有项目经理 / 公司负责人确认后，才可写入项目上下文。',`${preparing.length?`<p class="pc-pending-note">${preparing.length} 条沟通正在整理，尚未形成可审批候选。</p>`:''}${pending.length?collection(pending,item=>`<article class="pc-entry"><strong>${esc(item.summary||short(item.text)||'待整理沟通')}</strong><p>${list(item.actions).length} 项拟更新 · ${esc(item.modelStatus==='succeeded'?'AI 整理建议':'人工记录 / 待补充事项')}</p><footer><small>${date(item.createdAt)}</small><button type="button" class="text-button" data-pc-draft="${esc(item.id)}">${s.approval?.canApprove?'审批候选':'查看候选'}</button></footer></article>`,3):empty('暂无待审批更新。与项目助手沟通后，需要记录的内容会先形成候选，不直接变成正式决定。')}`,'pc-approval-card')}${section('进度计划',tasks.length,'来源：当前登记的任务、责任人与截止时间；不以文件数量或修改时间推算完成率。',`<div class="pc-task-totals"><span>待推进 ${openTasks}</span><span>进行中 ${busyTasks}</span><span>受阻 ${blockedTasks}</span></div>${tasks.length?collection(tasks,task=>`<article class="pc-entry"><header><strong>${esc(task.title||'未命名任务')}</strong><span class="pc-badge ${task.status==='blocked'?'pc-badge-alert':''}">${esc(taskStates[task.status]||task.status||'状态未登记')}</span></header><p>${esc(stages[task.phase]||task.phase||'阶段未登记')} · ${esc(name(task.ownerId))}</p><small>截止：${task.dueAt?date(task.dueAt):'未设置'}</small></article>`,4):empty('尚未登记计划任务。这不代表项目尚未开展，请通过项目助手记录工作安排。')}`)}${section('会议纪要与已确认沟通',confirmed.length,'来源：经过人工确认的沟通原文；保留原文和处理记录，不把普通聊天自动当作纪要。',confirmed.length?collection(confirmed,item=>`<article class="pc-entry"><header><strong>${esc(item.summary||short(item.text)||'已确认沟通')}</strong><span class="pc-badge">${/会议|纪要|会谈/.test(item.text||'')?'会议相关记录':'已确认沟通'}</span></header><p>${esc(short(item.text))}</p><footer><small>${date(item.confirmedAt||item.createdAt)} · ${esc(name(item.confirmedBy||item.createdBy))}</small><button type="button" class="text-button" data-pc-draft="${esc(item.id)}">查看原文</button></footer></article>`,3):empty('尚无已确认的会议纪要或沟通记录。提供纪要后，先由助手整理，再交负责人审批。'))}${section('重要决策',decisions.length,'仅展示状态为「已确认」的决定；历史登记不等同于均已通过新审批流程。',decisions.length?collection(decisions,item=>`<article class="pc-entry"><strong>${esc(item.title||'未命名决定')}</strong><p>${esc(item.summary||'未填写具体内容')}</p><small>${esc(name(item.ownerId))} · ${item.confirmedAt?date(item.confirmedAt):'确认时间未记录'}${item.managementSource?' · 有项目管理回执':' · 历史登记'}</small></article>`,4):empty('尚无已确认的决定。待确认要求和讨论意见不会显示在这里。'))}${section('风险提醒',risks.length,'来源：人工登记或已确认写入的风险；提示是否应继续工作仍由项目负责人判断。',risks.length?collection(risks,item=>`<article class="pc-entry"><header><strong>${esc(item.title||'未命名风险')}</strong><span class="pc-badge pc-badge-alert">${esc({low:'低',medium:'中',high:'高'}[item.severity]||'未定')}风险</span></header><p>${esc(item.description||'尚未填写风险说明')}</p><small>责任人：${esc(name(item.ownerId))}</small></article>`,4):empty('暂无已登记的开放风险，不代表项目已完成风险排查。'))}</div>${section('上下文更新记录',audits.length,'来源：Hub 确认回执。记录谁在何时确认了哪些更新，保留历史依据。',audits.length?`<div class="pc-audits">${collection(audits,audit=>`<article class="pc-audit"><span class="pc-audit-dot" aria-hidden="true"></span><div><strong>${esc(name(audit.actorId))} 确认 ${list(audit.changes).length} 项更新</strong><p>${esc(short(audit.text)||'已记录项目管理更新')}</p><small>${date(audit.createdAt)}</small>${audit.draftId?`<button type="button" class="text-button" data-pc-draft="${esc(audit.draftId)}">查看依据</button>`:''}</div></article>`,5)}</div>`:empty('暂无确认回执。新审批完成后，这里会保留可追溯的更新记录。'),'pc-update-card')}<section class="pc-card pc-demo-section" data-pc-demo></section><p class="pc-footer-note">上方数据来自当前项目档案与已登记事项；既有原型样例不等于真实项目验收。资料文件只是证据来源，连接目录不会自动成为项目结论。</p>`;
    renderDemo();
  }
  async function refresh(){
    if(!mount()||!api?.bootstrap||!api?.projectSnapshot)return;
    const generation=++state.generation,expected=state.projectId;state.loading=true;state.error='';
    if(!state.data)render();
    try{
      const [data,snapshot]=await Promise.all([api.bootstrap(),api.projectSnapshot()]);
      if(generation!==state.generation||!data?.project?.id||snapshot?.projectId!==data.project.id||(expected&&expected!==data.project.id))return;
      const memberId=data.settings?.currentMemberId;
      if(state.memberId&&memberId!==state.memberId)closeDialogs();
      state.projectId=data.project.id;state.memberId=memberId;state.data=data;state.snapshot=snapshot;state.loading=false;render();
    }catch(error){if(generation!==state.generation)return;state.error=String(error.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');state.loading=false;if(state.data)notice(`刷新未完成：${state.error}`);else render();}
  }
  function reviewDemo(id){
    const item=getDemo().items.find(candidate=>candidate.id===id);if(!item||item.status!=='pending')return;
    const projectId=state.projectId,memberId=state.memberId,generation=state.generation;
    const dialog=document.createElement('dialog');dialog.className='hub-dialog pc-review-dialog';dialog.dataset.projectContextDialog='demo';
    dialog.innerHTML=`<span class="pc-badge pc-badge-demo">仅模拟，不改变正式数据</span><h2>模拟项目负责人审批</h2><p class="pc-source">现在仅演示负责人核对与审批。此操作不会获得真实权限，也不会写入项目数据库。</p><dl><dt>群聊原文</dt><dd>${esc(item.text)}</dd>${item.clarification?`<dt>补充澄清</dt><dd>${esc(item.clarification)}</dd>`:''}<dt>信息来源</dt><dd>${esc(typeof item.source==='string'?item.source:'项目群聊 Demo')}${item.sourceMessageId?` · 消息 ${esc(item.sourceMessageId)}`:''}</dd><dt>提交时间</dt><dd>${date(item.createdAt)}</dd></dl><p class="pc-review-notice" role="status"></p><div class="hub-actions"><button type="button" class="primary-button" data-pc-demo-approve>模拟批准</button><button type="button" class="secondary-button" data-pc-demo-reject>模拟退回</button><button type="button" class="text-button" data-pc-close>取消</button></div>`;
    dialog.querySelector('[data-pc-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
    const review=async decision=>{
      if(generation!==state.generation||projectId!==state.projectId||memberId!==state.memberId){dialog.close();return;}
      const current=getDemo().items.find(candidate=>candidate.id===id);if(current?.status!=='pending'){dialog.close();return;}
      dialog.querySelectorAll('button').forEach(button=>button.disabled=true);
      try{await window.aidesignContextReviewDemo.review({projectId,memberId,id,decision});dialog.close();if(projectId===state.projectId&&memberId===state.memberId)renderDemo();}
      catch(error){dialog.querySelector('.pc-review-notice').textContent=String(error.message||error);dialog.querySelectorAll('button').forEach(button=>button.disabled=false);}
    };
    dialog.querySelector('[data-pc-demo-approve]').onclick=()=>review('approve');dialog.querySelector('[data-pc-demo-reject]').onclick=()=>review('reject');document.body.append(dialog);dialog.showModal();
  }
  function viewArchivedReceipt(draftId){
    const audit=inProject(state.snapshot?.audits).find(item=>item.draftId===draftId);if(!audit)return;
    const dialog=document.createElement('dialog');dialog.className='hub-dialog pc-review-dialog';dialog.dataset.projectContextDialog='receipt';
    dialog.innerHTML=`<h2>历史更新依据</h2><p class="pc-source">此确认回执对应较早的沟通，原文保存在回执中。这里只读查看，不重新审批或覆盖历史。</p><dl><dt>确认信息</dt><dd>${esc(name(audit.actorId))} · ${date(audit.createdAt)} · ${list(audit.changes).length} 项更新</dd><dt>沟通原文</dt><dd>${esc(audit.text||'未记录原文')}</dd></dl><button type="button" class="secondary-button" data-pc-close>关闭</button>`;
    dialog.querySelector('[data-pc-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||!mount()?.contains(button))return;
    if(button.hasAttribute('data-pc-refresh')){refresh();return;}
    if(button.dataset.pcDraft){if(!list(state.snapshot?.drafts).some(draft=>draft.id===button.dataset.pcDraft&&draft.projectId===state.projectId)){viewArchivedReceipt(button.dataset.pcDraft);return;}Promise.resolve(window.aidesignProjectUI?.openDraft(button.dataset.pcDraft)).catch(error=>notice(error.message));return;}
    if(button.dataset.pcDemoReview)reviewDemo(button.dataset.pcDemoReview);
  });
  window.addEventListener('hub-view-changed',event=>{if(event.detail?.view==='files')refresh();});
  window.addEventListener('hub-project-changed',event=>{state.generation++;state.projectId=event.detail?.projectId||null;state.memberId=null;state.data=null;state.snapshot=null;state.error='';state.focusDemoId=null;state.loading=true;closeDialogs();render();refresh();});
  window.addEventListener('project-hub-changed',()=>refresh());
  window.addEventListener('hub-context-demo-changed',()=>renderDemo());
  window.addEventListener('hub-context-demo-focus',event=>{if(event.detail?.projectId!==state.projectId||event.detail?.memberId!==state.memberId)return;state.focusDemoId=event.detail.id;renderDemo();});
  window.aidesignProjectContextUI={refresh};
  refresh();
})();
