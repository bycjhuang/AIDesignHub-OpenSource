import { deflateRawSync } from 'node:zlib';
import releaseIdentity from '../../../../assets/release-identity.json';

const EXPORT_MARK = `Powered by AIDesignHub · v${releaseIdentity.version} · ${releaseIdentity.releaseId.slice(-12)}`;

export type KnowledgeExportFormat = 'xlsx' | 'docx' | 'pptx';
export type KnowledgeExportCell = string | number | boolean | null;
export type KnowledgeExportTable = { name: string; columns: string[]; rows: KnowledgeExportCell[][] };
export type KnowledgeExportInput = {
  format: KnowledgeExportFormat;
  title: string;
  markdown: string;
  /** Complete structured tables, when present, replace Markdown table previews. */
  tables?: KnowledgeExportTable[];
  sources?: Array<{ name: string; locator?: string }>;
  coverage?: string;
};
export type KnowledgeExportResult = { buffer: Buffer; suggestedName: string; mimeType: string };

type Block = { kind: 'paragraph' | 'heading'; text: string; level?: number } | { kind: 'table'; table: KnowledgeExportTable };
type ZipFile = { name: string; text: string };
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_INPUT_CHARACTERS = 16 * 1024 * 1024;
const MIME: Record<KnowledgeExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function xml(value: unknown) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plain(value: string) {
  return value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '').replace(/\\([\\|*_`])/g, '$1');
}

function tableCells(line: string) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (char === '|' && !escaped) { cells.push(plain(current.trim())); current = ''; }
    else { current += char; }
    escaped = char === '\\' && !escaped;
  }
  cells.push(plain(current.trim()));
  return cells;
}

function markdownCell(value: string): KnowledgeExportCell {
  // Codes, long identifiers, currency and uncertain OCR values remain literal text.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.replace(/[-.]/g, '').length <= 15) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let heading = '数据';
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && line.includes('|') && index + 1 < lines.length
      && tableCells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell)) && lines[index + 1].includes('-')) {
      const columns = tableCells(line);
      const rows: KnowledgeExportCell[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(tableCells(lines[index]).map(markdownCell)); index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'table', table: { name: heading, columns, rows } });
      continue;
    }
    const match = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) { heading = plain(match[2]); blocks.push({ kind: 'heading', text: heading, level: match[1].length }); }
    else if (line.trim()) blocks.push({ kind: 'paragraph', text: fenced ? line : plain(line.replace(/^\s*[-*+]\s+/, '• ')) });
  }
  return blocks;
}

function safeName(title: string, format: KnowledgeExportFormat) {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/g, '').trim();
  const base = [...(name || '知识库整理结果')].slice(0, 100).join('');
  return `${/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base}.${format}`;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function zip(files: ZipFile[]) {
  if (files.length > 65_535) throw new Error('导出文件过大，请分批导出。');
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.text, 'utf8');
    const compressed = deflateRawSync(data);
    let checksum = 0xffffffff;
    for (const byte of data) checksum = CRC_TABLE[(checksum ^ byte) & 255] ^ (checksum >>> 8);
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(0x2821, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const directorySize = directory.reduce((size, part) => size + part.length, 0);
  if (offset + directorySize > 0xffffffff) throw new Error('导出文件过大，请分批导出。');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}

function relationships(entries: Array<{ id: string; type: string; target: string }>) {
  return `${XML}<Relationships xmlns="${REL}">${entries.map((entry) => `<Relationship Id="${xml(entry.id)}" Type="${OFFICE_REL}/${entry.type}" Target="${xml(entry.target)}"/>`).join('')}</Relationships>`;
}

function packageFiles(main: string, contentType: string, title: string, parts: Array<{ name: string; type: string }>): ZipFile[] {
  return [
    { name: '[Content_Types].xml', text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${contentType}"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${parts.map((part) => `<Override PartName="/${part.name}" ContentType="${part.type}"/>`).join('')}</Types>` },
    { name: '_rels/.rels', text: `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="${main}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', text: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>AIDesignHub</dc:creator><dc:description>${xml(releaseIdentity.releaseId)} | ${xml(releaseIdentity.sourceCanary)}</dc:description></cp:coreProperties>` },
  ];
}

function normalizedTable(table: KnowledgeExportTable) {
  const width = table.rows.reduce((maximum, row) => Math.max(maximum, row.length), Math.max(table.columns.length, 1));
  const used = new Set<string>();
  const columns = Array.from({ length: width }, (_, index) => {
    const raw = table.columns[index] || `列 ${index + 1}`;
    let name = raw; let suffix = 2;
    while (used.has(name.toLocaleLowerCase())) name = `${raw} (${suffix++})`;
    used.add(name.toLocaleLowerCase()); return name;
  });
  return { ...table, columns, rows: table.rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? null)) };
}

function shortSheetName(value: string, limit: number) {
  let name = '';
  for (const character of value) { if (name.length + character.length > limit) break; name += character; }
  return name;
}

function columnName(index: number) {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

function spreadsheetCell(value: KnowledgeExportCell, reference: string, header: boolean) {
  const style = header ? ' s="1"' : ' s="2"';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"${style}><v>${Number(value)}</v></c>`;
  if (value === null) return `<c r="${reference}"${style}/>`;
  if (String(value).length > 32_767) throw new Error('单元格超过 Excel 的 32767 字符限制，请拆分内容后导出。');
  const text = String(value).replace(/_x[\da-f]{4}_/gi, '_x005F_$&');
  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function spreadsheet(input: KnowledgeExportInput, blocks: Block[]) {
  const tables = blocks.filter((block): block is Extract<Block, { kind: 'table' }> => block.kind === 'table').map((block) => normalizedTable(block.table));
  const summary: KnowledgeExportTable = { name: '说明', columns: ['内容'], rows: [[input.title], ...blocks.filter((block) => block.kind !== 'table').map((block) => [block.text])] };
  const provenance: KnowledgeExportTable = { name: '来源与处理范围', columns: ['项目', '内容'], rows: [
    ['软件来源', EXPORT_MARK],
    ...(input.coverage ? [['处理范围', input.coverage]] : []),
    ...(input.sources ?? []).map((source) => [source.name, source.locator ?? '']),
  ] };
  const sheets = [...tables, summary, provenance].map(normalizedTable);
  const names = new Set<string>();
  const sheetNames = sheets.map((sheet) => {
    let base = sheet.name.replace(/[\\/?*\[\]:\u0000-\u001f]/g, '_').replace(/^'+|'+$/g, '').trim() || '数据';
    if (/^history$/i.test(base)) base = '历史记录';
    base = shortSheetName(base, 31);
    let name = base; let suffix = 2;
    while (names.has(name.toLocaleLowerCase())) { const ending = ` (${suffix++})`; name = shortSheetName(base, 31 - ending.length) + ending; }
    names.add(name.toLocaleLowerCase()); return name;
  });
  const parts = sheets.map((_, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' }));
  const nativeTables = tables.map((table, index) => table.rows.length > 0 && table.columns.every((column) => column.length <= 255) ? index : -1).filter((index) => index >= 0);
  parts.push(...nativeTables.map((index) => ({ name: `xl/tables/table${index + 1}.xml`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml' })));
  parts.push({ name: 'xl/styles.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' });
  const files = packageFiles('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', input.title, parts);
  files.push({ name: 'xl/workbook.xml', text: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}"><bookViews><workbookView/></bookViews><sheets>${sheetNames.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', text: relationships([...sheets.map((_, index) => ({ id: `rId${index + 1}`, type: 'worksheet', target: `worksheets/sheet${index + 1}.xml` })), { id: `rId${sheets.length + 1}`, type: 'styles', target: 'styles.xml' }]) });
  files.push({ name: 'xl/styles.xml', text: `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="微软雅黑"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4836B8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    if (sheet.rows.length > 1_048_575 || sheet.columns.length > 16_384) throw new Error('数据超过 Excel 工作表行列上限，请分批导出。');
    const end = `${columnName(sheet.columns.length - 1)}${sheet.rows.length + 1}`;
    const rows = [sheet.columns, ...sheet.rows].map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, cellIndex) => spreadsheetCell(value, `${columnName(cellIndex)}${rowIndex + 1}`, rowIndex === 0)).join('')}</row>`).join('');
    const columns = sheet.columns.map((_, column) => `<col min="${column + 1}" max="${column + 1}" width="${sheet.columns.length === 1 ? 100 : column === 0 ? 26 : 32}" customWidth="1"/>`).join('');
    const hasNativeTable = nativeTables.includes(index);
    files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, text: `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${columns}</cols><sheetData>${rows}</sheetData>${hasNativeTable ? '' : `<autoFilter ref="A1:${end}"/>`}<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><headerFooter><oddFooter>&amp;R${xml(EXPORT_MARK)}</oddFooter><evenFooter>&amp;R${xml(EXPORT_MARK)}</evenFooter></headerFooter>${hasNativeTable ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : ''}</worksheet>` });
    if (hasNativeTable) {
      files.push({ name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`, text: relationships([{ id: 'rId1', type: 'table', target: `../tables/table${index + 1}.xml` }]) });
      files.push({ name: `xl/tables/table${index + 1}.xml`, text: `${XML}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${index + 1}" name="DataTable${index + 1}" displayName="DataTable${index + 1}" ref="A1:${end}" totalsRowShown="0"><autoFilter ref="A1:${end}"/><tableColumns count="${sheet.columns.length}">${sheet.columns.map((column, columnIndex) => `<tableColumn id="${columnIndex + 1}" name="${xml(column)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>` });
    }
  }
  return zip(files);
}

function wordParagraph(text: string, style = 'Normal') {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xml(text).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">')}</w:t></w:r></w:p>`;
}

function wordTable(table: KnowledgeExportTable) {
  const normalized = normalizedTable(table);
  const width = Math.floor(9_360 / normalized.columns.length);
  const rows = [normalized.columns, ...normalized.rows].map((row, index) => `<w:tr>${index === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${index === 0 ? '<w:shd w:fill="EEEAFB"/>' : ''}</w:tcPr>${wordParagraph(String(cell ?? ''))}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9DCE5"/><w:left w:val="single" w:sz="4" w:color="D9DCE5"/><w:bottom w:val="single" w:sz="4" w:color="D9DCE5"/><w:right w:val="single" w:sz="4" w:color="D9DCE5"/><w:insideH w:val="single" w:sz="4" w:color="D9DCE5"/><w:insideV w:val="single" w:sz="4" w:color="D9DCE5"/></w:tblBorders></w:tblPr><w:tblGrid>${normalized.columns.map(() => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}

function document(input: KnowledgeExportInput, blocks: Block[]) {
  const files = packageFiles('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', input.title, [{ name: 'word/styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' }, { name: 'word/footer1.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml' }]);
  const body = [wordParagraph(input.title, 'Title'), ...blocks.map((block) => block.kind === 'table' ? wordTable(block.table) : wordParagraph(block.text, block.kind === 'heading' ? `Heading${Math.min(block.level ?? 1, 3)}` : 'Normal'))];
  if (input.coverage) body.push(wordParagraph('处理范围', 'Heading1'), wordParagraph(input.coverage));
  if (input.sources?.length) body.push(wordParagraph('资料来源', 'Heading1'), ...input.sources.map((source) => wordParagraph(`${source.name}${source.locator ? ` · ${source.locator}` : ''}`)));
  files.push({ name: 'word/footer1.xml', text: `${XML}<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="777777"/><w:sz w:val="16"/></w:rPr><w:t>${xml(EXPORT_MARK)}</w:t></w:r></w:p></w:ftr>` });
  files.push({ name: 'word/document.xml', text: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${OFFICE_REL}"><w:body>${body.join('')}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1273" w:bottom="1080" w:left="1273" w:header="360" w:footer="360"/></w:sectPr></w:body></w:document>` });
  files.push({ name: 'word/_rels/document.xml.rels', text: relationships([{ id: 'rId1', type: 'styles', target: 'styles.xml' }, { id: 'rIdFooter', type: 'footer', target: 'footer1.xml' }]) });
  files.push({ name: 'word/styles.xml', text: `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style>${[1, 2, 3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${30 - level * 2}"/></w:rPr></w:style>`).join('')}</w:styles>` });
  return zip(files);
}

type Slide = { title: string; paragraphs?: string[]; table?: KnowledgeExportTable };
const PPT_TABLE_HEIGHT = 4_750_000;

function textLines(text: string, width: number) {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = ''; let units = 0;
    for (const character of paragraph) {
      const size = character.charCodeAt(0) > 255 ? 2 : 1;
      if (units + size > width && line) { result.push(line); line = ''; units = 0; }
      line += character; units += size;
    }
    result.push(line);
  }
  return result;
}

function presentationRowHeight(row: KnowledgeExportCell[], columns: number) {
  const lines = row.reduce<number>((maximum, cell) => Math.max(maximum, textLines(String(cell ?? ''), Math.max(1, Math.floor(100 / columns))).length), 1);
  // 16 pt × 115% line spacing plus cell margins, in EMUs. Never cap a row below its text height.
  return lines * 240_000 + 110_000;
}

function presentationSlides(input: KnowledgeExportInput, blocks: Block[]): Slide[] {
  const slides: Slide[] = [];
  let title = input.title;
  let paragraphs: string[] = [];
  const flush = () => { if (paragraphs.length) { slides.push({ title, paragraphs }); paragraphs = []; } };
  const textSlides = (slideTitle: string, lines: string[]) => {
    for (let start = 0; start < lines.length; start += 12) slides.push({ title: slideTitle, paragraphs: lines.slice(start, start + 12) });
  };
  for (const block of blocks) {
    if (block.kind === 'heading') { flush(); title = block.text; continue; }
    if (block.kind === 'table') {
      flush();
      const table = normalizedTable(block.table);
      // Split wide tables into two-column label/value slides: never squeeze or drop cells.
      if (table.columns.length > 6) {
        if (!table.rows.length) textSlides(table.name, table.columns.flatMap(column => textLines(column, 80)));
        table.rows.forEach((row, index) => {
          const lines = table.columns.map((column, columnIndex) => `${column}：${row[columnIndex] ?? ''}`);
          textSlides(`${block.table.name} · 第 ${index + 1} 条`, lines.flatMap((line) => textLines(line, 80)));
        });
      } else {
        // Account for the repeated header and actual row height before fitting each slide.
        const headerHeight = presentationRowHeight(table.columns, table.columns.length);
        let rows: KnowledgeExportCell[][] = []; let height = headerHeight;
        for (const row of table.rows) {
          const rowHeight = presentationRowHeight(row, table.columns.length);
          if (rowHeight + headerHeight > PPT_TABLE_HEIGHT) {
            if (rows.length) { slides.push({ title: table.name, table: { ...table, rows } }); rows = []; height = headerHeight; }
            const lines = row.flatMap((cell, column) => textLines(`${table.columns[column]}：${cell ?? ''}`, 80));
            textSlides(table.name, lines);
          } else {
            if (rows.length && height + rowHeight > PPT_TABLE_HEIGHT) { slides.push({ title: table.name, table: { ...table, rows } }); rows = []; height = headerHeight; }
            rows.push(row); height += rowHeight;
          }
        }
        if (rows.length) slides.push({ title: table.name, table: { ...table, rows } });
        else if (!table.rows.length) {
          if (headerHeight <= PPT_TABLE_HEIGHT) slides.push({ title: table.name, table });
          else textSlides(table.name, table.columns.flatMap(column => textLines(column, 80)));
        }
      }
      continue;
    }
    for (const line of textLines(block.text, 88)) { paragraphs.push(line); if (paragraphs.length >= 13) flush(); }
  }
  flush();
  if (!slides.length) slides.push({ title: input.title, paragraphs: [] });
  const provenance = [...(input.coverage ? [`处理范围：${input.coverage}`] : []), ...(input.sources ?? []).map((source) => `${source.name}${source.locator ? ` · ${source.locator}` : ''}`)].flatMap((line) => textLines(line, 88));
  for (let start = 0; start < provenance.length; start += 13) slides.push({ title: '资料来源与处理范围', paragraphs: provenance.slice(start, start + 13) });
  return slides;
}

function drawingParagraph(text: string, size: number, bold = false) {
  return `<a:p><a:pPr marL="0" indent="0"><a:lnSpc><a:spcPct val="115000"/></a:lnSpc></a:pPr><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="202437"/></a:solidFill><a:latin typeface="Calibri"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${xml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`;
}

function textShape(id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string[], size: number, bold = false) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs.map((text) => drawingParagraph(text, size, bold)).join('') || drawingParagraph('', size)}</p:txBody></p:sp>`;
}

function presentationTable(table: KnowledgeExportTable) {
  const columns = table.columns.length;
  const width = Math.floor(10_972_800 / columns);
  const heights = [table.columns, ...table.rows].map(row => presentationRowHeight(row, columns));
  const rows = [table.columns, ...table.rows].map((row, index) => `<a:tr h="${heights[index]}">${row.map((cell) => `<a:tc><a:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${String(cell ?? '').split('\n').map((line) => drawingParagraph(line, 1600, index === 0)).join('')}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720"><a:solidFill><a:srgbClr val="${index === 0 ? 'EEEAFB' : index % 2 ? 'FFFFFF' : 'F5F6FA'}"/></a:solidFill></a:tcPr></a:tc>`).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="数据表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="609600" y="1524000"/><a:ext cx="10972800" cy="${heights.reduce((sum, height) => sum + height, 0)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${table.columns.map(() => `<a:gridCol w="${width}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function presentation(input: KnowledgeExportInput, blocks: Block[]) {
  const slides = presentationSlides(input, blocks);
  const parts = slides.map((_, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, type: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml' }));
  parts.push({ name: 'ppt/slideMasters/slideMaster1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml' }, { name: 'ppt/slideLayouts/slideLayout1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml' }, { name: 'ppt/theme/theme1.xml', type: 'application/vnd.openxmlformats-officedocument.theme+xml' });
  const files = packageFiles('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', input.title, parts);
  const namespaces = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  files.push({ name: 'ppt/presentation.xml', text: `${XML}<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` });
  files.push({ name: 'ppt/_rels/presentation.xml.rels', text: relationships([...slides.map((_, index) => ({ id: `rId${index + 1}`, type: 'slide', target: `slides/slide${index + 1}.xml` })), { id: 'rIdMaster', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }]) });
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', text: `${XML}<p:sldMaster ${namespaces}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>` });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', text: relationships([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }]) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', text: `${XML}<p:sldLayout ${namespaces} type="blank" preserve="1"><p:cSld name="空白"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', text: relationships([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]) });
  files.push({ name: 'ppt/theme/theme1.xml', text: `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="资料整理"><a:themeElements><a:clrScheme name="资料整理">${[['dk1', '202437'], ['lt1', 'FFFFFF'], ['dk2', '4C536B'], ['lt2', 'F5F6FA'], ['accent1', '4836B8'], ['accent2', '2563EB'], ['accent3', '059669'], ['accent4', 'D97706'], ['accent5', 'DB2777'], ['accent6', '0891B2'], ['hlink', '2563EB'], ['folHlink', '7C3AED']].map(([key, value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`).join('')}</a:clrScheme><a:fontScheme name="中文"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="默认"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map((width) => `<a:ln w="${width}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>` });
  slides.forEach((slide, index) => {
    const title = textShape(2, '标题', 609600, 365760, 10972800, 1005840, textLines(slide.title, 60), 3000, true);
    const body = slide.table ? presentationTable(slide.table) : textShape(3, '正文', 609600, 1524000, 10972800, 4754880, slide.paragraphs ?? [], 2000);
    const footer = textShape(4, '页码', 10_668_000, 6_400_800, 914400, 228600, [`${index + 1} / ${slides.length}`], 1100);
    const brand = textShape(5, '来源标识', 609600, 6_400_800, 9_000_000, 228600, [EXPORT_MARK], 900);
    files.push({ name: `ppt/slides/slide${index + 1}.xml`, text: `${XML}<p:sld ${namespaces}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${title}${body}${footer}${brand}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>` });
    files.push({ name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, text: relationships([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }]) });
  });
  return zip(files);
}

/** Creates only a document buffer; trusted main-process code owns the save dialog and destination. */
export function createKnowledgeExport(input: KnowledgeExportInput): KnowledgeExportResult {
  if (!input || !Object.hasOwn(MIME, input.format) || typeof input.title !== 'string' || typeof input.markdown !== 'string') throw new Error('文件导出参数无效。');
  if (input.markdown.length > MAX_INPUT_CHARACTERS || input.title.length > 1000) throw new Error('导出内容过大，请分批导出。');
  if ((input.tables !== undefined && !Array.isArray(input.tables)) || (input.sources !== undefined && !Array.isArray(input.sources))
    || (input.coverage !== undefined && typeof input.coverage !== 'string')
    || !(input.sources ?? []).every((source) => source && typeof source.name === 'string' && (source.locator === undefined || typeof source.locator === 'string'))) throw new Error('文件导出参数无效。');
  let characters = input.markdown.length + input.title.length + (input.coverage?.length ?? 0);
  let cells = 0;
  for (const source of input.sources ?? []) characters += source.name.length + (source.locator?.length ?? 0);
  for (const table of input.tables ?? []) {
    if (!table || typeof table.name !== 'string' || !Array.isArray(table.columns) || !table.columns.every((column) => typeof column === 'string') || !Array.isArray(table.rows)
      || !table.rows.every((row) => Array.isArray(row) && row.every((cell) => cell === null || typeof cell === 'string' || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell))))) throw new Error('导出表格格式无效。');
    characters += table.name.length + table.columns.reduce((total, column) => total + column.length, 0);
    const width = table.rows.reduce((maximum, row) => Math.max(maximum, row.length), Math.max(table.columns.length, 1));
    cells += width * (table.rows.length + 1);
    for (const row of table.rows) for (const cell of row) characters += String(cell ?? '').length;
  }
  if (characters > MAX_INPUT_CHARACTERS || cells > 2_000_000) throw new Error('导出内容过大，请分批导出。');
  // Structured tables carry full rows and provenance; Markdown may contain a duplicate preview.
  const blocks = parseMarkdown(input.markdown).filter((block) => !input.tables?.length || block.kind !== 'table');
  blocks.push(...(input.tables ?? []).map((table): Block => ({ kind: 'table', table })));
  const buffer = input.format === 'xlsx' ? spreadsheet(input, blocks) : input.format === 'docx' ? document(input, blocks) : presentation(input, blocks);
  return { buffer, suggestedName: safeName(input.title, input.format), mimeType: MIME[input.format] };
}
