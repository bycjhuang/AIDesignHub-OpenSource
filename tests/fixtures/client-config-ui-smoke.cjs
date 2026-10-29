'use strict';

// Synthetic project grants only. This fixture never copies credentials to the
// clipboard or starts an external model/client.
async function runClientConfigSmoke(win, hub) {
  if (process.env.BYCJ_WORKBENCH_SMOKE !== '1') throw new Error('Isolated smoke mode required.');
  try {
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const el=id=>document.getElementById(id);
      const pause=()=>new Promise(resolve=>setTimeout(resolve,250));
      const wait=async(predicate,label='')=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('MCP 配置界面等待超时：'+label);};
      const openMcp=async()=>{
        if(!el('agentSettingsDialog').open)el('agentOpenSettings').click();
        await wait(()=>el('agentSettingsDialog').open,'打开设置');
        if(!el('agentMcpSettings').open)el('agentMcpSettings').querySelector('summary').click();
        await wait(()=>el('agentMcpSettings').open&&!el('agentRefresh').disabled,'展开 MCP');
      };
      const closeSettings=()=>el('agentCloseSettings').click();
      const collapseMcp=()=>el('agentMcpSettings').querySelector('summary').click();
      const tokenHidden=()=>el('agentNewToken').value===''&&el('agentTokenPanel').hidden&&!el('agentClientIncludeToken').checked&&el('agentClientIncludeToken').disabled;
      const secretsCleared=()=>tokenHidden()&&el('agentClientConfigPreview').value===''&&el('agentClientConfigOutput').hidden;
      const createToken=async(label)=>{
        await openMcp();el('agentClearToken').click();
        el('agentGrantLabel').value=label;el('agentGrantForm').requestSubmit();
        await wait(()=>Boolean(el('agentNewToken').value)&&!el('agentCreateGrant').disabled,'生成隔离授权');
      };
      const generateSensitive=async()=>{
        el('agentClientIncludeToken').checked=true;el('agentClientIncludeToken').dispatchEvent(new Event('change'));
        el('agentGenerateClientConfig').click();
        await wait(()=>!el('agentClientConfigOutput').hidden&&!el('agentGenerateClientConfig').disabled,'生成含密钥模板');
      };
      const displayedSecretDismissal=async(label,dismiss)=>{
        await createToken(label);await generateSensitive();
        const token=el('agentNewToken').value;
        const wasSensitive=Boolean(token)&&el('agentClientConfigPreview').value.includes(token);
        dismiss();await pause();const clearedWhileHidden=secretsCleared();
        await openMcp();await pause();
        return wasSensitive&&clearedWhileHidden&&secretsCleared();
      };
      const grantRace=async(label,dismiss)=>{
        await openMcp();el('agentGrantLabel').value=label;el('agentGrantForm').requestSubmit();
        if(!el('agentCreateGrant').disabled)throw new Error('授权创建没有进入异步状态');
        // Dismiss before the native IPC promise can settle in this renderer.
        dismiss();await wait(()=>!el('agentCreateGrant').disabled,'等待迟到授权');await pause();
        const clearedWhileHidden=secretsCleared();await openMcp();await pause();
        return clearedWhileHidden&&secretsCleared();
      };
      const configRace=async(label,dismiss)=>{
        await createToken(label);
        el('agentClientIncludeToken').checked=true;el('agentClientIncludeToken').dispatchEvent(new Event('change'));
        el('agentGenerateClientConfig').click();
        if(!el('agentGenerateClientConfig').disabled)throw new Error('配置生成没有进入异步状态');
        // The pending response contains a secret; closing must invalidate it.
        dismiss();await wait(()=>!el('agentGenerateClientConfig').disabled,'等待迟到模板');await pause();
        const clearedWhileHidden=secretsCleared();await openMcp();await pause();
        return clearedWhileHidden&&secretsCleared();
      };
      document.querySelector('[data-view="agents"]').click();await wait(()=>!el('agentRefresh').disabled,'初始状态');
      const settingsInitiallyHidden=!el('agentSettingsDialog').open;
      const mcpInitiallyCollapsed=!el('agentMcpSettings').open;
      try {
        await openMcp();
        el('agentClientTransport').value='http';el('agentClientTransport').dispatchEvent(new Event('change'));el('agentGenerateClientConfig').click();
        await wait(()=>!el('agentClientConfigOutput').hidden);const http=JSON.parse(el('agentClientConfigPreview').value).mcpServers.AIDesignHub;
        const placeholder=http.headers.Authorization==='Bearer <AIDESIGNHUB_TOKEN>'&&http.url.endsWith('/mcp');
        await createToken('mcp-config-ui-smoke');await generateSensitive();
        const containsToken=JSON.parse(el('agentClientConfigPreview').value).mcpServers.AIDesignHub.headers.Authorization==='Bearer '+el('agentNewToken').value;
        el('agentRefresh').click();await wait(()=>el('agentClientConfigOutput').hidden);
        const cleared=secretsCleared();await wait(()=>!el('agentRefresh').disabled);
        el('agentClearToken').click();
        el('agentClientTransport').value='stdio';el('agentClientTransport').dispatchEvent(new Event('change'));el('agentGenerateClientConfig').click();
        await wait(()=>!el('agentClientConfigOutput').hidden);
        const stdio=JSON.parse(el('agentClientConfigPreview').value).mcpServers.AIDesignHub;
        const runtimeValid=/electron(?:\\.exe)?$/i.test(stdio.command)&&stdio.env.ELECTRON_RUN_AS_NODE==='1'&&stdio.env.AIDESIGNHUB_TOKEN==='<AIDESIGNHUB_TOKEN>';
        const noSecretVisible=tokenHidden();el('agentClearClientConfig').click();
        const hideRace=await grantRace('mcp-config-ui-smoke-hide',()=>el('agentClearToken').click());
        const refreshRace=await grantRace('mcp-config-ui-smoke-refresh',()=>el('agentRefresh').click());
        const leaveRace=await grantRace('mcp-config-ui-smoke-leave',()=>{document.querySelector('[data-view="dashboard"]').click();document.querySelector('[data-view="agents"]').click();});
        const settingsCloseClearsSecrets=await displayedSecretDismissal('mcp-config-ui-smoke-settings-close',closeSettings);
        const mcpCollapseClearsSecrets=await displayedSecretDismissal('mcp-config-ui-smoke-mcp-collapse',collapseMcp);
        const settingsCloseGrantRace=await grantRace('mcp-config-ui-smoke-settings-grant-race',closeSettings);
        const mcpCollapseGrantRace=await grantRace('mcp-config-ui-smoke-mcp-grant-race',collapseMcp);
        const settingsCloseConfigRace=await configRace('mcp-config-ui-smoke-settings-config-race',closeSettings);
        const mcpCollapseConfigRace=await configRace('mcp-config-ui-smoke-mcp-config-race',collapseMcp);
        await createToken('mcp-config-ui-smoke-revoke');await pause();
        const backgroundRefreshKeepsToken=Boolean(el('agentNewToken').value);
        const row=[...el('agentGrantList').querySelectorAll('.agent-grant-row')].find(row=>row.querySelector('strong')?.textContent==='mcp-config-ui-smoke-revoke');
        if(!row)throw new Error('新授权没有出现在撤销列表');
        const originalConfirm=window.confirm;window.confirm=()=>true;
        try{row.querySelector('button').click();await wait(()=>tokenHidden());}finally{window.confirm=originalConfirm;}
        await pause();const revokeClearsToken=tokenHidden();
        return {settingsInitiallyHidden,mcpInitiallyCollapsed,placeholder,containsToken,cleared,runtimeValid,noSecretVisible,hideRace,refreshRace,leaveRace,settingsCloseClearsSecrets,mcpCollapseClearsSecrets,settingsCloseGrantRace,mcpCollapseGrantRace,settingsCloseConfigRace,mcpCollapseConfigRace,backgroundRefreshKeepsToken,revokeClearsToken};
      } finally {
        el('agentClearToken').click();el('agentClearClientConfig').click();
        if(el('agentMcpSettings').open)collapseMcp();
        if(el('agentSettingsDialog').open)closeSettings();
      }
    })()`);
    if (Object.values(result).some(value => value !== true)) throw new Error(`MCP 配置模板烟测未通过：${JSON.stringify(result)}`);
    return result;
  } finally {
    for (const grant of hub.access.grants.filter(item => item.label.startsWith('mcp-config-ui-smoke'))) hub.revokeGrant(grant.id);
  }
}

module.exports = { runClientConfigSmoke };
