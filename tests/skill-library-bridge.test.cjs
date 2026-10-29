'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./fixtures/native-adh-backend-fixture.cjs');

test('native skill center shares the selected registry body under the active designer and survives project changes', async t => {
  const f = setup(t), service = f.service;
  const call = (operation, args = {}, caller = 'skill-library-ui') => service.handle({ action: `skill_library_${operation}`, caller, arguments: args });
  await assert.rejects(call('share', { skill: { id: 'design-fixture', content: 'untrusted' } }, 'tool'), error => error.code === 'USER_ACTION_REQUIRED');
  const original = f.backend.store.members.find(row => row.id === f.backend.store.settings.currentMemberId);
  const shared = await call('share', { skill: { id: 'design-fixture', displayName: '团队设计方法', description: '合成验收说明', layer: 'design', content: '# 合成技能\n保留人工复核。' } });
  assert.equal(shared.skill.author.name, original.name);
  assert.equal(shared.skill.author.id, original.id);
  assert.equal((await call('catalog')).teamSkills.length, 1);
  f.switchProject();
  const catalog = await call('catalog');
  assert.equal(catalog.teamSkills.length, 1);
  assert.equal(catalog.teamSkills[0].canUnshare, false);
  await assert.rejects(call('unshare', { id: shared.skill.id }));
  assert.equal((await call('body', { id: shared.skill.id, origin: 'local' })).skill.content, '# 合成技能\n保留人工复核。');
  assert.equal(f.counts().executionCalls, 0);
});

test('remote connection failures remain visible without hiding locally shared methods', async t => {
  const f = setup(t), service = f.service;
  const actual = service.teamSkills;
  service.teamSkills = { list: () => [{ id: 'local-1' }], status: () => ({ server: { running: false }, remote: { connected: true, url: 'http://192.168.1.2:47831' } }), async listRemote() { throw new Error('团队主机已离线'); }, stop() {} };
  t.after(() => { service.teamSkills = actual; });
  const response = await service.handle({ action: 'skill_library_catalog', caller: 'skill-library-ui' });
  assert.equal(response.teamSkills[0].id, 'local-1');
  assert.equal(response.sharing.remoteError, '团队主机已离线');
});
