(() => {
  'use strict';
  const api=window.bycjWorkbench;
  const $=id=>document.getElementById(id);
  if(!$('agentChatForm'))return;
  const state={snapshot:null,context:null,conversationId:null,initialized:false,sending:false,refreshing:null,pending:null,consents:new Set(),renderKey:null,generation:0,targetProjectId:null};
  const active=new Set(['queued','running','waiting_agent','cancel_requested']);
  const statuses={queued:'已派单',running:'执行中',waiting_agent:'等待外部 Agent',cancel_requested:'正在请求取消',cancelled:'已取消',awaiting_review:'待人工验收',succeeded:'已验收',rejected:'已退回',failed:'执行失败',interrupted:'已中断'};
  const node=(tag,cls,value)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(value!==undefined)el.textContent=String(value);return el;};
  const date=value=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const auto=c=>['cli','acp','openclaw-http'].includes(c?.mode);
  const configured=c=>auto(c)&&Boolean(c.mode==='openclaw-http'?c.endpoint:c.command);
  const connection=()=>state.snapshot?.connections.find(c=>c.id===$('agentChatConnection').value);
  const conversation=()=>state.snapshot?.conversations?.find(c=>c.id===state.conversationId);
  const jobs=()=>state.snapshot?.jobs.filter(j=>state.conversationId&&j.conversationId===state.conversationId).sort((a,b)=>a.createdAt-b.createdAt)||[];
  const running=()=>state.snapshot?.runs.some(r=>state.conversationId&&r.conversationId===state.conversationId&&active.has(r.status));
  function notice(message='',error=false){$('agentChatNotice').textContent=message;$('agentChatNotice').hidden=!message;$('agentChatNotice').classList.toggle('is-error',error);}
  function fill(select,items,label,preferred){const current=preferred??select.value;select.replaceChildren(...items.map(item=>{const option=node('option','',label(item));option.value=item.id;return option;}));if(items.some(item=>item.id===current))select.value=current;}
  function connectionLabel(c){return `${c.label}${configured(c)?'':auto(c)?' · 待配置':c.mode==='inbound'?' · 仅 MCP 接入':' · 人工交接'}`;}
  function updateComposer(){
    const c=connection();const busy=Boolean(running());
    $('agentChatSend').disabled=state.sending||busy||!configured(c)||!$('agentChatInput').value.trim();
    $('agentChatSend').textContent=state.sending?'发送中…':busy?'执行中…':'发送 ↑';
    $('agentNewChat').disabled=state.sending;$('agentChatConnection').disabled=state.sending||busy;
    $('agentChatInput').disabled=state.sending;
    $('agentChatSkill').disabled=state.sending;$('agentChatProjectTools').disabled=state.sending;$('agentChatContext').disabled=state.sending;
    $('agentChatOptionsSummary').textContent=`${state.snapshot?.skills.find(s=>s.id===$('agentChatSkill').value)?.name||'通用协作'} · ${$('agentChatProjectTools').checked?'允许只读检索项目':'未开放项目资料'} · ${$('agentChatContext').checked?'携带项目摘要':'不携带项目摘要'}`;
    const verified=c?.runtimeVerification||c?.modelValidation?.verified;
    $('agentChatConnectionNote').textContent=!c?'请在设置中添加执行器。':!auto(c)?'此客户端目前仅支持外部接入或人工交接，不能从这里直接发送。可切换其他 Agent，或打开配置。':!configured(c)?'此 Agent 尚未配置启动入口，请点击“配置”完成一次设置。':busy?'Agent 正在执行，你可以先写下追问。取消和执行详情在上方消息中。':`${c.label} · ${verified?'有执行 / 测试记录':'尚未验证模型，首次发送可能需要登录'}。对话会发送至其模型服务；仅携带本对话最近 12 条历史（最多 48 KiB）。`;
  }
  function button(label,fn,cls='text-button'){const b=node('button',cls,label);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(error){notice(error.message,true);}finally{if(b.isConnected)b.disabled=false;}});return b;}
  function openRun(run){window.dispatchEvent(new CustomEvent('agent-focus-run',{detail:{runId:run.id}}));}
  function renderMessages(forceScroll=false){
    const list=jobs();const entries=list.map(job=>({job,runs:state.snapshot.runs.filter(r=>r.jobId===job.id).sort((a,b)=>a.createdAt-b.createdAt)}));
    const key=JSON.stringify(entries.map(({job,runs})=>[job.id,runs.map(r=>[r.id,r.status,r.output,r.error,r.contextStale]),state.snapshot.events?.filter(e=>runs.some(r=>r.id===e.runId)).slice(-3)]));
    if(key===state.renderKey&&!forceScroll)return;
    state.renderKey=key;const scroll=$('agentChatScroll');const nearEnd=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<110;
    $('agentChatWelcome').hidden=list.length>0;
    const fragment=document.createDocumentFragment();
    for(const {job,runs} of entries){
      const user=node('article','agent-chat-message is-user');user.dataset.chatJob=job.id;
      const body=node('div','agent-chat-message-body');body.append(node('p','agent-chat-message-text',job.chatMessage||job.instruction));user.append(body);fragment.append(user);
      for(const run of runs){
        const message=node('article','agent-chat-message');message.dataset.chatRun=run.id;
        const c=state.snapshot.connections.find(item=>item.id===run.connectionId);
        message.append(node('span','agent-chat-message-avatar','✦'));const content=node('div','agent-chat-message-body');const head=node('header');
        const badge=node('span','agent-status',statuses[run.status]||run.status);badge.dataset.status=run.status;
        head.append(node('strong','',c?.label||run.provider),badge,node('time','',date(run.createdAt)));content.append(head);
        if(run.contextStale)content.append(node('p','hub-inline-warning','项目记录在派单后有变化。本次执行仍使用原快照；请检查是否需要补充说明、停止或重新派单。'));
        if(run.input?.projectContext){const details=node('details','hub-details');details.append(node('summary','','查看本次派单的项目上下文'),node('pre','hub-context',JSON.stringify(run.input.projectContext,null,2)));content.append(details);}
        if(run.output!=null)content.append(node('pre','agent-chat-message-text',typeof run.output==='string'?run.output:JSON.stringify(run.output,null,2)));
        else if(run.error)content.append(node('p','agent-chat-message-text',`这次执行未完成：${run.error}`));
        else content.append(node('p','agent-chat-message-text',active.has(run.status)?'任务已交给执行器，正在等待结果。':'这次运行没有返回成果。'));
        if(active.has(run.status)){const latest=state.snapshot.events?.filter(e=>e.runId===run.id).slice(-1)[0];if(latest)content.append(node('p','agent-chat-message-note',latest.message));}
        if(run.input?.chatHistoryInfo?.truncatedMessages||run.input?.chatHistoryInfo?.omittedMessages)content.append(node('p','agent-chat-message-note','本次仅携带最近一段对话；较早或过长的内容已省略，可在执行详情核对。'));
        const actions=node('div','agent-chat-message-tools');
        if(active.has(run.status)){const cancel=button(run.status==='cancel_requested'?'取消待确认':'停止本次执行',async()=>{if(!window.confirm('请求停止本次执行？已经发生的外部操作不会自动撤销。'))return;await api.agentCancelRun(run.id);await refresh();},'text-button agent-danger');cancel.disabled=run.status==='cancel_requested';actions.append(cancel);}
        if(run.status==='awaiting_review'){
          content.append(node('p','agent-chat-message-note','结果尚未验收。你可以继续追问；追问不会自动批准之前的成果。'));
          actions.append(button('验收通过',async()=>{if(!window.confirm('确认已核对事实、来源与成果，并通过本次验收？'))return;await api.agentReviewRun(run.id,true);await refresh();},'secondary-button'),button('退回',async()=>{if(!window.confirm('退回本次成果？原始结果将保留。'))return;await api.agentReviewRun(run.id,false);await refresh();}));
        }
        actions.append(button('执行详情',()=>openRun(run)));content.append(actions);message.append(content);fragment.append(message);
      }
      if(!runs.length){const waiting=node('p','agent-chat-message-note','需求已保存，尚未启动。请在历史记录中查看这项任务。');fragment.append(waiting);}
    }
    $('agentChatMessages').replaceChildren(fragment);
    if(forceScroll||nearEnd)scroll.scrollTop=scroll.scrollHeight;
  }
  function renderHistory(){
    const items=[...(state.snapshot?.conversations||[])].sort((a,b)=>b.updatedAt-a.updatedAt);
    $('agentConversationList').replaceChildren(...items.map(item=>{const b=button('',()=>selectConversation(item.id),'agent-conversation-item');b.dataset.conversationId=item.id;b.setAttribute('aria-current',String(item.id===state.conversationId));b.append(node('strong','',item.title),node('small','',`${date(item.updatedAt)} · ${item.messageCount} 条消息${item.activeRunId?' · 执行中':''}`));return b;}));
    if(!items.length)$('agentConversationList').append(node('p','agent-empty','还没有对话。从输入框发起第一项工作。'));
  }
  function confirmDiscard(){return !$('agentChatInput').value.trim()||window.confirm('当前还有未发送的草稿。切换对话将清除这段草稿，继续吗？');}
  function selectConversation(id){if(state.sending||!confirmDiscard())return;state.conversationId=id;state.pending=null;state.renderKey=null;$('agentChatInput').value='';$('agentChatProjectTools').checked=false;$('agentChatContext').checked=false;$('agentHistoryDialog').close();notice();render(true);$('agentChatInput').focus();}
  function render(forceScroll=false){
    if(!state.snapshot)return;
    const preferred=conversation()?.lastConnectionId;
    fill($('agentChatConnection'),state.snapshot.connections,connectionLabel,!state.initialized||forceScroll?(preferred||state.snapshot.connections.find(configured)?.id):undefined);
    fill($('agentChatSkill'),state.snapshot.skills,s=>s.name,!state.initialized||forceScroll?(conversation()?.skillId||'agent-chat'):undefined);
    state.initialized=true;
    $('agentChatSubtitle').textContent=conversation()?.title||'说出你的设计需求，让选定的 Agent 来执行。';
    renderMessages(forceScroll);renderHistory();updateComposer();
  }
  function resetProject(projectId){
    state.generation++;state.targetProjectId=projectId||null;state.refreshing=null;state.snapshot=null;state.context=null;state.sending=false;state.conversationId=null;state.pending=null;state.consents.clear();state.initialized=false;state.renderKey=null;
    $('agentChatInput').value='';$('agentChatProjectTools').checked=false;$('agentChatContext').checked=false;$('agentChatConnection').replaceChildren();$('agentChatSkill').replaceChildren();$('agentChatMessages').replaceChildren();$('agentConversationList').replaceChildren();$('agentChatWelcome').hidden=false;$('agentChatSubtitle').textContent='正在切换项目，载入本项目 Agent 对话…';$('agentHistoryDialog').close();notice();updateComposer();
  }
  function accept(snapshot,context){
    if(!context?.project?.id)return;
    if(state.targetProjectId&&context.project.id!==state.targetProjectId)return;
    if(snapshot.projectId&&snapshot.projectId!==context.project.id)return;
    const projectChanged=state.context&&state.context.project.id!==context.project.id;
    if(projectChanged)resetProject(context.project.id);
    state.targetProjectId=context.project.id;
    state.snapshot={...snapshot,conversations:snapshot.conversations||[]};state.context=context;
    if(!state.initialized&&!state.conversationId)state.conversationId=[...state.snapshot.conversations].sort((a,b)=>b.updatedAt-a.updatedAt)[0]?.id||null;
    render();
  }
  async function refresh(){
    if(state.refreshing)return state.refreshing;
    const generation=state.generation;
    const work=(async()=>{for(let attempt=0;attempt<2;attempt++){const [snapshot,context]=await Promise.all([api.agentSnapshot(),api.bootstrap()]);if(generation!==state.generation)return;if(snapshot.projectId&&snapshot.projectId!==context.project.id)continue;if(state.targetProjectId&&context.project.id!==state.targetProjectId)continue;accept(snapshot,context);return;}throw new Error('项目已切换，正在等待匹配的项目状态。');})().catch(error=>{if(generation===state.generation)throw error;}).finally(()=>{if(state.refreshing===work)state.refreshing=null;});state.refreshing=work;return work;
  }
  window.addEventListener('hub-project-changed',event=>{resetProject(event.detail?.projectId);refresh().catch(error=>notice(error.message,true));});
  window.addEventListener('hub-skill-selected',async event=>{const generation=state.generation;try{await refresh();if(generation!==state.generation)return;const id=event.detail?.skillId;if(state.snapshot?.skills.some(s=>s.id===id)){$('agentChatSkill').value=id;$('agentChatOptions').open=true;updateComposer();$('agentChatInput').focus();}}catch(error){if(generation===state.generation)notice(error.message,true);}});
  window.addEventListener('project-hub-changed',()=>refresh().catch(error=>notice(error.message,true)));
  function consentKey(c,tools,conversationId=state.conversationId){return JSON.stringify([state.context.project.id,conversationId,c.id,c.revision,c.updatedAt,tools,$('agentChatContext').checked]);}
  $('agentChatForm').addEventListener('submit',async event=>{
    event.preventDefault();if(state.sending||running()||!state.context||!state.snapshot)return;
    const message=$('agentChatInput').value.trim();const c=connection();if(!message)return;
    if(!configured(c)){notice('此执行器尚不能在 Hub 内直接发送，请先配置 CLI / ACP 连接。',true);return;}
    if(typeof api?.agentSendChat!=='function'){notice('请重启更新后的 AIDesignHub，加载聊天派单接口。',true);return;}
    const allowProjectTools=$('agentChatProjectTools').checked,includeProjectContext=$('agentChatContext').checked;
    const transfer=Boolean(conversation()?.lastConnectionId&&conversation().lastConnectionId!==c.id);
    if(transfer&&!window.confirm(`将这段对话切换到“${c.label}”？继续将把本对话的近期消息和已返回结果发送给这个执行器及其模型服务。不会自动传递其他项目资料。若不希望分享历史，请先新建对话。`))return;
    const key=consentKey(c,allowProjectTools);
    if(!state.consents.has(key)&&!window.confirm(`发送给“${c.label}”？会调用其当前模型，可能消耗额度。发送内容包括本条需求、本段对话的近期历史、项目基本信息与所选 Skill。${includeProjectContext?'还会发送本次项目摘要：阶段、有效决定、风险和任务；请先在项目助手核对。':'不会携带额外项目摘要。'}${allowProjectTools?'本次还允许只读检索当前项目的知识摘录和任务。':'不会授予 Hub 项目资料检索权限。'}执行器本身的文件和网络权限仍由其配置控制。`))return;
    const payload={projectId:state.context.project.id,conversationId:state.conversationId||undefined,connectionId:c.id,skillId:$('agentChatSkill').value||'agent-chat',message,allowProjectTools,includeProjectContext,allowHistoryTransfer:transfer};
    const generation=state.generation;
    const stillCurrent=()=>generation===state.generation&&state.context?.project.id===payload.projectId;
    const fingerprint=JSON.stringify(payload);if(state.pending?.fingerprint!==fingerprint)state.pending={fingerprint,requestId:crypto.randomUUID()};
    state.sending=true;updateComposer();notice('正在派单…');
    try{
      const result=await api.agentSendChat({...payload,requestId:state.pending.requestId});
      if(!stillCurrent())return;
      state.conversationId=result.conversationId;state.consents.add(key);state.consents.add(consentKey(c,allowProjectTools,result.conversationId));
      state.pending=null;$('agentChatInput').value='';$('agentChatProjectTools').checked=false;
      try{await refresh();if(stillCurrent()){render(true);notice();}}catch(error){if(stillCurrent())notice(`需求已经派单，状态刷新暂未成功：${error.message}。请从历史记录查看，不必重复发送。`,true);}window.dispatchEvent(new Event('agent-hub-changed'));
    }catch(error){if(stillCurrent()){notice(`${error.message} 草稿已保留。`,true);await refresh().catch(()=>{});}}
    finally{if(stillCurrent()){state.sending=false;updateComposer();$('agentChatInput').focus();}}
  });
  $('agentChatInput').addEventListener('input',updateComposer);
  let composing=false;
  $('agentChatInput').addEventListener('compositionstart',()=>{composing=true;});$('agentChatInput').addEventListener('compositionend',()=>{composing=false;});
  $('agentChatInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();if(!$('agentChatSend').disabled)$('agentChatForm').requestSubmit($('agentChatSend'));}});
  for(const id of ['agentChatConnection','agentChatSkill','agentChatProjectTools','agentChatContext'])$(id).addEventListener('change',updateComposer);
  $('agentChatConfigure').addEventListener('click',()=>window.dispatchEvent(new CustomEvent('agent-open-settings',{detail:{connectionId:connection()?.id}})));
  $('agentNewChat').addEventListener('click',()=>{if(state.sending||!confirmDiscard())return;state.conversationId=null;state.pending=null;state.renderKey=null;$('agentChatInput').value='';$('agentChatProjectTools').checked=false;$('agentChatContext').checked=false;notice();render(true);$('agentChatInput').focus();});
  for(const prompt of document.querySelectorAll('[data-agent-prompt]'))prompt.addEventListener('click',()=>{if(!state.sending&&confirmDiscard()){$('agentChatInput').value=prompt.dataset.agentPrompt;updateComposer();$('agentChatInput').focus();}});
  window.addEventListener('agent-snapshot-ready',event=>accept(event.detail.snapshot,event.detail.context));
  window.addEventListener('agent-hub-changed',()=>refresh().catch(error=>notice(error.message,true)));
  let unsubscribeChanged;
  if(typeof api?.agentOnChanged==='function'){let timer;unsubscribeChanged=api.agentOnChanged(()=>{clearTimeout(timer);timer=setTimeout(()=>refresh().catch(error=>notice(error.message,true)),150);});}
  window.addEventListener('agent-prefer-connection',async event=>{
    const id=event.detail?.connectionId,generation=state.generation;if(!id||state.sending||running()||conversation())return;
    await refresh().catch(()=>{});if(generation!==state.generation||state.sending||running()||conversation())return;
    if(state.snapshot?.connections.some(item=>item.id===id&&configured(item))){$('agentChatConnection').value=id;updateComposer();}
  });
  refresh().catch(error=>notice(`无法读取 Agent 配置：${error.message}`,true));
})();
