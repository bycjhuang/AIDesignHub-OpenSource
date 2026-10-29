'use strict';

// Isolated renderer integration test. Only synthetic execute() responses are used;
// the real local sendChat -> createJob -> startJob -> review-pending path remains intact.
async function runChatSmoke(win,hub) {
  if(process.env.BYCJ_WORKBENCH_SMOKE!=='1')throw new Error('Isolated smoke mode required.');
  const originalExecute=hub.execute,originalSendChat=hub.sendChat;
  const originalSize=win.getContentSize(),originalMinimum=win.getMinimumSize();
  const inputs=[];
  let projectGrantAttached=false;
  for(const [id,label] of [['smoke-chat-a','聊天烟测 Agent A'],['smoke-chat-b','聊天烟测 Agent B']])hub.saveConnection({id,provider:'custom',mode:'cli',label,command:process.execPath,args:[],timeoutMs:10000});
  hub.execute=async(connection,input)=>{
    inputs.push({connectionId:connection.id,prompt:input.prompt});
    projectGrantAttached ||= Boolean(input.env?.AIDESIGNHUB_TOKEN||connection.mcpServers?.length);
    input.onEvent?.({message:'聊天烟测：正在处理合成需求。'});
    await new Promise(resolve=>setTimeout(resolve,350));
    return {ok:true,text:`聊天合成成果第 ${inputs.length} 轮。<img src=x onerror="window.chatUiXss=true">`,outcome:'completed'};
  };
  let simulatedFailureCount=0;
  hub.sendChat=function(payload,...rest){
    if(payload?.message==='聊天烟测失败草稿，请保留原文。'){simulatedFailureCount++;throw new Error('聊天烟测模拟连接失败');}
    return originalSendChat.call(this,payload,...rest);
  };
  try {
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const $=id=>document.getElementById(id);
      const wait=async(predicate,label)=>{for(let i=0;i<180;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('聊天烟测等待超时：'+label);};
      const select=value=>{$('agentChatConnection').value=value;$('agentChatConnection').dispatchEvent(new Event('change',{bubbles:true}));};
      const fill=value=>{$('agentChatInput').value=value;$('agentChatInput').dispatchEvent(new Event('input',{bubbles:true}));};
      const snapshot=()=>window.bycjWorkbench.agentSnapshot();
      const originalConfirm=window.confirm;
      window.confirm=()=>true;
      const firstText='聊天烟测首轮 <img src=x onerror="window.chatUiXss=true">';
      try {
        document.querySelector('[data-view="agents"]').click();
        $('agentRefresh').click();
        await wait(()=>[...$('agentChatConnection').options].some(option=>option.value==='smoke-chat-a'),'聊天执行器列表');
        const defaultSettingsClosed=!$('agentSettingsDialog').open;
        const defaultHistoryClosed=!$('agentHistoryDialog').open;
        const defaultNoTools=!$('agentChatProjectTools').checked;
        const defaultGeneralSkill=$('agentChatSkill').value==='agent-chat';
        select('smoke-chat-a');fill(firstText);
        await wait(()=>!$('agentChatSend').disabled,'首轮发送就绪');
        const before=await snapshot();
        $('agentChatInput').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'测'}));
        $('agentChatInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));
        $('agentChatInput').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'测试'}));
        $('agentChatInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,bubbles:true,cancelable:true}));
        await new Promise(resolve=>setTimeout(resolve,80));
        const imeDoesNotSend=(await snapshot()).jobs.length===before.jobs.length&&$('agentChatInput').value===firstText;
        $('agentChatForm').requestSubmit();
        $('agentChatForm').requestSubmit();
        await wait(()=>$('agentChatSend').disabled,'发送中的禁用状态');
        const activeSendDisabled=$('agentChatSend').disabled;
        await wait(async()=>{const snap=await snapshot();return snap.runs.some(run=>run.input.instruction===firstText&&run.status==='awaiting_review');},'首轮实际派单成果');
        const firstSnapshot=await snapshot();
        const firstJob=firstSnapshot.jobs.find(job=>job.chatMessage===firstText);
        const firstRun=firstSnapshot.runs.find(run=>run.jobId===firstJob?.id);
        if(!firstJob||!firstRun)throw new Error('聊天消息没有关联真实任务与运行');
        await wait(()=>document.querySelector('[data-chat-run="'+firstRun.id+'"]')?.textContent.includes('聊天合成成果第 1 轮'),'首轮助手消息');
        const firstUserVisible=Boolean(document.querySelector('[data-chat-job="'+firstJob.id+'"]')?.textContent.includes('聊天烟测首轮'));
        const oneFirstDispatch=firstSnapshot.jobs.length===before.jobs.length+1;
        const pendingReview=firstRun.status==='awaiting_review';
        const xssAsText=!window.chatUiXss&&!$('agentChatMessages').querySelector('img')&&$('agentChatMessages').textContent.includes('<img');
        fill('聊天烟测追问：请结合刚才的上下文补充。');
        await wait(()=>!$('agentChatSend').disabled,'追问发送就绪');
        $('agentChatForm').requestSubmit();
        await wait(async()=>{const snap=await snapshot();return snap.runs.some(run=>run.input.instruction.startsWith('聊天烟测追问')&&run.status==='awaiting_review');},'追问成果');
        const secondSnapshot=await snapshot();
        const secondJob=secondSnapshot.jobs.find(job=>job.chatMessage?.startsWith('聊天烟测追问'));
        const secondRun=secondSnapshot.runs.find(run=>run.jobId===secondJob?.id);
        await wait(()=>document.querySelector('[data-chat-run="'+secondRun.id+'"]')?.textContent.includes('聊天合成成果第 2 轮'),'追问助手消息');
        const sameConversation=secondJob.conversationId===firstJob.conversationId;
        const contextCarried=secondRun.input.chatHistory.some(message=>message.role==='user'&&message.content===firstText)&&secondRun.input.chatHistory.some(message=>message.role==='assistant'&&message.content.includes('聊天合成成果第 1 轮'));
        const noAutomaticReview=secondSnapshot.runs.find(run=>run.id===firstRun.id).status==='awaiting_review'&&secondRun.status==='awaiting_review';
        select('smoke-chat-b');fill('聊天烟测历史切换，取消后不能派单。');
        const transferQuestions=[];window.confirm=message=>{transferQuestions.push(String(message));return false;};
        $('agentChatForm').requestSubmit();await new Promise(resolve=>setTimeout(resolve,80));
        const explicitHistoryConfirmation=transferQuestions.some(message=>message.includes('切换')&&message.includes('近期')&&message.includes('模型服务'));
        const cancelledTransferDoesNotSend=(await snapshot()).jobs.length===secondSnapshot.jobs.length&&$('agentChatInput').value==='聊天烟测历史切换，取消后不能派单。';
        window.confirm=()=>true;select('smoke-chat-a');fill('聊天烟测失败草稿，请保留原文。');
        $('agentChatForm').requestSubmit();
        await wait(()=>!$('agentChatInput').disabled&&$('agentChatNotice').textContent.includes('模拟连接失败'),'失败信息与保留草稿');
        const failedSendKeepsDraft=$('agentChatInput').value==='聊天烟测失败草稿，请保留原文。'&&$('agentChatNotice').textContent.includes('草稿已保留');
        const failedSendDoesNotAddJob=(await snapshot()).jobs.length===secondSnapshot.jobs.length;
        select('zcode');fill('不能通过 inbound 连接伪造主动回复');
        await wait(()=>$('agentChatSend').disabled,'入站连接发送禁用');
        const inboundDisabled=$('agentChatSend').disabled;
        $('agentChatConfigure').click();
        await wait(()=>$('agentSettingsDialog').open,'配置入口打开设置');
        const configureOpensSettings=$('agentSettingsDialog').open;
        $('agentCloseSettings').click();
        await wait(()=>!$('agentSettingsDialog').open,'设置关闭');
        $('agentOpenSettings').click();await wait(()=>$('agentSettingsDialog').open,'顶部设置入口');
        $('agentCloseSettings').click();await wait(()=>!$('agentSettingsDialog').open,'顶部设置关闭');
        const settingsButtonWorks=!$('agentSettingsDialog').open;
        select('smoke-chat-a');fill('');$('agentNewChat').click();
        await wait(()=>!$('agentChatMessages').querySelector('[data-chat-job]'),'新建空白对话');
        const newConversationBlank=!$('agentChatMessages').querySelector('[data-chat-job]');
        $('agentOpenHistory').click();await wait(()=>$('agentHistoryDialog').open,'打开历史');
        await wait(()=>$('agentConversationList').querySelector('[data-conversation-id="'+firstJob.conversationId+'"]')||[...$('agentConversationList').querySelectorAll('button')].some(button=>button.textContent.includes('聊天烟测首轮')),'历史会话条目');
        const historyButton=$('agentConversationList').querySelector('[data-conversation-id="'+firstJob.conversationId+'"]')||[...$('agentConversationList').querySelectorAll('button')].find(button=>button.textContent.includes('聊天烟测首轮'));
        historyButton.click();
        await wait(()=>!$('agentHistoryDialog').open&&Boolean($('agentChatMessages').querySelector('[data-chat-run="'+secondRun.id+'"]')),'恢复原会话');
        const historyRestoresConversation=Boolean($('agentChatMessages').querySelector('[data-chat-job="'+firstJob.id+'"]'))&&$('agentChatMessages').textContent.includes('聊天合成成果第 2 轮');
        const finalSnapshot=await snapshot();
        const onlyTwoJobs=finalSnapshot.jobs.length===before.jobs.length+2;
        return {defaultSettingsClosed,defaultHistoryClosed,defaultNoTools,defaultGeneralSkill,imeDoesNotSend,activeSendDisabled,firstUserVisible,oneFirstDispatch,pendingReview,xssAsText,sameConversation,contextCarried,noAutomaticReview,explicitHistoryConfirmation,cancelledTransferDoesNotSend,failedSendKeepsDraft,failedSendDoesNotAddJob,inboundDisabled,configureOpensSettings,settingsButtonWorks,newConversationBlank,historyRestoresConversation,onlyTwoJobs};
      }finally{
        window.confirm=originalConfirm;
        if($('agentSettingsDialog').open)$('agentSettingsDialog').close();
        if($('agentHistoryDialog').open)$('agentHistoryDialog').close();
      }
    })()`);
    await win.webContents.executeJavaScript(`document.getElementById('agentOpenSettings').click()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    result.escapeClosesSettings=await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100;i++){if(!document.getElementById('agentSettingsDialog').open)return true;await new Promise(resolve=>setTimeout(resolve,20));}return false;})()`);
    win.setMinimumSize(600,600);win.setContentSize(760,860);
    result.narrowComposerFits=await win.webContents.executeJavaScript(`(async()=>{await new Promise(resolve=>setTimeout(resolve,150));const form=document.getElementById('agentChatForm');const rect=form.getBoundingClientRect();const controls=['agentChatInput','agentChatConnection','agentChatSend'].map(id=>document.getElementById(id).getBoundingClientRect());return innerWidth<=780&&rect.left>=0&&rect.right<=innerWidth+2&&form.scrollWidth<=form.clientWidth+2&&controls.every(box=>box.left>=rect.left-2&&box.right<=rect.right+2);})()`);
    win.setMinimumSize(...originalMinimum);win.setContentSize(...originalSize);
    result.onlyTwoExecutions=inputs.length===2;
    result.oneSimulatedSendFailure=simulatedFailureCount===1;
    result.noAutomaticProjectGrant=!projectGrantAttached;
    result.followUpPromptContainsContext=inputs.length===2&&inputs[1].prompt.includes('conversation_history')&&inputs[1].prompt.includes('聊天合成成果第 1 轮');
    if(Object.values(result).some(value=>value!==true))throw new Error('聊天界面烟测未通过：'+JSON.stringify(result));
    return result;
  }finally{hub.execute=originalExecute;hub.sendChat=originalSendChat;win.setMinimumSize(...originalMinimum);win.setContentSize(...originalSize);}
}

module.exports={runChatSmoke};
