import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractOfficeDocument } from './officeParser';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'log']);
const OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx']);
const LEGACY_OFFICE_EXTENSIONS = new Set(['doc', 'ppt', 'xls']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff']);
const MAX_PDF_OCR_PAGES = 300;

export const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, ...LEGACY_OFFICE_EXTENSIONS, ...IMAGE_EXTENSIONS, 'pdf']);
export type ParsedSection = { locator: string; text: string };
export type ParsedDocument = { text: string; sections: ParsedSection[]; status: 'indexed' | 'metadata-only'; warning?: string };

function cleanText(value: string) {
  return value.normalize('NFKC').replace(/\u0000/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fromSections(sections: ParsedSection[], warning?: string): ParsedDocument {
  const cleaned = sections.map((section) => ({ locator: section.locator, text: cleanText(section.text) })).filter((section) => section.text);
  return cleaned.length
    ? { text: cleaned.map((section) => section.text).join('\n\n'), sections: cleaned, status: 'indexed', warning }
    : { text: '', sections: [], status: 'metadata-only', warning };
}

function localOcrOptions() {
  const bundledAssets = process.env.BYCJ_KNOWLEDGE_ASSETS_DIR;
  const bundledOcr = bundledAssets ? path.join(bundledAssets, 'ocr') : '';
  if (!bundledOcr || !existsSync(path.join(bundledOcr, 'chi_sim.traineddata.gz'))) throw new Error('本地 OCR 资源未安装；不会联网下载。');
  return { langPath: bundledOcr, cacheMethod: 'none' as const, gzip: true };
}

async function createChineseOcrWorker() {
  const { createWorker } = await import('tesseract.js');
  return createWorker('chi_sim', 1, localOcrOptions());
}

export async function parseKnowledgeFile(filePath: string): Promise<ParsedDocument> {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const buffer = await readFile(filePath);

  if (TEXT_EXTENSIONS.has(extension)) return fromSections([{ locator: '正文', text: buffer.toString('utf8') }]);
  if (OFFICE_EXTENSIONS.has(extension)) {
    const document = extractOfficeDocument(buffer, extension);
    const result = fromSections(document.sections, document.warnings.join(' ') || undefined);
    return result.status === 'indexed'
      ? result
      : { ...result, warning: '没有从文件中提取到可索引文字；复杂图表或嵌入对象可能需要另行处理。' };
  }
  if (extension === 'doc') {
    try {
      const module = await import('word-extractor');
      const WordExtractor = (module.default ?? module) as unknown as new () => {
        extract(input: Buffer): Promise<{
          getBody(): string;
          getHeaders(options?: { includeFooters?: boolean }): string;
          getFooters(): string;
          getFootnotes(): string;
          getEndnotes(): string;
          getAnnotations(): string;
          getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
        }>;
      };
      const document = await new WordExtractor().extract(buffer);
      return fromSections([
        { locator: '正文', text: document.getBody() },
        { locator: '页眉', text: document.getHeaders({ includeFooters: false }) },
        { locator: '页脚', text: document.getFooters() },
        { locator: '脚注', text: document.getFootnotes() },
        { locator: '尾注', text: document.getEndnotes() },
        { locator: '批注', text: document.getAnnotations() },
        { locator: '文本框', text: document.getTextboxes() },
      ]);
    } catch (error) {
      return {
        text: '',
        sections: [],
        status: 'metadata-only',
        warning: `旧版 Word 文档解析失败：${error instanceof Error ? error.message : '未知错误'}。可另存为 docx 后重试。`,
      };
    }
  }
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    return { text: '', sections: [], status: 'metadata-only', warning: '旧版 PowerPoint/Excel 格式暂只记录文件信息，请转换为 pptx 或 xlsx。' };
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    try {
      const worker = await createChineseOcrWorker();
      try {
        const chineseResult = await worker.recognize(filePath);
        await worker.reinitialize('eng');
        const englishResult = await worker.recognize(filePath);
        const result = Number(englishResult.data.confidence || 0) > Number(chineseResult.data.confidence || 0) + 3 ? englishResult : chineseResult;
        const parsed = fromSections([{ locator: '图片 OCR', text: result.data.text }]);
        return parsed.status === 'indexed' ? parsed : { ...parsed, warning: '图片中没有识别到可索引的中英文文字。' };
      } finally {
        await worker.terminate();
      }
    } catch (error) {
      return { text: '', sections: [], status: 'metadata-only', warning: `图片 OCR 暂不可用：${error instanceof Error ? error.message : '未知错误'}` };
    }
  }
  if (extension === 'pdf') {
    const canvas = await import('@napi-rs/canvas');
    // PDF parsing runs in Node and installs its native graphics constructors
    // only where the host does not already provide a DOM implementation.
    for (const key of ['DOMMatrix', 'ImageData', 'Path2D'] as const) {
      if (Reflect.get(globalThis, key) == null && !Reflect.set(globalThis, key, canvas[key])) {
        throw new Error(`无法初始化 PDF 图形环境：${key}`);
      }
    }

    const [{ PDFParse }, { CanvasFactory, getPath: getPdfWorkerPath }] = await Promise.all([
      import('pdf-parse'),
      import('pdf-parse/worker'),
    ]);
    PDFParse.setWorker(pathToFileURL(getPdfWorkerPath()).href);
    const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
    try {
      const result = await parser.getText();
      const totalPages = Number(result.total) || result.pages?.length || 0;
      const pageTexts = new Map<number, string>();
      for (let index = 0; index < totalPages; index += 1) {
        const page = result.pages?.find((item: any) => Number(item?.num) === index + 1) ?? result.pages?.[index];
        pageTexts.set(index + 1, cleanText(String(page?.text || '')));
      }

      const pagesNeedingOcr = [...pageTexts.entries()].filter(([, text]) => !text).map(([pageNumber]) => pageNumber);
      let ocrFailure = '';
      if (pagesNeedingOcr.length) {
        let worker: Awaited<ReturnType<typeof createChineseOcrWorker>> | null = null;
        try {
          worker = await createChineseOcrWorker();
          for (const pageNumber of pagesNeedingOcr.slice(0, MAX_PDF_OCR_PAGES)) {
            try {
              const screenshot = await parser.getScreenshot({ partial: [pageNumber], scale: 1.5, imageBuffer: true, imageDataUrl: false });
              const image = screenshot.pages[0]?.data;
              if (!image?.length) continue;
              const recognized = await worker.recognize(Buffer.from(image));
              pageTexts.set(pageNumber, cleanText(recognized.data.text || ''));
            } catch (error) {
              ocrFailure = error instanceof Error ? error.message : '未知错误';
            }
          }
        } catch (error) {
          ocrFailure = error instanceof Error ? error.message : '未知错误';
        } finally {
          await worker?.terminate();
        }
      }

      const sections = [...pageTexts.entries()].map(([pageNumber, text]) => ({ locator: `第 ${pageNumber} 页`, text }));
      const emptyPageCount = sections.filter((section) => !section.text).length;
      const warnings: string[] = [];
      if (pagesNeedingOcr.length > MAX_PDF_OCR_PAGES) warnings.push(`扫描版 PDF 仅 OCR 前 ${MAX_PDF_OCR_PAGES} 个无文本页面。`);
      if (ocrFailure) warnings.push(`部分页面 OCR 失败：${ocrFailure}`);
      if (emptyPageCount) warnings.push(`${emptyPageCount} 页没有识别到可索引文字。`);
      const parsed = fromSections(sections, warnings.length ? warnings.join(' ') : undefined);
      return parsed.status === 'indexed' ? parsed : { ...parsed, warning: warnings.join(' ') || 'PDF 没有可提取或可识别的文字。' };
    } finally {
      await parser.destroy();
    }
  }
  return { text: '', sections: [], status: 'metadata-only', warning: `暂不支持 .${extension} 正文解析。` };
}
