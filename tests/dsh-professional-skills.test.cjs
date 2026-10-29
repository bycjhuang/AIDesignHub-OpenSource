'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { stageProfessionalSkills } = require('../backend/dsh-professional-skills.cjs');
const { DEFAULT_EXCLUDED_SKILL_IDS } = require('../backend/dsh-skill-policy.cjs');
test('Hub stages fourteen usable professional skills without personal workflows or overwriting user skills', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'adh-professional-skills-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ids = await stageProfessionalSkills(home);
  assert.equal(ids.length, 14);
  for (const id of ids) {
    assert.ok(!DEFAULT_EXCLUDED_SKILL_IDS.includes(id));
    const body = await fs.readFile(path.join(home, 'skills', id, 'SKILL.md'), 'utf8');
    assert.match(body, /mcp__/);
    assert.doesNotMatch(body, /BYCJ_DESKTOP_EXTRAS|\\mcp-bridges\\/);
  }
  const file = path.join(home, 'skills', 'blender-modeling', 'SKILL.md');
  await fs.writeFile(file, 'user customization');
  await stageProfessionalSkills(home);
  assert.equal(await fs.readFile(file, 'utf8'), 'user customization');
});
