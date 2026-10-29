'use strict';

const readline = require('node:readline');
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (mode.startsWith('acp')) {
  const reader = readline.createInterface({ input: process.stdin });
  let pendingPrompt;
  reader.on('line', line => {
    const request = JSON.parse(line);
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      if (request.params.clientCapabilities.terminal !== false || request.params.clientCapabilities.fs.writeTextFile !== false) process.exit(3);
      reply({ protocolVersion: mode === 'acp-version' ? 2 : 1, agentCapabilities: {} });
    } else if (request.method === 'session/new') reply({ sessionId: 'fake-session' });
    else if (request.method === 'session/prompt') {
      if (mode === 'acp-hang') { pendingPrompt = request.id; return; }
      pendingPrompt = request.id;
      if (mode === 'acp-noisy') process.stdout.write('Warning: browser helper started\n');
      send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {
        sessionId: 'fake-session', options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }],
      } });
    } else if (request.id === 99 && request.result) {
      if (request.result.outcome.optionId !== 'no') process.exit(4);
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', status: 'completed' } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP verified' } } } });
      send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: mode === 'acp-partial' ? 'max_tokens' : 'end_turn' } });
    } else if (request.method === 'session/cancel') {
      send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } });
      process.exit(0);
    }
  });
  reader.on('close', () => process.exit(0));
} else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'flood') process.stdout.write('x'.repeat(8192));
else if (mode === 'bad-json') process.stdout.write('not json\n');
else if (mode === 'exit-fail') process.exit(7);
else if (mode === 'auth-fail') { process.stderr.write('gateway agent requires credentials before opening a websocket; private-token-never-echo'); process.exit(1); }
else if (mode === 'openclaw') send({ result: { payloads: [{ text: 'OpenClaw verified' }], meta: { agentMeta: { sessionId: 'claw-session', usage: { total: 8 } } } } });
else if (mode === 'openclaw-failed') send({ ok: false, error: { message: 'test failure' } });
else if (mode === 'env-check') send({ urlMatches: process.env.AIDESIGNHUB_URL === 'http://127.0.0.1:9000', tokenMatches: process.env.AIDESIGNHUB_TOKEN === 'temporary-test-token' });
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    if (mode === 'hermes' || mode === 'hermes-partial' || mode === 'hermes-noisy') {
      if (mode === 'hermes-noisy') process.stdout.write('Warning: chromium sandbox log line\n');
      send({ type: 'system', subtype: 'init', session_id: 'hermes-session' });
      send({ type: 'text', text: 'draft' });
      send({ type: 'tool_use', name: 'read_file' });
      send({ type: 'tool_result', name: 'read_file', is_error: false });
      send({ type: 'result', session_id: 'hermes-session', exit_code: mode === 'hermes-partial' ? 1 : 0, text: input, tokens: { total: 9 } });
    } else if (mode === 'args') process.stdout.write(JSON.stringify({ args: process.argv.slice(3), stdin: input }));
    else if (mode === 'prompt-file') {
      const bytes = require('node:fs').readFileSync(process.argv[3]);
      send({ promptBytes: bytes.length, promptHash: require('node:crypto').createHash('sha256').update(bytes).digest('hex'), args: process.argv.slice(4), stdin: input });
    }
    else process.stdout.write(input);
  });
}
