(() => {
  'use strict';
  const api = window.bycjWorkbench;
  const activeStatuses = new Set(['discovering', 'loading', 'saving']);
  const statusLabels = { discovering: '正在发现网页图片', loading: '正在读取图片信息', ready: '采集完成', saving: '正在保存原图', cancelled: '已停止', error: '采集未完成' };
  const state = { generation: 0, projectId: null, projectName: '', caseId: null, caseTitle: '', articleId: null, session: null, assets: [], selected: new Set(), assetSelected: new Set(), tab: 'candidates', mode: 'static', visible: 60, busy: false, loading: false, error: '', message: '', pollTimer: null, pollSequence: 0, pollFailures: 0, listSequence: 0, previewSequence: 0, returnFocus: null, signature: '', previewItem: null };
  const refs = {};
  const element = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = String(value); return node; };
  const button = (text, action, className = 'secondary-button') => { const node = element('button', className, text); node.type = 'button'; if (action) node.addEventListener('click', action); return node; };
  const field = (label, node) => { const wrapper = element('label', 'ic-field'); wrapper.append(element('span', '', label), node); return wrapper; };
  const input = (id, type = 'text') => { const node = element('input'); node.id = id; node.type = type; refs[id] = node; return node; };
  const select = (id, values) => { const node = element('select'); node.id = id; for (const [value, label] of values) { const option = element('option', '', label); option.value = value; node.append(option); } refs[id] = node; return node; };
  const capture = () => ({ generation: state.generation, projectId: state.projectId });
  const current = operation => operation.generation === state.generation && operation.projectId === state.projectId && refs.dialog.open;
  const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
  // Only bounded raster data from the main-process image reader may enter img.src.
  const raster = (value, limit = 1024 * 1024) => typeof value === 'string' && value.length <= limit && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/.test(value);
  const format = item => { const type = String(item.contentType || '').split(';')[0].split('/')[1]; if (type) return type === 'jpeg' ? 'JPG' : type.toUpperCase(); try { const ext = new URL(item.sourceUrl).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]; return ext ? ext.toUpperCase().replace('JPEG', 'JPG') : '图片'; } catch { return '图片'; } };
  const sizeText = item => item.width && item.height ? `${item.width} × ${item.height}` : '尺寸尚未读取';
  const bytesText = value => value > 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : value > 0 ? `${Math.max(1, Math.round(value / 1024))} KB` : '';
  const hostText = value => { try { return new URL(value).host; } catch { return '未记录来源'; } };
  const available = () => ['imageCollectionStart', 'imageCollectionGet', 'imageCollectionCancel', 'imageCollectionSave', 'imageCollectionList'].every(name => typeof api?.[name] === 'function');
  const busySession = () => activeStatuses.has(state.session?.status) || state.session?.archiveStatus === 'collecting';
  const canSelectCandidate = item => !item.savedAssetId && ((item.status === 'ready' && !item.duplicateOf) || (item.status === 'duplicate' && item.existingAssetId && item.duplicateOf === item.existingAssetId));
  const selectable = item => state.tab === 'library' || canSelectCandidate(item);
  const notify = (message, error = false) => window.aidesignHubToast?.(message, error ? 'error' : 'normal');

  async function external(value) {
    const url = safeUrl(value); if (!url) return;
    const operation = capture();
    try { if (!api?.openExternalUrl) throw new Error('请重启 AIDesignHub 以加载打开来源接口。'); await api.openExternalUrl(url); }
    catch (error) { if (current(operation)) setError(error.message); }
  }
  function sourceButton(value, label) { const node = button(label, () => external(value), 'text-button ic-source-link'); node.disabled = !safeUrl(value); node.title = safeUrl(value) || '未记录来源'; return node; }
  function setError(message) { state.error = String(message || '操作未完成，请重试。'); renderStatus(); }
  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; state.pollSequence++; }
  function clearContext(projectId = null) {
    state.generation++; stopPolling(); state.listSequence++; state.previewSequence++;
    state.projectId = projectId; state.projectName = ''; state.caseId = null; state.caseTitle = ''; state.articleId = null; state.session = null; state.assets = []; state.selected.clear(); state.assetSelected.clear(); state.busy = false; state.loading = false; state.error = ''; state.message = ''; state.signature = ''; state.visible = 60; state.pollFailures = 0;
    refs.url.value = ''; refs.note.value = ''; refs.caseOnly.checked = false; if (refs.viewer.open) refs.viewer.close(); refs.previewMedia.replaceChildren(); state.previewItem = null;
  }
  async function assertProject(operation) {
    if (!current(operation)) return false;
    if (!api?.bootstrap) throw new Error('请重启 AIDesignHub 以加载项目接口。');
    const data = await api.bootstrap();
    if (!current(operation)) return false;
    if (data?.project?.id !== operation.projectId) { window.dispatchEvent(new CustomEvent('hub-project-changed', { detail: { projectId: data?.project?.id || null } })); return false; }
    return true;
  }
  async function perform(action, { projectCheck = true } = {}) {
    if (state.busy || state.loading) return;
    const operation = capture(); stopPolling(); state.busy = true; state.error = ''; renderGrid(); renderStatus();
    try { if (projectCheck && !(await assertProject(operation))) return; if (!current(operation)) return; await action(operation); }
    catch (error) { if (current(operation)) setError(error?.message || String(error)); }
    finally { if (current(operation)) { state.busy = false; renderGrid(); renderStatus(); schedulePoll(); } }
  }
  function acceptSnapshot(snapshot, operation, expectedId) {
    if (!current(operation) || !snapshot || snapshot.projectId !== operation.projectId || (expectedId && snapshot.id !== expectedId)) return false;
    const previous = state.session; state.session = snapshot; state.articleId = snapshot.articleId || state.articleId; if (state.pollFailures) state.error = ''; state.pollFailures = 0;
    const selectableIds = new Set((snapshot.candidates || []).filter(canSelectCandidate).map(item => item.id));
    for (const id of state.selected) if (!selectableIds.has(id)) state.selected.delete(id);
    renderStatus(); renderGrid();
    if ((previous?.status === 'saving' && snapshot.status !== 'saving') || (previous?.archiveStatus === 'collecting' && snapshot.archiveStatus !== 'collecting')) { state.message = `本次采集已保存 ${snapshot.savedCount || 0} 张原图。`; loadLibrary(); renderStatus(); }
    return true;
  }
  function schedulePoll() {
    stopPolling();
    if (!refs.dialog.open || document.hidden || state.busy || !busySession() || state.pollFailures >= 3) return;
    const operation = capture(), id = state.session.id, sequence = state.pollSequence;
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (!current(operation) || state.session?.id !== id || sequence !== state.pollSequence) return;
      try { const snapshot = await api.imageCollectionGet(id); if (sequence !== state.pollSequence || !acceptSnapshot(snapshot, operation, id)) return; }
      catch (error) { if (!current(operation) || state.session?.id !== id || sequence !== state.pollSequence) return; state.pollFailures++; state.error = state.pollFailures >= 3 ? '连接连续失败，已暂停自动刷新。点击“刷新”继续查看任务。' : `刷新暂未完成：${error?.message || '请稍后重试'}`; renderStatus(); }
      if (current(operation) && state.session?.id === id && sequence === state.pollSequence) schedulePoll();
    }, state.pollFailures ? 2200 : 1000);
  }
  async function startCollection() {
    const url = safeUrl(refs.url.value.trim());
    if (!url) { setError('请输入不含用户名和密码的完整 HTTP(S) 网页链接。'); refs.url.focus(); return; }
    if (!available()) { setError('当前窗口尚未加载图片采集接口，请保存工作后重启 AIDesignHub。'); return; }
    await perform(async operation => {
      stopPolling(); const mode = refs.mode.value; state.mode = mode; state.message = mode === 'browser' ? '动态采集会打开独立浏览器窗口；可在该窗口完成页面展开。' : '';
      const snapshot = await api.imageCollectionStart({ sourceUrl: url, projectId: operation.projectId, ...(state.caseId ? { caseId: state.caseId } : {}), mode });
      if (!current(operation)) return; state.selected.clear(); state.visible = 60; state.signature = ''; state.tab = 'candidates'; renderTabs(); acceptSnapshot(snapshot, operation);
    });
  }
  async function archiveArticle(importHtml = false) {
    const sourceUrl = safeUrl(refs.url.value.trim());
    if (!sourceUrl) { setError('请先填写文章的原始 HTTP(S) 链接。'); refs.url.focus(); return; }
    const method = importHtml ? api?.imageCollectionImport : api?.imageCollectionArchive;
    if (!method) { setError('请保存工作后重启 AIDesignHub，以加载全文归档接口。'); return; }
    await perform(async operation => {
      const snapshot = await method({ sourceUrl, projectId: operation.projectId, ...(state.caseId ? { caseId: state.caseId } : {}), mode: refs.mode.value });
      if (!current(operation) || snapshot?.canceled) return;
      state.selected.clear(); state.articleId = null; state.visible = 60; state.signature = ''; state.tab = 'candidates'; renderTabs();
      state.message = importHtml ? '正在从已保存的 HTML 提取正文和公开图片地址。' : '正在保存文章正文和全部可获取的图片，完成后可导出整篇资料。';
      acceptSnapshot(snapshot, operation);
    });
  }
  async function exportArticle() {
    if (!api?.imageCollectionExport || !state.articleId) return;
    await perform(async operation => {
      const result = await api.imageCollectionExport({ articleId: state.articleId, ...(state.caseId ? { caseId: state.caseId } : {}) });
      if (current(operation) && !result?.canceled) { state.message = '整篇导出已完成：正文、' + (result.count || 0) + ' 张原图和来源清单。'; renderStatus(); }
    });
  }
  async function retryFailed(candidateIds) {
    if (!api?.imageCollectionRetry) { setError('当前窗口尚未加载失败重试接口，请重启 AIDesignHub。'); return; }
    const id = state.session?.id; if (!id) return;
    await perform(async operation => { const snapshot = await api.imageCollectionRetry({ sessionId: id, ...(candidateIds ? { candidateIds } : {}) }); acceptSnapshot(snapshot, operation, id); });
  }
  async function refreshSession() {
    state.pollFailures = 0;
    if (state.tab === 'library') { await loadLibrary(); return; }
    const id = state.session?.id; if (!id) { renderGrid(); return; }
    await perform(async operation => { const snapshot = await api.imageCollectionGet(id); acceptSnapshot(snapshot, operation, id); });
  }
  async function cancelSession() {
    const id = state.session?.id; if (!id) return;
    await perform(async operation => { const snapshot = await api.imageCollectionCancel(id); acceptSnapshot(snapshot, operation, id); state.message = '已停止任务；已经保存的原图保留在项目素材库。'; });
  }
  async function saveSelected() {
    const ids = [...state.selected]; const id = state.session?.id; if (!id || !ids.length) return;
    await perform(async operation => {
      const snapshot = await api.imageCollectionSave({ sessionId: id, candidateIds: ids, note: refs.note.value.trim() });
      if (acceptSnapshot(snapshot, operation, id)) { state.message = snapshot.status === 'saving' ? '正在后台下载并归档选中的原图，可在进度中查看结果。' : `已保存 ${snapshot.savedCount || 0} 张原图。`; if (snapshot.status !== 'saving') loadLibrary(); }
    });
  }
  async function loadLibrary() {
    if (!refs.dialog.open || !state.projectId || !api?.imageCollectionList) return;
    const operation = capture(), sequence = ++state.listSequence;
    refs.libraryLoading.hidden = false;
    try {
      const assets = await api.imageCollectionList({ projectId: operation.projectId, ...(state.caseId && refs.caseOnly.checked ? { caseId: state.caseId } : {}) });
      if (!current(operation) || sequence !== state.listSequence) return;
      state.assets = (Array.isArray(assets) ? assets : []).filter(item => item.projectId === operation.projectId && (!refs.caseOnly.checked || !state.caseId || item.caseId === state.caseId));
      const ids = new Set(state.assets.map(item => item.id)); for (const id of state.assetSelected) if (!ids.has(id)) state.assetSelected.delete(id);
      state.signature = ''; renderGrid();
    } catch (error) { if (current(operation) && sequence === state.listSequence) setError(`素材库读取失败：${error.message || error}`); }
    finally { if (current(operation) && sequence === state.listSequence) refs.libraryLoading.hidden = true; }
  }
  async function exportAssets() {
    const ids = [...state.assetSelected]; if (!ids.length) return;
    if (!api?.imageCollectionExport) { setError('请重启 AIDesignHub 以加载原图导出接口。'); return; }
    await perform(async operation => { const result = await api.imageCollectionExport({ assetIds: ids }); if (current(operation) && !result?.cancelled) { state.message = '导出已完成，原图与来源清单已写入所选目录。'; renderStatus(); } });
  }
  async function revealAsset(id) {
    if (!api?.imageCollectionReveal) { setError('请重启 AIDesignHub 以加载打开文件夹接口。'); return; }
    await perform(async operation => { await api.imageCollectionReveal(id); if (current(operation)) state.message = '已打开原图所在文件夹。'; });
  }
  function filteredItems() {
    const items = state.tab === 'library' ? state.assets : state.session?.candidates || [];
    const width = Math.max(0, Number(refs.minWidth.value) || 0), height = Math.max(0, Number(refs.minHeight.value) || 0), ratio = refs.ratio.value, type = refs.format.value, duplicate = refs.duplicate.value;
    return items.filter(item => {
      const w = Number(item.width) || 0, h = Number(item.height) || 0, r = h ? w / h : 0, isDuplicate = item.status === 'duplicate' || Boolean(item.duplicateOf);
      if (w < width || h < height || (refs.hd.checked && (Math.max(w, h) < 1600 || Math.min(w, h) < 900))) return false;
      if (ratio === 'landscape' && r <= 1.1 || ratio === 'portrait' && (!r || r >= 0.9) || ratio === 'square' && (r < 0.9 || r > 1.1) || ratio === 'panorama' && r < 2) return false;
      if (type && format(item) !== type) return false;
      return state.tab === 'library' ? true : duplicate === 'hide' ? !isDuplicate : duplicate === 'only' ? isDuplicate : true;
    });
  }
  function renderStatus() {
    const session = state.session, active = busySession(), count = state.tab === 'library' ? state.assetSelected.size : state.selected.size;
    const archiveLabel = { complete: '全文归档完成', partial: '部分归档完成', error: '全文归档未完成', cancelled: '全文归档已停止' }[session?.archiveStatus];
    refs.context.textContent = state.loading ? '正在读取当前项目…' : `${state.projectName || '当前项目'}${state.caseTitle ? ` / ${state.caseTitle}` : ''}`;
    refs.oldBridge.hidden = available();
    refs.error.hidden = !state.error; refs.error.textContent = state.error;
    refs.message.hidden = !state.message; refs.message.textContent = state.message;
    refs.status.textContent = state.loading ? '正在读取当前项目…' : session ? `${archiveLabel || statusLabels[session.status] || session.status} · ${session.progress?.done || 0} / ${session.progress?.total || 0} · 已归档 ${session.savedCount || 0} 张` : '输入公开网页链接，预览候选图片后选择要保存的原图。';
    if (session?.preservedPrevious) refs.status.textContent += ' · 已保留旧归档 ' + (session.availableSavedCount || 0) + ' 张';
    refs.status.dataset.status = session?.status || 'empty';
    refs.progress.hidden = !session || !active; const total = Number(session?.progress?.total) || 0; refs.progress.max = total || 1; refs.progress.value = total ? Math.min(total, Number(session?.progress?.done) || 0) : 0;
    refs.start.textContent = session ? '重新采集' : '开始采集'; refs.start.disabled = !available() || state.loading || state.busy || active;
    refs.url.disabled = state.busy || active; refs.mode.disabled = state.busy || active;
    refs.archiveAll.disabled = state.loading || state.busy || active || !api?.imageCollectionArchive;
    refs.importHtml.disabled = state.loading || state.busy || active || !api?.imageCollectionImport;
    refs.exportArticle.hidden = !state.articleId; refs.exportArticle.disabled = state.busy || state.loading || active;
    refs.modeNote.textContent = refs.mode.value === 'browser' ? '将打开独立浏览器窗口加载动态网页。可在独立窗口展开页面，采集进度在这里更新。' : '直接读取公开网页中的图片地址；图片较少时可改用动态浏览器采集。';
    refs.stop.disabled = !active || state.busy || !available(); refs.stop.hidden = !active;
    refs.refresh.disabled = state.busy || state.loading || !available();
    const failed = (session?.candidates || []).filter(item => item.status === 'error').length;
    refs.retry.hidden = !failed; refs.retry.textContent = `重试失败项（${failed}）`; refs.retry.disabled = active || state.busy || !api?.imageCollectionRetry;
    refs.selection.textContent = `已选择 ${count} 张`; refs.save.disabled = !state.selected.size || state.busy || state.loading || active; refs.save.textContent = state.selected.size ? `保存 ${state.selected.size} 张原图到当前项目` : '保存选中原图到当前项目';
    refs.export.disabled = !state.assetSelected.size || state.busy || state.loading || !api?.imageCollectionExport;
    refs.selectAll.disabled = state.busy || state.loading || (state.tab === 'candidates' && active); refs.clear.disabled = !count || state.busy;
    refs.note.disabled = state.busy || active; refs.caseOnlyLabel.hidden = !state.caseId || state.tab !== 'library';
    refs.sessionSource.replaceChildren(); if (session?.sourceUrl) refs.sessionSource.append(sourceButton(session.sourceUrl, `${session.title || hostText(session.sourceUrl)} ↗`));
    refs.errors.replaceChildren(); const errors = (session?.errors || []).slice(0, 6);
    if (errors.length) { refs.errors.append(element('summary', '', `采集记录（${session.errors.length}）`)); const list = element('ul'); for (const item of errors) list.append(element('li', '', typeof item === 'string' ? item : item.message || item.error || '页面读取未完成')); refs.errors.append(list); } refs.errors.hidden = !errors.length;
  }
  function renderTabs() {
    for (const [tab, node] of [['candidates', refs.candidateTab], ['library', refs.libraryTab]]) { node.setAttribute('aria-selected', String(state.tab === tab)); node.tabIndex = state.tab === tab ? 0 : -1; }
    refs.collectPanel.hidden = state.tab === 'library'; refs.savePanel.hidden = state.tab === 'library'; refs.export.hidden = state.tab !== 'library'; refs.duplicateField.hidden = state.tab === 'library'; refs.caseOnlyLabel.hidden = !state.caseId || state.tab !== 'library';
    refs.grid.setAttribute('aria-label', state.tab === 'library' ? '已归档项目原图' : '网页候选图片'); renderStatus();
  }
  function switchTab(tab) { state.tab = tab; state.visible = 60; state.signature = ''; renderTabs(); renderGrid(); if (tab === 'library') loadLibrary(); }
  function renderGrid(force = false) {
    if (!refs.dialog.open) return;
    const items = filteredItems(), visible = items.slice(0, state.visible), selected = state.tab === 'library' ? state.assetSelected : state.selected;
    const signature = `${state.tab}|${state.visible}|${items.length}|${state.busy}|${busySession()}|` + visible.map(item => `${item.id}:${item.status}:${item.width}:${item.height}:${item.savedAssetId || ''}:${item.duplicateOf || ''}:${item.thumbnailUrl?.length || 0}:${item.error || ''}:${selected.has(item.id)}`).join('|');
    refs.count.textContent = `${state.tab === 'library' ? '已归档' : '候选'} ${state.tab === 'library' ? state.assets.length : state.session?.candidates?.length || 0} 张 · 筛选 ${items.length} 张 · 显示 ${visible.length} 张`;
    refs.more.hidden = items.length <= state.visible; refs.more.textContent = `再显示 ${Math.min(60, Math.max(0, items.length - state.visible))} 张`;
    if (!force && signature === state.signature) { renderStatus(); return; } state.signature = signature;
    const focusKey = refs.grid.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const fragment = document.createDocumentFragment();
    for (const item of visible) fragment.append(buildCard(item, selected));
    if (!visible.length) {
      const empty = element('div', 'ic-empty');
      empty.append(element('strong', '', state.tab === 'library' ? '当前项目还没有匹配的原图' : state.session ? '没有符合筛选条件的图片' : '从一个网页开始收集'), element('p', '', state.tab === 'library' ? '采集后选择图片并保存，原图与来源信息会出现在这里。' : state.session ? (busySession() ? '正在读取网页，请稍候；也可以先放宽筛选条件。' : '可放宽筛选条件、重试失败项，或改用动态浏览器采集。') : '静态采集适合普通图文页，动态浏览器适合需要脚本加载的网页。'));
      fragment.append(empty);
    }
    refs.grid.replaceChildren(fragment);
    if (focusKey) [...refs.grid.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
    renderStatus();
  }
  function buildCard(item, selected) {
    const library = state.tab === 'library', card = element('article', 'ic-image-card'); card.dataset.imageId = item.id; card.dataset.imageStatus = library || item.savedAssetId ? 'saved' : item.status; card.dataset.savedAssetId = library ? item.id : item.savedAssetId || ''; card.dataset.width = item.width || ''; card.dataset.height = item.height || '';
    const canSelect = selectable(item), checked = selected.has(item.id), saved = Boolean(item.savedAssetId), duplicate = item.status === 'duplicate' || Boolean(item.duplicateOf);
    card.classList.toggle('is-selected', checked);
    const media = element('div', 'ic-card-media');
    const open = button('', event => showPreview(item, library, event.currentTarget), 'ic-card-preview'); open.setAttribute('aria-label', `查看大图：${item.alt || item.name || sizeText(item)}`); open.dataset.focusKey = `preview:${item.id}`;
    open.append(element('span', 'ic-image-placeholder', item.status === 'error' ? '图片读取失败' : item.status === 'pending' ? '正在读取' : '暂无预览'));
    if (raster(item.thumbnailUrl)) { const img = element('img'); img.alt = item.alt || item.name || ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = item.thumbnailUrl; img.addEventListener('error', () => img.remove(), { once: true }); open.append(img); }
    const label = element('label', 'ic-card-select'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = checked; checkbox.disabled = !canSelect || state.busy || (!library && busySession()); checkbox.setAttribute('aria-label', `选择图片：${item.alt || item.name || sizeText(item)}`); checkbox.dataset.focusKey = `select:${item.id}`;
    checkbox.addEventListener('change', () => { if (state.busy || (!library && busySession())) { checkbox.checked = selected.has(item.id); return; } if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); card.classList.toggle('is-selected', checkbox.checked); state.signature = ''; renderStatus(); }); label.append(checkbox); media.append(open, label);
    const status = library || saved ? '已保存原图' : duplicate ? canSelect ? '素材库已有' : '重复图片' : item.status === 'error' ? '读取失败' : item.status === 'pending' ? '待处理' : '可保存'; const badge = element('span', 'ic-image-badge', status); badge.dataset.status = library || saved ? 'saved' : item.status; media.append(badge);
    const info = element('div', 'ic-card-info'); info.append(element('strong', '', `${sizeText(item)} · ${format(item)}`), element('span', 'ic-card-description', item.name || item.alt || hostText(item.sourcePageUrl || item.sourceUrl)));
    const facts = [bytesText(item.byteLength), hostText(item.sourcePageUrl || item.sourceUrl)].filter(Boolean).join(' · '); info.append(element('small', '', facts));
    if (item.error) info.append(element('p', 'ic-card-error', item.error));
    if (duplicate) info.append(element('small', 'ic-card-duplicate', canSelect ? '已有原图，可补充本页来源与备注' : '与已发现图片的内容相同'));
    if (library && item.note) info.append(element('p', 'ic-card-note', item.note));
    const actions = element('div', 'ic-card-actions'); actions.append(sourceButton(item.sourcePageUrl || item.sourceUrl, '来源网页 ↗'));
    if (library) actions.append(button('打开文件夹', () => revealAsset(item.id), 'text-button'));
    else if (item.status === 'error') { const retry = button('重试', () => retryFailed([item.id]), 'text-button'); retry.disabled = busySession() || state.busy || !api?.imageCollectionRetry; actions.append(retry); }
    info.append(actions); card.append(media, info); return card;
  }
  async function showPreview(item, library, trigger) {
    state.previewItem = { item, library, returnFocus: trigger || document.activeElement }; const operation = capture(), sequence = ++state.previewSequence;
    refs.previewTitle.textContent = item.alt || item.name || '原图预览'; refs.previewMeta.textContent = `${sizeText(item)} · ${format(item)}${item.byteLength ? ` · ${bytesText(item.byteLength)}` : ''}`;
    refs.previewSources.replaceChildren(sourceButton(item.sourcePageUrl || item.sourceUrl, '打开来源网页 ↗'), sourceButton(item.sourceUrl, '打开图片来源 ↗'));
    refs.previewMedia.replaceChildren(element('p', '', '正在读取大图预览…')); if (!refs.viewer.open) refs.viewer.showModal();
    try {
      if (!api?.imageCollectionPreview) throw new Error('当前窗口未加载大图预览接口，请重启 AIDesignHub。');
      const payload = library ? { assetId: item.id } : { sessionId: state.session?.id, candidateId: item.id };
      const result = await api.imageCollectionPreview(payload);
      if (!current(operation) || !refs.viewer.open || sequence !== state.previewSequence) return;
      if (!raster(result?.dataUrl, 24 * 1024 * 1024)) throw new Error('大图预览不可用或超出显示上限，可打开来源查看。');
      const img = element('img'); img.alt = item.alt || item.name || '所选图片'; img.decoding = 'async'; img.src = result.dataUrl; img.addEventListener('error', () => { if (sequence === state.previewSequence) refs.previewMedia.replaceChildren(element('p', 'ic-card-error', '大图未能显示，可打开图片来源查看。')); }, { once: true }); refs.previewMedia.replaceChildren(img);
    } catch (error) { if (current(operation) && refs.viewer.open && sequence === state.previewSequence) refs.previewMedia.replaceChildren(element('p', 'ic-card-error', error.message || '大图读取失败。')); }
  }
  function closePreview() {
    const preview = state.previewItem; state.previewSequence++; refs.previewMedia.replaceChildren(); if (refs.viewer.open) refs.viewer.close(); state.previewItem = null;
    if (!refs.dialog.open || !preview) return;
    const sameCard = [...refs.grid.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === `preview:${preview.item.id}`);
    const focus = preview.returnFocus?.isConnected ? preview.returnFocus : sameCard || (state.tab === 'library' ? refs.libraryTab : refs.candidateTab);
    focus.focus({ preventScroll: true });
  }
  function close() { stopPolling(); state.listSequence++; closePreview(); if (refs.dialog.open) refs.dialog.close(); if (state.returnFocus?.isConnected) state.returnFocus.focus({ preventScroll: true }); }
  async function open(options = {}) {
    mount(); const previousProject = state.projectId, previousCase = state.caseId; state.generation++; stopPolling(); state.previewSequence++; state.listSequence++; state.returnFocus = document.activeElement;
    state.loading = true; state.busy = false; state.error = ''; state.message = ''; refs.previewMedia.replaceChildren(); if (refs.viewer.open) refs.viewer.close();
    refs.grid.replaceChildren(element('div', 'ic-empty', '正在读取当前项目…')); refs.count.textContent = ''; if (!refs.dialog.open) refs.dialog.showModal(); renderStatus();
    const generation = state.generation;
    try {
      if (!api?.bootstrap) throw new Error('请重启 AIDesignHub 以加载项目接口。');
      const data = await api.bootstrap(); if (generation !== state.generation || !refs.dialog.open) return;
      const projectId = data?.project?.id; if (!projectId) throw new Error('请先创建或选择一个项目。');
      const validContext = !options.projectId || options.projectId === projectId;
      const caseId = validContext ? options.caseId || null : null;
      if (previousProject !== projectId || previousCase !== caseId) clearContext(projectId);
      state.projectId = projectId; state.projectName = data.project.name || '当前项目'; state.caseId = caseId; state.caseTitle = caseId ? String(options.title || '当前案例') : ''; state.loading = false;
      if (validContext && options.sourceUrl) refs.url.value = safeUrl(options.sourceUrl) || '';
      state.articleId = validContext ? options.articleId || state.articleId : null;
      state.tab = options.tab === 'library' ? 'library' : 'candidates'; refs.caseOnly.checked = Boolean(caseId); state.visible = 60; state.signature = ''; renderTabs(); renderGrid();
      if (!validContext) setError('项目已切换，已清除旧案例来源。请为当前项目重新输入链接。');
      const operation = capture(); loadLibrary();
      if (validContext && options.sessionId) {
        try { acceptSnapshot(await api.imageCollectionGet(options.sessionId), operation, options.sessionId); }
        catch { if (current(operation)) { state.session = null; state.tab = 'library'; state.message = '采集会话已结束，已保存的文章和原图仍可查看、导出。'; renderTabs(); renderGrid(); renderStatus(); } }
      } else if (state.session) await refreshSession();
      if (!current(operation)) return;
      if (validContext && options.collectAll && !busySession() && !state.articleId && refs.url.value) await archiveArticle();
      if (!current(operation)) return; schedulePoll(); (state.tab === 'candidates' ? refs.url : refs.libraryTab).focus({ preventScroll: true });
    } catch (error) { if (generation === state.generation && refs.dialog.open) { state.loading = false; setError(error.message || '项目读取失败。'); } }
  }
  function mount() {
    if (refs.dialog) return;
    const dialog = element('dialog', 'ic-dialog'); dialog.id = 'imageCollectionDialog'; dialog.setAttribute('aria-labelledby', 'imageCollectionTitle'); refs.dialog = dialog;
    const shell = element('div', 'ic-shell'), header = element('header', 'ic-header'), titleGroup = element('div');
    titleGroup.append(element('span', 'section-kicker', 'WEB IMAGE COLLECTION')); const title = element('h2', '', '网页图片与项目素材'); title.id = 'imageCollectionTitle'; refs.context = element('p', 'ic-context'); titleGroup.append(title, refs.context);
    const closeButton = button('关闭', close, 'secondary-button'); closeButton.id = 'imageCollectionClose'; header.append(titleGroup, closeButton);
    const tabs = element('div', 'ic-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '图片工作区'); refs.candidateTab = button('采集网页图片', () => switchTab('candidates')); refs.candidateTab.id = 'imageCollectionCandidatesTab'; refs.libraryTab = button('项目素材库', () => switchTab('library')); refs.libraryTab.id = 'imageCollectionLibraryTab';
    for (const node of [refs.candidateTab, refs.libraryTab]) { node.setAttribute('role', 'tab'); node.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target = event.key === 'Home' ? 'candidates' : event.key === 'End' ? 'library' : state.tab === 'candidates' ? 'library' : 'candidates'; switchTab(target); (target === 'library' ? refs.libraryTab : refs.candidateTab).focus(); } }); } tabs.append(refs.candidateTab, refs.libraryTab);
    const body = element('div', 'ic-body'); refs.oldBridge = element('p', 'ic-notice ic-warning', '当前窗口仍在运行旧版接口。请保存工作后重启 AIDesignHub，原有案例数据会保留。'); refs.oldBridge.setAttribute('role', 'status');
    const form = element('form', 'ic-collect-panel'); form.id = 'imageCollectionForm'; refs.collectPanel = form;
    refs.url = input('imageCollectionUrl', 'url'); refs.url.placeholder = 'https://…'; refs.url.autocomplete = 'off'; refs.url.spellcheck = false; refs.url.maxLength = 4096; refs.url.required = true;
    refs.mode = select('imageCollectionMode', [['static', '静态网页'], ['browser', '动态浏览器（独立窗口）']]); refs.mode.addEventListener('change', renderStatus);
    refs.start = button('开始采集', null, 'primary-button'); refs.start.id = 'imageCollectionStart'; refs.start.type = 'submit'; form.append(field('网页链接', refs.url), field('采集方式', refs.mode), refs.start); form.addEventListener('submit', event => { event.preventDefault(); startCollection(); });
    refs.modeNote = element('p', 'ic-mode-note'); form.append(refs.modeNote);
    const articleActions = element('div', 'ic-status-actions');
    refs.archiveAll = button('保存整篇文章与全部原图', () => archiveArticle(), 'primary-button'); refs.archiveAll.id = 'imageCollectionArchiveAll';
    refs.importHtml = button('导入浏览器保存的 HTML', () => archiveArticle(true)); refs.importHtml.id = 'imageCollectionImportHtml';
    articleActions.append(refs.archiveAll, refs.importHtml); form.append(articleActions, element('small', 'ic-mode-note', '微信若要求验证，请在浏览器正常打开，另存为“网页，全部”后导入 HTML；正文、同名 _files 文件夹中的图片和公开原图地址会一起采集。单篇最多 600 张候选，受限或超限会标为部分完成。'));
    const statusPanel = element('section', 'ic-status-panel'); refs.status = element('p', 'ic-status'); refs.status.setAttribute('role', 'status'); refs.status.setAttribute('aria-live', 'polite'); refs.progress = element('progress'); refs.progress.setAttribute('aria-label', '图片处理进度');
    const statusActions = element('div', 'ic-status-actions'); refs.stop = button('停止', cancelSession); refs.stop.id = 'imageCollectionStop'; refs.refresh = button('刷新', refreshSession); refs.refresh.id = 'imageCollectionRefresh'; refs.retry = button('重试失败项', () => retryFailed()); refs.retry.id = 'imageCollectionRetry'; statusActions.append(refs.stop, refs.refresh, refs.retry); refs.sessionSource = element('div', 'ic-session-source'); statusPanel.append(refs.status, statusActions, refs.progress, refs.sessionSource);
    refs.error = element('p', 'ic-notice ic-error'); refs.error.id = 'imageCollectionError'; refs.error.setAttribute('role', 'alert'); refs.message = element('p', 'ic-notice'); refs.message.setAttribute('role', 'status'); refs.errors = element('details', 'ic-errors');
    const filters = element('div', 'ic-filters'); refs.minWidth = input('imageCollectionMinWidth', 'number'); refs.minHeight = input('imageCollectionMinHeight', 'number'); for (const node of [refs.minWidth, refs.minHeight]) { node.min = '0'; node.max = '50000'; node.step = '1'; node.placeholder = '不限'; }
    refs.ratio = select('imageCollectionRatio', [['', '全部比例'], ['landscape', '横图'], ['portrait', '竖图'], ['square', '近方形'], ['panorama', '超宽图 ≥ 2:1']]);
    refs.format = select('imageCollectionFormat', [['', '全部格式'], ['JPG', 'JPG'], ['PNG', 'PNG'], ['WEBP', 'WebP'], ['GIF', 'GIF']]); refs.duplicate = select('imageCollectionDuplicate', [['', '包含重复图'], ['hide', '隐藏重复图'], ['only', '只看重复图']]);
    refs.hd = input('imageCollectionHd', 'checkbox'); const hd = element('label', 'ic-check'); hd.title = '长边至少 1600px，短边至少 900px'; hd.append(refs.hd, document.createTextNode('只看高清（≥1600×900）'));
    refs.duplicateField = field('重复图片', refs.duplicate); filters.append(field('最小宽度 px', refs.minWidth), field('最小高度 px', refs.minHeight), field('宽高比例', refs.ratio), field('图片格式', refs.format), refs.duplicateField, hd);
    for (const node of [refs.minWidth, refs.minHeight, refs.ratio, refs.format, refs.duplicate, refs.hd]) node.addEventListener('change', () => { state.visible = 60; state.signature = ''; renderGrid(); });
    const toolbar = element('div', 'ic-grid-toolbar'); refs.count = element('span', 'ic-count'); refs.libraryLoading = element('span', 'ic-loading', '正在读取素材库…'); refs.libraryLoading.hidden = true; refs.caseOnly = input('imageCollectionCaseOnly', 'checkbox'); refs.caseOnlyLabel = element('label', 'ic-check'); refs.caseOnlyLabel.append(refs.caseOnly, document.createTextNode('仅当前案例')); refs.caseOnly.addEventListener('change', () => { state.visible = 60; loadLibrary(); });
    refs.selectAll = button('全选可见', () => { const selected = state.tab === 'library' ? state.assetSelected : state.selected; for (const item of filteredItems().slice(0, state.visible)) if (selectable(item)) selected.add(item.id); renderGrid(true); }, 'text-button'); refs.selectAll.id = 'imageCollectionSelectAll'; refs.clear = button('清空选择', () => { (state.tab === 'library' ? state.assetSelected : state.selected).clear(); renderGrid(true); }, 'text-button'); toolbar.append(refs.count, refs.libraryLoading, refs.caseOnlyLabel, refs.selectAll, refs.clear);
    refs.grid = element('div', 'ic-image-grid'); refs.grid.id = 'imageCollectionGrid'; refs.more = button('显示更多', () => { state.visible += 60; renderGrid(); }); refs.more.classList.add('ic-more'); refs.more.id = 'imageCollectionMore';
    body.append(refs.oldBridge, tabs, form, statusPanel, refs.error, refs.message, refs.errors, filters, toolbar, refs.grid, refs.more);
    const footer = element('footer', 'ic-footer'); refs.selection = element('strong', 'ic-selection'); const savePanel = element('div', 'ic-save-panel'); refs.savePanel = savePanel; refs.note = element('textarea'); refs.note.id = 'imageCollectionNote'; refs.note.rows = 2; refs.note.maxLength = 2000; refs.note.placeholder = '可选：记录用途、设计参考或需要核实的信息'; refs.save = button('保存原图到当前项目', saveSelected, 'primary-button'); refs.save.id = 'imageCollectionSave'; savePanel.append(field('归档备注', refs.note), refs.save);
    refs.export = button('导出选中原图与来源清单', exportAssets, 'primary-button'); refs.export.id = 'imageCollectionExport'; refs.exportArticle = button('导出整篇文章与全部原图', exportArticle, 'primary-button'); refs.exportArticle.id = 'imageCollectionExportArticle'; footer.append(refs.selection, savePanel, refs.export, refs.exportArticle, element('small', 'ic-background-note', '关闭工作台后任务可在后台继续；需要结束请点击“停止”。'));
    shell.append(header, body, footer); dialog.append(shell); document.body.append(dialog);
    const viewer = element('dialog', 'ic-viewer'); viewer.id = 'imageCollectionViewer'; viewer.setAttribute('aria-labelledby', 'imageCollectionPreviewTitle'); refs.viewer = viewer; const viewerHeader = element('header', 'ic-viewer-header'); const viewerTitle = element('div'); refs.previewTitle = element('h3'); refs.previewTitle.id = 'imageCollectionPreviewTitle'; refs.previewMeta = element('p'); viewerTitle.append(refs.previewTitle, refs.previewMeta); viewerHeader.append(viewerTitle, button('关闭大图', closePreview, 'secondary-button')); refs.previewMedia = element('div', 'ic-preview-media'); refs.previewMedia.setAttribute('aria-live', 'polite'); refs.previewSources = element('footer', 'ic-preview-sources'); viewer.append(viewerHeader, refs.previewMedia, refs.previewSources); document.body.append(viewer);
    for (const target of [dialog, viewer]) { target.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); if (target === viewer) closePreview(); else close(); }); target.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (target === viewer) closePreview(); else close(); } }, true); }
    dialog.addEventListener('close', stopPolling);
  }
  mount();
  window.aidesignImageCollection = Object.freeze({ open, close });
  document.getElementById('openImageCollection')?.addEventListener('click', () => open());
  document.getElementById('openProjectImageLibrary')?.addEventListener('click', () => open({ tab: 'library' }));
  window.addEventListener('hub-project-changed', event => { close(); clearContext(event.detail?.projectId || null); });
  window.addEventListener('hub-view-changed', event => { if (event.detail?.view && event.detail.view !== 'cases' && refs.dialog.open) close(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPolling(); else schedulePoll(); });
  window.addEventListener('beforeunload', () => { state.generation++; stopPolling(); state.previewSequence++; state.listSequence++; });
})();
