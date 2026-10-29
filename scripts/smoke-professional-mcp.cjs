'use strict';

// Read-only MCP protocol acceptance. No tools are called. A temporary user
// environment contains upstream servers' startup logs and plugin auto-install.
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { buildProfessionalMcpEntries } = require('../backend/dsh-professional-mcp.cjs');

async function main() {
  const args = process.argv.slice(2);
  const value = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; };
  const payloadRoot = path.resolve(value('--payload-root') || path.join(__dirname, '..', '.runtime', 'professional-mcp'));
  const reportFile = value('--report');
  const nodeExe = value('--node') || process.execPath;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'adh-mcp-protocol-'));
  const entries = buildProfessionalMcpEntries({ payloadRoot, nodeExe, appData: path.join(scratch, 'no-router') });
  const reports = [];
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const entry = entries[next++];
        const home = path.join(scratch, entry.config.serverName);
        const roaming = path.join(home, 'AppData', 'Roaming');
        const local = path.join(home, 'AppData', 'Local');
        await Promise.all([mkdir(roaming, { recursive: true }), mkdir(local, { recursive: true }), mkdir(path.join(home, 'Documents'), { recursive: true })]);
        const env = { ...process.env, ...entry.config.env, APPDATA: roaming, LOCALAPPDATA: local,
          USERPROFILE: home, HOME: home, TMP: scratch, TEMP: scratch };
        delete env.ELECTRON_RUN_AS_NODE;
        const transport = new StdioClientTransport({ command: entry.config.command, args: entry.config.args, cwd: home, env, stderr: 'pipe' });
        let tail = '';
        transport.stderr?.on('data', chunk => { tail = `${tail}${chunk.toString('utf8')}`.slice(-1200); });
        const client = new Client({ name: 'aidesignhub-mcp-acceptance', version: '1.0.0' }, { capabilities: {} });
        const started = Date.now();
        let timer;
        try {
          await Promise.race([
            (async () => {
              await client.connect(transport, { timeout: 20000 });
              const result = await client.listTools({}, { timeout: 20000 });
              const startupPluginInstalled = entry.config.serverName === 'lightroom'
                ? existsSync(path.join(roaming, 'Adobe', 'Lightroom', 'Modules', 'LightroomMCP.lrplugin', 'Info.lua')) : undefined;
              if (startupPluginInstalled) throw new Error('MCP_STARTUP_INSTALLED_SOFTWARE_PLUGIN');
              const report = { server: entry.config.serverName, status: 'tools-listed', tools: result.tools.length,
                ...(startupPluginInstalled !== undefined ? { startupPluginInstalled } : {}), elapsedMs: Date.now() - started };
              reports.push(report); console.info(JSON.stringify(report));
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP_PROTOCOL_TIMEOUT')), 25000); }),
          ]);
        } catch (error) {
          const report = { server: entry.config.serverName, status: 'unavailable', error: error.message,
            diagnostic: tail.replaceAll(scratch, '<isolated-user>'), elapsedMs: Date.now() - started };
          reports.push(report); console.info(JSON.stringify(report));
        } finally {
          clearTimeout(timer);
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        }
      }
    }));
    reports.sort((a, b) => a.server.localeCompare(b.server));
    if (reportFile) {
      await mkdir(path.dirname(path.resolve(reportFile)), { recursive: true });
      await writeFile(reportFile, `${JSON.stringify({ protocolOnly: true, toolOperationsExecuted: 0, isolatedStartupProfile: true, reports }, null, 2)}\n`);
    }
    console.info(JSON.stringify({ listed: reports.filter(item => item.status === 'tools-listed').length, unavailable: reports.filter(item => item.status !== 'tools-listed').length, tools: reports.reduce((sum, item) => sum + (item.tools || 0), 0), toolOperationsExecuted: 0 }));
    if (reports.some(item => item.status !== 'tools-listed')) process.exitCode = 1;
  } finally {
    // scratch is the exact mkdtemp-owned temporary directory above.
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
