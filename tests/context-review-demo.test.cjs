'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture() {
  const events = [], forbidden = () => { throw new Error('Unexpected backend/network/storage access'); };
  const context = { window: { dispatchEvent: e => events.push(e) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, fetch: forbidden, localStorage: { setItem: forbidden }, sessionStorage: { setItem: forbidden } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../context-review-demo.js'), 'utf8'), context);
  return { api: context.window.aidesignContextReviewDemo, events, scope: { projectId: 'synthetic-project', memberId: 'synthetic-member' } };
}
test('context demo: ordinary messages do not create candidates and scope is required', () => {
  const { api, scope } = fixture();
  assert.equal(api.propose({ ...scope, source: 'group', text: '我们今天讨论一下方案。' }), null);
  assert.equal(api.propose({ ...scope, source: 'group', text: '@DesignHubExtra 未提及真正助手' }), null);
  assert.equal(api.snapshot(scope).items.length, 0);
  assert.throws(() => api.snapshot({ projectId: scope.projectId }));
});
test('context demo: ambiguity blocks approval until explicit associated clarification', () => {
  const { api, scope } = fixture();
  const item = api.propose({ ...scope, source: 'group', text: '@DesignHub 可能周五汇报，暂定。', sourceMessageId: 'message-a' });
  assert.equal(item.status, 'needs_clarification');
  assert.throws(() => api.review({ ...scope, id: item.id, decision: 'approve' }), /澄清/);
  assert.equal(api.clarify({ ...scope, id: item.id, text: '好的' }).status, 'needs_clarification');
  assert.equal(api.clarify({ ...scope, id: item.id, text: '应该周五，仍待确认。' }).status, 'needs_clarification');
  assert.equal(api.clarify({ ...scope, id: item.id, text: '已确认：周五下午两点汇报，由林澜负责。' }).status, 'pending');
  assert.equal(api.snapshot(scope).approved.length, 0);
});
test('context demo: approvals and duplicate source messages are idempotent; results are cloned', () => {
  const { api, scope, events } = fixture();
  const item = api.propose({ ...scope, source: 'assistant', text: '入口采用方案二，周四完成模型。', sourceMessageId: 'assistant-a' });
  const approved = api.review({ ...scope, id: item.id, decision: 'approve' });
  const count = events.length;
  assert.equal(api.review({ ...scope, id: item.id, decision: 'approve' }).reviewedAt, approved.reviewedAt);
  assert.equal(api.review({ ...scope, id: item.id, decision: 'reject' }).status, 'approved');
  assert.equal(events.length, count);
  assert.equal(api.propose({ ...scope, source: 'assistant', text: '重复来源不得再创建', sourceMessageId: 'assistant-a' }).id, item.id);
  const snapshot = api.snapshot(scope); snapshot.items[0].text = 'mutated'; snapshot.approved.length = 0;
  assert.notEqual(api.snapshot(scope).items[0].text, 'mutated');
  assert.equal(api.snapshot(scope).approved.length, 1);
  assert.equal(approved.reviewerLabel, '项目负责人（演示）');
  assert(events.every(e => e.type === 'hub-context-demo-changed'));
});
test('context demo: project/member isolation blocks cross-scope access and rejected items stay rejected', () => {
  const { api, scope } = fixture();
  const item = api.propose({ ...scope, source: 'group', text: '@DesignHub 已确定入口采用方案二。' });
  for (const other of [{ ...scope, projectId: 'other-project' }, { ...scope, memberId: 'other-member' }]) {
    assert.equal(api.snapshot(other).items.length, 0);
    assert.throws(() => api.review({ ...other, id: item.id, decision: 'approve' }), /不属于/);
    assert.throws(() => api.clarify({ ...other, id: item.id, text: '已确认：不得越界。' }), /不属于/);
  }
  assert.equal(api.review({ ...scope, id: item.id, decision: 'reject' }).status, 'rejected');
  assert.equal(api.review({ ...scope, id: item.id, decision: 'approve' }).status, 'rejected');
  assert.equal(api.snapshot(scope).approved.length, 0);
});
