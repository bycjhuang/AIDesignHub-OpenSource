'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkSource } = require('./open-source-license.cjs');
const { auditSource } = require('./release-security.cjs');
const { digest } = require('./release-manifest.cjs');

async function archiveSource(root = path.resolve(__dirname, '..')) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const license = checkSource(root);
  if (!license.ok) throw new Error('Source license materials are incomplete. Run npm run audit:licenses.');
  if (git(['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Commit tracked source changes before creating the release source archive.');
  const audit = await auditSource(root);
  if (audit.findings.length) throw new Error(`Source privacy audit failed: ${JSON.stringify(audit.findings.slice(0, 12))}`);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const commit = git(['rev-parse', 'HEAD']).trim();
  const output = path.join(root, 'release'); fs.mkdirSync(output, { recursive: true });
  const file = `AIDesignHub-${version}-source.zip`;
  git(['archive', '--format=zip', `--prefix=AIDesignHub-${version}/`, '--output', path.join(output, file), 'HEAD']);
  const record = { schema: 1, version, license: 'AGPL-3.0-only', commit, file, bytes: fs.statSync(path.join(output, file)).size, sha256: await digest(path.join(output, file)), sourceFiles: audit.files };
  fs.writeFileSync(path.join(output, `AIDesignHub-${version}-source.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}
module.exports = { archiveSource };
if (require.main === module) archiveSource().then(result => console.info(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
