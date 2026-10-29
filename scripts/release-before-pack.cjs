'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

module.exports = async () => {
  const root = path.resolve(__dirname, '..');
  const licenses = require('./open-source-license.cjs').checkSource(root);
  if (!licenses.ok) throw new Error(`Source license materials are incomplete: ${JSON.stringify(licenses.findings)}`);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].filter(file => fs.existsSync(path.join(root, file))).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')).update('\n');
  const metadata = { schema: 1, gitCommit: git(['rev-parse', 'HEAD']).trim(), workingTreeDirty: Boolean(git(['status', '--porcelain']).trim()), sourceFiles: files.length, sourceSha256: hash.digest('hex'), node: process.version, platform: process.platform, arch: process.arch, builtAt: new Date().toISOString(), reproducibleBuildVerified: false };
  const target = path.join(root, '.runtime/release-audit/build-source.json');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(metadata, null, 2) + '\n');
};
