(() => {
  'use strict';
  const api = window.bycjWorkbench;
  let generation = 0;
  const openCollaboration = detail => window.dispatchEvent(new CustomEvent('adh-workbench-request', { detail: { panel: 'collaboration', tab: 'settings', ...detail } }));
  const openSkills = () => window.dispatchEvent(new CustomEvent('adh-workbench-request', { detail: { panel: 'skills' } }));
  window.aidesignAIHub = Object.freeze({ openCollaboration, openSkills });
  window.aidesignAgentSetupUI = Object.freeze({ openSettings: connectionId => openCollaboration({ connectionId }), autoPair: () => openCollaboration({ autoPair: true }), refresh: () => openCollaboration({}) });
  window.addEventListener('agent-open-settings', event => openCollaboration({ connectionId: event.detail?.connectionId }));
  window.addEventListener('agent-focus-run', event => openCollaboration({ tab: 'tasks', runId: event.detail?.runId }));
  window.addEventListener('hub-project-changed', () => { generation++; });
  window.addEventListener('adh-workbench-request', async event => {
    const current = generation, detail = event.detail || {};
    try {
      if (!api?.adhWorkbenchOpen) throw new Error('请重启 Hub 加载 ADH 项目协作。');
      await api.adhWorkbenchOpen({ projectId: detail.projectId, ...(detail.panel === 'skills' ? { panel: 'skills' } : detail.panel === 'collaboration' ? { panel: 'collaboration', tab: detail.tab, connectionId: detail.connectionId, runId: detail.runId, autoPair: detail.autoPair === true } : { action: detail.action, caseIds: detail.caseIds || [], prompt: detail.prompt || '' }) });
      if (current !== generation) return;
      document.querySelector('[data-view="adh-agent"]')?.click();
    } catch (error) {
      if (current === generation) window.dispatchEvent(new CustomEvent('workbench-error', { detail: { message: error.message } }));
    }
  });
})();
