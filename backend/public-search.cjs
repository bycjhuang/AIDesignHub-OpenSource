'use strict';
const { validatePublicUrl } = require('./public-page.cjs');
const decode = value => String(value || '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  const number = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
  return Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
});
const plain = value => decode(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
async function callPublicSearch(query, limit, signal) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
  const client = new Client({ name: 'aidesignhub-public-search', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.exa.ai/mcp'));
  try {
    await client.connect(transport, { signal, timeout: 20000 });
    const catalog = await client.listTools({}, { signal, timeout: 15000 });
    const tool = catalog.tools.find(item => item.name === 'web_search_exa');
    if (!tool || tool.inputSchema?.type !== 'object') throw new Error('公开检索服务暂未提供可用的搜索工具。');
    const args = { query };
    if (tool.inputSchema.properties?.numResults) args.numResults = limit;
    if (tool.inputSchema.properties?.objective) args.objective = 'Find public original architecture, landscape, interior design or project resources relevant to this query. Prefer project designers and architecture publications. Exclude unrelated pages. Return source URLs and short relevant excerpts.';
    // Use the MCP wire-result schema: this SDK version's optional JSON-schema
    // output validator is incompatible with some remote result schemas.
    return await client.request({ method: 'tools/call', params: { name: tool.name, arguments: args } }, CallToolResultSchema, { signal, timeout: 30000 });
  } finally { await client.close(); }
}
function parseExaSearchResults(payload, limit = 6) {
  if (payload?.isError) throw new Error('公开检索服务返回错误，请稍后重试或先读取已有来源。');
  const raw = (Array.isArray(payload?.content) ? payload.content : []).filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 80000);
  const results = [], seen = new Set();
  for (const block of raw.split(/(?:^|\n)(?=Title: )/)) {
    const title = /^Title:\s*([^\n]+)/m.exec(block)?.[1], link = /^URL:\s*(https?:\/\/[^\s]+)/m.exec(block)?.[1];
    if (!title || !link) continue;
    let url; try { url = validatePublicUrl(link).href; } catch { continue; }
    if (seen.has(url)) continue; seen.add(url);
    const excerpt = block.split(/(?:Highlights:|Text:|Content:)/)[1] || '';
    results.push({ title: plain(title).slice(0, 350), url, snippet: plain(excerpt).slice(0, 1200), contentStatus: 'search-excerpt-only' });
    if (results.length >= limit) break;
  }
  return results;
}
async function searchPublicWeb({ query, limit = 6, signal, callSearch = callPublicSearch } = {}) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 600) throw new Error('请输入 2–600 字的检索词。');
  const count = Number.isInteger(limit) ? Math.max(1, Math.min(10, limit)) : 6;
  const timeout = AbortSignal.timeout(45000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const results = parseExaSearchResults(await callSearch(query.trim(), count, combined), count);
  return { query: query.trim(), source: 'exa-public-mcp', results, retrievedAt: new Date().toISOString(), note: results.length ? '搜索摘录仅用于发现链接，请用 hub_web_read 阅读原始来源再核实。公开检索服务有使用限额，遇限流请保留已有资料。' : '本次没有可用结果，请简化检索词，或先读取已有案例来源。' };
}
module.exports = { searchPublicWeb, parseExaSearchResults };
