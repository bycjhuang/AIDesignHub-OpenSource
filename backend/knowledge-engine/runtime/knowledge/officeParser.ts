import { inflateRawSync } from 'node:zlib';

type ZipEntry = { name: string; compressionMethod: number; compressedSize: number; uncompressedSize: number; localHeaderOffset: number };
export type OfficeSection = { locator: string; text: string };
export type OfficeDocument = { sections: OfficeSection[]; warnings: string[] };
export const KNOWLEDGE_PARSER_REVISION = 'structured-office-20261016-v1';
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;

function findEndOfCentralDirectory(buffer: Buffer) {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) return [];
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) return [];
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) break;
    entries.push({
      name: buffer.subarray(nameStart, nameEnd).toString('utf8'),
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryData(buffer: Buffer, entry: ZipEntry) {
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES || entry.compressedSize > MAX_ZIP_ENTRY_BYTES) return null;
  const local = entry.localHeaderOffset;
  if (local < 0 || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) return null;
  const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) return null;
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) {
    try { return inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES }); } catch { return null; }
  }
  return null;
}

function decodeXmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const radix = /^#x/i.test(entity) ? 16 : 10;
    const code = Number.parseInt(entity.replace(/^#x?/i, ''), radix);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

function xmlToText(xml: string) {
  return decodeXmlEntities(xml.replace(/<\/(?:w:p|a:p|row|si|c)>/gi, '\n').replace(/<(?:w:|a:)?(?:br|tab)\b[^>]*\/\s*>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\u0000/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attributes(xml: string): Record<string, string> {
  return Object.fromEntries([...xml.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => [match[1], decodeXmlEntities(match[2] ?? match[3] ?? '')]));
}

function textRuns(xml: string) {
  // Rich-text runs belong to the same cell/paragraph; phonetic annotations do not.
  return [...xml.replace(/<(?:\w+:)?rPh\b[^>]*>[\s\S]*?<\/(?:\w+:)?rPh>/gi, '').matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
    .map((match) => decodeXmlEntities(match[1].replace(/<[^>]*>/g, ''))).join('');
}

function spreadsheetColumn(value: string) {
  return value.split('').reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
}

function structuredTable(xml: string, namespace: 'w' | 'a', tableIndex: number) {
  const rows = [...xml.matchAll(new RegExp(`<${namespace}:tr\\b[^>]*>([\\s\\S]*?)<\\/${namespace}:tr>`, 'gi'))];
  return rows.map((row, index) => {
    let column = 1;
    const cells = [...row[1].matchAll(new RegExp(`<${namespace}:tc\\b[^>]*>([\\s\\S]*?)<\\/${namespace}:tc>`, 'gi'))].map((cell) => {
      const span = Math.max(1, Number(/<w:gridSpan\b[^>]*w:val=["'](\d+)["']/i.exec(cell[1])?.[1]) || 1);
      const label = span > 1 ? `列${column}-${column + span - 1}` : `列${column}`;
      column += span;
      const continuation = /<w:vMerge\s*\/>/i.test(cell[1]) ? '【纵向合并续接】' : '';
      const text = xmlToText(cell[1]).replace(/\n+/g, ' / ');
      return `${label}=${text || continuation || '【空白】'}`;
    });
    return `表格${tableIndex} 第${index + 1}行：${cells.join(' | ')}`;
  }).join('\n');
}

function structuredDocumentText(xml: string, namespace: 'w' | 'a') {
  const tables: string[] = [];
  return decodeXmlEntities(xml.replace(new RegExp(`<${namespace}:tbl\\b[^>]*>[\\s\\S]*?<\\/${namespace}:tbl>`, 'gi'), (table) => {
    tables.push(structuredTable(table, namespace, tables.length + 1));
    return `\n\uE000TABLE${tables.length - 1}\uE001\n`;
  })
    .replace(new RegExp(`<${namespace}:(?:tab|br|cr)\\b[^>]*\\/>`, 'gi'), '\n')
    .replace(new RegExp(`<\\/${namespace}:p>`, 'gi'), '\n')
    .replace(new RegExp(`<${namespace}:t\\b[^>]*>([\\s\\S]*?)<\\/${namespace}:t>`, 'gi'), (_match, text) => text)
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')).replace(/\uE000TABLE(\d+)\uE001/g, (_match, index) => tables[Number(index)]).trim();
}

function excelDate(value: string, formatId: number, customFormat: string | undefined, date1904: boolean) {
  const format = (customFormat || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').toLowerCase();
  const isDate = (formatId >= 14 && formatId <= 22) || (formatId >= 27 && formatId <= 36) || (formatId >= 45 && formatId <= 47) || (formatId >= 50 && formatId <= 58) || /[ymdhis]/.test(format);
  const serial = Number(value);
  if (!isDate || !Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return value;
  if (!date1904 && Math.floor(serial) === 60) return `1900-02-29（Excel原值${value}）`;
  const origin = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  const corrected = !date1904 && serial < 60 ? serial + 1 : serial;
  const date = new Date(origin + Math.round(corrected * 86_400_000));
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$/, ' UTC');
}

function extractSpreadsheet(entries: ZipEntry[], readXml: (name: string) => string, warnings: Set<string>): OfficeSection[] {
  const sharedXml = readXml('xl/sharedStrings.xml');
  const shared = [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?si>)/gi)].map((item) => textRuns(item[1] || ''));
  const workbook = readXml('xl/workbook.xml');
  const relations = new Map([...readXml('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/(?:\w+:)?Relationship>)/gi)]
    .map((match) => { const attr = attributes(match[1]); return [attr.Id, attr.Target] as const; }));
  const sheetNames = new Map<string, string>();
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)(?:\/\s*>|>)/gi)) {
    const attr = attributes(match[1]);
    const target = relations.get(attr['r:id']);
    if (target) {
      const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      sheetNames.set(normalized, attr.name || '未命名');
    }
  }
  const stylesXml = readXml('xl/styles.xml');
  const customFormats = new Map([...stylesXml.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?\s*>/gi)].map((match) => { const attr = attributes(match[1]); return [Number(attr.numFmtId), attr.formatCode] as const; }));
  const cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/i.exec(stylesXml)?.[1] || '';
  const formats = [...cellXfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?\s*>/gi)].map((match) => Number(attributes(match[1]).numFmtId) || 0);
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*date1904=["'](?:1|true)["']/i.test(workbook);
  const sections: OfficeSection[] = [];
  for (const entry of entries.filter((item) => /^xl\/worksheets\/[^/]+\.xml$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
    const xml = readXml(entry.name);
    const sheetName = sheetNames.get(entry.name) || `工作表 ${/sheet(\d+)\.xml$/i.exec(entry.name)?.[1] || entry.name}`;
    const rows: Array<{ number: number; values: Map<string, string> }> = [];
    const allColumns = new Set<string>();
    for (const row of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?row>)/gi)) {
      const rowNumber = Number(attributes(row[1]).r) || rows.length + 1;
      const values = new Map<string, string>();
      for (const cell of (row[2] || '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi)) {
        const attr = attributes(cell[1]);
        const body = cell[2] || '';
        const column = /^([a-z]+)\d+$/i.exec(attr.r || '')?.[1].toUpperCase();
        if (!column) { warnings.add('部分单元格缺少地址，无法保证列对应关系；请回到原表核对。'); continue; }
        const rawValue = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i.exec(body)?.[1];
        const formula = /<(?:\w+:)?f\b[^>]*(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?f>)/i.exec(body);
        let value = decodeXmlEntities(rawValue ?? '');
        if (attr.t === 's') {
          const index = /^\d+$/.test(value) ? Number(value) : -1;
          if (index >= 0 && index < shared.length) value = shared[index];
          else { value = `【待核实：共享文本索引${value || '?'}不存在】`; warnings.add('部分共享文本引用无效，已在对应单元格标记待核实。'); }
        } else if (attr.t === 'inlineStr') value = textRuns(body);
        else if (attr.t === 'b') value = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value;
        else if (attr.t === 'e') value = `【Excel错误：${value}】`;
        else if (!attr.t || attr.t === 'n') { const formatId = formats[Number(attr.s) || 0] || 0; value = value ? excelDate(value, formatId, customFormats.get(formatId), date1904) : ''; }
        if (formula && rawValue === undefined) {
          value = `【待核实：公式${decodeXmlEntities(formula[1] || '（共享公式）')}无缓存值，尚未计算】`;
          warnings.add('部分公式没有缓存值；已保留公式并标记待核实，不会将其当作零或计算结果。');
        }
        values.set(column, value.replace(/\r?\n/g, ' / '));
        allColumns.add(column);
      }
      if (values.size) rows.push({ number: rowNumber, values });
    }
    const columns = [...allColumns].sort((a, b) => spreadsheetColumn(a) - spreadsheetColumn(b));
    const rowText = (row: typeof rows[number]) => `第${row.number}行：${columns.map((column) => `${column}${row.number}=${row.values.get(column) || '【空白】'}`).join(' | ')}`;
    for (let offset = 0; offset < rows.length; offset += 40) {
      const batch = rows.slice(offset, offset + 40);
      sections.push({ locator: `工作表「${sheetName}」 · 行 ${batch[0].number}-${batch.at(-1)!.number}`,
        text: `工作表：${sheetName}\n列坐标：${columns.join(' | ')}\n${offset ? `原始首行参考（可能为表头）：${rowText(rows[0])}\n` : ''}${batch.map(rowText).join('\n')}` });
    }
    if (/<(?:\w+:)?mergeCell\b/i.test(xml)) warnings.add('工作表含合并单元格；保留原始单元格坐标，空白位置不会自动填充或猜测。');
    if (/<(?:\w+:)?f\b/i.test(xml)) warnings.add('公式仅读取文件保存时的缓存值，未重新计算；缓存值可能需要在 Excel 中刷新。');
  }
  return sections;
}

export function extractOfficeDocument(buffer: Buffer, extension: string): OfficeDocument {
  const entries = readZipDirectory(buffer);
  const warnings = new Set<string>();
  const xmlCache = new Map<string, string>();
  const readXml = (name: string) => {
    if (xmlCache.has(name)) return xmlCache.get(name)!;
    const entry = entries.find((item) => item.name === name);
    if (!entry) return '';
    const bytes = readZipEntryData(buffer, entry);
    if (!bytes) warnings.add(`Office 组件 ${name} 无法解析或超过安全大小限制，正文可能不完整。`);
    const text = bytes?.toString('utf8') || '';
    xmlCache.set(name, text);
    return text;
  };
  let sections: OfficeSection[] = [];
  if (extension === 'xlsx') sections = extractSpreadsheet(entries, readXml, warnings);
  else if (extension === 'docx' || extension === 'pptx') {
    const matcher = extension === 'docx' ? /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i : /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/i;
    sections = entries.filter((entry) => matcher.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
      .map((entry) => ({ locator: extension === 'docx' ? (/document\.xml$/i.test(entry.name) ? '正文' : entry.name)
        : `${/notesSlide/i.test(entry.name) ? '备注' : '第'} ${/(?:notesSlide|slide)(\d+)\.xml$/i.exec(entry.name)?.[1] || '?'} 页`,
      text: structuredDocumentText(readXml(entry.name), extension === 'docx' ? 'w' : 'a') })).filter((section) => section.text);
    if (entries.some((entry) => matcher.test(entry.name) && /<(w|a):tbl\b(?:(?!<\/(?:w|a):tbl>)[\s\S])*<(?:w|a):tbl\b/i.test(readXml(entry.name)))) warnings.add('文件包含嵌套表格，行列关系可能不完整，需回到原文件核对。');
  }
  if (entries.some((entry) => /\/(?:drawings|charts|embeddings|media)\//i.test(entry.name))) warnings.add('文件包含图表、图片或嵌入对象；当前只提取正文和表格文字，未识别这些对象中的内容。');
  if (!entries.length) warnings.add('Office 压缩结构无法读取，请确认文件未损坏且不受密码保护。');
  return { sections, warnings: [...warnings] };
}

export function extractOfficeSections(buffer: Buffer, extension: string): OfficeSection[] {
  return extractOfficeDocument(buffer, extension).sections;
}

export function extractOfficeText(buffer: Buffer, extension: string) {
  return extractOfficeSections(buffer, extension).map((section) => `${section.locator}\n${section.text}`).join('\n\n');
}
