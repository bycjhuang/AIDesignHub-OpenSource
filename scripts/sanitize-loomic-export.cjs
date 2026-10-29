'use strict';
const fs = require('node:fs');
const path = require('node:path');

function sanitizeBundle(source) {
  // Excalidraw's prebuilt dependency carries its upstream demo Firebase config.
  // Local mode has no Firebase service; clear only that named configuration.
  return source.replace(/\bVITE_APP_FIREBASE_CONFIG\s*:\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g, 'VITE_APP_FIREBASE_CONFIG:"{}"');
}
function sanitizeLoomicExport(directory) {
  let changed = 0;
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(target, 'utf8'), sanitized = sanitizeBundle(source);
        if (source !== sanitized) { fs.writeFileSync(target, sanitized); changed++; }
      }
    }
  };
  walk(directory); return changed;
}
module.exports = { sanitizeBundle, sanitizeLoomicExport };
if (require.main === module) console.info(`[local-canvas] cleared upstream demo cloud config in ${sanitizeLoomicExport(path.resolve(__dirname, '../Loomic-main/Loomic-main/apps/web/out'))} bundle(s)`);
