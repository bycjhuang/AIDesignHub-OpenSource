export type SearchableKnowledgeChunk = { id: string; text: string; sourceName: string; embedding?: number[]; embeddingModel?: string };
export type KnowledgeSearchMatch = { id: string; score: number; retrievalMode: 'keyword' | 'hybrid' };
// E5 can put unrelated passages near 0.8; preserve an absolute cosine floor.
export const MIN_SEMANTIC_SIMILARITY = 0.85;
const STOP_WORDS = new Set(['的', '了', '是', '有', '在', '与', '及', '和', '或', '为', '我', '你', '这', '这个', '它', '吗', '呢', '吧', '请', '问', '一下', '什么', '怎么', '怎样', '如何', '哪里', '哪个', '哪些', '多少', '是否', '用', '采用', '使用', '需要', '可以', '应该', 'a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'please', 'the', 'to', 'was', 'were', 'what', 'which', 'with']);
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
export function isValidKnowledgeVector(vector: number[] | undefined): vector is number[] {
  if (!Array.isArray(vector) || !vector.length || vector.length > 8_192) return false;
  let magnitude = 0;
  for (const value of vector) { if (!Number.isFinite(value)) return false; magnitude += value * value; }
  return Number.isFinite(magnitude) && magnitude > 1e-12;
}
function terms(text: string) {
  return [...new Set([...segmenter.segment(text.normalize('NFKC').toLocaleLowerCase('zh-CN'))]
    .filter((segment) => segment.isWordLike && !STOP_WORDS.has(segment.segment)).map((segment) => segment.segment))];
}
/** Transparent local full-text fallback, independent of the native engine. */
export function keywordSearch(chunks: SearchableKnowledgeChunk[], query: string): KnowledgeSearchMatch[] {
  const tokens = terms(query);
  if (!tokens.length) return [];
  const ranked = chunks.map((chunk) => {
    const text = new Set(terms(chunk.text)); const filename = new Set(terms(chunk.sourceName)); let score = 0;
    for (const token of tokens) { if (text.has(token)) score += 1; if (filename.has(token)) score += 2; }
    return { id: chunk.id, score, retrievalMode: 'keyword' as const };
  }).filter((hit) => hit.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const maximum = ranked[0]?.score || 1;
  return ranked.map((hit) => ({ ...hit, score: hit.score / maximum }));
}
export function combineKnowledgeMatches(keyword: KnowledgeSearchMatch[], semantic: KnowledgeSearchMatch[], limit: number): KnowledgeSearchMatch[] {
  if (!semantic.length) return keyword.slice(0, limit);
  const merged = new Map(keyword.map((hit) => [hit.id, { ...hit, score: hit.score * 0.65 }]));
  for (const hit of semantic) merged.set(hit.id, { ...hit, score: (merged.get(hit.id)?.score || 0) + hit.score * 0.35, retrievalMode: 'hybrid' });
  return [...merged.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, limit);
}
