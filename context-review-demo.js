(() => {
  'use strict';
  // Shared renderer-only demo state. Deliberately no IPC, models, network or storage.
  const buckets = new Map();
  const copy = value => JSON.parse(JSON.stringify(value));
  const clean = (value, limit = 6000) => String(value ?? '').trim().slice(0, limit);
  const uncertainty = /可能|暂定|不确定|待确认|尚未确认|还没确认|没有确认|未确认|待定|也许|大概|或许|不清楚|再看看|需[^。！？\n]{0,12}确认|尚未决定|还没决定|没有决定|未决定|要不要|是否|待核实|不明确|[?？]/;
  const confirmed = /已确认|已经确认|确认[：:,，]|已确定|已经确定|确定[：:,，]|已决定|已经决定|决定|明确|最终|同意|不调整|取消|采用|执行|按.{1,30}(交付|执行|完成|推进)/;
  const mention = /@(?:Design\s?Hub|AIDesignHub)(?![A-Za-z0-9_])/i;
  const stripMention = text => text.replace(/@(?:Design\s?Hub|AIDesignHub)(?![A-Za-z0-9_])/gi, '').trim();
  const question = '这项信息是否已经确定？请补充明确结论（例如“已确认：……”），以及涉及的负责人或时间；仍未确定时请说明。';
  let sequence = 0;
  function scope(input) {
    const projectId = clean(input?.projectId, 240), memberId = clean(input?.memberId, 240);
    if (!projectId || !memberId) throw new Error('演示上下文需要明确的项目和当前身份。');
    return { projectId, memberId, key: JSON.stringify([projectId, memberId]) };
  }
  function changed(item) {
    window.dispatchEvent(new CustomEvent('hub-context-demo-changed', { detail: { projectId: item.projectId, memberId: item.memberId, id: item.id, status: item.status } }));
  }
  function find(input) {
    const s = scope(input), item = buckets.get(s.key)?.find(row => row.id === input.id);
    if (!item) throw new Error('此候选不属于当前项目或当前演示身份。');
    return item;
  }
  function propose(input) {
    const s = scope(input), source = input?.source;
    if (source !== 'group' && source !== 'assistant') throw new Error('候选来源必须是群聊或项目助手。');
    const raw = clean(input.text);
    // Group submissions need an explicit mention; ordinary conversations remain ordinary.
    if (source === 'group' && !mention.test(raw)) return null;
    const text = stripMention(raw);
    const list = buckets.get(s.key) || [];
    const sourceMessageId = clean(input.sourceMessageId, 240);
    const previous = sourceMessageId && list.find(row => row.source === source && row.sourceMessageId === sourceMessageId);
    if (previous) return copy(previous);
    const needsClarification = text.length < 6 || uncertainty.test(text);
    const reviewer = (Array.isArray(input.members) ? input.members : []).find(m => m.active !== false && ['pm', 'leader', 'owner', 'admin', 'project_manager', '项目经理', '公司负责人'].includes(m.role));
    const item = {
      id: `context_demo_${Date.now()}_${++sequence}`, projectId: s.projectId, memberId: s.memberId,
      text, source, sourceMessageId, status: needsClarification ? 'needs_clarification' : 'pending',
      question: needsClarification ? question : '', clarification: '', createdAt: new Date().toISOString(),
      reviewedAt: null, reviewerLabel: '项目负责人（演示）', reviewerName: clean(reviewer?.name || '项目负责人', 120),
      demo: true,
    };
    list.push(item); buckets.set(s.key, list); changed(item); return copy(item);
  }
  function clarify(input) {
    const item = find(input);
    if (item.status !== 'needs_clarification') return copy(item);
    const text = clean(input.text);
    if (!text) throw new Error('请先补充这条候选的明确结论。');
    item.clarification = text;
    const ready = text.length >= 6 && !uncertainty.test(text) && confirmed.test(text);
    if (ready) { item.status = 'pending'; item.question = ''; }
    else item.question = '这条补充仍不足以形成确定结论。请明确写出“已确认：具体结论”，或保留待澄清；不会自动提交审批。';
    changed(item); return copy(item);
  }
  function review(input) {
    if (!['approve', 'reject'].includes(input?.decision)) throw new Error('请选择批准或退回。');
    const item = find(input);
    // Terminal outcomes never flip on repeat clicks; duplicate approvals are idempotent.
    if (item.status === 'approved' || item.status === 'rejected') return copy(item);
    if (input.decision === 'approve' && item.status !== 'pending') throw new Error('候选尚未澄清，不能批准进入演示上下文。');
    item.status = input.decision === 'approve' ? 'approved' : 'rejected';
    item.reviewedAt = new Date().toISOString();
    changed(item); return copy(item);
  }
  function snapshot(input) {
    const s = scope(input), items = buckets.get(s.key) || [];
    return copy({ items, approved: items.filter(item => item.status === 'approved') });
  }
  window.aidesignContextReviewDemo = Object.freeze({ propose, clarify, review, snapshot });
})();
