(() => {
  'use strict';
  const api = window.bycjWorkbench, frame = document.getElementById('aiDesignFrame');
  const loading = document.getElementById('aiDesignLoading'), message = document.getElementById('aiDesignStatus');
  const retry = document.getElementById('aiDesignRetry');
  const shell = document.querySelector('.app-shell'), sidebar = document.querySelector('.sidebar');
  const edge = document.getElementById('aiDesignNavEdge');
  let hoverTimer = null, leaveTimer = null;
  let visible = false, generation = 0, projectId = null, origin = null, opening = null;
  function hideNavigation() {
    clearTimeout(hoverTimer); clearTimeout(leaveTimer); hoverTimer = leaveTimer = null;
    sidebar?.classList.remove('is-hovering');
  }
  function showNavigation() {
    clearTimeout(leaveTimer); leaveTimer = null;
    if (visible) sidebar?.classList.add('is-hovering');
  }
  function scheduleNavigationHide() {
    if (!visible) return;
    clearTimeout(leaveTimer); leaveTimer = setTimeout(hideNavigation, 200);
  }
  edge.addEventListener('mouseenter', () => {
    if (!visible) return;
    clearTimeout(hoverTimer); hoverTimer = setTimeout(showNavigation, 800);
  });
  edge.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); hoverTimer = null; });
  edge.addEventListener('click', showNavigation);
  edge.addEventListener('focus', showNavigation);
  sidebar?.addEventListener('mouseenter', () => { if (visible) { clearTimeout(leaveTimer); leaveTimer = null; } });
  sidebar?.addEventListener('mouseleave', scheduleNavigationHide);
  frame.addEventListener('mouseenter', scheduleNavigationHide);
  window.addEventListener('keydown', event => { if (visible && event.key === 'Escape') hideNavigation(); });
  async function open(force = false) {
    if (!visible || opening && !force || frame.src && projectId && !force) return;
    const request = ++generation;
    loading.hidden = false; frame.hidden = true; retry.hidden = true;
    message.textContent = '正在打开设计画布…';
    const pending = opening = (async () => {
      try {
        if (!api?.aiDesignOpen) throw new Error('请重启 Hub，载入设计画布组件。');
        const result = await api.aiDesignOpen();
        if (request !== generation) return;
        const url = new URL(result.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('设计画布地址无效。');
        origin = url.origin; projectId = result.projectId;
        frame.src = url.href;
      } catch (error) {
        if (request !== generation) return;
        message.textContent = error.message || '设计画布暂时无法打开。'; retry.hidden = false;
      }
    })();
    try { await pending; } finally { if (opening === pending) opening = null; }
  }
  frame.addEventListener('load', () => {
    if (!projectId || !origin) return;
    loading.hidden = true; frame.hidden = false;
  });
  retry.addEventListener('click', () => void open(true));
  window.addEventListener('hub-view-changed', event => {
    visible = event.detail?.view === 'ai-design';
    shell?.classList.toggle('ai-design-mode', visible);
    hideNavigation();
    if (visible) {
      sidebar?.classList.add('is-collapsed');
      window.aidesignHubChatUI?.close();
      document.getElementById('aiDrawer')?.classList.remove('is-open');
      if (origin && frame.contentWindow) frame.contentWindow.postMessage({ type: 'adh-canvas-immersive' }, origin);
      void open();
    } else if (event.detail?.view !== 'adh-agent') sidebar?.classList.remove('is-collapsed');
  });
  window.addEventListener('hub-project-changed', () => {
    generation++; projectId = null; origin = null; opening = null;
    frame.removeAttribute('src'); frame.hidden = true; loading.hidden = false;
    if (visible) void open(true);
  });
  window.addEventListener('message', event => {
    if (!visible || !origin || event.source !== frame.contentWindow || event.origin !== origin) return;
    if (event.data?.type === 'adh-canvas-ready') frame.contentWindow.postMessage({ type: 'adh-canvas-immersive' }, origin);
    if (event.data?.type === 'adh-open-model-settings') {
      const category = ['text', 'image', 'video'].includes(event.data.category) ? event.data.category : 'image';
      window.dispatchEvent(new CustomEvent('adh-open-model-settings', { detail: { category } }));
    }
  });
  window.addEventListener('adh-model-settings-changed', () => {
    if (origin && frame.contentWindow) frame.contentWindow.postMessage({ type: 'adh-model-settings-updated' }, origin);
  });
})();
