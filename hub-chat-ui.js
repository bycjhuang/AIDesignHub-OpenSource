(() => {
  'use strict';
  const api=window.bycjWorkbench,$=id=>document.getElementById(id);
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={dashboard:'项目驾驶舱',phases:'设计流程',files:'项目上下文',chat:'项目沟通',knowledge:'知识中心',cases:'案例与素材',skills:'技能中心',agents:'外部 Agent 协作',schedule:'进度与风险',contracts:'合同与回款',team:'团队总看板'};
  const state={projectId:null,memberId:null,channelId:null,mode:'group',demoReady:false,view:'dashboard',snapshot:null,epoch:0,request:0,open:false,busy:new Set(),drafts:new Map(),retry:new Map(),consents:new Set(),consentDialog:null};
  window.aidesignChatDemo.mount($('hubChatDemo'));
  // Group chat is deliberately renderer-only. The existing assistant remains
  // separate; no demo message can reach hubChatSend, projectPrepare or sync.
  function renderMode(){const group=state.mode==='group';$('hubChatDemo').hidden=!group||!state.demoReady;$('hubChatLive').hidden=group;$('hubChatDemoLoading').hidden=!group||state.demoReady;
    window.aidesignChatDemo.setActive?.(group&&state.demoReady&&state.open);
    for(const [id,active] of [['hubChatGroupTab',group],['hubChatAssistantTab',!group]]){$(id).classList.toggle('is-active',active);$(id).setAttribute('aria-pressed',String(active));}
    $('hubChatDock').classList.toggle('is-group-demo',group);
  }
  const threadKey=()=>`${state.projectId}/${state.memberId}/${state.channelId}`;
  function notice(text,error=false){$('hubChatNotice').hidden=!text;$('hubChatNotice').textContent=text;$('hubChatNotice').classList.toggle('is-error',error);if(state.mode==='group'&&!state.demoReady){$('hubChatDemoLoadingText').textContent=error?'项目资料暂未加载成功，请重试。':'正在准备项目群聊演示…';$('hubChatDemoRetry').hidden=!error;}}
  function saveInput(){if(state.mode==='assistant'&&state.projectId&&state.channelId)state.drafts.set(threadKey(),$('hubChatInput').value);}
  function restoreInput(){$('hubChatInput').value=state.drafts.get(threadKey())||'';}
  function controls(){const s=state.snapshot,busy=state.busy.has(threadKey());
    $('hubChatSend').disabled=!s||busy;
    $('hubChatSend').textContent=busy?'处理中…':'发送 ↑';
    $('hubChatModelSettings').title=s?.model.configured?`已配置 ${s.model.model||'内置模型'}`:'尚未配置内置模型';
    $('hubChatSessionSettings').disabled=!s;
  }
  function render(){const s=state.snapshot;if(!s)return;
    $('hubChatProject').textContent=s.context.project.project?.name||s.context.project.name||s.context.scopeLabel.split(' · ')[0];
    const list=$('hubChatMessages'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<80;
    list.innerHTML=s.messages.length?s.messages.map(m=>{const bot=m.senderId==='aidesignhub_assistant',member=s.members.find(x=>x.id===m.senderId);return `<article class="hub-chat-message ${bot?'is-bot':''}" data-hub-message="${esc(m.id)}"><header><strong>${esc(bot?'✦ Design Hub':member?.name||m.senderName||'项目成员')}</strong><small>${new Date(m.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></header><div class="hub-chat-body">${esc(m.body)}</div>${m.attachments?.length?`<small>${m.attachments.length} 个历史附件 · 本次未发送给模型</small>`:''}${m.hubChat?.view?`<footer>${esc(labels[m.hubChat.view]||m.hubChat.view)}${m.hubChat.status==='processing'?' · 正在回复':''}</footer>`:''}${m.hubChat?.draftId?`<button class="secondary-button" data-hub-chat-draft="${esc(m.hubChat.draftId)}">查看建议 · 核对后写入</button>`:''}</article>`;}).join(''):`<div class="hub-chat-empty"><span>✦</span><h3>${s.channelId===s.assistantChannelId?'在这里留下项目的上下文':'开始这个项目的沟通'}</h3><p>${s.channelId===s.assistantChannelId?'说说业主的新意见，或询问当前页面的资料。整理结果由你核对，不替你做决定。':'与成员沟通；需要助手时输入 @DesignHub。消息按项目保存。'}</p></div>`;
    for(const button of list.querySelectorAll('[data-hub-chat-draft]'))button.textContent='查看上下文候选';
    const empty=list.querySelector('.hub-chat-empty p');if(empty)empty.textContent='说说新的项目情况，或询问当前页面资料。需要补充时会继续问你；整理出的候选内容交项目负责人审批。';
    if(nearBottom)list.scrollTop=list.scrollHeight;controls();
  }
  async function refresh(){const request=++state.request,epoch=state.epoch,expected=state.projectId;
    const data=await api.bootstrap();if(request!==state.request||epoch!==state.epoch)return;
    if(expected&&expected!==data.project.id)return;
    state.projectId=data.project.id;state.memberId=data.settings.currentMemberId;
    $('hubChatProject').textContent=data.project.name;
    if(state.mode==='group'){
      state.snapshot=null;state.channelId=null;
      window.aidesignChatDemo.setProject({projectId:data.project.id,name:data.project.name,members:data.members.filter(m=>m.active!==false&&m.projectId===data.project.id),currentMemberId:data.settings.currentMemberId});
      window.aidesignChatDemo.setView(labels[state.view]||state.view);state.demoReady=true;renderMode();return data;
    }
    const s=await api.hubChatSnapshot({projectId:state.projectId,view:state.view,query:$('hubChatInput').value.slice(0,2000)});
    if(request!==state.request||epoch!==state.epoch||s.projectId!==state.projectId)return;
    const initial=!state.channelId;state.snapshot=s;state.channelId=s.channelId;if(initial)restoreInput();renderMode();render();return s;
  }
  async function open(mode='group',prefill){saveInput();state.request++;state.mode=mode==='group'?'group':'assistant';state.demoReady=false;state.snapshot=null;state.channelId=null;state.open=true;$('hubChatDock').hidden=false;document.querySelector('.app-shell').classList.add('has-hub-chat');renderMode();controls();notice('');window.dispatchEvent(new CustomEvent('hub-chat-dock',{detail:{open:true}}));
    if(state.mode==='group'){$('hubDraftDialog').close();document.querySelectorAll('dialog[data-hub-chat-dialog]').forEach(d=>d.close());}
    const s=await refresh();if(!s)return;
    if(state.mode==='assistant'){if(prefill&&typeof prefill==='object')prefill=prefill.prefill;if(typeof prefill==='string'){$('hubChatInput').value=prefill;saveInput();controls();}}return s;
  }
  function close(){saveInput();state.open=false;state.consentDialog?.close();window.aidesignChatDemo.setActive?.(false);$('hubChatDock').hidden=true;document.querySelector('.app-shell').classList.remove('has-hub-chat');window.dispatchEvent(new CustomEvent('hub-chat-dock',{detail:{open:false}}));}
  async function setView(view){const next=view==='workflow'?'phases':view;if(next!==state.view)state.consentDialog?.close();state.view=next;notice('');return refresh();}
  const consentKey=s=>JSON.stringify([s.projectId,state.memberId,s.context.page.view,s.model.provider,s.model.baseUrl,s.model.model]);
  function authorize(s,{inspect=false}={}){
    const key=consentKey(s),epoch=state.epoch,view=state.view,memberId=state.memberId;
    if(!inspect&&state.consents.has(key))return Promise.resolve(true);
    state.consentDialog?.close();
    return new Promise(resolve=>{
      const enabled=state.consents.has(key);
      const d=dialog(inspect?'会话设置':'启用当前项目助手',`<p>模型：<strong>${esc(s.model.model||'未配置')}</strong><br>服务地址：${esc(s.model.baseUrl||'未配置')}<br>资料范围：当前项目 · ${esc(labels[view]||view)}</p><p>发送时将提供你的消息、当前项目摘要、当前页面资料及本会话相关历史；不自动上传本地文件全文。新的整理建议需项目负责人审批，才会改变正式上下文。</p><details class="hub-chat-consent-details"><summary>查看资料明细</summary><pre>${esc(JSON.stringify(s.context,null,2))}</pre></details><p class="hub-muted">授权只在这个窗口的当前项目、身份、模型与页面范围内有效。更换项目或模型会重新确认。</p><div class="hub-actions">${s.model.configured&&s.context.page.access!=='restricted'?`<button type="button" class="primary-button" data-consent-allow>${inspect?'启用当前会话':'同意并发送'}</button>`:''}${enabled?'<button type="button" class="secondary-button" data-consent-revoke>停用本会话 AI</button>':''}<button type="button" class="secondary-button" data-consent-cancel>取消</button></div>`);
      state.consentDialog=d;let accepted=false;
      d.querySelector('[data-consent-allow]')?.addEventListener('click',()=>{if(epoch===state.epoch&&state.mode==='assistant'&&state.open&&view===state.view&&memberId===state.memberId&&state.snapshot&&consentKey(state.snapshot)===key){state.consents.add(key);accepted=true;}d.close();});
      d.querySelector('[data-consent-revoke]')?.addEventListener('click',()=>{state.consents.delete(key);d.close();});
      d.querySelector('[data-consent-cancel]').onclick=()=>d.close();
      d.addEventListener('close',()=>{if(state.consentDialog===d)state.consentDialog=null;resolve(accepted);},{once:true});
    });
  }
  async function send(event){event?.preventDefault();if(state.mode!=='assistant')return;const text=$('hubChatInput').value.trim(),s=state.snapshot;if(!text||!s||state.busy.has(threadKey()))return;
    if(!s.model.configured){notice('请先在模型设置中配置服务；输入内容已保留，尚未发送。');$('projectModelSettings').click();return;}
    if(s.syncMode==='client'||s.context.page.access==='restricted'){notice('当前项目身份不能在此范围调用助手。消息尚未发送。',true);return;}
    const key=threadKey(),epoch=state.epoch,projectId=s.projectId,channelId=s.channelId,view=state.view,scopeKey=consentKey(s),useModel=true;
    state.busy.add(key);controls();notice('');
    try{
      if(!await authorize(s))return;
      if(epoch!==state.epoch||key!==threadKey()||state.mode!=='assistant'||!state.open||view!==state.view||!state.snapshot||consentKey(state.snapshot)!==scopeKey||!state.consents.has(scopeKey))return;
      const fingerprint=JSON.stringify({text,view,useModel,scopeKey}),previous=state.retry.get(key),requestId=previous?.fingerprint===fingerprint?previous.requestId:crypto.randomUUID();state.retry.set(key,{fingerprint,requestId});
      notice('Design Hub 正在处理…');const result=await api.hubChatSend({projectId,channelId,text,view,useModel,requestId});state.retry.delete(key);
      if(epoch!==state.epoch||key!==threadKey()||result.projectId!==state.projectId)return;
      if($('hubChatInput').value.trim()===text){$('hubChatInput').value='';state.drafts.delete(key);}notice(result.status==='failed'?'消息已保留，内置 AI 未能回复。请检查模型设置。':result.draft?'已生成上下文候选，待项目负责人审批。':'');await refresh();window.dispatchEvent(new CustomEvent('project-hub-changed'));
    }catch(e){if(epoch===state.epoch&&key===threadKey())notice(e.message,true);}finally{state.busy.delete(key);if(epoch===state.epoch&&key===threadKey())controls();}
  }
  function dialog(title,html){const d=document.createElement('dialog');d.className='hub-dialog hub-chat-settings';d.dataset.hubChatDialog='true';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="icon-button" aria-label="关闭">×</button></header>${html}`;document.body.append(d);d.querySelector('header button').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.showModal();return d;}
  $('hubChatForm').addEventListener('submit',send);$('hubChatClose').onclick=close;
  $('hubChatContextLink').onclick=()=>document.querySelector('.nav-item[data-view="files"]')?.click();
  $('hubChatSessionSettings').onclick=()=>{if(state.snapshot)authorize(state.snapshot,{inspect:true});};
  $('hubChatGroupTab').onclick=()=>open('group').catch(e=>notice(e.message,true));$('hubChatAssistantTab').onclick=()=>open('assistant').catch(e=>notice(e.message,true));
  $('hubChatDemoRetry').onclick=()=>open('group').catch(e=>notice(e.message,true));
  $('hubChatExpand').onclick=()=>{const expanded=$('hubChatDock').classList.toggle('is-expanded');$('hubChatExpand').setAttribute('aria-pressed',String(expanded));$('hubChatExpand').setAttribute('aria-label',expanded?'还原聊天窗口':'展开聊天窗口');$('hubChatExpand').title=expanded?'还原聊天窗口':'展开聊天窗口';};
  let previewTimer;$('hubChatInput').addEventListener('input',()=>{saveInput();controls();clearTimeout(previewTimer);previewTimer=setTimeout(()=>refresh().catch(()=>{}),350);});
  $('hubChatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}});
  $('hubChatModelSettings').onclick=()=>$('projectModelSettings').click();$('hubDraftClose').onclick=()=>$('hubDraftDialog').close();
  document.addEventListener('click',e=>{const b=e.target.closest('[data-hub-chat-draft]');if(!b)return;b.closest('dialog[data-hub-chat-dialog]')?.close();window.aidesignProjectUI.openDraft(b.dataset.hubChatDraft).catch(e=>notice(e.message,true));});
  window.addEventListener('hub-view-changed',e=>setView(e.detail.view).catch(e=>notice(e.message,true)));
  window.addEventListener('hub-project-changed',e=>{saveInput();state.consents.clear();state.epoch++;state.request++;state.projectId=e.detail?.projectId||null;state.memberId=null;state.channelId=null;state.snapshot=null;state.demoReady=false;renderMode();restoreInput();$('hubChatMessages').replaceChildren();$('hubChatProject').textContent='正在切换项目…';$('hubDraftDialog').close();document.querySelectorAll('dialog[data-hub-chat-dialog]').forEach(d=>d.close());notice('');controls();refresh().catch(e=>notice(e.message,true));});
  window.addEventListener('hub-model-config-changed',()=>{state.consents.clear();state.consentDialog?.close();});
  for(const event of ['project-hub-changed','case-hub-changed','hub-local-data-changed','hub-model-config-changed'])window.addEventListener(event,()=>refresh().catch(()=>{}));
  api.hubChatOnChanged?.(projectId=>{if(projectId===state.projectId)refresh().catch(()=>{});});
  window.aidesignHubChatUI={open,close,refresh,setView};
  open('group').catch(e=>notice(e.message,true));
})();
