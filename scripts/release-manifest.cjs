'use strict';

// Standalone verifier: built-in Node modules only. Obtain the public key from a
// trusted repository copy, not solely from the same download as the installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function fingerprint(jwk) { return crypto.createHash('sha256').update(crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' })).digest('hex'); }
function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(file);
    stream.on('data', data => hash.update(data)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')));
  });
}
async function verifyManifest(manifestFile, signatureFile, keyFile) {
  const data = fs.readFileSync(manifestFile);
  const signature = JSON.parse(fs.readFileSync(signatureFile, 'utf8'));
  const jwk = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (signature.algorithm !== 'Ed25519' || signature.keyFingerprint !== fingerprint(jwk) || !crypto.verify(null, data, crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature.signature, 'base64'))) throw new Error('Release manifest signature is invalid.');
  const manifest = JSON.parse(data);
  if (manifest.schema !== 1 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Invalid release manifest.');
  for (const item of manifest.artifacts) {
    if (typeof item.file !== 'string' || /[\\/]/.test(item.file) || ['.', '..'].includes(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Unsafe artifact entry.');
    const file = path.join(path.dirname(manifestFile), item.file);
    if (fs.statSync(file).size !== item.bytes || await digest(file) !== item.sha256) throw new Error(`Artifact verification failed: ${item.file}`);
  }
  return { valid: true, version: manifest.version, releaseId: manifest.releaseId, artifacts: manifest.artifacts.length, keyFingerprint: signature.keyFingerprint };
}
async function signRelease(artifact, output, sourceArtifact) {
  const { loadPrivateKey } = require('./release-authority.cjs');
  const identity = require('../assets/release-identity.js');
  const jwk = JSON.parse(fs.readFileSync(path.join(root, 'assets/release-public-key.json'), 'utf8'));
  const build = JSON.parse(fs.readFileSync(path.join(root, '.runtime/release-audit/build-source.json'), 'utf8'));
  if (!sourceArtifact) throw new Error('An AGPL release must include --source <matching-source.zip>.');
  const sourceRecord = JSON.parse(fs.readFileSync(sourceArtifact.replace(/-source\.zip$/, '-source.json'), 'utf8'));
  if (sourceRecord.version !== identity.version || sourceRecord.commit !== build.gitCommit || build.workingTreeDirty || sourceRecord.sha256 !== await digest(sourceArtifact)) throw new Error('Installer and corresponding source do not match the same clean release baseline.');
  fs.mkdirSync(output, { recursive: true });
  const destination = path.join(output, path.basename(artifact));
  if (path.resolve(artifact) !== path.resolve(destination)) fs.copyFileSync(artifact, destination);
  const artifacts = [{ file: path.basename(destination), bytes: fs.statSync(destination).size, sha256: await digest(destination) }];
  if (sourceArtifact) {
    const sourceDestination = path.join(output, path.basename(sourceArtifact));
    if (path.resolve(sourceArtifact) !== path.resolve(sourceDestination)) fs.copyFileSync(sourceArtifact, sourceDestination);
    artifacts.push({ file: path.basename(sourceDestination), bytes: fs.statSync(sourceDestination).size, sha256: await digest(sourceDestination), role: 'corresponding-source' });
  }
  const manifest = { schema: 1, product: identity.product, version: identity.version, releaseId: identity.releaseId, sourceCanary: identity.sourceCanary, repository: identity.officialRepository, builtFrom: build, artifacts, signatureType: 'Ed25519 detached manifest; not Windows Authenticode', signedAt: new Date().toISOString() };
  const name = `AIDesignHub-${identity.version}.manifest.json`;
  const manifestFile = path.join(output, name);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(manifestFile, bytes);
  fs.writeFileSync(`${manifestFile}.sig.json`, JSON.stringify({ algorithm: 'Ed25519', keyFingerprint: fingerprint(jwk), signature: crypto.sign(null, bytes, loadPrivateKey()).toString('base64') }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
  fs.copyFileSync(path.join(root, 'assets/release-public-key.json'), path.join(output, 'AIDesignHub-release-public-key.json'));
  fs.copyFileSync(__filename, path.join(output, 'verify-release.cjs'));
  return verifyManifest(manifestFile, `${manifestFile}.sig.json`, path.join(root, 'assets/release-public-key.json'));
}
module.exports = { digest, fingerprint, verifyManifest };
if (require.main === module) {
  const value = flag => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
  const action = process.argv.includes('--verify')
    ? verifyManifest(path.resolve(value('--manifest')), path.resolve(value('--signature')), path.resolve(value('--key')))
    : process.argv.includes('--sign') ? signRelease(path.resolve(value('--artifact')), path.resolve(value('--output') || path.join(root, 'release')), value('--source') ? path.resolve(value('--source')) : undefined) : Promise.reject(new Error('Use --sign --artifact <exe> [--source <zip>], or --verify --manifest <json> --signature <sig.json> --key <trusted-public-key.json>.'));
  action.then(result => console.info(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
