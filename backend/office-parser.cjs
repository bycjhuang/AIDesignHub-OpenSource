const { inflateRawSync } = require('node:zlib');

const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) return [];
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) return [];
  const entries = [];
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

function readZipEntryData(buffer, entry) {
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES || entry.compressedSize > MAX_ZIP_ENTRY_BYTES) return null;
  const local = entry.localHeaderOffset;
  if (local < 0 || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) return null;
  const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) return null;
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) {
    try { return inflateRawSync(compressed); } catch { return null; }
  }
  return null;
}

function decodeXmlEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const radix = entity.startsWith('#x') ? 16 : 10;
    const code = Number.parseInt(entity.replace(/^#x?/, ''), radix);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function xmlToText(xml) {
  return decodeXmlEntities(xml.replace(/<\/(?:w:p|a:p|row|si|c|v|t|a:t|w:t)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function selectedSections(buffer, matcher, label) {
  return readZipDirectory(buffer)
    .filter((entry) => matcher(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    .map((entry) => {
      const data = readZipEntryData(buffer, entry);
      return data ? { locator: label(entry.name), text: xmlToText(data.toString('utf8')) } : null;
    })
    .filter((section) => Boolean(section?.text));
}

function extractOfficeSections(buffer, extension) {
  if (extension === 'docx') {
    return selectedSections(buffer, (name) => /^word\/(?:document|header\d*|footer\d*)\.xml$/i.test(name), (name) => (/document\.xml$/i.test(name) ? '正文' : name));
  }
  if (extension === 'pptx') {
    return selectedSections(buffer, (name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name), (name) => `第 ${/slide(\d+)\.xml$/i.exec(name)?.[1] ?? '?'} 页`);
  }
  if (extension === 'xlsx') {
    return selectedSections(buffer, (name) => /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/i.test(name), (name) => {
      if (/sharedStrings\.xml$/i.test(name)) return '共享文本';
      return `工作表 ${/sheet(\d+)\.xml$/i.exec(name)?.[1] ?? '?'}`;
    });
  }
  return [];
}

module.exports = { extractOfficeSections };
