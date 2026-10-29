'use strict';

// Explicit local acceptance: starts discovered, supported protocol/help entries
// but never sends a model prompt or imports a real project database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { LocalBackend } = require('../backend/local-backend.cjs');
const { AgentHub } = require('../backend/agent-hub.cjs');
const { AgentPairingService } = require('../backend/agent-pairing.cjs');

async function main() {
  if (!process.argv.includes('--probe-installed')) throw new Error('Pass --probe-installed to explicitly authorize local protocol/help checks.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidesignhub-agent-setup-'));
  const backend = new LocalBackend({ dataDir: path.join(root, 'normal') });
  const hub = new AgentHub({ backend });
  const pairings = new AgentPairingService({ hub, dataDir: path.join(root, 'device-settings-v1') });
  pairings.on('progress', progress => console.log(`${progress.stage}: ${progress.message}`));
  let demoHub;
  try {
    const result = await pairings.autoPair({ confirmed: true, useModel: false });
    const demo = new LocalBackend({ dataDir: path.join(root, 'demo') });
    demoHub = new AgentHub({ backend: demo });
    const restored = new AgentPairingService({ hub: demoHub, dataDir: path.join(root, 'device-settings-v1') }).restore();
    const passed = result.results.filter(item => item.ok);
    assert.equal(restored.restored.length, passed.length, 'The separate demo database restores the same device pairings');
    for (const item of restored.restored) assert.ok(!demoHub.connection(item.connectionId).verifiedAt, 'No model verification is copied');
    assert.equal(hub.state.jobs.length, 0);
    assert.equal(demoHub.state.jobs.length, 0);
    const report = {
      directory: root, noProjectJobs: true, modelCalled: false,
      installedProducts: [...new Set(result.discovery.candidates.filter(c => c.installed).map(c => c.provider))],
      checks: result.results.map(item => ({ provider: item.provider, ok: item.ok, code: item.validation?.code || item.code, message: item.message, attempts: item.attempts })),
      restoredInSeparateDatabase: restored.restored.map(item => item.provider),
    };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (passed.length < 3) process.exitCode = 1;
  } finally { hub.dispose(); demoHub?.dispose(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
