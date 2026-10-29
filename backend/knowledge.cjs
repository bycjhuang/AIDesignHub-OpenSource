const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { extractOfficeSections } = require('./office-parser.cjs');

const TEXT_EXTENSIONS = new Set(['txt','md','markdown','csv','json','html','htm','xml','log']);
const OFFICE_EXTENSIONS = new Set(['docx','pptx','xlsx']);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, 'doc', 'pdf']);

function cleanText(value) {
  return String(value || '').normalize('NFKC').replace(/\u0000/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeFileName(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 140) || 'document';
}

function normalizeSections(sections) {
  return sections.map((section) => ({ locator: section.locator || '正文', text: cleanText(section.text) })).filter((section) => section.text);
}

async function parsePdf(buffer) {
  const canvas = await import('@napi-rs/canvas');
  globalThis.DOMMatrix ??= canvas.DOMMatrix;
  globalThis.ImageData ??= canvas.ImageData;
  globalThis.Path2D ??= canvas.Path2D;
  const [{ PDFParse }, worker] = await Promise.all([import('pdf-parse'), import('pdf-parse/worker')]);
  PDFParse.setWorker(pathToFileURL(worker.getPath()).href);
  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory: worker.CanvasFactory });
  try {
    const result = await parser.getText();
    const total = Number(result.total) || result.pages?.length || 0;
    const sections = [];
    for (let index = 0; index < total; index += 1) {
      const page = result.pages?.find((item) => Number(item?.num) === index + 1) ?? result.pages?.[index];
      sections.push({ locator: `第 ${index + 1} 页`, text: cleanText(page?.text || '') });
    }
    return normalizeSections(sections);
  } finally {
    await parser.destroy();
  }
}

async function parseKnowledgeFile(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  if (TEXT_EXTENSIONS.has(extension)) {
    const raw = buffer.toString('utf8');
    const text = ['html','htm','xml'].includes(extension) ? raw.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ') : raw;
    return { sections: normalizeSections([{ locator:'正文', text }]), warning: null };
  }
  if (OFFICE_EXTENSIONS.has(extension)) {
    const sections = normalizeSections(extractOfficeSections(buffer, extension));
    return { sections, warning: sections.length ? null : '没有从Office文件中提取到文字。' };
  }
  if (extension === 'doc') {
    try {
      const imported = await import('word-extractor');
      const WordExtractor = imported.default ?? imported;
      const document = await new WordExtractor().extract(buffer);
      const sections = normalizeSections([
        { locator:'正文', text:document.getBody() }, { locator:'页眉', text:document.getHeaders({ includeFooters:false }) },
        { locator:'页脚', text:document.getFooters() }, { locator:'脚注', text:document.getFootnotes() },
        { locator:'批注', text:document.getAnnotations() }, { locator:'文本框', text:document.getTextboxes() },
      ]);
      return { sections, warning: sections.length ? null : '没有从旧版Word文档中提取到文字。' };
    } catch (error) { return { sections:[], warning:`旧版Word解析失败：${error.message}` }; }
  }
  if (extension === 'pdf') {
    try {
      const sections = await parsePdf(buffer);
      return { sections, warning: sections.length ? null : 'PDF没有可提取文字；扫描版文件后续可启用OCR。' };
    } catch (error) { return { sections:[], warning:`PDF解析失败：${error.message}` }; }
  }
  return { sections:[], warning:`暂不支持 .${extension} 正文解析。` };
}

function chunkSections(sections, maxLength = 900, overlap = 120) {
  const chunks = [];
  for (const section of sections) {
    const text = section.text;
    if (text.length <= maxLength) { chunks.push({ locator:section.locator, text }); continue; }
    let start = 0;
    let part = 1;
    while (start < text.length) {
      let end = Math.min(text.length, start + maxLength);
      if (end < text.length) {
        const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('。', end), text.lastIndexOf('；', end));
        if (boundary > start + maxLength * .55) end = boundary + 1;
      }
      chunks.push({ locator:`${section.locator}${part > 1 ? ` · ${part}` : ''}`, text:text.slice(start,end).trim() });
      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlap);
      part += 1;
    }
  }
  return chunks.filter((chunk) => chunk.text);
}

function tokenize(value) {
  const normalized = cleanText(value).toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]{1,}|[\u3400-\u9fff]/g) || []);
  const chinese = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  for (let index = 0; index < chinese.length - 1; index += 1) tokens.add(chinese[index] + chinese[index + 1]);
  return [...tokens];
}

function scoreChunk(chunk, queryTokens, rawQuery) {
  const haystack = chunk.text.toLowerCase();
  let score = haystack.includes(rawQuery.toLowerCase()) ? 24 : 0;
  for (const token of queryTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = haystack.match(new RegExp(escaped, 'g'))?.length || 0;
    score += Math.min(matches, 5) * (token.length > 1 ? 3 : 1);
  }
  return score;
}

function buildExtractiveAnswer(query, hits) {
  if (!hits.length) return `没有在已导入资料中找到与“${query}”直接相关的内容。可以导入更多任务书、规范、会议纪要或合同后再检索。`;
  const queryTokens = tokenize(query);
  const sentences = [];
  for (const hit of hits.slice(0, 4)) {
    for (const sentence of hit.text.split(/(?<=[。！？；\n])/).map((item) => item.trim()).filter(Boolean)) {
      const score = queryTokens.reduce((sum, token) => sum + (sentence.toLowerCase().includes(token) ? token.length : 0), 0);
      if (score > 0) sentences.push({ sentence, score, source:hit.documentName });
    }
  }
  const selected = sentences.sort((a,b) => b.score-a.score).slice(0,4);
  if (!selected.length) return `检索到 ${hits.length} 条相关资料。最相关内容来自《${hits[0].documentName}》${hits[0].locator}：${hits[0].text.slice(0,280)}${hits[0].text.length > 280 ? '…' : ''}`;
  return selected.map((item,index) => `${index + 1}. ${item.sentence}`).join('\n');
}

class KnowledgeService {
  constructor({ dataDir, idFactory }) {
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, 'knowledge-files');
    this.idFactory = idFactory;
    fs.mkdirSync(this.filesDir, { recursive:true });
  }

  isSupported(filePath) { return SUPPORTED_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase()); }

  async importFiles(filePaths, projectId, sourceType = 'project') {
    const documents = [];
    for (const originalPath of filePaths.filter((filePath) => this.isSupported(filePath))) {
      const id = this.idFactory('doc');
      const name = path.basename(originalPath);
      const storedPath = path.join(this.filesDir, `${id}-${safeFileName(name)}`);
      fs.copyFileSync(originalPath, storedPath);
      const stat = fs.statSync(storedPath);
      const parsed = await parseKnowledgeFile(storedPath);
      const chunks = chunkSections(parsed.sections);
      documents.push({
        id, projectId, name, originalPath, storedPath, extension:path.extname(name).slice(1).toLowerCase(), sourceType,
        size:stat.size, importedAt:Date.now(), updatedAt:Date.now(), status:chunks.length ? 'indexed' : 'metadata-only',
        warning:parsed.warning, sectionCount:parsed.sections.length, chunkCount:chunks.length, chunks,
      });
    }
    return documents;
  }

  search(documents, projectId, query, limit = 8) {
    const rawQuery = cleanText(query);
    if (!rawQuery) return { query, answer:'请输入要检索的问题。', hits:[] };
    const queryTokens = tokenize(rawQuery);
    const hits = [];
    for (const document of documents.filter((item) => item.projectId === projectId)) {
      for (const chunk of document.chunks || []) {
        const score = scoreChunk(chunk, queryTokens, rawQuery);
        if (score > 0) hits.push({ documentId:document.id, documentName:document.name, sourceType:document.sourceType, locator:chunk.locator, text:chunk.text, score });
      }
    }
    hits.sort((a,b) => b.score-a.score);
    const selected = hits.slice(0,limit);
    return { query:rawQuery, answer:buildExtractiveAnswer(rawQuery, selected), hits:selected.map((hit) => ({ ...hit, excerpt:hit.text.slice(0,420), text:undefined })) };
  }
}

module.exports = { KnowledgeService, SUPPORTED_EXTENSIONS };
