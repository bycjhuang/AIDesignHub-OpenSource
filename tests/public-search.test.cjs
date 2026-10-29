'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchPublicWeb, parseExaSearchResults } = require('../backend/public-search.cjs');

test('public research search returns bounded source links as unverified excerpts and rejects private targets', async () => {
  const payload = { content: [{ type: 'text', text: 'Title: 海边文化空间\nURL: https://architecture.example.org/project\nHighlights:\n源页面的摘要\n\n---\n\nTitle: 私有链接\nURL: http://127.0.0.1/private\nHighlights:\n不能接受\n\n---\n\nTitle: 同一来源重复\nURL: https://architecture.example.org/project\nHighlights:\n重复\n\nTitle: 第二来源\nURL: https://design.example.org/case\nHighlights:\n设计方介绍' }] };
  assert.equal(parseExaSearchResults(payload, 10).length, 2);
  let called;
  const result = await searchPublicWeb({ query: '  滨水文化项目  ', limit: 1, callSearch: async (query, limit, signal) => { called = { query, limit, aborted: signal.aborted }; return payload; } });
  assert.deepEqual(called, { query: '滨水文化项目', limit: 1, aborted: false });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].contentStatus, 'search-excerpt-only');
  assert.match(result.note, /原始来源/);
});

test('search input and upstream failure remain explicit instead of fabricating sources', async () => {
  await assert.rejects(searchPublicWeb({ query: 'a' }), /检索词/);
  await assert.rejects(searchPublicWeb({ query: '公共建筑', callSearch: async () => ({ isError: true }) }), /服务返回错误/);
  const result = await searchPublicWeb({ query: '公共建筑', callSearch: async () => ({ content: [] }) });
  assert.deepEqual(result.results, []); assert.match(result.note, /没有可用结果/);
});
