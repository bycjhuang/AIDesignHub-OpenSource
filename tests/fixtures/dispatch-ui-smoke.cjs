'use strict';

// Renderer workflow test only. External execution is simulated; protocol and
// subprocess behavior are covered separately by the backend tests.
async function runDispatchSmoke(win, hub) {
  if (process.env.BYCJ_WORKBENCH_SMOKE !== '1') throw new Error('Isolated smoke mode required.');
  const original = { discover:hub.discoverRuntimes, probe:hub.probeConnection, test:hub.testConnection, execute:hub.execute };
  let calls=0, toolGrantAttached=false;
  hub.discoverRuntimes=()=>({checkedAt:Date.now(),warnings:[],candidates:[{
    id:'smoke-deepseek',provider:'deepseek',label:'隔离测试执行器',installed:true,status:'detected',note:'测试替身，不是模型连通性证明。',version:'test',
    config:{provider:'deepseek',label:'隔离测试执行器',mode:'acp',command:process.execPath,args:[],cwd:'',timeoutMs:10000},
  }]});
  const validation=(id,level,verified)=>{
    const result={ok:true,verified,level,checkedAt:Date.now(),code:'SMOKE',message:verified?'测试替身返回成功，不代表真实模型验证。':'测试替身协议已响应，未调用模型。'};
    hub.change(state=>{const connection=state.connections.find(item=>item.id===id);connection.validation=result;if(level==='task')connection.modelValidation=result;return true;});return result;
  };
  hub.probeConnection=async id=>validation(id,'protocol',false);
  hub.testConnection=async id=>validation(id,'task',true);
  hub.execute=async (connection,input)=>{
    calls++;toolGrantAttached=Boolean(input.env?.AIDESIGNHUB_TOKEN||connection.mcpServers?.length);
    input.onEvent({message:'测试替身正在整理固定任务输入。'});
    await new Promise(resolve=>setTimeout(resolve,100));
    return {ok:true,text:'隔离主动派单成果。<img src=x onerror="window.dispatchXss=true">',outcome:'completed'};
  };
  try {
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const $=id=>document.getElementById(id);
      const wait=async(fn)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('主动派单界面等待超时');};
      const before=await window.bycjWorkbench.agentSnapshot();
      document.querySelector('[data-view="agents"]').click();
      await wait(()=>!$('agentRefresh').disabled);
      if(!$('agentSettingsDialog').open)$('agentOpenSettings').click();
      await wait(()=>$('agentSettingsDialog').open);
      const settingsOpened=$('agentSettingsDialog').open;
      $('agentDetectRuntimes').click();await wait(()=>document.querySelector('[data-agent-device="deepseek"]')?.textContent.includes('已发现安装'));
      $('agentAutoPair').click();
      await wait(()=>!$('agentAutoPair').disabled&&$('agentAutoPairState').textContent.includes('启动／协议配对')&&document.querySelector('[data-agent-device="deepseek"]').textContent.includes('接口已配对'));
      const autoPairReady=document.querySelector('[data-agent-device="deepseek"]').textContent.includes('接口已配对');
      const advancedCollapsed=!$('agentAdvancedConnection').open;
      $('agentAdvancedConnection').open=true;
      document.querySelector('[data-agent-provider="deepseek"] button').click();
      await wait(()=>$('agentMode').value==='acp');
      const templateApplied=$('agentConnectionId').value==='deepseek'&&$('agentArgs').value==='[]';
      $('agentProbeConnection').click();await wait(()=>!$('agentProbeConnection').disabled);
      const protocolOnly=$('agentConnectionState').textContent.includes('协议已响应')&&$('agentConnectionState').textContent.includes('模型未验证');
      const originalConfirm=window.confirm;window.confirm=()=>true;
      try{
        $('agentTestConnection').click();await wait(()=>!$('agentTestConnection').disabled);
        const syntheticTest=$('agentProbeResult').textContent.includes('测试替身返回成功');
        $('agentProbeConnection').click();await wait(()=>!$('agentProbeConnection').disabled);
        const modelEvidencePreserved=$('agentConnectionState').textContent.includes('已返回测试');
        $('agentCloseSettings').click();await wait(()=>!$('agentSettingsDialog').open);
        $('agentOpenHistory').click();await wait(()=>$('agentHistoryDialog').open);
        if(!$('agentManualTaskDetails').open)$('agentManualTaskDetails').querySelector('summary').click();
        await wait(()=>$('agentManualTaskDetails').open);
        const legacyTaskAccessible=!$('agentSettingsDialog').open&&$('agentHistoryDialog').open&&$('agentManualTaskDetails').open;
        $('agentJobConnection').value='deepseek';$('agentJobConnection').dispatchEvent(new Event('change'));
        const defaultNoTools=!$('agentJobProjectTools').checked;
        $('agentJobTitle').value='隔离主动派单 UI 验证';$('agentJobInstruction').value='仅输出合成测试，不使用任何项目文件。';
        $('agentJobForm').requestSubmit($('agentDispatchJob'));
        await wait(async()=>{const snap=await window.bycjWorkbench.agentSnapshot();return snap.runs.some(run=>run.input.title==='隔离主动派单 UI 验证'&&run.status==='awaiting_review');});
        await wait(()=>$('agentRunOutput').textContent.includes('隔离主动派单成果'));
        const snapshot=await window.bycjWorkbench.agentSnapshot();const run=snapshot.runs.find(run=>run.input.title==='隔离主动派单 UI 验证');
        const oneJob=snapshot.jobs.length===before.jobs.length+1;
        const awaitingReview=run.status==='awaiting_review'&&!$('agentReviewPanel').hidden;
        const escaped=!window.dispatchXss&&$('agentRunOutput').textContent.includes('<img');
        const progress=$('agentRunEvents').textContent.includes('测试替身正在整理');
        $('agentApproveRun').click();await wait(async()=>{const snap=await window.bycjWorkbench.agentSnapshot();return snap.runs.find(item=>item.id===run.id).status==='succeeded';});
        $('agentJobConnection').value='zcode';$('agentJobConnection').dispatchEvent(new Event('change'));
        const inboundNotDispatch=$('agentDispatchJob').disabled;
        return {settingsOpened,autoPairReady,advancedCollapsed,templateApplied,protocolOnly,syntheticTest,modelEvidencePreserved,legacyTaskAccessible,defaultNoTools,oneJob,awaitingReview,escaped,progress,inboundNotDispatch,humanAccepted:true};
      }finally{
        window.confirm=originalConfirm;
        if($('agentManualTaskDetails').open)$('agentManualTaskDetails').querySelector('summary').click();
        if($('agentHistoryDialog').open)$('agentCloseHistory').click();
        if($('agentSettingsDialog').open)$('agentCloseSettings').click();
      }
    })()`);
    result.onlyOneExecution=calls===1;result.noAutomaticProjectGrant=!toolGrantAttached;
    if(Object.values(result).some(value=>value!==true))throw new Error(`主动派单烟测未通过：${JSON.stringify(result)}`);
    return result;
  }finally{
    hub.discoverRuntimes=original.discover;hub.probeConnection=original.probe;hub.testConnection=original.test;hub.execute=original.execute;
  }
}

module.exports={runDispatchSmoke};
