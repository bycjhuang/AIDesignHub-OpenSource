'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEXT = /\.(?:[cm]?js|jsx|tsx?|json|map|md|html?|css|ya?ml|toml|ini|cfg|cmd|ps1|py|txt|xml|example|npmrc)$/i;
const PRIVATE_PART = /^(?:\.env(?:\..+)?|\.npmrc|\.git|\.dsh|\.codex|\.claude|\.agents|npm-cache|__pycache__|model-private|device-settings-v1|team-skill-library-v1|chat-attachments|knowledge-files|agent-runs)$/i;
const PRIVATE_FILE = /^(?:agent-access|model-settings|model-secrets|agent-pairings|connection-private|auth|credentials|store)\.json(?:\..*)?$|\.(?:pfx|p12|pem|key|keystore)$/i;
const USER_PATH = /[A-Z]:[\\/]+Users[\\/]+([^\\/\r\n"'<>]+)/gi;
const SECRET = [
  ['api-key', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}/g],
  ['secret-literal', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[=:]\s*['"]([A-Za-z0-9_+\/-]{22,})['"]/gi],
];

function publicExample(name) { return /^\.env(?:\..+)?\.example$/i.test(name) || name === '.env.example'; }
function isPrivatePath(file) {
  const parts = file.split(/[\\/]/);
  const publicCaBundle = parts.at(-1) === 'cacert.pem';
  return parts.some(part => !publicExample(part) && PRIVATE_PART.test(part)) || (!publicCaBundle && PRIVATE_FILE.test(parts.at(-1)));
}
function synthetic(value) {
  return /(?:fixture|example|placeholder|dummy|never-a-real|(?:^|[-_])(?:test|fake)(?:[-_]|$)|abcdefghijklmnopqrstuvwxyz|real-api-key-for-local-tests)/i.test(value)
    || /^(?:x|a|0|1|2|3|4|5|6|7|8|9|\*){16,}$/i.test(value);
}
function inspectText(text, file) {
  const findings = [];
  const add = (rule, at) => findings.push({ file, line: text.slice(0, at).split('\n').length, rule });
  USER_PATH.lastIndex = 0;
  let match;
  // Upstream dependency docs and compiled build configs contain sample paths.
  // Exact private terms and recognizable key prefixes remain checked everywhere.
  const vendorExamples = /(?:^|\/)node_modules\/|(?:^|\/)professional-mcp\//.test(file);
  while ((match = USER_PATH.exec(text))) if (!vendorExamples && !/^(?:user|public|default|developer|tester|test|example|fixture)$/i.test(match[1])) add('personal-profile-path', match.index);
  for (const term of (process.env.ADH_RELEASE_PRIVATE_TERMS || '').split('|').filter(Boolean)) {
    let at = text.indexOf(term);
    while (at >= 0) { add('personal-identity', at); at = text.indexOf(term, at + term.length); }
  }
  for (const [rule, re] of SECRET) {
    if (rule === 'secret-literal' && vendorExamples && /\.d\.ts$/.test(file)) continue;
    re.lastIndex = 0;
    while ((match = re.exec(text))) {
      // This is Excalidraw's localStorage field name, not a credential value.
      if (rule === 'secret-literal' && match[1] === 'excalidraw-oai-api-key') continue;
      if (!synthetic(match[1] || match[0])) add(rule, match.index);
    }
  }
  return findings;
}
async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await walk(root);
  return files;
}
async function auditFiles(root, files, { checkPaths = true } = {}) {
  const findings = [];
  let checked = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (checkPaths && isPrivatePath(relative)) findings.push({ file: relative, rule: 'private-file' });
      if (TEXT.test(file)) {
        const bytes = await fs.readFile(file);
        if (!bytes.subarray(0, 4096).includes(0)) findings.push(...inspectText(bytes.toString('utf8'), relative));
      }
      checked += 1;
    }
  }));
  return { files: checked, findings: findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0)) };
}
async function auditDirectory(root) { return auditFiles(root, await listFiles(root)); }
async function auditSource(root) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
  const files = [];
  for (const name of new Set(names)) { const file = path.join(root, name); if ((await fs.stat(file).catch(() => null))?.isFile()) files.push(file); }
  return auditFiles(root, files);
}
module.exports = { auditDirectory, auditSource, inspectText, isPrivatePath, listFiles };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const index = process.argv.indexOf('--directory');
  const run = index >= 0 ? auditDirectory(path.resolve(process.argv[index + 1])) : auditSource(root);
  run.then(async result => {
    const destination = path.join(root, '.runtime', 'release-audit');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, index >= 0 ? 'package-audit.json' : 'source-audit.json'), JSON.stringify(result, null, 2));
    console.info(JSON.stringify({ files: result.files, findings: result.findings.length, locations: result.findings.slice(0, 35) }, null, 2));
    if (result.findings.length) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
