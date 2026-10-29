#!/usr/bin/env node
'use strict';

const { connectionFromEnv, serviceRequest } = require('./hub-mcp.cjs');
const CATEGORIES = { project: /project/, tasks: /task/, skills: /skill/, runs: /run/ };

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(JSON.stringify({
      usage: ['node scripts/hub-cli.cjs list [project|tasks|skills|runs]', 'node scripts/hub-cli.cjs call <tool-name> \'{"field":"value"}\''],
      environment: ['AIDESIGNHUB_URL', 'AIDESIGNHUB_TOKEN'],
      note: 'Uses the running Hub service. Never reads the database or executes arbitrary commands.',
    }, null, 2) + '\n');
    return;
  }
  const connection = connectionFromEnv();
  if (argv[0] === 'list' && argv.length <= 2) {
    if (argv[1] && !CATEGORIES[argv[1]]) throw new Error('Unknown tool category');
    const result = await serviceRequest(connection, '/v1/tools');
    const tools = argv[1] ? result.tools.filter(tool => CATEGORIES[argv[1]].test(tool.name)) : result.tools;
    process.stdout.write(JSON.stringify({ tools }, null, 2) + '\n');
    return;
  }
  if (argv[0] === 'call' && argv.length >= 2 && argv.length <= 3) {
    let args;
    try { args = JSON.parse(argv[2] || '{}'); } catch { throw new Error('Tool arguments must be valid JSON'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
    const result = await serviceRequest(connection, '/v1/call', { method: 'POST', body: { name: argv[1], arguments: args } });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  throw new Error('Use list [category], call <tool-name> <JSON>, or --help');
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
