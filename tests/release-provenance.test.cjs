'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fingerprint, verifyManifest, digest } = require('../scripts/release-manifest.cjs');
const { withPresentationProvenance } = require('../backend/export-provenance.cjs');

test('release verification detects modified installer, manifest and untrusted signer', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-release-proof-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(folder)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(folder), /^adh-release-proof-/); fs.rmSync(folder, { recursive: true, force: true }); });
  const pair = crypto.generateKeyPairSync('ed25519'), jwk = pair.publicKey.export({ format: 'jwk' });
  const binary = path.join(folder, 'fixture.exe'), manifest = path.join(folder, 'manifest.json'), signature = path.join(folder, 'signature.json'), key = path.join(folder, 'public.json');
  fs.writeFileSync(binary, 'synthetic-installer');
  const source = path.join(folder, 'fixture-source.zip'); fs.writeFileSync(source, 'synthetic-source');
  const bytes = Buffer.from(JSON.stringify({ schema: 1, version: 'fixture', releaseId: 'fixture', artifacts: [{ file: 'fixture.exe', bytes: fs.statSync(binary).size, sha256: await digest(binary) }, { file: 'fixture-source.zip', bytes: fs.statSync(source).size, sha256: await digest(source), role: 'corresponding-source' }] }));
  fs.writeFileSync(manifest, bytes); fs.writeFileSync(key, JSON.stringify(jwk));
  fs.writeFileSync(signature, JSON.stringify({ algorithm: 'Ed25519', keyFingerprint: fingerprint(jwk), signature: crypto.sign(null, bytes, pair.privateKey).toString('base64') }));
  assert.equal((await verifyManifest(manifest, signature, key)).valid, true);
  fs.appendFileSync(source, 'tamper'); await assert.rejects(verifyManifest(manifest, signature, key), /Artifact verification failed/);
  fs.writeFileSync(source, 'synthetic-source');
  fs.appendFileSync(binary, 'tamper'); await assert.rejects(verifyManifest(manifest, signature, key), /Artifact verification failed/);
  fs.writeFileSync(binary, 'synthetic-installer'); fs.appendFileSync(manifest, ' '); await assert.rejects(verifyManifest(manifest, signature, key), /signature is invalid/);
  fs.writeFileSync(manifest, bytes); fs.writeFileSync(key, JSON.stringify(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })));
  await assert.rejects(verifyManifest(manifest, signature, key), /signature is invalid/);
});

test('presentation provenance is applied after content without altering original slide content', async () => {
  const entries = [], metadata = {};
  const pptx = withPresentationProvenance({ subject: 'case', addSlide() { return { addText(text) { entries.push(text); } }; }, async writeFile() { metadata.subject = this.subject; return 'saved'; } });
  const slide = pptx.addSlide(); slide.addText('case facts');
  await pptx.writeFile(); await pptx.writeFile();
  assert.deepEqual(entries.slice(0, 1), ['case facts']);
  assert.equal(entries.filter(text => text.startsWith('Powered by AIDesignHub')).length, 1);
  assert.match(metadata.subject, /AIDesignHub\.SourceCanary\./);
});
