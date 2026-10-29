'use strict';
const path = require('node:path');
const { mkdir, readdir, readFile, writeFile } = require('node:fs/promises');

// Hub-owned copies only. Never overwrite an independently installed skill.
async function stageProfessionalSkills(dshHome, sourceRoot = path.join(__dirname, 'professional-skills')) {
  const result = [];
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const content = await readFile(path.join(sourceRoot, entry.name, 'SKILL.md'));
    const directory = path.join(dshHome, 'skills', entry.name);
    await mkdir(directory, { recursive: true });
    try { await writeFile(path.join(directory, 'SKILL.md'), content, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    result.push(entry.name);
  }
  return result;
}
module.exports = { stageProfessionalSkills };
