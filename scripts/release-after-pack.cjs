'use strict';

const { auditDirectory } = require('./release-security.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ appOutDir }) => {
  const licenses = require('./open-source-license.cjs').checkPackaged(appOutDir);
  if (!licenses.ok) throw new Error(`Packaged license materials are incomplete: ${JSON.stringify(licenses.findings)}`);
  const knowledge = path.join(appOutDir, 'resources', 'knowledge');
  const inventory = JSON.parse(await fs.readFile(path.join(knowledge, 'production-dependencies.json'), 'utf8'));
  for (const name of inventory.roots) {
    await fs.access(path.join(knowledge, 'node_modules', name, 'package.json')).catch(() => { throw new Error(`Installer knowledge dependency missing: ${name}`); });
  }
  const result = await auditDirectory(appOutDir);
  await fs.writeFile(path.resolve(__dirname, '../.runtime/release-audit/packaged-audit.json'), JSON.stringify(result, null, 2));
  console.info(`[release-security] packaged files: ${result.files}; blocking findings: ${result.findings.length}`);
  if (result.findings.length) {
    // Print locations and rule names only, never the matched credential.
    for (const item of result.findings.slice(0, 30)) console.error(JSON.stringify(item));
    throw new Error('Installer privacy audit failed. See the locations above; no installer will be published.');
  }
};
