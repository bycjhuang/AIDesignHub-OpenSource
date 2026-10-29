'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, createPublicKey, createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const authorityFile = path.join(process.env.LOCALAPPDATA || '', 'AIDesignHub', 'release-authority', 'private-key.dpapi');
const publicFile = path.join(root, 'assets', 'release-public-key.json');

function protect(value, decrypt = false) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Release authority requires Windows current-user DPAPI.');
  const script = decrypt
    ? 'Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : 'Add-Type -AssemblyName System.Security; $v=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Windows release-key protection failed. No private key is logged.');
  return result.stdout.trim();
}
function fingerprint(key) { return createHash('sha256').update(createPublicKey({ key, format: 'jwk' }).export({ type: 'spki', format: 'der' })).digest('hex'); }
function loadPrivateKey() {
  if (!fs.existsSync(authorityFile)) throw new Error('Local signing authority is missing. Initialize it explicitly with --init-authority.');
  const key = protect(fs.readFileSync(authorityFile, 'utf8'), true);
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  if (fingerprint(publicKey) !== fingerprint(JSON.parse(fs.readFileSync(publicFile, 'utf8')))) throw new Error('Local authority does not match the trusted repository public key.');
  return key;
}
function initialize() {
  if (!fs.existsSync(authorityFile)) {
    if (fs.existsSync(publicFile)) throw new Error('A public authority already exists; restore its private key instead of silently replacing it.');
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const encrypted = protect(pem);
    fs.mkdirSync(path.dirname(authorityFile), { recursive: true });
    fs.writeFileSync(authorityFile, encrypted, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(publicFile, JSON.stringify(pair.publicKey.export({ format: 'jwk' }), null, 2) + '\n');
  }
  const privateKey = loadPrivateKey();
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' });
  const version = require('../package.json').version;
  const identityFile = path.join(root, 'assets', 'release-identity.js');
  const prior = fs.existsSync(identityFile) ? require(identityFile) : null;
  const identity = prior?.version === version ? prior : {
    product: 'AIDesignHub', version, releaseId: `ADH-${version}-${randomUUID()}`,
    sourceCanary: `AIDesignHub.SourceCanary.${version}.${randomUUID()}`,
    officialRepository: 'https://github.com/bycjhuang/AIDesignHub-OpenSource',
    publicKeyFingerprint: fingerprint(publicKey), createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(identityFile, `'use strict';\n// Public per-release provenance marker; contains no user identity or secret.\n(function (root) {\n  const identity = Object.freeze(${JSON.stringify(identity, null, 2)});\n  if (typeof module === 'object' && module.exports) module.exports = identity;\n  else root.AIDesignHubRelease = identity;\n})(globalThis);\n`);
  fs.writeFileSync(path.join(root, 'assets/release-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'Loomic-main/Loomic-main/apps/web/src/lib/release-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  console.info(JSON.stringify({ version, releaseId: identity.releaseId, publicKeyFingerprint: fingerprint(publicKey), privateKeyProtection: 'Windows DPAPI CurrentUser' }));
}
module.exports = { fingerprint, loadPrivateKey };
if (require.main === module) {
  try { if (!process.argv.includes('--init-authority')) throw new Error('Use --init-authority to initialize or reuse the local release authority.'); initialize(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
