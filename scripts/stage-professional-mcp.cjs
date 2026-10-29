'use strict';

const path = require('node:path');
const { ensureProfessionalMcp } = require('../backend/dsh-professional-mcp.cjs');

const args = process.argv.slice(2);
const value = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; };
const sourceDir = value('--source');
const cacheRoot = path.resolve(value('--cache-root') || path.join(__dirname, '..', '.runtime'));
if (!sourceDir) {
  console.error('Usage: node scripts/stage-professional-mcp.cjs --source <offline mcp-bridges directory> [--cache-root <directory>]');
  process.exitCode = 1;
} else {
  ensureProfessionalMcp({ cacheRoot, sourceDir, onProgress: ({ complete, total }) => console.info(`[professional-mcp] ${complete}/${total} files verified`) })
    .then(({ payloadRoot, ready, manifest, previousPayloadRoot }) => console.info(JSON.stringify({ payloadRoot, ready, files: manifest.files, bytes: manifest.bytes, sha256: manifest.sha256, previousPayloadRoot })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
