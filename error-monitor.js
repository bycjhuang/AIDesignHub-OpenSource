window.__BYCJ_WORKBENCH_ERRORS__ = [];
window.addEventListener('error', (event) => {
  window.__BYCJ_WORKBENCH_ERRORS__.push(String(event.error?.stack || event.message || 'Unknown error'));
});
window.addEventListener('unhandledrejection', (event) => {
  window.__BYCJ_WORKBENCH_ERRORS__.push(String(event.reason?.stack || event.reason || 'Unhandled rejection'));
});
