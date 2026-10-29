(() => {
  'use strict';
  // A deliberately isolated, in-memory interaction demo. No IPC, fetch or model calls.
  const sessions = new Map();
  const roleLabels = { designer: '项目设计师', pm: '项目经理', project_manager: '项目经理', director: '设计总监', design_director: '设计总监', reviewer: '校审负责人', finance: '经营 / 财务', leader: '公司负责人', owner: '公司负责人', admin: '管理员' };
  const fallbackMembers = [{ id: 'demo_lin', name: '林澜', role: '项目经理' }, { id: 'demo_zhao', name: '赵工', role: '校审负责人' }, { id: 'demo_fang', name: '方敏', role: '经营 / 财务' }];
  const assistant = { id: '__demo_assistant', name: 'Design Hub', role: '演示助手' };
  const sampleImage = 'assets/aidesignhub-logo.png';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  let host, current, key, view = '', composing = false, modalReturnFocus, active = true, filePickerKey = null;
  const q = selector => host?.querySelector(selector);
  const member = id => id === assistant.id ? assistant : current.members.find(m => m.id === id) || { id, name: '项目成员', role: '成员' };
  const avatar = m => `<span class="cd-avatar ${m.id === assistant.id ? 'is-bot' : ''}">${esc(m.id === assistant.id ? '✦' : m.name.slice(0, 1))}</span>`;
  const button = (action, text, title = text, extra = '') => `<button type="button" data-cd-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${text}</button>`;
  const mentionsHub = text => /@(?:Design\s?Hub|AIDesignHub)(?![A-Za-z0-9_])/i.test(text);
  const reviewScope = () => ({ projectId: current.projectId, memberId: current.currentMemberId });
  const reviewSnapshot = () => window.aidesignContextReviewDemo?.snapshot(reviewScope()) || { items: [], approved: [] };
  const reviewItem = id => reviewSnapshot().items.find(item => item.id === id);

  function seed(s) {
    const colleague = s.members.find(m => m.id !== s.currentMemberId) || s.members[0];
    const second = s.members.find(m => m.id !== s.currentMemberId && m.id !== colleague.id) || colleague;
    return [
      { id: uid(), senderId: colleague.id, time: '09:12', text: '大家早上好，这里演示项目群的日常沟通。今天先核对首层方案，再一起讨论入口的空间关系。', files: [], sample: true },
      { id: uid(), senderId: s.currentMemberId, time: '09:16', text: '收到。我把汇报文件放到群里，大家可以引用具体消息继续讨论。', files: [{ id: uid(), name: '概念方案汇报_演示.pdf', bytes: 2483200, type: 'file', sample: true }], sample: true },
      { id: uid(), senderId: second.id, time: '09:20', text: '这是图片消息的预览示例，点击可以放大查看。', files: [{ id: uid(), name: '品牌图标_演示.png', bytes: 0, type: 'image', url: sampleImage, sample: true }], sample: true },
      { id: uid(), senderId: assistant.id, time: '09:21', text: '我是 Design Hub 演示助手。@DesignHub 可演示“提取候选 → 不确定时追问 → 项目负责人审批 → 进入演示上下文”。普通聊天不自动收录；这套固定逻辑不调用 AI，也不修改真实项目。', files: [], sample: true },
    ];
  }
  function makeSession(meta) {
    const s = { ...meta, draft: '', attachments: [], messages: [], reply: null, panel: null, popup: null, search: '', searchMember: '', searchType: '', memberQuery: '', simulatedRoles: {}, notice: '重要信息请在群里保留原文；任务、决策与归档由 Hub 管理。', flash: '', totalBytes: 0 };
    s.messages = seed(s);
    return s;
  }
  function shell() {
    host.innerHTML = `<header class="cd-header"><div><strong data-cd-group-title></strong><small data-cd-subtitle></small></div><nav aria-label="项目群操作">${button('search', '⌕', '查找聊天记录')}${button('members', '成员', '查看群成员')}${button('more', '···', '群设置')}</nav></header>
      <div class="cd-main"><section class="cd-conversation" aria-label="项目群聊天"><div class="cd-notice-strip">${button('notice', '群公告', '查看群公告')}</div><div class="cd-messages" role="log" aria-label="演示聊天记录" aria-live="polite"></div>
      <div class="cd-flash" role="status" hidden></div><form class="cd-composer"><div class="cd-toolbar" aria-label="消息工具">${button('emoji', '☺', '表情')}${button('file', '▱', '添加文件或图片')}${button('screenshot', '✂', '截图交互演示')}${button('voice', '♩', '语音输入演示')}${button('mention', '@', '提及成员')}</div><div class="cd-popup" hidden></div><div class="cd-reply-preview" hidden></div><div class="cd-attachments" hidden></div><textarea class="cd-input" rows="3" maxlength="4000" aria-label="项目群消息" placeholder="发送消息，输入 @ 提及成员…"></textarea><div class="cd-compose-foot"><button type="submit" class="cd-send">发送</button></div><input class="cd-file-input" type="file" multiple hidden></form></section><aside class="cd-panel" aria-label="群聊详情" hidden></aside></div><div class="cd-modal-root" hidden></div>`;
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('keydown', onKey);
    host.addEventListener('paste', onPaste);
    host.addEventListener('dragover', onDrag);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);
    q('.cd-composer').addEventListener('submit', send);
    q('.cd-input').addEventListener('compositionstart', () => { composing = true; });
    q('.cd-input').addEventListener('compositionend', () => { composing = false; });
  }
  function render() {
    if (!host || !current) return;
    q('[data-cd-group-title]').textContent = `${current.name} (${current.members.length + 1})`;
    q('[data-cd-subtitle]').textContent = '项目群聊';
    q('.cd-input').value = current.draft;
    renderMessages(); renderComposer(); renderPanel(); renderPopup();
  }
  function attachmentCard(file, inMessage = false) {
    const data = `data-cd-file="${esc(file.id)}"`;
    if (file.type === 'image') return `<button type="button" class="cd-image-card" ${data} aria-label="预览图片 ${esc(file.name)}"><img src="${esc(file.url)}" alt="${esc(file.name)}"><span>图片</span></button>`;
    return `<button type="button" class="cd-file-card" ${data}><span class="cd-file-icon">${esc(file.name.split('.').pop().slice(0, 4).toUpperCase() || 'FILE')}</span><span><strong>${esc(file.name)}</strong><small>${size(file.bytes)}</small></span></button>`;
  }
  function reviewCard(item) {
    if (!item) return '';
    const labels = { needs_clarification: '待澄清', pending: '待负责人审批', approved: '已进入演示上下文', rejected: '已退回' };
    const hints = { needs_clarification: item.question, pending: '候选已提交到演示审批区；尚未进入项目上下文。', approved: '项目负责人（演示）已批准。只进入本机演示上下文，不修改真实项目。', rejected: '项目负责人（演示）已退回。不会进入演示上下文。' };
    return `<section class="cd-review-card is-${esc(item.status)}" data-cd-review-card="${esc(item.id)}"><header><strong>上下文候选</strong><span>${labels[item.status]}</span></header><p>${esc(hints[item.status])}</p>${item.clarification ? `<blockquote>补充：${esc(item.clarification)}</blockquote>` : ''}<footer>${item.status === 'needs_clarification' ? `<button type="button" data-cd-clarify="${esc(item.id)}">补充这条信息</button>` : ''}<button type="button" data-cd-review-open="${esc(item.id)}">查看审批</button></footer></section>`;
  }
  function renderMessages(scroll = true) {
    const list = q('.cd-messages');
    if (!list) return;
    const oldTop = list.scrollTop, nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    const reviewItems = new Map(reviewSnapshot().items.map(item => [item.id, item]));
    list.innerHTML = `${current.messages.map(m => {
      const sender = member(m.senderId), own = m.senderId === current.currentMemberId;
      return `<article class="cd-message ${own ? 'is-own' : ''} ${m.senderId === assistant.id ? 'is-assistant' : ''}" id="cd-message-${esc(m.id)}" data-cd-message="${esc(m.id)}">${avatar(sender)}<div class="cd-message-content"><div class="cd-message-meta"><span>${esc(sender.name)}</span><time>${esc(m.time)}</time></div><div class="cd-bubble">${m.reply ? `<button type="button" class="cd-quoted" data-cd-jump="${esc(m.reply.id)}">${esc(m.reply.name)}：${esc(m.reply.text)}</button>` : ''}${m.text ? `<div class="cd-text">${esc(m.text)}</div>` : ''}${m.files.map(f => attachmentCard(f, true)).join('')}${m.contextReviewId ? reviewCard(reviewItems.get(m.contextReviewId)) : ''}</div><div class="cd-message-actions"><button type="button" data-cd-reply="${esc(m.id)}">引用</button>${m.text && !m.contextReviewId ? `<button type="button" data-cd-extract="${esc(m.id)}">整理为事项</button>` : ''}</div></div></article>`;
    }).join('')}`;
    if (scroll && nearBottom) list.scrollTop = list.scrollHeight; else list.scrollTop = oldTop;
  }
  function renderComposer() {
    const attachments = q('.cd-attachments'), reply = q('.cd-reply-preview');
    attachments.hidden = !current.attachments.length;
    attachments.innerHTML = current.attachments.map(f => `<div class="cd-pending">${attachmentCard(f)}<button type="button" data-cd-remove="${esc(f.id)}" aria-label="移除附件 ${esc(f.name)}">×</button></div>`).join('');
    reply.hidden = !current.reply;
    reply.innerHTML = current.reply ? `<span>${current.reply.clarifyId ? '补充这条候选' : '引用'} ${esc(current.reply.name)}：${esc(current.reply.text)}</span>${button('cancel-reply', '×', '取消引用')}` : '';
    q('.cd-send').disabled = !current.draft.trim() && !current.attachments.length;
    q('.cd-flash').hidden = !current.flash; q('.cd-flash').textContent = current.flash;
  }
  function filteredMessages() {
    const needle = current.search.trim().toLocaleLowerCase();
    return current.messages.filter(m => (!current.searchMember || m.senderId === current.searchMember) && (!needle || `${m.text} ${m.files.map(f => f.name).join(' ')}`.toLocaleLowerCase().includes(needle)) && (!current.searchType || current.searchType === 'text' && !!m.text || m.files.some(f => f.type === current.searchType)));
  }
  function renderPanelResults() {
    const region = q('.cd-search-results'); if (!region) return;
    const matches = filteredMessages();
    q('.cd-search-count').textContent = `${matches.length} 条演示记录`;
    region.innerHTML = matches.length ? matches.map(m => `<button type="button" class="cd-search-result" data-cd-jump="${esc(m.id)}"><span>${esc(member(m.senderId).name)} <time>${esc(m.time)}</time></span><strong>${esc(m.text || m.files.map(f => f.name).join('、'))}</strong><small>${m.files.length ? `${m.files.length} 个附件 · ` : ''}点击定位消息</small></button>`).join('') : '<div class="cd-empty">没有找到匹配记录<br><small>试试更短的关键词或其他筛选条件。</small></div>';
  }
  function renderMemberGrid() {
    const region = q('.cd-member-grid'); if (!region) return;
    const people = [...current.members, assistant].filter(m => `${m.name} ${current.simulatedRoles[m.id] || roleLabels[m.role] || m.role}`.toLocaleLowerCase().includes(current.memberQuery.toLocaleLowerCase()));
    region.innerHTML = people.length ? people.map(m => `<button type="button" class="cd-person" data-cd-person="${esc(m.id)}">${avatar(m)}<strong>${esc(m.name)}</strong><small>${esc(current.simulatedRoles[m.id] || roleLabels[m.role] || m.role || '项目成员')}</small></button>`).join('') : '<div class="cd-empty">没有找到成员</div>';
  }
  function renderPanel() {
    const panel = q('.cd-panel'); panel.hidden = !current.panel; host.classList.toggle('has-cd-panel', !!current.panel);
    if (!current.panel) { panel.replaceChildren(); return; }
    const title = current.panel === 'search' ? '查找聊天记录' : current.panel === 'settings' ? '群设置' : '群成员';
    panel.innerHTML = `<header><h3>${title}</h3>${button('close-panel', '×', '关闭详情')}</header>${current.panel === 'search' ? `<div class="cd-panel-controls"><input data-cd-search type="search" placeholder="搜索关键词或文件名" aria-label="查找聊天记录关键词" value="${esc(current.search)}"><div class="cd-search-filters"><select data-cd-search-member aria-label="按成员筛选"><option value="">全部成员</option>${[...current.members, assistant].map(m => `<option value="${esc(m.id)}" ${current.searchMember === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select><select data-cd-search-type aria-label="按消息类型筛选"><option value="">全部类型</option>${[['text', '文字'], ['image', '图片'], ['file', '文件']].map(([v, t]) => `<option value="${v}" ${current.searchType === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div><small class="cd-search-count"></small></div><div class="cd-search-results"></div>` : `<div class="cd-panel-controls"><input data-cd-member-query type="search" placeholder="搜索群成员" aria-label="搜索群成员" value="${esc(current.memberQuery)}"></div><div class="cd-member-grid"></div><div class="cd-group-details"><label>群聊名称<strong>${esc(current.name)}</strong></label><label>群公告<button type="button" data-cd-action="notice">${esc(current.notice)}</button></label><label>我在本群的昵称<strong>${esc(member(current.currentMemberId).name)}</strong></label><p>成员身份来自当前项目。这里的角色调整仅作演示，不修改真实权限。</p>${button('search', '查找聊天内容', '查找聊天内容')}${current.panel === 'settings' ? `<hr>${button('about', '演示说明', '演示说明')}` : ''}</div>`}`;
    renderPanelResults(); renderMemberGrid();
  }
  function renderPopup() {
    const popup = q('.cd-popup'); popup.hidden = !current.popup;
    popup.innerHTML = current.popup === 'emoji' ? ['😀', '👍', '✅', '🙏', '💡', '📌', '🎉', '👀'].map(e => `<button type="button" data-cd-emoji="${e}" aria-label="插入表情 ${e}">${e}</button>`).join('') : current.popup === 'mention' ? `<small>提及成员（演示，不发送通知）</small>${[...current.members, assistant].map(m => `<button type="button" data-cd-mention="${esc(m.id)}">${avatar(m)}<span>${esc(m.name)}</span></button>`).join('')}` : '';
  }
  function flash(text) { current.flash = text; renderComposer(); }
  function setPanel(panel) { current.panel = current.panel === panel ? null : panel; current.popup = null; renderPanel(); renderPopup(); if (current.panel) q('.cd-panel input')?.focus(); }
  function insert(text) {
    const input = q('.cd-input'); input.focus();
    const start = input.selectionStart, end = input.selectionEnd;
    input.setRangeText(text, start, end, 'end'); current.draft = input.value.slice(0, 4000); input.value = current.draft;
    current.popup = null; renderPopup(); renderComposer();
  }
  function send(event) {
    event?.preventDefault(); if (!current || !active) return;
    const text = current.draft.trim(); if (!text && !current.attachments.length) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const sent = { id: uid(), senderId: current.currentMemberId, text, files: current.attachments, reply: current.reply, time };
    current.messages.push(sent);
    current.attachments = []; current.reply = null; current.draft = ''; current.popup = null;
    q('.cd-input').value = '';
    if (sent.reply?.clarifyId || mentionsHub(text)) {
      const service = window.aidesignContextReviewDemo;
      try {
        if (!service) throw new Error('上下文审批演示尚未加载，请刷新窗口后重试。');
        const before = sent.reply?.clarifyId ? reviewItem(sent.reply.clarifyId) : null;
        const item = sent.reply?.clarifyId ? service.clarify({ ...reviewScope(), id: sent.reply.clarifyId, text }) : service.propose({ ...reviewScope(), text, source: 'group', sourceMessageId: sent.id, members: current.members });
        if (item) {
          sent.contextCandidateId = item.id;
          const response = item.status === 'needs_clarification' ? '这条信息需要先澄清，暂不进入审批或项目上下文。' : item.status === 'pending' ? '已生成上下文候选，等待项目负责人审批；目前还不是项目事实。' : before?.status === item.status ? '这条候选已有审批结果，本次普通补充没有改变已审批的内容。' : '演示候选状态已更新。';
          current.messages.push({ id: uid(), senderId: assistant.id, text: response, files: [], time, contextReviewId: item.id });
        }
      } catch (error) { current.messages.push({ id: uid(), senderId: assistant.id, text: error.message, files: [], time, sample: true }); }
    }
    current.flash = '仅显示在本机演示窗口，没有发送给成员或写入项目。';
    renderMessages(); renderComposer(); renderPopup(); renderPanelResults(); q('.cd-messages').scrollTop = q('.cd-messages').scrollHeight; q('.cd-input').focus();
  }
  function addFiles(files) {
    if (!current || !active) return;
    let added = 0, rejected = 0;
    for (const file of Array.from(files || [])) {
      if (current.attachments.length >= 5 || file.size > 12 * 1048576 || current.totalBytes + file.size > 40 * 1048576) { rejected++; continue; }
      const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
      const item = { id: uid(), name: file.name || '粘贴图片.png', bytes: file.size, type: isImage ? 'image' : 'file' };
      if (isImage) item.url = URL.createObjectURL(file);
      current.attachments.push(item); current.totalBytes += file.size; added++;
    }
    flash(`${added ? `已添加 ${added} 个本地附件，未上传。` : ''}${rejected ? '部分文件未添加：最多 5 个待发送附件、每个 12 MB、本项目演示合计 40 MB。' : ''}`);
  }
  function findFile(id) { return current.attachments.find(f => f.id === id) || current.messages.flatMap(m => m.files).find(f => f.id === id); }
  function closeModal() {
    const root = q('.cd-modal-root'); if (!root || root.hidden) return;
    root.hidden = true; root.replaceChildren(); modalReturnFocus?.isConnected && modalReturnFocus.focus(); modalReturnFocus = null;
  }
  function modal(title, html) {
    const root = q('.cd-modal-root'); modalReturnFocus = document.activeElement;
    root.innerHTML = `<div class="cd-modal" role="dialog" aria-modal="true" aria-labelledby="cd-modal-title" tabindex="-1"><header><h3 id="cd-modal-title">${esc(title)}</h3>${button('close-modal', '×', '关闭弹窗')}</header>${html}</div>`;
    root.hidden = false; root.querySelector('button')?.focus();
  }
  function filePreview(id) {
    const f = findFile(id); if (!f) return;
    modal(f.name, `${f.type === 'image' ? `<img class="cd-image-preview" src="${esc(f.url)}" alt="${esc(f.name)}">` : `<div class="cd-file-preview"><span>${esc(f.name.split('.').pop().toUpperCase())}</span><strong>${esc(f.name)}</strong><small>${size(f.bytes)}</small></div>`}<p>${f.sample ? '这是演示素材。' : '文件仅在当前窗口中预览，未上传。'}${f.type === 'file' ? '此版本演示文件卡片与信息，不解析正文、不归档，也不打开外部程序。' : ''}</p>`);
  }
  function roleModal(id) {
    const m = member(id);
    if (id === assistant.id) return modal('Design Hub 演示助手', '<p>在群中 @DesignHub 可演示上下文提取。不确定的信息先追问，明确后等待项目负责人审批；只有批准的内容进入演示上下文。</p><p>这是固定规则，不调用模型，也不修改真实项目记录或权限。</p>');
    const roles = ['项目设计师', '项目经理', '设计总监', '校审负责人', '经营 / 财务', '公司负责人'];
    const selected = current.simulatedRoles[id] || roleLabels[m.role] || m.role;
    if (selected && !roles.includes(selected)) roles.push(selected);
    modal(`${m.name} · 项目身份`, `<p>仅演示管理员调整身份的交互，不修改本项目真实成员或权限。</p><label class="cd-modal-label">演示角色<select data-cd-role>${roles.map(r => `<option ${r === selected ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label><button type="button" class="cd-primary" data-cd-save-role="${esc(id)}">应用到演示</button>`);
  }
  function jump(id) {
    current.panel = null; renderPanel();
    const target = Array.from(q('.cd-messages').children).find(el => el.dataset.cdMessage === id);
    if (!target) return flash('引用消息暂不在当前演示中。');
    target.scrollIntoView({ block: 'center', behavior: 'auto' }); target.classList.add('cd-highlight');
    setTimeout(() => target.classList.remove('cd-highlight'), 1800);
  }
  function onClick(event) {
    const b = event.target.closest('button'); if (!b || !host.contains(b) || !current || !active) return;
    if (b.dataset.cdFile) return filePreview(b.dataset.cdFile);
    if (b.dataset.cdRemove) { const index = current.attachments.findIndex(f => f.id === b.dataset.cdRemove); if (index >= 0) { const [f] = current.attachments.splice(index, 1); current.totalBytes -= f.bytes; if (f.url?.startsWith('blob:')) URL.revokeObjectURL(f.url); } return renderComposer(); }
    if (b.dataset.cdReply) { const m = current.messages.find(m => m.id === b.dataset.cdReply); if (!m) return; const item = reviewItem(m.contextReviewId || m.contextCandidateId); current.reply = { id: m.id, name: member(m.senderId).name, text: (m.text || m.files.map(f => f.name).join('、')).slice(0, 100), ...(item?.status === 'needs_clarification' ? { clarifyId: item.id } : {}) }; renderComposer(); return q('.cd-input').focus(); }
    if (b.dataset.cdClarify) {
      const item = reviewItem(b.dataset.cdClarify);
      if (!item || item.status !== 'needs_clarification') return flash('这条候选目前不需要补充，请查看最新审批状态。');
      const receipt = [...current.messages].reverse().find(m => m.contextReviewId === item.id);
      current.reply = { id: receipt?.id || item.sourceMessageId, name: assistant.name, text: (item.text || item.question).slice(0, 100), clarifyId: item.id };
      renderComposer(); return q('.cd-input').focus();
    }
    if (b.dataset.cdReviewOpen) {
      const target = document.querySelector('.nav-item[data-view="files"]');
      if (!target) return flash('请在“项目上下文”演示区查看审批；群聊内不能直接批准。');
      window.aidesignHubChatUI?.close(); target.click(); window.dispatchEvent(new CustomEvent('hub-context-demo-focus', { detail: { ...reviewScope(), id: b.dataset.cdReviewOpen } })); return;
    }
    if (b.dataset.cdJump) return jump(b.dataset.cdJump);
    if (b.dataset.cdPerson) return roleModal(b.dataset.cdPerson);
    if (b.dataset.cdSaveRole) { current.simulatedRoles[b.dataset.cdSaveRole] = q('[data-cd-role]').value; closeModal(); renderMemberGrid(); return flash('演示角色已更新，真实团队权限没有改变。'); }
    if (b.dataset.cdEmoji) return insert(b.dataset.cdEmoji);
    if (b.dataset.cdMention) { const text = `@${member(b.dataset.cdMention).name} `; const input = q('.cd-input'); if (input.value.slice(0, input.selectionStart).endsWith('@')) input.setSelectionRange(input.selectionStart - 1, input.selectionStart); return insert(text); }
    if (b.dataset.cdExtract) { const m = current.messages.find(m => m.id === b.dataset.cdExtract); return modal('整理为事项 · 演示预览', `<p>将消息交给 Hub 整理，然后由人确认。这一步目前只演示界面，不写入任务、风险或档案。</p><blockquote>${esc(m.text)}</blockquote><label class="cd-modal-label">事项类型<select><option>待办任务</option><option>项目决策</option><option>风险提醒</option></select></label><label class="cd-modal-label">事项内容<textarea rows="3">${esc(m.text)}</textarea></label>${button('extract-done', '完成演示（不写入）', '完成演示，不写入项目', 'class="cd-primary"')}`); }
    switch (b.dataset.cdAction) {
      case 'search': return setPanel('search');
      case 'members': return setPanel('members');
      case 'more': return setPanel('settings');
      case 'close-panel': current.panel = null; return renderPanel();
      case 'emoji': case 'mention': current.popup = current.popup === b.dataset.cdAction ? null : b.dataset.cdAction; return renderPopup();
      case 'file': filePickerKey = key; q('.cd-file-input').value = ''; return q('.cd-file-input').click();
      case 'cancel-reply': current.reply = null; return renderComposer();
      case 'close-modal': return closeModal();
      case 'extract-done': closeModal(); return flash('事项整理演示结束。');
      case 'notice': return modal('群公告', `<p>${esc(current.notice)}</p>`);
      case 'about': return modal('说明', '<p>聊天消息、附件、引用、搜索与角色调整仅存于当前页面内存，切换项目分别保留，刷新后清空。@DesignHub 提取候选，负责人批准后进入上下文。</p>');
      case 'screenshot': return modal('截图', `<p>粘贴已截好的图片，或添加一张本地示例图预览。</p><img class="cd-sample-image" src="${sampleImage}" alt="本地品牌图标示例">${button('sample-screenshot', '添加示例图片', '添加示例图片', 'class="cd-primary"')}`);
      case 'sample-screenshot': if (current.attachments.length >= 5) { closeModal(); return flash('最多添加 5 个待发送附件。'); } current.attachments.push({ id: uid(), name: '截图交互_示例图.png', type: 'image', bytes: 0, url: sampleImage, sample: true }); closeModal(); return flash('已添加示例图。');
      case 'voice': return modal('语音输入', `<div class="cd-voice-sample" aria-hidden="true">▂ ▄ ▆ ▃ ▇ ▅ ▂ ▆ ▄ ▂</div><p>将语音转为可编辑文字，由你确认发送。</p><blockquote>刚接到业主电话，周五先比较两种入口方案，最终方向还需要书面确认。</blockquote>${button('sample-voice', '填入示例转写文字', '填入示例转写文字', 'class="cd-primary"')}`);
      case 'sample-voice': closeModal(); insert('刚接到业主电话，周五先比较两种入口方案，最终方向还需要书面确认。'); return flash('已填入示例文字，请编辑后发送。');
    }
  }
  function onInput(event) {
    if (!current || !active) return;
    if (event.target.matches('.cd-input')) { current.draft = event.target.value; renderComposer(); if (event.target.value.slice(0, event.target.selectionStart).endsWith('@')) { current.popup = 'mention'; renderPopup(); } }
    else if (event.target.matches('[data-cd-search]')) { current.search = event.target.value; renderPanelResults(); }
    else if (event.target.matches('[data-cd-member-query]')) { current.memberQuery = event.target.value; renderMemberGrid(); }
  }
  function onChange(event) {
    if (event.target.matches('.cd-file-input')) { if (current && active && filePickerKey === key) addFiles(event.target.files); event.target.value = ''; filePickerKey = null; return; }
    if (!current || !active) return;
    if (event.target.matches('[data-cd-search-member]')) { current.searchMember = event.target.value; renderPanelResults(); }
    else if (event.target.matches('[data-cd-search-type]')) { current.searchType = event.target.value; renderPanelResults(); }
  }
  function onKey(event) {
    if (!current || !active) return;
    const modalRoot = q('.cd-modal-root');
    if (!modalRoot.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModal(); }
      if (event.key === 'Tab') { const nodes = Array.from(modalRoot.querySelectorAll('button,input,textarea,select,[tabindex="0"]')); const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
      return;
    }
    if (event.key === 'Escape') { if (current.popup) { current.popup = null; renderPopup(); } else if (current.panel) { current.panel = null; renderPanel(); } }
    if (event.target.matches('.cd-input') && event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); send(); }
  }
  function onPaste(event) { if (!active || !event.target.matches('.cd-input')) return; const files = Array.from(event.clipboardData?.files || []); if (files.length) { event.preventDefault(); addFiles(files); } }
  function onDrag(event) { if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return; event.preventDefault(); if (active) host.classList.add('cd-dragging'); }
  function onDragLeave(event) { if (!host.contains(event.relatedTarget)) host.classList.remove('cd-dragging'); }
  function onDrop(event) { host.classList.remove('cd-dragging'); if (!event.dataTransfer?.files?.length) return; event.preventDefault(); if (active) addFiles(event.dataTransfer.files); }
  function onContextChanged(event) {
    if (!host || !current || event.detail?.projectId !== current.projectId || event.detail?.memberId !== current.currentMemberId) return;
    renderMessages(false); renderPanelResults();
  }
  function mount(container) {
    if (!container || host === container) return;
    if (host) dispose(); host = container; host.classList.add('hub-chat-demo'); shell(); window.addEventListener('hub-context-demo-changed', onContextChanged); if (current) render();
  }
  function setProject(meta) {
    if (!meta?.projectId) return;
    const members = (Array.isArray(meta.members) && meta.members.length ? meta.members : fallbackMembers).filter(m => m.active !== false).map(m => ({ id: String(m.id), name: String(m.name || '项目成员'), role: String(m.role || '项目成员') }));
    const currentMemberId = String(meta.currentMemberId || members[0]?.id || 'demo_me');
    if (!members.some(m => m.id === currentMemberId)) members.unshift({ id: currentMemberId, name: '我', role: '项目成员' });
    const normalized = { projectId: String(meta.projectId), name: String(meta.name || '当前项目'), members, currentMemberId };
    const nextKey = JSON.stringify([normalized.projectId, currentMemberId]);
    const signature = JSON.stringify(normalized), existing = sessions.get(nextKey);
    if (nextKey === key && existing?.signature === signature) return;
    if (host) closeModal();
    if (existing) { Object.assign(existing, normalized); existing.signature = signature; current = existing; }
    else { current = makeSession(normalized); current.signature = signature; sessions.set(nextKey, current); }
    key = nextKey; render();
  }
  function setView(label) { view = String(label || ''); /* Group messages stay project-scoped, not page-scoped. */ }
  function setActive(value) {
    active = value === true;
    if (!host) return;
    host.inert = !active;
    if (!active) { closeModal(); filePickerKey = null; composing = false; host.classList.remove('cd-dragging'); if (current) { current.popup = null; renderPopup(); } }
  }
  function refresh() { if (current) render(); }
  function dispose() {
    window.removeEventListener('hub-context-demo-changed', onContextChanged);
    if (host) { for (const [type, handler] of [['click', onClick], ['input', onInput], ['change', onChange], ['keydown', onKey], ['paste', onPaste], ['dragover', onDrag], ['dragleave', onDragLeave], ['drop', onDrop]]) host.removeEventListener(type, handler); host.replaceChildren(); }
    for (const s of sessions.values()) for (const f of [...s.attachments, ...s.messages.flatMap(m => m.files)]) if (f.url?.startsWith('blob:')) URL.revokeObjectURL(f.url);
    sessions.clear(); current = null; key = null; host = null;
  }
  window.aidesignChatDemo = { mount, setProject, setView, setActive, refresh, dispose };
})();
