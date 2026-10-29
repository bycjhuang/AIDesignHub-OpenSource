(function (global) {
  'use strict';

  const PHASES = { load: '正在读取资料', import: '正在导入资料', extract: '正在提取正文', indexing: '正在建立索引', search: '正在检索资料', retrieve: '正在检索资料', map: '正在分批整理资料', reduce: '正在汇总结果', saving: '正在保存完整结果…', export: '正在准备导出', complete: '处理完成' };
  const idOf = (item) => item?.id || item?.libraryId || '';
  const nextId = () => global.crypto?.randomUUID?.() || `knowledge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const string = (value) => typeof value === 'string' ? value : '';
  function coverageText(coverage) {
    if (typeof coverage === 'string') return coverage;
    if (!coverage) return '';
    if (coverage.text || coverage.message) return string(coverage.text || coverage.message);
    const parts = [];
    if (coverage.scope === 'search') parts.push(`根据 ${coverage.processedSources ?? 0} 份相关资料回答，未逐份整理整库`);
    if (Number.isFinite(coverage.totalSources)) parts.push(`已处理 ${coverage.processedSources ?? 0}/${coverage.totalSources} 份资料`);
    if (Number.isFinite(coverage.totalChunks)) parts.push(`${coverage.processedChunks ?? 0}/${coverage.totalChunks} 个片段`);
    if (Array.isArray(coverage.warnings)) parts.push(...coverage.warnings.filter(warning => typeof warning === 'string'));
    return parts.join('，');
  }
  function sourceGroups(sources) {
    const groups = new Map();
    for (const source of sources) {
      const candidate = string(source.relativePath || source.originalPath || source.path || source.filePath);
      // Engine-owned copies have UUID storage folders, not user folder names.
      const internal = /[\\/]knowledge-workbench-v1[\\/]projects[\\/]|[\\/]files[\\/][0-9a-f-]{36}[\\/]/i.test(candidate);
      const full = (internal && !source.relativePath && !source.originalPath ? '' : candidate).replace(/\\/g, '/');
      const folder = full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : '';
      const label = folder || '资料文件';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(source);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([folder, items]) => ({ folder, items: items.sort((a, b) => string(a.name).localeCompare(string(b.name))) }));
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function button(label, action, className = 'kw-button', title) {
    const element = node('button', className, label);
    element.type = 'button';
    if (title) element.title = title;
    element.addEventListener('click', action);
    return element;
  }
  function appendInline(parent, value) {
    const tokens = String(value).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
    for (const token of tokens) {
      if (token.startsWith('**') && token.endsWith('**')) parent.append(node('strong', '', token.slice(2, -2)));
      else if (token.startsWith('`') && token.endsWith('`')) parent.append(node('code', '', token.slice(1, -1)));
      else parent.append(document.createTextNode(token));
    }
  }
  // Only text nodes and a small set of structural elements are created. Source
  // HTML, image URLs and links cannot execute inside knowledge answers.
  function appendMarkdown(parent, value) {
    const lines = string(value).split(/\r?\n/);
    const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const content = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) content.push(lines[i]);
        parent.append(node('pre', '', content.join('\n')));
      } else if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const wrapper = node('div', 'kw-table-wrap');
        const table = node('table');
        const head = node('thead'); const tr = node('tr');
        for (const cell of cells(line)) { const th = node('th'); appendInline(th, cell); tr.append(th); }
        head.append(tr); table.append(head); const body = node('tbody'); i++;
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
          const row = node('tr');
          for (const cell of cells(lines[++i])) { const td = node('td'); appendInline(td, cell); row.append(td); }
          body.append(row);
        }
        table.append(body); wrapper.append(table); parent.append(wrapper);
      } else if (/^#{1,4}\s/.test(line)) {
        const heading = node(/^#{1,2}\s/.test(line) ? 'h3' : 'h4'); appendInline(heading, line.replace(/^#+\s+/, '')); parent.append(heading);
      } else if (/^\s*[-*]\s+/.test(line)) {
        const list = node('ul');
        do { const li = node('li'); appendInline(li, lines[i].replace(/^\s*[-*]\s+/, '')); list.append(li); i++; } while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]));
        i--; parent.append(list);
      } else if (line.trim()) { const p = node('p'); appendInline(p, line); parent.append(p); }
    }
  }

  function createKnowledgeWorkbench({ api, getProject, toast = () => {} }) {
    const root = document.getElementById('knowledge-workbench-root');
    if (!root) throw new Error('Knowledge workbench mount is missing.');
    root.classList.add('knowledge-workbench');
    // This template is static. All project, source, question and answer values
    // below are assigned as text or form values, never as HTML.
    root.innerHTML = `
      <aside class="kw-sidebar" aria-label="知识库与资料">
        <header class="kw-sidebar-head"><div><h2>知识库</h2><p>项目资料，随问随查</p></div><button type="button" class="kw-icon-button" data-kw="create" aria-label="新建知识库" title="新建知识库">＋</button></header>
        <div class="kw-import"><button type="button" class="kw-button kw-primary" data-kw="files">添加文件</button><button type="button" class="kw-button" data-kw="folder">添加文件夹</button></div>
        <button type="button" class="kw-reindex" data-kw="reindex" title="重新读取原文件，更新解析和索引；不修改原文件">↻ 更新解析</button>
        <label class="kw-source-filter"><span aria-hidden="true">⌕</span><input type="search" data-kw="filter" placeholder="筛选资料文件…" aria-label="筛选资料文件"></label>
        <div class="kw-libraries" data-kw="libraries" aria-label="知识库文件夹"></div>
        <div class="kw-library-actions"><button type="button" class="kw-button" data-kw="rename">编辑知识库</button><button type="button" class="kw-button kw-danger" data-kw="remove-library">删除</button></div>
        <footer class="kw-summary" data-kw="summary"></footer>
      </aside>
      <main class="kw-main">
        <header class="kw-main-head"><div class="kw-heading"><h2 data-kw="title">项目知识库</h2><p data-kw="subtitle">选择左侧知识库开始</p></div><div class="kw-tabs" role="tablist" aria-label="知识库工作方式"><button type="button" role="tab" data-kw="chat-tab" aria-selected="true">资料问答</button><button type="button" role="tab" data-kw="search-tab" aria-selected="false">本地搜索</button></div></header>
        <div class="kw-banner" data-kw="banner" role="status" hidden></div>
        <div class="kw-error" data-kw="error" role="alert" hidden></div>
        <section class="kw-chat-panel" data-kw="chat-panel" role="tabpanel" aria-label="资料问答">
          <div class="kw-messages" data-kw="messages" aria-live="polite"></div>
          <form class="kw-composer" data-kw="ask-form">
            <div class="kw-options"><label>处理范围<select data-kw="scope" aria-label="处理范围"><option value="auto">自动判断</option><option value="search">相关资料问答</option><option value="all">整库完整整理</option></select></label><label>结果格式<select data-kw="format" aria-label="结果格式"><option value="auto">自动选择</option><option value="text">文字回答</option><option value="xlsx">Excel 表格</option><option value="docx">Word 文档</option><option value="pptx">PPT 演示</option></select></label></div>
            <textarea data-kw="question" rows="3" placeholder="询问资料中的要求，或让 AI 完整整理整库内容…" aria-label="知识库问题"></textarea>
            <div class="kw-compose-footer"><div class="kw-model"><span data-kw="model"></span><button type="button" class="kw-model-refresh" data-kw="model-refresh" aria-label="刷新模型配置" title="沿用 Hub 本机模型设置">↻</button></div><button type="submit" class="kw-button kw-primary" data-kw="send">发送问题</button><button type="button" class="kw-button kw-stop" data-kw="stop" hidden>停止处理</button></div>
            <p class="kw-disclosure" data-kw="disclosure"></p>
          </form>
        </section>
        <section class="kw-search-panel" data-kw="search-panel" role="tabpanel" aria-label="本地搜索" hidden>
          <form class="kw-search-form" data-kw="search-form"><input type="search" data-kw="search-query" placeholder="搜索关键字、条文或项目要求…" aria-label="搜索知识库原文"><button class="kw-button kw-primary" type="submit" data-kw="search-submit">搜索原文</button></form>
          <p class="kw-search-note">在本机索引中搜索，不调用生成模型。</p><div class="kw-search-results" data-kw="search-results"></div>
        </section>
        <div class="kw-progress" data-kw="progress" role="status" hidden><span class="kw-progress-dot" aria-hidden="true"></span><span data-kw="progress-label"></span></div>
      </main>
      <dialog class="kw-dialog" data-kw="dialog"></dialog>`;
    const $ = (name) => root.querySelector(`[data-kw="${name}"]`);
    const state = { projectId: '', libraries: [], libraryId: '', sources: [], summary: {}, messages: [], hits: [], searched: false, model: { configured: false }, busy: '', active: null, generation: 0, disposed: false, visible: false, collapsed: new Set() };
    const storageKey = (suffix) => `adh:knowledge:${state.projectId}:${state.libraryId}:${suffix}`;
    function readStored(key, fallback) { try { return JSON.parse(global.localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
    function writeStored(key, value) { try { global.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Draft stays in the current input if storage is unavailable. */ } }
    function saveDraft() { if (state.libraryId) writeStored(storageKey('draft'), { question: $('question').value, search: $('search-query').value, scope: $('scope').value, format: $('format').value }); }
    function loadDraft() {
      const draft = readStored(storageKey('draft'), {});
      $('question').value = string(draft.question); $('search-query').value = string(draft.search);
      $('scope').value = ['auto', 'search', 'all'].includes(draft.scope) ? draft.scope : 'auto';
      $('format').value = ['auto', 'text', 'xlsx', 'docx', 'pptx'].includes(draft.format) ? draft.format : 'auto';
    }
    function error(message) { const text = string(message); $('error').textContent = text.includes('KNOWLEDGE_RUNTIME_MISSING') ? '当前安装缺少知识库离线运行组件，请修复完整安装包。原有资料已保留。' : text; $('error').hidden = !message; }
    function notice(message) { $('banner').textContent = string(message); $('banner').hidden = !message; }
    const currentLibrary = () => state.libraries.find(library => idOf(library) === state.libraryId);
    const current = (generation) => !state.disposed && generation === state.generation;
    function setBusy(value) {
      state.busy = value;
      const pending = Boolean(value); const noLibrary = !state.libraryId;
      for (const name of ['files', 'folder', 'reindex', 'rename', 'remove-library', 'search-submit']) $(name).disabled = pending || noLibrary;
      $('create').disabled = pending || !state.projectId;
      $('send').disabled = pending || noLibrary || !$('question').value.trim() || !state.sources.length;
      $('search-query').disabled = pending || noLibrary;
      for (const name of ['question', 'scope', 'format']) $(name).disabled = pending;
      $('send').hidden = value === 'answer'; $('stop').hidden = value !== 'answer'; $('stop').disabled = false;
      $('progress').hidden = !pending;
      if (pending) $('progress-label').textContent = value === 'answer' ? '正在根据资料处理问题…' : value === 'search' ? '正在本地搜索…' : value === 'load' ? '正在读取知识库…' : value === 'export' ? '正在准备导出文件…' : '正在解析资料并更新本地索引…';
      root.querySelectorAll('[data-kw-library], [data-kw-source-remove]').forEach(element => { element.disabled = pending; });
    }
    function renderModel() {
      const configured = state.model?.configured;
      $('model').textContent = configured ? `回答模型：${state.model.model || state.model.provider || '本机配置模型'}` : '本地检索 · 未配置生成模型';
      $('model').title = configured ? `沿用 Hub 本机模型配置${state.model.provider ? `（${state.model.provider}）` : ''}` : '仍可搜索资料和提取原文；配置模型后可生成回答。';
      $('disclosure').textContent = configured ? '问答时，仅本次使用的资料文本会发送给已配置模型；原文件仍保存在本机。' : '当前可离线搜索和提取资料原文。需要 AI 生成回答时，请先在 Hub 设置中配置模型。';
    }
    function renderSummary() {
      const count = state.sources.filter(source => source.status === 'indexed').length;
      const chunks = state.summary.chunkCount ?? state.sources.reduce((sum, source) => sum + (Number(source.chunkCount) || 0), 0);
      $('summary').textContent = state.libraryId ? `${count}/${state.sources.length} 份资料可检索 · ${chunks} 个片段` : '资料保存在本机，按项目隔离。';
      const library = currentLibrary();
      $('title').textContent = library?.name || '项目知识库';
      $('subtitle').textContent = library ? (library.description || '基于项目原文回答，每个结论可回到出处核对。') : '新建知识库，再添加规范、合同、纪要或项目资料。';
    }
    function renderLibraries() {
      const list = $('libraries'); list.replaceChildren();
      if (!state.libraries.length) list.append(node('p', 'kw-empty-small', '还没有知识库。点击上方 ＋ 创建。'));
      const filter = $('filter').value.trim().toLocaleLowerCase();
      for (const library of state.libraries) {
        const id = idOf(library); const active = id === state.libraryId;
        const section = node('section', 'kw-library');
        const select = button('', () => void selectLibrary(id), `kw-library-select${active ? ' active' : ''}`);
        select.dataset.kwLibrary = id; select.disabled = Boolean(state.busy); select.setAttribute('aria-current', active ? 'true' : 'false');
        select.append(node('span', 'kw-folder-mark', active ? '▾' : '▸'), node('span', 'kw-library-name', library.name || '未命名知识库'), node('span', 'kw-file-count', active ? state.sources.length : (library.sourceCount ?? '')));
        section.append(select);
        if (active) {
          const tree = node('div', 'kw-source-tree');
          const visible = state.sources.filter(source => `${source.name || ''} ${source.relativePath || ''}`.toLocaleLowerCase().includes(filter));
          if (!visible.length) tree.append(node('p', 'kw-empty-small', filter ? '没有匹配的资料文件。' : '添加文件或文件夹，建立资料索引。'));
          for (const group of sourceGroups(visible)) {
            const branch = node('details', 'kw-source-folder'); branch.open = !state.collapsed.has(group.folder);
            const summary = node('summary'); summary.title = group.folder;
            summary.append(node('span', '', group.folder.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || '资料文件'));
            branch.append(summary); branch.addEventListener('toggle', () => { if (branch.open) state.collapsed.delete(group.folder); else state.collapsed.add(group.folder); });
            for (const source of group.items) {
              const row = node('div', 'kw-source-row');
              const view = button('', () => previewSource(source), 'kw-source-open', source.path || source.name);
              const status = source.status === 'indexed' ? '已索引' : source.status === 'error' ? '解析失败' : source.status === 'pending' ? '等待解析' : '未提取文字';
              view.append(node('span', 'kw-source-name', source.name || '未命名文件'), node('span', `kw-source-status${source.status === 'error' ? ' error' : ''}`, `${status} · ${source.chunkCount || 0} 片段`));
              // The migration banner already explains this shared notice. Keep
              // per-file warnings and the complete original message in details.
              const warning = string(source.error).split('已保留旧版片段；更新解析后可建立语义索引并处理完整正文。').join('').trim();
              if (source.error) view.title = [view.title, source.error].filter(Boolean).join('\n');
              if (warning) view.append(node('span', 'kw-source-error', warning));
              const remove = button('×', () => confirmRemoveSource(source), 'kw-source-remove'); remove.dataset.kwSourceRemove = source.id; remove.disabled = Boolean(state.busy); remove.setAttribute('aria-label', `移除 ${source.name}`);
              row.append(view, remove); branch.append(row);
            }
            tree.append(branch);
          }
          section.append(tree);
        }
        list.append(section);
      }
    }
    function citationPreview(hit) {
      const dialog = openDialog(hit.sourceName || hit.name || '资料出处');
      dialog.content.append(node('p', 'kw-citation-location', hit.locator || hit.path || '原文片段'), node('pre', 'kw-citation-text', hit.text || hit.content || '此处没有可预览的原文。'));
      if (hit.sourceId) dialog.footer.append(button('定位原文件', () => void revealSource(hit.sourceId)));
      dialog.footer.append(button('关闭', closeDialog));
    }
    function previewSource(source) {
      const dialog = openDialog(source.name || '资料文件');
      dialog.content.append(node('p', 'kw-citation-location', source.originalPath || source.relativePath || source.path || source.filePath || ''), node('p', '', source.error || `${source.chunkCount || 0} 个索引片段。可先在“本地搜索”中检索，再查看对应原文出处。`));
      dialog.footer.append(button('定位原文件', () => void revealSource(source.id)), button('关闭', closeDialog));
    }
    async function revealSource(sourceId) { try { await api.revealKnowledgeSource(state.projectId, state.libraryId, sourceId); } catch (cause) { error(cause.message || '无法定位原文件。'); } }
    function renderMessages() {
      const list = $('messages'); list.replaceChildren();
      if (!state.messages.length) {
        const empty = node('div', 'kw-welcome');
        empty.append(node('div', 'kw-welcome-icon', '▤'), node('h3', '', '让项目资料成为可核对的答案'), node('p', '', '先添加资料，再提问、比较要求，或完整整理整库记录。'));
        const examples = node('div', 'kw-examples');
        for (const label of ['提取资料中的关键设计要求', '比较各份资料中的指标差异', '完整整理所有记录，生成 Excel']) examples.append(button(label, () => { $('question').value = label; if (label.includes('所有记录')) { $('scope').value = 'all'; $('format').value = 'xlsx'; } saveDraft(); setBusy(state.busy); $('question').focus(); }, 'kw-example'));
        empty.append(examples); list.append(empty);
      }
      for (const message of state.messages) {
        const role = message.role === 'user' ? 'user' : 'assistant';
        const article = node('article', `kw-message kw-${role}${message.incomplete ? ' kw-incomplete' : ''}`);
        article.dataset.messageId = message.id || '';
        article.append(node('div', 'kw-message-label', role === 'user' ? '你的问题' : message.model?.used === false || message.model?.mode === 'extractive' ? '资料原文提取' : '知识库回答'));
        const content = node('div', 'kw-message-content'); appendMarkdown(content, message.content || message.answer || ''); article.append(content);
        const coverage = coverageText(message.coverage || message.scope);
        if (coverage) article.append(node('p', 'kw-coverage', coverage));
        if (message.incomplete) article.append(node('p', 'kw-incomplete-label', '此结果尚未完整处理，请核对覆盖范围。'));
        if (Array.isArray(message.citations) && message.citations.length) {
          const citations = node('div', 'kw-citations');
          message.citations.forEach((hit, index) => citations.append(button(`${index + 1}. ${hit.sourceName || '资料出处'}${hit.locator ? ` · ${hit.locator}` : ''}`, () => citationPreview(hit), 'kw-citation')));
          article.append(citations);
        }
        if (role === 'assistant' && message.exportId) {
          const exports = node('div', 'kw-exports'); exports.append(node('span', '', '导出结果'));
          for (const [format, label] of [['docx', 'Word'], ['xlsx', 'Excel'], ['pptx', 'PPT']]) exports.append(button(label, () => void exportResult(message.exportId, format), 'kw-export'));
          article.append(exports);
        }
        list.append(article);
      }
    }
    function renderSearch() {
      const list = $('search-results'); list.replaceChildren();
      if (!state.searched) { list.append(node('p', 'kw-search-empty', '输入关键字，查找资料中的原文与出处。')); return; }
      if (!state.hits.length) { list.append(node('p', 'kw-search-empty', '没有找到相关原文。可换一个关键字，或检查资料是否已成功索引。')); return; }
      list.append(node('p', 'kw-search-count', `找到 ${state.hits.length} 个相关片段`));
      for (const hit of state.hits) {
        const item = node('article', 'kw-search-hit');
        item.append(node('h3', '', hit.sourceName || '资料原文'), node('p', 'kw-citation-location', hit.locator || ''), node('p', 'kw-hit-text', hit.text || ''));
        item.append(button('查看出处', () => citationPreview(hit), 'kw-text-button')); list.append(item);
      }
    }
    function setMode(mode) {
      const chat = mode === 'chat';
      $('chat-panel').hidden = !chat; $('search-panel').hidden = chat;
      $('chat-tab').setAttribute('aria-selected', String(chat)); $('search-tab').setAttribute('aria-selected', String(!chat));
    }
    function openDialog(title) {
      const dialog = $('dialog'); if (dialog.open) dialog.close(); dialog.replaceChildren();
      const header = node('header'); const heading = node('h3', '', title); heading.id = 'kw-dialog-title';
      const close = button('×', closeDialog, 'kw-dialog-close'); close.setAttribute('aria-label', '关闭对话框'); header.append(heading, close);
      const content = node('div', 'kw-dialog-content'); const footer = node('footer');
      dialog.append(header, content, footer); dialog.setAttribute('aria-labelledby', heading.id); dialog.showModal();
      return { element: dialog, content, footer };
    }
    function closeDialog() { $('dialog').close(); }
    function editLibrary(library) {
      const editing = Boolean(library); const dialog = openDialog(editing ? '编辑知识库' : '新建知识库');
      const form = node('form', 'kw-library-form');
      const nameLabel = node('label', '', '知识库名称'); const nameInput = node('input'); nameInput.name = 'library-name'; nameInput.maxLength = 80; nameInput.required = true; nameInput.value = library?.name || ''; nameInput.setAttribute('aria-label', '知识库名称'); nameLabel.append(nameInput);
      const descriptionLabel = node('label', '', '说明（可选）'); const description = node('textarea'); description.name = 'library-description'; description.rows = 3; description.maxLength = 800; description.value = library?.description || ''; description.setAttribute('aria-label', '知识库说明'); descriptionLabel.append(description);
      const formError = node('p', 'kw-form-error'); formError.setAttribute('role', 'alert');
      form.append(nameLabel, descriptionLabel, formError); dialog.content.append(form);
      const save = button(editing ? '保存' : '创建', () => form.requestSubmit(), 'kw-button kw-primary'); dialog.footer.append(button('取消', closeDialog), save);
      const projectId = state.projectId; const generation = state.generation;
      form.addEventListener('submit', async event => {
        event.preventDefault(); const name = nameInput.value.trim(); if (!name) return;
        save.disabled = true; nameInput.disabled = true; description.disabled = true;
        try {
          const payload = { name, description: description.value.trim() };
          const result = editing ? await api.updateKnowledgeLibrary(projectId, idOf(library), payload) : await api.createKnowledgeLibrary(projectId, payload);
          if (!current(generation) || state.projectId !== projectId) return;
          closeDialog(); if (!editing) state.libraryId = idOf(result);
          await refresh(); toast(editing ? '知识库已更新' : '知识库已创建');
        } catch (cause) { if (current(generation)) formError.textContent = cause.message || '保存失败，请重试。'; }
        finally { save.disabled = false; nameInput.disabled = false; description.disabled = false; }
      });
      nameInput.focus();
    }
    function confirmAction(title, explanation, operation) {
      const dialog = openDialog(title); dialog.content.append(node('p', '', explanation));
      const confirm = button('确认移除', async () => { confirm.disabled = true; closeDialog(); await runMutation(operation, '资料索引已移除，原文件保持不变。'); }, 'kw-button kw-danger');
      dialog.footer.append(button('取消', closeDialog), confirm);
    }
    function confirmRemoveSource(source) {
      const projectId = state.projectId; const libraryId = state.libraryId;
      confirmAction(`移除「${source.name}」`, '仅从此知识库移除资料索引，不删除原文件。', () => api.removeKnowledgeSource(projectId, libraryId, source.id));
    }
    async function runMutation(operation, message = '') {
      if (state.busy) return;
      const generation = state.generation; error(''); setBusy('manage');
      try { const result = await operation(); if (!current(generation)) return; if (message) notice(message); await refresh(); return result; }
      catch (cause) { if (current(generation)) error(cause.message || '操作失败，请重试。'); }
      finally { if (current(generation)) setBusy(''); }
    }
    async function importSources(folder) {
      const projectId = state.projectId; const libraryId = state.libraryId;
      await runMutation(async () => {
        const result = await (folder ? api.chooseKnowledgeFolder(projectId, libraryId) : api.chooseKnowledgeFiles(projectId, libraryId));
        if (result?.added?.length || Number(result?.added) > 0) notice(`已导入 ${Array.isArray(result.added) ? result.added.length : result.added} 份资料${result.skipped?.length ? `，${result.skipped.length} 份已跳过` : ''}。`);
        return result;
      });
    }
    async function selectLibrary(libraryId) {
      if (state.busy || libraryId === state.libraryId) return;
      saveDraft(); state.libraryId = libraryId; state.collapsed.clear();
      writeStored(`adh:knowledge:${state.projectId}:active-library`, libraryId);
      await loadLibrary();
    }
    async function loadLibrary() {
      const generation = ++state.generation; const projectId = state.projectId; const libraryId = state.libraryId;
      state.sources = []; state.messages = []; state.hits = []; state.searched = false;
      loadDraft(); error(''); renderLibraries(); renderMessages(); renderSearch(); renderSummary();
      if (!libraryId) { setBusy(''); return; }
      setBusy('load');
      const results = await Promise.allSettled([api.listKnowledgeSources(projectId, libraryId), api.getKnowledgeHistory(projectId, libraryId)]);
      if (!current(generation)) return;
      if (results[0].status === 'fulfilled') { state.sources = results[0].value.sources || []; state.summary = results[0].value.summary || {}; }
      else error(results[0].reason?.message || '资料列表读取失败，请刷新重试。');
      if (results[1].status === 'fulfilled') state.messages = (results[1].value.messages || []).slice(-100);
      else error(results[1].reason?.message || '历史问答读取失败。');
      renderLibraries(); renderMessages(); renderSearch(); renderSummary(); setBusy('');
    }
    async function refreshModel() {
      try { state.model = await api.getKnowledgeModelStatus(); renderModel(); }
      catch { state.model = { configured: false }; renderModel(); }
    }
    async function refresh() {
      if (state.disposed) return;
      const project = getProject(); const projectId = typeof project === 'string' ? project : project?.id;
      if (!projectId) {
        saveDraft(); if (state.active) void api.cancelKnowledgeAnswer(state.active.id).catch(() => {});
        state.active = null; state.generation++; state.projectId = ''; state.libraryId = ''; state.libraries = []; state.sources = []; state.messages = []; state.hits = []; state.searched = false;
        $('question').value = ''; $('search-query').value = ''; closeDialog(); notice('');
        renderLibraries(); renderMessages(); renderSearch(); renderSummary(); error('请先选择项目。'); setBusy(''); return;
      }
      if (projectId === state.projectId && state.busy === 'answer') return;
      if (projectId !== state.projectId) {
        saveDraft();
        if (state.active) void api.cancelKnowledgeAnswer(state.active.id).catch(() => {});
        state.active = null; state.generation++; closeDialog(); state.projectId = projectId; state.libraryId = ''; state.libraries = []; state.sources = []; state.messages = []; state.hits = []; state.searched = false;
        $('question').value = ''; $('search-query').value = '';
        renderLibraries(); renderMessages(); renderSearch(); renderSummary();
      }
      const generation = ++state.generation; setBusy('load'); error('');
      try {
        const result = await api.listKnowledgeLibraries(projectId);
        if (!current(generation)) return;
        state.libraries = result.libraries || [];
        const preferred = state.libraryId || readStored(`adh:knowledge:${projectId}:active-library`, '');
        state.libraryId = state.libraries.some(library => idOf(library) === preferred) ? preferred : idOf(state.libraries[0]);
        writeStored(`adh:knowledge:${projectId}:active-library`, state.libraryId);
        if (result.migration?.message) notice(result.migration.message);
        else if (result.migration?.reindexRecommended) notice(`已保留原有 ${result.migration.originalSources || 0} 份资料及历史片段。可点击“更新解析”，读取原文件并建立完整索引。`);
        await loadLibrary();
        void refreshModel();
      } catch (cause) { if (current(generation)) { error(cause.message || '知识库读取失败，请刷新重试。'); setBusy(''); renderLibraries(); renderSummary(); } }
    }
    async function ask(event) {
      event?.preventDefault(); if (state.busy || !state.libraryId) return;
      const question = $('question').value.trim(); if (!question) return;
      saveDraft(); error(''); notice('');
      const generation = state.generation; const projectId = state.projectId; const libraryId = state.libraryId; const requestId = nextId();
      state.active = { id: requestId, projectId, libraryId, generation }; setBusy('answer');
      const user = { id: `${requestId}-user`, role: 'user', content: question };
      state.messages.push(user); renderMessages(); $('messages').scrollTop = $('messages').scrollHeight;
      try {
        const result = await api.answerKnowledgeLibrary(projectId, libraryId, { question, scope: $('scope').value, format: $('format').value, requestId });
        if (!current(generation) || state.active?.id !== requestId) return;
        state.messages.push({ ...result, id: `${requestId}-answer`, role: 'assistant', content: result.answer || result.content || '' });
        $('question').value = ''; saveDraft(); renderMessages(); $('messages').scrollTop = $('messages').scrollHeight;
      } catch (cause) {
        if (!current(generation) || state.active?.id !== requestId) return;
        const stopped = /cancel|abort|取消|停止/i.test(cause.message || '');
        const message = stopped ? '已停止处理。问题原文已保留，可检查资料后重新提交。' : (cause.message || '处理失败，问题原文已保留。');
        error(message); state.messages.push({ id: `${requestId}-failure`, role: 'assistant', content: message, coverage: cause.coverage, incomplete: true }); renderMessages();
      } finally { if (current(generation) && state.active?.id === requestId) { state.active = null; setBusy(''); } }
    }
    async function stop() {
      if (!state.active) return;
      const active = state.active;
      $('stop').disabled = true; $('progress-label').textContent = '正在停止处理…';
      try {
        const result = await api.cancelKnowledgeAnswer(active.id);
        if (!current(active.generation) || state.active?.id !== active.id) return;
        // Committing is an atomic save boundary. Keep awaiting the original ask
        // Promise so its complete answer/export pointer can still be presented.
        if (result?.committing) $('progress-label').textContent = '正在保存完整结果…';
        else if (result?.cancelled === false) $('progress-label').textContent = '正在等待处理结果…';
      } catch (cause) {
        if (!current(active.generation) || state.active?.id !== active.id) return;
        error(cause.message || '停止请求未成功，请重试。'); $('stop').disabled = false;
      }
    }
    async function search(event) {
      event?.preventDefault(); if (state.busy || !state.libraryId) return;
      const query = $('search-query').value.trim(); if (!query) return;
      const generation = state.generation; saveDraft(); error(''); setBusy('search');
      try {
        const result = await api.searchKnowledgeLibrary(state.projectId, state.libraryId, query);
        if (!current(generation)) return;
        state.hits = result.hits || []; state.searched = true; renderSearch();
      } catch (cause) { if (current(generation)) error(cause.message || '本地搜索失败，请重试。'); }
      finally { if (current(generation)) setBusy(''); }
    }
    async function exportResult(exportId, format) {
      if (state.busy) return;
      const generation = state.generation; error(''); setBusy('export');
      try {
        const result = await api.exportKnowledgeResult(state.projectId, state.libraryId, { exportId, format });
        if (current(generation) && result) { notice(`已导出：${result.suggestedName || result.filePath || '结果文件'}`); toast('知识库结果已导出'); }
      } catch (cause) { if (current(generation)) error(`回答已保留，导出未完成：${cause.message || '请重试。'}`); }
      finally { if (current(generation)) setBusy(''); }
    }
    $('create').addEventListener('click', () => editLibrary());
    $('rename').addEventListener('click', () => editLibrary(currentLibrary()));
    $('remove-library').addEventListener('click', () => {
      const library = currentLibrary(); if (!library) return;
      const projectId = state.projectId;
      confirmAction(`删除「${library.name}」`, '此库的索引和问答历史将被移除，原始资料文件不会删除。', async () => { await api.removeKnowledgeLibrary(projectId, idOf(library)); state.libraryId = ''; });
    });
    $('files').addEventListener('click', () => void importSources(false)); $('folder').addEventListener('click', () => void importSources(true));
    $('reindex').addEventListener('click', () => void runMutation(() => api.reindexKnowledgeLibrary(state.projectId, state.libraryId), '资料解析已更新。'));
    $('filter').addEventListener('input', renderLibraries); $('question').addEventListener('input', () => { saveDraft(); setBusy(state.busy); });
    for (const name of ['search-query', 'scope', 'format']) $(name).addEventListener('input', saveDraft);
    $('ask-form').addEventListener('submit', ask); $('stop').addEventListener('click', () => void stop()); $('search-form').addEventListener('submit', search);
    $('question').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void ask(); } });
    $('chat-tab').addEventListener('click', () => setMode('chat')); $('search-tab').addEventListener('click', () => setMode('search'));
    $('model-refresh').addEventListener('click', () => void refreshModel());
    $('dialog').addEventListener('click', event => { if (event.target !== $('dialog')) return; const rect = $('dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); });
    const unsubscribe = api.onKnowledgeProgress?.(event => {
      if (state.disposed || event.projectId !== state.projectId || event.libraryId !== state.libraryId || !state.busy) return;
      if (state.active && event.requestId !== state.active.id) return;
      const coverage = coverageText(event.coverage || event);
      $('progress-label').textContent = string(event.message) || [PHASES[event.phase] || '正在处理资料', coverage].filter(Boolean).join(' · ');
    });
    renderModel(); renderLibraries(); renderMessages(); renderSearch(); renderSummary(); setBusy('');
    return {
      refresh,
      async importFiles() {
        const project = getProject();
        if ((typeof project === 'string' ? project : project?.id) !== state.projectId) await refresh();
        if (state.busy || !state.projectId) return;
        if (!state.libraryId) { notice('先新建一个知识库，再添加项目资料。'); editLibrary(); return; }
        return importSources(false);
      },
      setVisible(visible) { const wasVisible = state.visible; state.visible = Boolean(visible); if (visible && !wasVisible) void refresh(); else if (!visible) saveDraft(); },
      dispose() { saveDraft(); state.disposed = true; state.generation++; unsubscribe?.(); if (state.active) void api.cancelKnowledgeAnswer(state.active.id).catch(() => {}); closeDialog(); },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { sourceGroups, coverageText };
  global.createKnowledgeWorkbench = createKnowledgeWorkbench;
})(typeof window === 'undefined' ? globalThis : window);
