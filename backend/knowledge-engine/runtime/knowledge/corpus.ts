import { createHash } from 'node:crypto';
import { KNOWLEDGE_PARSER_REVISION } from './officeParser';
import type { KnowledgeCorpusPage, KnowledgeCorpusSource, KnowledgeCorpusSegment, KnowledgeSource } from '../../packages/contracts/desktop';
export type { KnowledgeCorpusPage, KnowledgeCorpusSource, KnowledgeCorpusSegment } from '../../packages/contracts/desktop';

type CorpusSource = KnowledgeSource & { filePath?: string; parsedSections?: Array<{ locator: string; text: string }> };
type CorpusChunk = { id: string; projectId: string; sourceId: string; locator: string; text: string };
type CorpusCursor = { version: 1; projectId: string; snapshot: string; offset: number };
const SEGMENT_CHARACTERS = 16_000;
const PAGE_CHARACTERS = 64_000;
const MAX_PAGE_SEGMENTS = 32;
const OCR_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff']);

function safeWarning(source: CorpusSource, warning: string) {
  let value = warning;
  if (source.filePath) {
    value = value.replaceAll(source.filePath, source.name).replaceAll(source.filePath.replaceAll('\\', '/'), source.name);
  }
  // Parser/OS errors may contain paths even though the public source has none.
  return value.replace(/file:\/\/\/[^\s'"<>，。；]+/gi, '[本地文件]')
    .replace(/[a-zA-Z]:[\\/][^\s'"<>，。；]+/g, '[本地路径]');
}

function sourceWarnings(source: CorpusSource, chunkCount: number): string[] {
  const warnings: string[] = [];
  if (source.error) warnings.push(safeWarning(source, source.error));
  if (source.status === 'metadata-only') warnings.push('仅保存文件信息，没有可供处理的正文。');
  if (source.status === 'error') warnings.push('文件解析或索引失败，不能视为已完整处理。');
  if (source.status === 'indexed' && !chunkCount) warnings.push('文件标记为已索引，但没有可读取正文；请重新添加以更新索引。');
  if (!source.parsedSections && source.chunkCount !== chunkCount) warnings.push('文件记录的片段数与实际正文不一致，以实际正文片段数为准。');
  if (!source.parsedSections && chunkCount) warnings.push('当前正文来自历史检索片段，可能含重叠文本；请点击“更新解析”保存无检索重叠的完整正文，再进行精确汇总。');
  if (OCR_EXTENSIONS.has(source.extension.toLowerCase())) warnings.push('正文来自图片 OCR，数字、表头和表格对应关系需要回到原图核对；未向回答模型发送原图。');
  if (['docx', 'xlsx', 'pptx'].includes(source.extension.toLowerCase()) && source.parserRevision !== KNOWLEDGE_PARSER_REVISION) warnings.push('这份 Office 资料使用旧版解析缓存，表格行列或共享文本可能未正确保留；请先点击“更新解析”重新建立正文索引。');
  return warnings;
}

function decodeCursor(cursor: string): CorpusCursor {
  try {
    if (typeof cursor !== 'string' || cursor.length > 1_000) throw new Error();
    const decoded: CorpusCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded.version !== 1 || typeof decoded.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(decoded.snapshot)
      || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error();
    return decoded;
  } catch { throw new Error('知识库处理游标无效，请重新开始完整处理。'); }
}

/** Visits every stored text chunk; semantic ranking and embeddings are intentionally absent. */
export function readKnowledgeCorpusPage(
  projectId: string, allSources: readonly CorpusSource[], allChunks: readonly CorpusChunk[], cursor?: string, pageSize?: number,
): KnowledgeCorpusPage {
  const sourceRecords = allSources.filter((source) => source.projectId === projectId)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const grouped = new Map(sourceRecords.map((source) => [source.id, source.parsedSections
    ? source.parsedSections.map((section, index): CorpusChunk => ({ id: `${source.id}:section:${index + 1}`, projectId, sourceId: source.id, locator: section.locator, text: section.text }))
    : [] as CorpusChunk[]]));
  const canonicalIds = new Set(sourceRecords.filter((source) => source.parsedSections !== undefined).map((source) => source.id));
  for (const chunk of allChunks) if (chunk.projectId === projectId && !canonicalIds.has(chunk.sourceId)) grouped.get(chunk.sourceId)?.push(chunk);
  const sources = sourceRecords.map((source): KnowledgeCorpusSource => {
    const chunkCount = grouped.get(source.id)!.length;
    return { id: source.id, projectId, name: source.name, extension: source.extension, status: source.status, chunkCount,
      contentOrigin: source.parsedSections !== undefined ? 'parsed-sections' : 'legacy-chunks', warnings: sourceWarnings(source, chunkCount) };
  });
  const hash = createHash('sha256').update(JSON.stringify({ projectId, sources }));
  const segments: KnowledgeCorpusSegment[] = [];
  let totalChunkCount = 0;
  for (const source of sourceRecords) {
    // Include parse revision metadata so re-imports invalidate in-progress work even when text is unchanged.
    hash.update(JSON.stringify([source.id, source.indexedAt, source.modifiedAt, source.size]));
    for (const chunk of grouped.get(source.id)!) {
      hash.update(JSON.stringify([chunk.id, chunk.locator, chunk.text]));
      const texts: string[] = [];
      for (let start = 0; start < chunk.text.length;) {
        let end = Math.min(start + SEGMENT_CHARACTERS, chunk.text.length);
        const last = chunk.text.charCodeAt(end - 1);
        const next = chunk.text.charCodeAt(end);
        if (end < chunk.text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
        texts.push(chunk.text.slice(start, end));
        start = end;
      }
      if (!texts.length) texts.push('');
      const segmentCount = texts.length;
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        segments.push({ chunkId: chunk.id, sourceId: source.id, sourceName: source.name, locator: chunk.locator,
          text: texts[segmentIndex],
          chunkIndex: totalChunkCount, segmentIndex, segmentCount, overlapPrefixChars: 0 });
      }
      totalChunkCount += 1;
    }
  }
  const snapshot = hash.digest('hex');
  const previous = cursor === undefined ? undefined : decodeCursor(cursor);
  if (previous && (previous.projectId !== projectId || previous.snapshot !== snapshot)) throw new Error('知识库资料在处理期间发生变化，请重新开始完整处理，避免遗漏或重复。');
  const offset = previous?.offset ?? 0;
  if (offset > segments.length) throw new Error('知识库处理游标超出范围，请重新开始完整处理。');
  const limit = typeof pageSize === 'number' && Number.isFinite(pageSize) ? Math.max(1, Math.min(MAX_PAGE_SEGMENTS, Math.floor(pageSize))) : 8;
  const selected: KnowledgeCorpusSegment[] = [];
  let characters = 0;
  while (offset + selected.length < segments.length && selected.length < limit) {
    const next = segments[offset + selected.length];
    if (selected.length && characters + next.text.length > PAGE_CHARACTERS) break;
    selected.push(next);
    characters += next.text.length;
  }
  const coveredSegmentCount = offset + selected.length;
  const last = segments[coveredSegmentCount - 1];
  const coveredChunkCount = last ? last.chunkIndex + Number(last.segmentIndex + 1 === last.segmentCount) : 0;
  const done = coveredSegmentCount === segments.length;
  const indexedSourceCount = sources.filter((source) => source.status === 'indexed' && source.chunkCount > 0).length;
  const failedSourceCount = sources.filter((source) => source.status === 'error' || source.status === 'metadata-only').length;
  const warnings = ['完整处理覆盖当前已解析的全部正文片段；已遍历不等于原文件中每个表格、图片或嵌入对象均已正确解析。'];
  if (sourceRecords.some((source) => !source.parsedSections && grouped.get(source.id)!.length)) warnings.push('历史片段没有重叠位置记录，已保留全部原文；相邻片段可能重叠，须按来源标记重复候选，不能仅因行内容相同就删除记录或认定为新增记录。请先“更新解析”再作精确汇总。');
  if (sources.some((source) => source.warnings.length)) warnings.push('部分资料存在解析或 OCR 提示，请查看资料清单并保留待核实项。');
  return { projectId, snapshot, sources, segments: selected, totalSourceCount: sources.length, indexedSourceCount, failedSourceCount,
    pendingSourceCount: sources.length - indexedSourceCount - failedSourceCount, totalChunkCount, coveredChunkCount,
    totalSegmentCount: segments.length, coveredSegmentCount, nextCursor: done ? null : Buffer.from(JSON.stringify({ version: 1, projectId, snapshot, offset: coveredSegmentCount } satisfies CorpusCursor)).toString('base64url'), done, warnings };
}
