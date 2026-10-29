(() => {
  'use strict';
  const api = window.bycjWorkbench;
  const panel = document.getElementById('projectResearchPanel');
  if (!panel) document.getElementById('openProjectResearch')?.addEventListener('click', () => {
    const selection=window.aidesignCaseUI?.getSelection?.()||{};
    window.dispatchEvent(new CustomEvent('adh-workbench-request',{detail:{projectId:selection.projectId||null,action:'research',caseIds:[],prompt:'结合当前选中的项目，寻找适合的对标案例，读取可靠来源并下载项目高清图，保存到案例与素材库。'}}));
  });
  if (!panel) return;
  const $ = id => document.getElementById(id);
  const state = { generation: 0, projectId: null, tasks: [], selectedId: null, busy: false, listRequest: 0, connectionRequest: 0 };
  const labels = { dispatching: '正在派单', queued: '等待执行', researching: 'Agent 正在检索', running: 'Agent 正在检索', validating: '正在核验来源', validating_sources: '正在核验来源', archiving: '正在归档案例和图片', collecting: '正在归档案例和图片', completed: '调研完成 · 待人工复核', complete: '调研完成 · 待人工复核', partial: '部分完成 · 有待补资料', failed: '未完成', interrupted: '运行已中断', cancelled: '已取消', awaiting_agent: '等待 Agent' };
  const terminal = new Set(['completed', 'complete', 'partial', 'failed', 'interrupted', 'cancelled']);
  const el = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = String(value); return node; };
  const message = (text, error = false) => { $('projectResearchNotice').textContent = text; $('projectResearchNotice').classList.toggle('is-error', error); };
  const values = input => Array.isArray(input) ? input : [];
  function link(url, title) {
    const a = el('button', 'text-button research-source-link', title || url); a.type = 'button';
    try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) return el('span', '', title || '来源无效'); }
    catch { return el('span', '', title || '来源无效'); }
    a.addEventListener('click', () => api.openExternalUrl(url).catch(error => message(error.message, true))); return a;
  }
  function sourceRows(container, sources) {
    for (const source of values(sources)) {
      const row = el('li'); row.append(link(source.url || source.sourceUrl, source.title || source.url || source.sourceUrl));
      const status = ({ read: '正文已读取', verified: '已核验', unavailable: '未能读取', not_read: '未读取', blocked: '需人工验证' })[source.status] || source.status || (source.verified ? '已读取' : '待核验');
      row.append(el('small', 'hub-muted', ` · ${status}${source.error ? ` · ${source.error}` : ''}`)); container.append(row);
    }
  }
  async function action(button, work) {
    const generation = state.generation; button.disabled = true;
    try { await work(generation); } catch (error) { if (generation === state.generation) message(error.message, true); }
    finally { if (generation === state.generation) button.disabled = false; }
  }
  function renderDetail(task) {
    const detail = $('projectResearchDetail'); detail.replaceChildren(); detail.hidden = !task;
    if (!task) return;
    detail.append(el('h3', '', task.title || task.brief || '项目案例调研'), el('p', 'hub-muted', '以下为 Agent 的研究建议，来源阅读、图片筛选和下载情况分别列出，供人工复核。'));
    if (task.summary) detail.append(el('p', '', task.summary));
    for (const item of values(task.cases)) {
      const card = el('article', 'research-case-result'); card.append(el('h4', '', item.name || item.title || '候选案例'));
      if (item.summary) card.append(el('p', '', item.summary));
      const refs = values(item.references || item.referencePoints || item.insights);
      for (const ref of refs) { const p = el('p'); p.append(el('strong', '', typeof ref === 'string' ? ref : ref.point || ref.title || ref.reference || '参考点')); if (typeof ref === 'object') p.append(el('span', '', ` ${ref.application || ref.relevance || ref.reason || ''}${ref.limitation ? `；限制：${ref.limitation}` : ''}`)); card.append(p); }
      const sources = el('ul', 'research-source-list'); sourceRows(sources, item.sources); card.append(sources);
      if (item.imageArchive || item.images) { const images = item.imageArchive || item.images; card.append(el('p', 'hub-muted', `图片归档：${images.savedCount ?? values(images.assetIds).length} 张${images.status ? ` · ${images.status}` : ''}`)); }
      detail.append(card);
    }
    if (values(task.references).length) {
      detail.append(el('h4', '', '结合当前项目的参考点'));
      for (const ref of task.references) {
        const row = el('p'); row.append(el('strong', '', typeof ref === 'string' ? ref : ref.point || ref.title || ref.reference || '参考点'));
        if (typeof ref === 'object') { row.append(el('span', '', ` ${ref.application || ref.relevance || ref.reason || ref.description || ''}`)); if (ref.limitation || ref.limitations) row.append(el('small', 'hub-muted', ` 适用限制：${ref.limitation || ref.limitations}`)); }
        detail.append(row);
      }
    }
    const sources = el('ul', 'research-source-list'); sourceRows(sources, task.sources); detail.append(el('h4', '', '全部来源与访问情况'), sources);
    for (const error of values(task.errors)) detail.append(el('p', 'research-warning', typeof error === 'string' ? error : error.message || JSON.stringify(error)));
    for (const warning of [...values(task.warnings), ...values(task.limitations)]) detail.append(el('p', 'research-warning', typeof warning === 'string' ? warning : warning.message || ''));
    if (task.error) detail.append(el('p', 'research-warning', task.error));
    const imageButton = el('button', 'secondary-button', '查看项目本地原图'); imageButton.type = 'button'; imageButton.addEventListener('click', () => window.aidesignImageCollection?.open({ projectId: state.projectId, tab: "library" })); detail.append(imageButton);
    if (task.runId) { const run = el('button', 'text-button', '查看 Agent 执行记录'); run.type = 'button'; run.addEventListener('click', () => { document.querySelector('[data-view="agents"]')?.click(); window.dispatchEvent(new CustomEvent('agent-focus-run', { detail: { runId: task.runId } })); }); detail.append(run); }
  }
  function render() {
    const list = $('projectResearchTasks'); list.replaceChildren();
    if (!state.tasks.length) list.append(el('p', 'hub-muted', '还没有项目调研。填写研究方向，分派给一个可联网执行的 Agent。'));
    for (const task of state.tasks) {
      const row = el('article', 'research-task-row'); const info = el('div'); info.append(el('strong', '', task.title || task.brief || '案例调研'), el('small', 'hub-muted', labels[task.status] || task.status));
      const progress = task.progress; if (progress) info.append(el('small', 'hub-muted', typeof progress === 'string' ? progress : progress.message || progress.stage || ''));
      const actions = el('div', 'research-task-actions'); const view = el('button', 'secondary-button', state.selectedId === task.id ? '收起详情' : '查看调研'); view.type = 'button'; view.addEventListener('click', () => { state.selectedId = state.selectedId === task.id ? null : task.id; render(); }); actions.append(view);
      if (terminal.has(task.status) && values(task.cases).length) {
        const verify = el('button', 'text-button', '重新核验与补图'); verify.type = 'button'; verify.addEventListener('click', () => action(verify, async generation => {
          await api.projectResearchRevalidate({ id: task.id, projectId: state.projectId }); if (generation !== state.generation) return; message('正在复用已有 Agent 成果，重新核验来源与图片；不会再次调用模型。'); await refresh();
        })); actions.append(verify);
        const page = el('button', 'secondary-button', '生成案例分析页'); page.type = 'button'; page.addEventListener('click', () => action(page, async generation => {
          const result = await api.projectResearchExport({ id: task.id, projectId: state.projectId, format: 'html' }); if (generation !== state.generation) return;
          message(result.canceled ? '已取消导出。' : `案例分析页已保存，含 ${result.imageCount || 0} 张项目图和 ${result.sourceCount || 0} 个来源。`);
        })); actions.append(page);
        for (const [template, label] of [['brief', '生成案例研究 PPT · 简报版'], ['editorial', '生成 PPT · 杂志版']]) {
          const ppt = el('button', template === 'brief' ? 'primary-button' : 'secondary-button', label); ppt.type = 'button'; ppt.title = template === 'editorial' ? '杂志版：暗色全幅主图 + 借鉴 / 转译 / 警示' : '简报版：蓝白四图网格 + 项目档案 / 特色 / 借鉴 / 改进'; ppt.addEventListener('click', () => action(ppt, async generation => {
            message(`正在生成${template === 'editorial' ? '杂志版' : '研究简报'} PPT，包含本地图片与来源链接…`);
            const result = await api.projectResearchExport({ id: task.id, projectId: state.projectId, template });
            if (generation !== state.generation) return; message(result.canceled ? '已取消导出。' : `${template === 'editorial' ? '杂志版' : '简报版'} PPT 已保存${result.slideCount ? `，共 ${result.slideCount} 页` : ''}。${values(result.warnings).length ? ` ${result.warnings.length} 项素材提示请在演示文稿内核对。` : ''}`);
          })); actions.append(ppt);
        }
      }
      if (['partial', 'failed', 'interrupted', 'cancelled'].includes(task.status)) { const retry = el('button', 'text-button', '重新调研'); retry.type = 'button'; retry.addEventListener('click', () => action(retry, async generation => { await api.projectResearchRetry({ id: task.id, projectId: state.projectId }); if (generation === state.generation) { message('已重新分派调研，旧成果保留。'); await refresh(); } })); actions.append(retry); }
      row.append(info, actions); list.append(row);
    }
    renderDetail(state.tasks.find(item => item.id === state.selectedId));
  }
  async function refresh() {
    if (!api?.projectResearchList) { message('请重启 Hub，以加载项目调研功能。', true); return; }
    const generation = state.generation, request = ++state.listRequest; let snapshot;
    try { snapshot = await api.projectResearchList({ projectId: state.projectId }); } catch (error) { if (generation === state.generation && request === state.listRequest) message(error.message, true); return; }
    if (generation !== state.generation || request !== state.listRequest) return;
    state.projectId = snapshot.projectId; state.tasks = snapshot.tasks || snapshot.research || [];
    $('projectResearchProject').textContent = snapshot.project?.name || '当前项目';
    const profile = snapshot.project?.researchProfile, profileBox = $('projectResearchProfile'); profileBox.replaceChildren(); profileBox.hidden = !profile;
    if (profile) { profileBox.append(el('strong', '', profile.isSynthetic ? '项目基础信息 · 演示假设（非实际指标）' : '当前项目基础信息'), el('p', '', profile.positioning || ''));
      const metrics = [['用地', profile.siteAreaM2], ['地上', profile.aboveGroundAreaM2], ['地下', profile.belowGroundAreaM2], ['总建面', profile.grossFloorAreaM2]].map(([key, value]) => `${key} ${Number(value || 0).toLocaleString('zh-CN')} ㎡`).join(' · ');
      profileBox.append(el('p', 'hub-muted', `${metrics} · 容积率 ${profile.plotRatio ?? '待补充'} · 限高假设 ${profile.maxHeight ?? '待补充'} m`));
    }
    render();
  }
  async function connections() {
    const generation = state.generation, request = ++state.connectionRequest; let snapshot;
    try { snapshot = await api.agentSnapshot(); } catch (error) { if (generation === state.generation && request === state.connectionRequest) message(error.message, true); return; }
    if (generation !== state.generation || request !== state.connectionRequest) return;
    const usable = values(snapshot.connections).filter(item => (['cli', 'acp'].includes(item.mode) && item.command) || (item.mode === 'openclaw-http' && item.endpoint));
    const select = $('projectResearchConnection'), selected = select.value; select.replaceChildren();
    if (!usable.length) { const option = el('option', '', '请先在 Agent 协作中配置执行器'); option.value = ''; select.append(option); }
    for (const item of usable) { const option = el('option', '', item.label || item.id); option.value = item.id; select.append(option); }
    if (usable.some(item => item.id === selected)) select.value = selected;
  }
  $('openProjectResearch').addEventListener('click', () => { panel.hidden = false; panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('projectResearchBrief').focus(); refresh().catch(error => message(error.message, true)); connections().catch(error => message(error.message, true)); });
  $('projectResearchForm').addEventListener('submit', event => {
    event.preventDefault(); if (state.busy) return;
    const button = $('projectResearchStart'), submittedGeneration = state.generation; state.busy = true;
    action(button, async generation => {
      const brief = $('projectResearchBrief').value.trim(), connectionId = $('projectResearchConnection').value;
      if (!connectionId) throw new Error('请先在 Agent 协作中配置一个可主动执行、可联网检索的 Agent。');
      const seedUrls = $('projectResearchSeeds').value.split(/\s+/).filter(Boolean);
      const task = await api.projectResearchStart({ projectId: state.projectId, brief, connectionId, maxCases: Number($('projectResearchCount').value), seedUrls, includeProjectContext: $('projectResearchContext').checked });
      if (generation !== state.generation) return; state.selectedId = task.id; message('调研已分派。完成后会自动核验来源、下载符合条件的项目图并写回案例库。'); await refresh();
    }).finally(() => { if (submittedGeneration === state.generation) state.busy = false; });
  });
  let timer;
  const unsubscribe = api?.projectResearchOnChanged?.(() => { clearTimeout(timer); timer = setTimeout(() => refresh().catch(error => message(error.message, true)), 160); });
  window.addEventListener('hub-project-changed', event => { state.generation++; state.projectId = event.detail?.projectId || null; state.tasks = []; state.selectedId = null; state.busy = false; $('projectResearchStart').disabled = false; $('projectResearchBrief').value = ''; $('projectResearchSeeds').value = ''; render(); refresh().catch(error => message(error.message, true)); connections().catch(error => message(error.message, true)); });
  window.addEventListener('agent-hub-changed', () => connections().catch(error => message(error.message, true)));
  window.addEventListener('hub-view-changed', event => { if (event.detail?.view === 'cases') { refresh().catch(error => message(error.message, true)); connections().catch(error => message(error.message, true)); } });
  window.addEventListener('beforeunload', () => { state.generation++; clearTimeout(timer); unsubscribe?.(); });
  refresh().catch(error => message(error.message, true)); connections().catch(error => message(error.message, true));
})();
