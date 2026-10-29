'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { acquireServiceLock } = require('../backend/service-lock.cjs');
const { applyResearchDemoProfiles } = require('../backend/project-research-profiles.cjs');
const directory = process.argv[process.argv.indexOf('--data-dir') + 1];
if (!process.argv.includes('--data-dir') || !path.isAbsolute(directory || '') || !fs.existsSync(path.join(directory, 'store.json'))) throw new Error('必须明确提供已有 Hub 数据目录：--data-dir <绝对路径>；请先关闭使用它的 Hub。');
const release = acquireServiceLock(directory);
try {
  const backup = path.join(directory, `store.before-research-profiles-${Date.now()}.json`);
  fs.copyFileSync(path.join(directory, 'store.json'), backup, fs.constants.COPYFILE_EXCL);
  const backend = new LocalBackend({ dataDir: directory }), result = applyResearchDemoProfiles(backend);
  console.log(JSON.stringify({ ...result, backup, projects: backend.store.projects.map(item => ({ id: item.id, name: item.name, researchProfile: item.researchProfile })) }));
} finally { release(); }
