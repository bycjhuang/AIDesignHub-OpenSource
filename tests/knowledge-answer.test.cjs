'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { answerKnowledge, planKnowledgeTask, KnowledgeTaskError } = require('../backend/knowledge-answer.cjs');

function corpus(count = 13, size = 4, textFor = index => `编号${index}，金额${index + 1}元`) {
  const sources = Array.from({ length: count }, (_, index) => ({ id: `s${index}`, projectId: 'library', name: `资料${index}.txt`,
    extension: 'txt', status: 'indexed', chunkCount: 1, contentOrigin: 'parsed-sections', warnings: [] }));
  const segments = sources.map((source, index) => ({ chunkId: `c${index}`, sourceId: source.id, sourceName: source.name,
    locator: `第${index + 1}段`, text: textFor(index), chunkIndex: index, segmentIndex: 0, segmentCount: 1, overlapPrefixChars: 0 }));
  const pages = [];
  for (let offset = 0; offset < count; offset += size) {
    const items = segments.slice(offset, offset + size), covered = offset + items.length;
    pages.push({ projectId: 'library', snapshot: 'stable-snapshot', sources, segments: items, totalSourceCount: count,
      indexedSourceCount: count, failedSourceCount: 0, pendingSourceCount: 0, totalChunkCount: count, coveredChunkCount: covered,
      totalSegmentCount: count, coveredSegmentCount: covered, nextCursor: covered < count ? String(covered) : null,
      done: covered === count, warnings: [] });
  }
  let pageIndex = 0;
  const calls = [];
  return { sources, segments, pages, calls, worker: { request: async (method, args) => {
    calls.push({ method, args }); assert.equal(method, 'corpus'); assert.equal(args.projectId, 'library');
    assert.equal(args.cursor, pageIndex === 0 ? undefined : pages[pageIndex - 1].nextCursor);
    return pages[pageIndex++];
  } } };
}
function extraction(messages, change = {}) {
  const input = JSON.parse(messages[1].content);
  const response = { complete: true, coveredSegmentKeys: input.documents.map(item => item.key), title: '全部金额明细', summary: '本批完整提取。',
    columns: ['编号', '金额', '币种'], sort: [{ column: '金额', direction: 'desc', kind: 'number' }],
    aggregates: [{ op: 'sum', column: '金额', groupBy: ['币种'], name: '总金额', unitColumn: '币种' }, { op: 'count', name: '记录数', groupBy: ['币种'] }],
    rows: input.documents.map(item => { const index = Number(item.source.match(/资料(\d+)/)[1]);
      return { values: [`000${index}`, index + 1, 'CNY'], sourceKey: item.key, uncertainties: [] }; }), ...change };
  return JSON.stringify(response);
}
function model(generate) {
  let calls = 0;
  return { status: () => ({ configured: true, provider: 'synthetic-local', model: 'fixture' }),
    get calls() { return calls; }, completeKnowledge: async ({ messages, signal }) => {
      calls++; return { reply: await generate(messages, calls, signal), provider: 'synthetic-local', model: 'fixture' };
    } };
}

test('automatic intent retains upstream full-corpus routing and explicit manual controls', () => {
  for (const question of ['整理全部资料', '一共有多少笔成交？', '生成Word报告', '导出Excel表格', '做一份PPT', 'compare all files']) assert.equal(planKnowledgeTask(question).scope, 'all');
  assert.equal(planKnowledgeTask('主通道宽度是多少').scope, 'search');
  assert.equal(planKnowledgeTask('整理全部资料', 'search').scope, 'search');
  assert.equal(planKnowledgeTask('导出Excel表格').format, 'xlsx');
});

test('all-corpus workflow pages beyond top eight and retains every row, citation, leading zero, stable order and local aggregate', async () => {
  const f = corpus(25), service = model(async messages => extraction(messages)), progress = [];
  const result = await answerKnowledge({ question: '整理全部金额，统计总金额和记录数，导出Excel', libraryId: 'library',
    worker: f.worker, modelService: service, onProgress: value => progress.push(value) });
  assert.equal(result.plan.scope, 'all'); assert.equal(result.model.used, true); assert.equal(result.incomplete, false);
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.processedSources, 25);
  assert.equal(result.coverage.processedSegments, 25); assert.equal(result.citations.length, 25);
  assert.equal(f.calls.length, 7); assert.equal(service.calls, 25);
  assert.equal(result.exportInput.format, 'xlsx'); assert.equal(result.exportInput.tables[0].rows.length, 25);
  assert.deepEqual(result.exportInput.tables[0].rows.map(row => row[1]), Array.from({ length: 25 }, (_, index) => 25 - index));
  assert.equal(result.exportInput.tables[0].rows.at(-1)[0], '0000');
  assert.ok(result.exportInput.tables.length >= 2); assert.match(JSON.stringify(result.exportInput.tables[1]), /325/);
  assert.match(result.answer, /仅预览前 20 行/); assert.match(result.exportInput.markdown, /00024/);
  assert.equal(progress.at(-1).phase, 'complete');
});

test('oversized source text is processed in contiguous bounded fragments without clipping any character', async () => {
  const text = '原文🔢一行数据\n'.repeat(2100) + '最后一行必须保留';
  const f = corpus(1, 1, () => text), seen = [];
  const service = model(async messages => {
    assert.ok(messages.reduce((sum, item) => sum + item.content.length, 0) <= 10000);
    const input = JSON.parse(messages[1].content); seen.push(...input.documents.map(item => item.text));
    return extraction(messages, { title: '原文保留', columns: ['原文'], sort: [], aggregates: [],
      rows: input.documents.map(item => ({ values: [item.text], sourceKey: item.key, uncertainties: [] })) });
  });
  const result = await answerKnowledge({ question: '完整提取全部原文', scope: 'all', libraryId: 'library', worker: f.worker,
    modelService: service, contextChars: 10000 });
  assert.equal(seen.join(''), text); assert.ok(service.calls > 2);
  assert.equal(result.exportInput.tables[0].rows.map(row => row[0]).join(''), text);
  assert.equal(result.coverage.processedChunks, 1); assert.equal(result.coverage.processedSegments, 1);
});

test('without a configured model all pages remain available as source extracts, with explicit non-generated status', async () => {
  const f = corpus(13), service = { status: () => ({ configured: false }), completeKnowledge: () => assert.fail('must stay offline') };
  const result = await answerKnowledge({ question: '完整整理全部资料为Word报告', libraryId: 'library', worker: f.worker, modelService: service });
  assert.equal(f.calls.length, 4); assert.equal(result.model.used, false); assert.equal(result.model.mode, 'extractive');
  assert.equal(result.incomplete, true); assert.match(result.answer, /未调用生成模型/); assert.match(result.answer, /未完成问题所需/);
  assert.equal(result.exportInput.tables[0].rows.length, 13); assert.match(result.exportInput.tables[0].rows.at(-1)[0], /编号12/);
  assert.match(result.exportInput.coverage, /未完成问题所需/);
});

test('all-corpus legacy preflight reparses original sources once before processing the replacement snapshot', async () => {
  const f = corpus(1, 1); const canonical = structuredClone(f.pages[0]); const legacy = structuredClone(canonical);
  legacy.sources[0].contentOrigin = 'legacy-chunks'; legacy.snapshot = 'legacy-snapshot';
  const calls = [];
  const worker = { request: async (method, args) => {
    calls.push({ method, args });
    if (method === 'reindex') return { added: [{}], skipped: [] };
    return calls.length === 1 ? legacy : canonical;
  } };
  const service = model(async messages => extraction(messages));
  const result = await answerKnowledge({ question: '统计全部金额', libraryId: 'library', worker, modelService: service });
  assert.deepEqual(calls.map(call => call.method), ['corpus', 'reindex', 'corpus']);
  assert.equal(result.coverage.snapshot, 'stable-snapshot'); assert.equal(result.coverage.complete, true); assert.equal(service.calls, 1);
});

test('failed legacy reparsing retains historical rows and cannot label their corpus or statistics complete', async () => {
  const f = corpus(1, 1); const page = f.pages[0]; page.sources[0].contentOrigin = 'legacy-chunks';
  const calls = [];
  const worker = { request: async method => { calls.push(method); return method === 'reindex' ? { added: [], skipped: [{ name: 'missing.txt', reason: 'original unavailable' }] } : page; } };
  const result = await answerKnowledge({ question: '统计全部金额', libraryId: 'library', worker, modelService: model(async messages => extraction(messages)) });
  assert.deepEqual(calls, ['corpus', 'reindex', 'corpus']); assert.equal(result.coverage.complete, false); assert.equal(result.incomplete, true);
  assert.equal(result.exportInput.tables[0].rows.length, 1); assert.match(result.answer, /原文件未能更新/);
  assert.match(result.exportInput.tables[0].rows[0].at(-1), /历史重叠索引/); assert.match(result.exportInput.coverage, /未核实/);
});

test('a late malformed model response exposes partial coverage and never replays a batch or returns a complete artifact', async () => {
  const f = corpus(3, 1), service = model(async (messages, calls) => calls === 2 ? '{"complete":true,"rows":[' : extraction(messages));
  await assert.rejects(answerKnowledge({ question: '整理全部资料', libraryId: 'library', worker: f.worker, modelService: service }), error => {
    assert.ok(error instanceof KnowledgeTaskError); assert.equal(error.coverage.complete, false);
    assert.equal(error.coverage.processedSources, 1); assert.equal(error.coverage.batches, 1); assert.equal(error.exportInput, undefined); return true;
  });
  assert.equal(service.calls, 2); assert.equal(f.calls.length, 2);
});

test('cancellation during the second batch retains only completed coverage and does not request a later page', async () => {
  const f = corpus(4, 1), controller = new AbortController();
  const service = model(async (messages, calls, signal) => { assert.equal(signal, controller.signal); if (calls === 2) controller.abort(); return extraction(messages); });
  await assert.rejects(answerKnowledge({ question: '整理全部资料', libraryId: 'library', worker: f.worker, modelService: service, signal: controller.signal }), error => {
    assert.equal(error.code, 'REQUEST_CANCELLED'); assert.equal(error.coverage.complete, false); assert.equal(error.coverage.processedSources, 1); return true;
  });
  assert.equal(service.calls, 2); assert.equal(f.calls.length, 2);
});

test('a corpus snapshot change, foreign source, or unsupported executable aggregate cannot claim completion', async () => {
  for (const invalid of ['snapshot', 'foreign', 'aggregate']) {
    const f = corpus(2, 1);
    if (invalid === 'snapshot') f.pages[1].snapshot = 'changed';
    if (invalid === 'foreign') f.pages[0].sources[0].projectId = 'foreign-library';
    const service = model(async messages => extraction(messages, invalid === 'aggregate' ? { aggregates: [{ op: 'eval', column: '金额', name: 'exec' }] } : {}));
    await assert.rejects(answerKnowledge({ question: '统计全部金额', libraryId: 'library', worker: f.worker, modelService: service }), error => {
      assert.ok(error instanceof KnowledgeTaskError); assert.equal(error.coverage.complete, false); return true;
    });
    assert.ok(service.calls <= 1);
  }
});

test('search Q&A sends complete cited chunks and rejects fabricated citation ids without model replay', async () => {
  const hit = { citationId: 'original', projectId: 'library', sourceId: 's0', sourceName: '合成规范.txt', locator: '第2段', text: '主通道宽度为2米。', score: 1, retrievalMode: 'keyword' };
  let searches = 0;
  const worker = { request: async (method, args) => { searches++; assert.equal(method, 'search'); assert.equal(args.projectId, 'library'); return [hit]; } };
  const service = model(async messages => { const input = JSON.parse(messages[1].content); assert.equal(input.documents[0].text, hit.text); return '主通道宽度为2米。[资料 1]'; });
  const result = await answerKnowledge({ question: '主通道宽度是多少', libraryId: 'library', worker, modelService: service });
  assert.equal(result.answer, '主通道宽度为2米。[资料 1]'); assert.equal(result.citations[0].sourceId, hit.sourceId);
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.totalSources, null);
  assert.equal(result.exportInput.tables[0].rows[0][3], hit.text); assert.equal(service.calls, 1);
  const bad = model(async () => '虚构答案。[资料 99]');
  await assert.rejects(answerKnowledge({ question: '主通道宽度是多少', libraryId: 'library', worker, modelService: bad }), error => error.code === 'KNOWLEDGE_INVALID_CITATION');
  assert.equal(bad.calls, 1); assert.equal(searches, 2);
});

test('search stays offline with no model or no hits, and rejects cross-library results before a model request', async () => {
  const hit = { projectId: 'library', sourceId: 's', sourceName: '规范.txt', locator: '第一段', text: '可核对原文', score: 1 };
  const worker = { request: async () => [hit] };
  const result = await answerKnowledge({ question: '通道要求', libraryId: 'library', worker });
  assert.equal(result.model.used, false); assert.match(result.answer, /未生成问答结论/); assert.match(result.answer, /可核对原文/);
  const service = model(async () => assert.fail('must not call model'));
  const empty = await answerKnowledge({ question: '通道要求', libraryId: 'library', worker: { request: async () => [] }, modelService: service });
  assert.equal(empty.model.used, false); assert.equal(service.calls, 0);
  await assert.rejects(answerKnowledge({ question: '通道要求', libraryId: 'library', worker: { request: async () => [{ ...hit, projectId: 'foreign' }] }, modelService: service }), error => error.code === 'KNOWLEDGE_INVALID_SEARCH');
  assert.equal(service.calls, 0);
});
