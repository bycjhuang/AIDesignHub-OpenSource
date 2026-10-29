'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { ModelService } = require('../backend/model-service.cjs');
const { answerKnowledge } = require('../backend/knowledge-answer.cjs');
const KEY = 'sk-knowledge-fixture-not-a-real-secret';
const MESSAGES = [{ role: 'system', content: '仅按原文回答，引用资料。' }, { role: 'user', content: '合成资料：主通道宽度为2米。' }];
function fixture(t, fetchImpl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-knowledge-model-'));
  t.after(() => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^adh-knowledge-model-/);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const key = crypto.randomBytes(32);
  const secretStore = { isEncryptionAvailable: () => true };
  secretStore.encryptString = text => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); };
  secretStore.decryptString = bytes => { const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); };
  const service = new ModelService({ dataDir, secretStore, ...(fetchImpl ? { fetchImpl } : {}) });
  const save = baseUrl => service.save({ provider: 'openai-compatible', baseUrl, allowLocalHttp: baseUrl.startsWith('http:'), model: 'knowledge-fixture', apiKey: KEY });
  return { service, save, dataDir };
}
function response(content = '通道宽度为2米。[资料 1]', choice = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', ...choice }] }), { headers: { 'Content-Type': 'application/json' } });
}
const code = expected => error => { assert.equal(error.code, expected); assert.ok(!error.message.includes(KEY)); return true; };

test('knowledge completion uses the encrypted local configuration for one actual stub HTTP POST without tools', async t => {
  let received, calls = 0;
  const server = http.createServer(async (request, reply) => {
    calls++; let body = ''; for await (const chunk of request) body += chunk;
    received = { method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '宽度为2米。[资料 1]' }, finish_reason: 'stop' }], usage: { total_tokens: 40 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = fixture(t); f.save(`http://127.0.0.1:${server.address().port}`);
  const before = fs.readFileSync(path.join(f.dataDir, 'model-private/model-config.enc'));
  const result = await f.service.completeKnowledge({ messages: MESSAGES });
  assert.equal(calls, 1); assert.equal(received.method, 'POST'); assert.equal(received.url, '/chat/completions');
  assert.equal(received.authorization, `Bearer ${KEY}`); assert.deepEqual(received.body.messages, MESSAGES);
  assert.equal(received.body.stream, false); assert.equal(received.body.tools, undefined); assert.equal(received.body.tool_choice, undefined);
  assert.equal(result.reply, '宽度为2米。[资料 1]'); assert.equal(result.model, 'knowledge-fixture'); assert.equal(result.usage.total_tokens, 40);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.deepEqual(fs.readFileSync(path.join(f.dataDir, 'model-private/model-config.enc')), before);
  assert.ok(!before.toString().includes(KEY));
});

test('knowledge completion rejects redirects, tool calls, incomplete output, excessive bodies and secret echoes without replay', async t => {
  const examples = [
    [() => new Response('', { status: 302, headers: { Location: 'https://outside.example' } }), 'MODEL_REDIRECT_BLOCKED'],
    [() => response('', { message: { content: '', tool_calls: [{ function: { name: 'exec' } }] }, finish_reason: 'tool_calls' }), 'MODEL_TOOLS_NOT_ALLOWED'],
    [() => response('partial', { finish_reason: 'length' }), 'MODEL_INCOMPLETE_RESPONSE'],
    [() => response('partial', { finish_reason: null }), 'MODEL_INCOMPLETE_RESPONSE'],
    [() => new Response('x'.repeat(300000)), 'MODEL_RESPONSE_LIMIT'],
    [() => response(KEY), 'MODEL_SECRET_IN_RESPONSE'],
    [() => new Response(KEY, { status: 500 }), 'MODEL_HTTP_ERROR'],
    [() => { throw new Error('provider leaked ' + KEY); }, 'MODEL_NETWORK_ERROR'],
  ];
  for (const [make, expected] of examples) {
    let calls = 0;
    const f = fixture(t, async (_, options) => { calls++; assert.equal(options.redirect, 'manual'); return make(); });
    f.save('https://model.example/v1');
    await assert.rejects(f.service.completeKnowledge({ messages: MESSAGES }), code(expected));
    assert.equal(calls, 1);
  }
});

test('knowledge completion cancellation aborts the one in-flight request and rejects even if the provider ignores abort', async t => {
  let calls = 0, observed;
  const f = fixture(t, async (_, options) => { calls++; observed = options.signal; return new Promise(() => {}); });
  f.save('https://model.example/v1');
  const controller = new AbortController();
  const pending = f.service.completeKnowledge({ messages: MESSAGES, signal: controller.signal });
  controller.abort(new Error('private reason ' + KEY));
  await assert.rejects(pending, code('MODEL_CANCELLED'));
  assert.equal(calls, 1); assert.equal(observed.aborted, true);
  await assert.rejects(f.service.completeKnowledge({ messages: MESSAGES, signal: controller.signal }), code('MODEL_CANCELLED'));
  assert.equal(calls, 1);
});

test('knowledge completion rejects tool-role, additional fields and excessive input before network', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return response(); }); f.save('https://model.example/v1');
  for (const messages of [[{ role: 'tool', content: 'execute' }], [{ role: 'user', content: 'x', tool_calls: [] }], [{ role: 'user', content: 'x'.repeat(131073) }]]) {
    await assert.rejects(f.service.completeKnowledge({ messages }));
  }
  await assert.rejects(f.service.completeKnowledge({ messages: [{ role: 'user', content: '中'.repeat(50000) }] }), code('MODEL_CONTEXT_LIMIT'));
  assert.equal(calls, 0);
});

test('full-corpus answers make one local HTTP POST per batch and preserve all thirteen sources in Office export data', async t => {
  let posts = 0;
  const server = http.createServer(async (request, reply) => {
    posts++; let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), input = JSON.parse(body.messages[1].content);
    assert.equal(request.method, 'POST'); assert.equal(body.tools, undefined); assert.ok(!raw.includes(KEY));
    const extraction = { complete: true, coveredSegmentKeys: input.documents.map(item => item.key), title: '十三份完整明细', summary: '本批已完整提取。',
      columns: ['原文'], sort: [], aggregates: [], rows: input.documents.map(item => ({ values: [item.text], sourceKey: item.key, uncertainties: [] })) };
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(extraction) }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = fixture(t); f.save(`http://127.0.0.1:${server.address().port}`);
  const sources = Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, projectId: 'library', name: `资料${index}.txt`, extension: 'txt',
    status: 'indexed', chunkCount: 1, contentOrigin: 'parsed-sections', warnings: [] }));
  const segments = sources.map((source, index) => ({ chunkId: `c${index}`, sourceId: source.id, sourceName: source.name, locator: '第1段',
    text: `必须完整保留第${index}份资料`, chunkIndex: index, segmentIndex: 0, segmentCount: 1, overlapPrefixChars: 0 }));
  let reads = 0;
  const worker = { request: async (method, args) => {
    reads++; assert.equal(method, 'corpus'); const offset = Number(args.cursor || 0), page = segments.slice(offset, offset + 4), covered = offset + page.length;
    return { projectId: 'library', snapshot: 'snapshot', sources, segments: page, totalSourceCount: 13, indexedSourceCount: 13, failedSourceCount: 0,
      pendingSourceCount: 0, totalChunkCount: 13, coveredChunkCount: covered, totalSegmentCount: 13, coveredSegmentCount: covered,
      nextCursor: covered < 13 ? String(covered) : null, done: covered === 13, warnings: [] };
  } };
  const result = await answerKnowledge({ question: '完整整理全部资料为Excel', libraryId: 'library', worker, modelService: f.service });
  assert.equal(reads, 4); assert.equal(posts, 13); assert.equal(result.coverage.batches, 13); assert.equal(result.coverage.complete, true);
  assert.equal(result.citations.length, 13); assert.equal(result.exportInput.tables[0].rows.length, 13); assert.equal(result.exportInput.format, 'xlsx');
  assert.equal(result.exportInput.tables[0].rows.at(-1)[0], '必须完整保留第12份资料'); assert.equal(result.model.provider, 'openai-compatible');
});
