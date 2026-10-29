'use strict';

// This exporter consumes a completed, locally archived research record. It never
// searches the web or asks a model to fill factual gaps during export.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PptxGenJS = require('pptxgenjs');
const { withPresentationProvenance } = require('./export-provenance.cjs');
const { validatePublicUrl, validateRasterImage } = require('./public-page.cjs');

const COLORS = Object.freeze({ paper: 'F7F6F2', ink: '22252B', muted: '646975', accent: '5C4AC7', rule: 'D6D5D0' });
const FONT = 'Microsoft YaHei';
const PAGE_STATUSES = new Set(['read', 'unavailable', 'verified', 'available', 'blocked', 'failed', 'unread', 'not_read', 'partial', 'page-extracted']);
const FIELD_NAMES = Object.freeze({ name: '项目名称', projectName: '项目名称', location: '地点', address: '地点', area: '面积', architect: '设计单位', designer: '设计单位', year: '年份', type: '项目类型', typeLabel: '项目类型', projectType: '项目类型', openingDate: '开业时间', completionYear: '建成年份', stage: '阶段', focus: '当前关注点' });
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim() : '';
function publicUrl(value) { try { return validatePublicUrl(value).href; } catch { return ''; } }
function content(value) {
  if (typeof value === 'string' || typeof value === 'number') return text(value);
  if (!value || typeof value !== 'object') return '';
  return text(value.value || value.text || value.quote || value.summary || value.point || value.description || value.message || value.error || value.title || value.name);
}
function asLines(value) { return (Array.isArray(value) ? value : value ? [value] : []).map(content).filter(Boolean); }
function wrap(value, width = 78) {
  const lines = [];
  for (const paragraph of text(value).split(/\r?\n/)) {
    let current = '', units = 0;
    for (const char of paragraph) {
      const cost = /[\u0000-\u00ff]/.test(char) ? /[MW@%]/.test(char) ? 1.8 : /[A-Z]/.test(char) ? 1.3 : 1 : 2;
      if (units + cost > width) { lines.push(current); current = ''; units = 0; }
      current += char; units += cost;
    }
    lines.push(current);
  }
  return lines;
}
function shortHeading(value) {
  const raw = text(value).replace(/\s+/g, ' '), clipped = [...raw].slice(0, 65).join('');
  const lines = wrap(clipped, 52), visible = lines.slice(0, 2);
  if (lines.length > 2 || clipped !== raw) visible[visible.length - 1] = visible.at(-1).slice(0, -1) + '…';
  return { text: visible.join('\n'), fontSize: visible.length > 1 ? 24 : 28 };
}
function pagesFor(paragraphs, maxLines = 14) {
  const pages = []; let page = [];
  for (const paragraph of paragraphs.filter(Boolean)) {
    const lines = wrap(paragraph);
    if (page.length && page.length + Math.min(lines.length, maxLines) + 1 > maxLines) { pages.push(page); page = []; }
    while (lines.length) {
      const remaining = maxLines - page.length;
      page.push(...lines.splice(0, remaining));
      if (page.length === maxLines) { pages.push(page); page = []; }
    }
    if (page.length && page.length < maxLines - 1) page.push('');
  }
  if (page.some(Boolean)) pages.push(page);
  return pages.length ? pages : [['暂无已核验的研究内容。']];
}
function sourceObjects(value, result = []) {
  if (!value) return result;
  if (typeof value === 'string') { const url = publicUrl(value); if (url) result.push({ url }); return result; }
  if (Array.isArray(value)) { for (const item of value) sourceObjects(item, result); return result; }
  if (typeof value !== 'object') return result;
  const url = publicUrl(value.url || value.sourceUrl || value.pageUrl || value.sourcePageUrl);
  if (url) result.push({ ...value, url });
  for (const key of ['sources', 'sourceUrls', 'evidenceUrls', 'evidence', 'urls', 'links']) sourceObjects(value[key], result);
  return result;
}
function collectSources(research, cases, images) {
  const values = [];
  sourceObjects(research.sources, values); sourceObjects(research.links, values);
  for (const item of cases) {
    sourceObjects(item, values);
    for (const point of [...list(item.referencePoints), ...list(item.references)]) sourceObjects(point, values);
  }
  for (const point of [...list(research.referencePoints), ...list(research.references)]) sourceObjects(point, values);
  for (const image of images) {
    sourceObjects({ url: image.sourcePageUrl, title: image.name }, values);
    sourceObjects({ url: image.sourceUrl, title: `${image.name || '图片'} · 下载地址` }, values);
    sourceObjects(image.sources, values);
  }
  const result = new Map();
  for (const source of values) {
    const previous = result.get(source.url);
    const previousPageStatus = PAGE_STATUSES.has(previous?.status) ? previous.status : '';
    const incomingPageStatus = PAGE_STATUSES.has(source.status) ? source.status : '';
    // research.sources is the authoritative page-read record. A field's quote
    // verification may use the same URL, but is a separate state dimension.
    const status = previousPageStatus && !['unread', 'not_read'].includes(previousPageStatus) ? previousPageStatus : incomingPageStatus || previousPageStatus;
    const evidenceStatuses = [...new Set([...list(previous?.evidenceStatuses), ...list(source.evidenceStatuses), previous?.evidenceStatus, source.evidenceStatus,
      !incomingPageStatus && source.status].filter(Boolean))];
    const merged = { ...(previous || {}), ...source, title: text(previous?.title || source.title || source.name || new URL(source.url).hostname), evidenceStatuses };
    if (status) merged.status = status; else delete merged.status;
    if (evidenceStatuses.length) merged.evidenceStatus = evidenceStatuses.includes('needs_verification') ? 'needs_verification' : evidenceStatuses[0];
    result.set(source.url, merged);
  }
  return [...result.values()];
}
function isWithin(file, root) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function prepareImages(images, allowedRoots, convertImage, warnings) {
  const roots = allowedRoots.map(root => { try { return fs.realpathSync(root); } catch { return ''; } }).filter(Boolean);
  const result = []; const seen = new Set();
  for (const asset of images) {
    const label = text(asset.name || asset.id || '图片');
    try {
      if (!text(asset.path) || !roots.length) throw new Error('图片未提供受信归档路径');
      const file = fs.realpathSync(asset.path);
      if (!roots.some(root => isWithin(file, root))) throw new Error('图片不在本地归档目录');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error('图片文件大小无效');
      if (!publicUrl(asset.sourcePageUrl || asset.sourceUrl)) throw new Error('图片缺少可查看的来源链接');
      let bytes = fs.readFileSync(file);
      const info = validateRasterImage(bytes, asset.contentType || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(file).toLowerCase()]), { allowSmall: true, allowAnimation: true });
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      let mime = info.contentType;
      if (mime === 'image/webp') {
        if (typeof convertImage !== 'function') throw new Error('WebP 需要本机图片转换器后才能写入 PowerPoint');
        bytes = await convertImage(bytes, asset);
        if (!Buffer.isBuffer(bytes)) throw new Error('本机图片转换未返回 PNG');
        validateRasterImage(bytes, 'image/png', { allowSmall: true }); mime = 'image/png';
      }
      result.push({ ...asset, ...info, data: `data:${mime};base64,${bytes.toString('base64')}`, sourcePageUrl: publicUrl(asset.sourcePageUrl || asset.sourceUrl) });
      if (Math.max(info.width, info.height) < 1600) warnings.push(`${label}：实际 ${info.width} × ${info.height}，未达到 1600 像素高清长边。`);
    } catch (error) { warnings.push(`${label}：未写入 PPT（${error.message}）。`); }
  }
  return result;
}
function caseParagraphs(item) {
  const lines = asLines(item.summary || item.description || item.researchSummary).map(value => `Agent 整理摘要：${value}`);
  const fields = item.fields || item.facts || {};
  if (fields && !Array.isArray(fields)) for (const [key, value] of Object.entries(fields)) {
    const label = FIELD_NAMES[key]; const actual = content(value);
    if (label && actual) lines.push(`${label}：${actual}${value?.status === 'needs_verification' ? '（待原文核验）' : ''}`);
  }
  const relevance = asLines(item.relevance || item.projectRelevance || item.referencePoints);
  if (relevance.length) lines.push('对当前项目的参考：', ...relevance);
  const limitations = asLines(item.limitations || item.cautions);
  if (limitations.length) lines.push('适用条件与限制：', ...limitations);
  return lines;
}
function referenceParagraphs(point) {
  if (typeof point === 'string') return [point, '此项为 Agent 提炼，需人工核对其适用条件。'];
  const lines = [];
  const add = (label, value) => { const values = asLines(value); if (values.length) lines.push(`${label}：${values.join('\n')}`); };
  add('观察与依据', point.observation || point.evidence);
  add('借鉴点', point.point || point.summary);
  add('本项目关联', point.projectRelevance || point.relevance || point.reason);
  add('可借鉴做法', point.application || point.suggestion || point.recommendation || point.reference);
  add('适用条件与限制', point.limitations || point.limitation || point.caution || point.conditions);
  if (!lines.length) lines.push(content(point));
  lines.push('Agent 提炼，尚需人工核对。');
  return lines.filter(Boolean);
}
function archiveWarnings(record, cases) {
  const reports = [record.imageReport, record.imageArchive, record.imageCollection,
    !Array.isArray(record.images) && record.images, ...cases.map(item => item.imageArchive)].filter(value => value && typeof value === 'object');
  const warnings = [];
  const reasons = { 'download-failed': '下载失败', 'below-resolution-threshold': '分辨率未达门槛', 'relevance-needs-review': '图片相关性待人工核对', 'not-found-on-page': '页面未找到 Agent 指定的图片', 'research-limit': '达到本次研究图片上限', 'source-limit': '达到单来源图片上限' };
  for (const report of reports) {
    warnings.push(...asLines(report.errors), ...asLines(report.warnings));
    if (report.failedCount) warnings.push(`${report.failedCount} 张图片下载失败，详情见 Hub 研究记录。`);
    for (const source of list(report.sources)) for (const error of asLines(source.errors)) {
      let label = text(source.title);
      if (!label) { try { label = new URL(source.url).hostname; } catch { label = '图片来源'; } }
      warnings.push(`${label}：${error}`);
    }
    const counts = new Map();
    for (const rejected of list(report.rejected)) if (reasons[rejected.reason]) counts.set(rejected.reason, (counts.get(rejected.reason) || 0) + 1);
    for (const [reason, count] of counts) warnings.push(`${count} 张候选图片未写入素材库：${reasons[reason]}。`);
  }
  return [...new Set(warnings)];
}

async function exportResearchPresentation({ research, project, cases, images = [], outputPath, allowedImageRoots = [], convertImage } = {}) {
  if (!research || typeof research !== 'object') throw new Error('请先选择已返回成果的项目调研任务。');
  if (!outputPath || path.extname(outputPath).toLowerCase() !== '.pptx' || !path.isAbsolute(outputPath)) throw new Error('请选择本地 PPTX 保存位置。');
  const record = research.result && typeof research.result === 'object' ? { ...research, ...research.result } : research;
  const projectData = project?.project || project || research.projectContext?.project || research.contextSnapshot?.project || research.projectSnapshot || {};
  const caseItems = (Array.isArray(cases) ? cases : list(record.cases)).filter(item => item && typeof item === 'object');
  const warnings = [];
  const usableImages = await prepareImages(images, allowedImageRoots, convertImage, warnings);
  const sources = collectSources(record, caseItems, images);
  const pptx = withPresentationProvenance(new PptxGenJS());
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'AIDesignHub'; pptx.subject = '项目案例调研';
  pptx.title = `${text(projectData.name) || '项目'} · 案例研究`;
  pptx.company = 'AIDesignHub'; pptx.lang = 'zh-CN';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'zh-CN' };
  let slideCount = 0;
  const title = text(record.title || research.title || '案例研究');
  const noteSources = values => [...new Set(sourceObjects(values).map(source => source.url))];
  const addBase = (heading, sourceValues = []) => {
    const slide = pptx.addSlide(); slide.background = { color: COLORS.paper }; slideCount++;
    const head = shortHeading(heading);
    slide.addText(head.text, { x: .68, y: .42, w: 11.95, h: .95, fontFace: FONT, fontSize: head.fontSize, lineSpacing: 28, bold: true, color: COLORS.ink, margin: 0, wrap: false, valign: 'mid' });
    slide.addShape(pptx.ShapeType.line, { x: .68, y: 1.34, w: 11.95, h: 0, line: { color: COLORS.rule, width: .7 } });
    const urls = noteSources(sourceValues);
    if (urls.length) slide.addText(`来源：${new URL(urls[0]).hostname}${urls.length > 1 ? ` 等 ${urls.length} 条，见备注与来源清单` : '，点击查看'}`, { x: .7, y: 7.05, w: 10.9, h: .2, fontSize: 10, color: COLORS.accent, margin: 0, hyperlink: { url: urls[0] } });
    slide.addText(String(slideCount).padStart(2, '0'), { x: 12, y: 7.01, w: .6, h: .25, fontSize: 11, color: COLORS.muted, margin: 0, align: 'right' });
    slide.addNotes([heading, ...urls].join('\n'));
    return slide;
  };
  const addBody = (heading, paragraphs, sourceValues) => {
    const pages = pagesFor(paragraphs);
    pages.forEach((lines, index) => {
      const slide = addBase(`${heading}${pages.length > 1 ? `（${index + 1}/${pages.length}）` : ''}`, sourceValues);
      slide.addText(lines.join('\n'), { x: .72, y: 1.62, w: 11.85, h: 5.05, fontFace: FONT, fontSize: 19, color: COLORS.ink, margin: 0, breakLine: false, valign: 'top', lineSpacingMultiple: 1.12 });
    });
  };
  if (record.origin === 'adh' && list(record.slidePlan).length) {
    for (const plan of list(record.slidePlan).slice(0, 24)) {
      const selected = list(plan.imageAssetIds).map(id => usableImages.find(image => image.id === id || image.assetId === id)).filter(Boolean).slice(0, 3);
      const heading = text(plan.title) || '案例分析', body = text(plan.body), sourceValues = list(plan.sourceUrls).map(url => ({ url }));
      if (!selected.length) { addBody(heading, body ? [body] : ['本页依据与补充内容见来源。'], sourceValues); continue; }
      const slide = addBase(heading, sourceValues), gap = .22, boxWidth = (11.85 - gap * (selected.length - 1)) / selected.length;
      for (let index = 0; index < selected.length; index++) {
        const image = selected[index], box = { x: .72 + index * (boxWidth + gap), y: 1.62, w: boxWidth, h: body ? 3.95 : 4.95 };
        const ratio = Math.min(box.w / image.width, box.h / image.height), w = image.width * ratio, h = image.height * ratio;
        slide.addImage({ data: image.data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h });
        slide.addText(`${image.width} × ${image.height} px`, { x: box.x, y: body ? 5.62 : 6.62, w: box.w, h: .18, fontFace: FONT, fontSize: 10, color: COLORS.muted, margin: 0, align: 'center' });
      }
      const bodyLines = wrap(body, 85);
      if (body) slide.addText(bodyLines.length > 4 ? '完整分析与事实说明见下一页。' : bodyLines.join('\n'), { x: .72, y: 5.95, w: 11.85, h: .98, fontFace: FONT, fontSize: 13, color: COLORS.ink, margin: 0, wrap: false, valign: 'top' });
      slide.addNotes([heading, body, ...selected.flatMap(image => [image.sourcePageUrl, image.sourceUrl]), ...noteSources(sourceValues)].filter(Boolean).join('\n'));
      if (bodyLines.length > 4) addBody(`${heading}（分析续页）`, [body], sourceValues);
    }
  } else {
  const cover = addBase('案例研究');
  cover.addText(wrap(title, 42).slice(0, 3).join('\n'), { x: .76, y: 1.7, w: 11.8, h: 2.1, fontFace: FONT, fontSize: 37, color: COLORS.ink, bold: true, margin: 0, valign: 'mid' });
  cover.addText(text(projectData.name) || '项目未命名', { x: .78, y: 4.18, w: 11.6, h: .5, fontSize: 22, color: COLORS.accent, margin: 0 });
  cover.addText(`${caseItems.length} 个案例，${sources.length} 条来源，${usableImages.length} 张本地图片\n${record.status === 'completed' ? '研究完成，内容待人工核对' : '研究成果与采集状态见后页'}`, { x: .8, y: 5.2, w: 11.5, h: .95, fontSize: 17, color: COLORS.muted, margin: 0, breakLine: false });

  const context = [`项目：${text(projectData.name) || '未提供'}`];
  if (text(projectData.stage)) context.push(`当前阶段：${text(projectData.stage)}`);
  if (text(projectData.focus)) context.push(`项目关注点：${text(projectData.focus)}`);
  const profile = projectData.researchProfile || research.projectSnapshot?.project?.researchProfile || research.projectSnapshot?.researchProfile || {};
  if (profile.isSynthetic) context.push('项目背景：用户授权编制的演示假设。以下定位与规模指标不代表已批准的规划条件。');
  if (text(profile.positioning)) context.push(`研究定位：${text(profile.positioning)}`);
  for (const [key, label, unit] of [['siteAreaM2', '用地面积', '㎡'], ['aboveGroundAreaM2', '地上建筑面积', '㎡'], ['grossFloorAreaM2', '总建筑面积', '㎡'], ['plotRatio', '容积率', '']]) {
    const value = profile[key];
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) context.push(`${label}：${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit}`);
  }
  if (asLines(profile.objectives).length) context.push('本次研究目标：', ...asLines(profile.objectives));
  if (text(record.title || record.brief || record.topic || record.query)) context.push(`调研任务：${text(record.title || record.brief || record.topic || record.query)}`);
  const snapshot = research.projectContext || research.contextSnapshot || research.projectSnapshot || {};
  if (list(snapshot.decisions).length) context.push('项目已有决策：', ...snapshot.decisions.map(item => text(item.summary || item.title)).filter(Boolean));
  addBody('项目背景与调研问题', context);
  addBody('调研结论与证据状态', [
    ...asLines(record.summary),
    `研究状态：${({ completed: '已完成', complete: '已完成', partial: '部分完成', failed: '失败', researching: '进行中', verifying: '核验中', ready: '已返回成果' }[record.status]) || text(record.status) || '未标注'}`,
    `来源与素材：${sources.length} 条链接，${usableImages.length} 张可嵌入本地图片。`,
    '参考点由 Agent 结合项目上下文提炼。可用链接、抓取失败与图片实际尺寸均保留，供人工复核。',
    ...asLines(record.limitations),
  ], sources);
  for (const item of caseItems) addBody(text(item.name || item.title || item.projectName || '案例'), caseParagraphs(item), sourceObjects(item));
  const references = (list(record.referencePoints).length ? record.referencePoints : list(record.references)).filter(Boolean);
  if (references.length) for (const point of references) addBody(content(point.title || point.name || point.point || point.observation) || '当前项目的案例参考点', referenceParagraphs(point), sourceObjects(point));
  else addBody('当前项目的案例参考点', ['尚未形成有证据的项目参考点。请在研究任务中补充项目问题与案例关联，再重新导出。']);

  for (const image of usableImages) {
    const heading = text(image.name || image.caption || '案例图片');
    const slide = addBase(heading, [{ url: image.sourcePageUrl }, { url: image.sourceUrl }]);
    const box = { x: .72, y: 1.58, w: 11.85, h: 4.79 };
    const ratio = Math.min(box.w / image.width, box.h / image.height);
    const w = image.width * ratio, h = image.height * ratio;
    slide.addImage({ data: image.data, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h });
    slide.addText(`下载实测 ${image.width} × ${image.height}${Math.max(image.width, image.height) >= 1600 ? ' px' : ' px（低于高清长边门槛）'}`, { x: .75, y: 6.55, w: 11.6, h: .25, fontSize: 11, color: COLORS.muted, margin: 0 });
    slide.addNotes([heading, image.sourcePageUrl, image.sourceUrl, `${image.width} × ${image.height}`, text(image.note)].filter(Boolean).join('\n'));
  }

  }
  const sourcePages = Math.max(1, Math.ceil(sources.length / 5));
  for (let index = 0; index < sourcePages; index++) {
    const slide = addBase(`来源链接清单${sourcePages > 1 ? `（${index + 1}/${sourcePages}）` : ''}`);
    const items = sources.slice(index * 5, index * 5 + 5);
    if (!items.length) slide.addText('暂无可验证的公开来源链接。', { x: .75, y: 1.7, w: 11.5, h: .6, fontSize: 20, color: COLORS.muted, margin: 0 });
    items.forEach((source, row) => {
      const y = 1.62 + row * .98;
      const rawStatus = text(source.status || source.verificationStatus);
      const status = ({ verified: '已核验', read: '已读取', available: '可查看', unavailable: '暂不可用', blocked: '需人工验证', failed: '读取失败', unread: '尚未读取', not_read: '尚未读取', partial: '部分读取', 'page-extracted': '已提取正文' }[rawStatus]) || rawStatus;
      slide.addText(`${index * 5 + row + 1}. ${wrap(source.title, 66)[0]}${status ? `（${status}）` : ''}`, { x: .75, y, w: 11.8, h: .36, fontSize: 17, color: COLORS.ink, margin: 0, hyperlink: { url: source.url } });
      slide.addText(source.url.length > 130 ? source.url.slice(0, 127) + '…' : source.url, { x: .95, y: y + .39, w: 11.55, h: .37, fontSize: 11, color: COLORS.accent, margin: 0, hyperlink: { url: source.url } });
    });
    slide.addNotes(items.map(source => `${source.title}\n${source.url}\n${text(source.error || source.note)}${source.evidenceStatuses?.length ? `\n字段证据状态：${source.evidenceStatuses.join(' / ')}` : ''}`).join('\n\n'));
  }
  const failed = [...asLines(record.errors), ...asLines(record.warnings), ...archiveWarnings(record, caseItems)];
  addBody('素材缺口与人工复核', [
    ...warnings, ...failed,
    '图片分辨率以本地文件实测值为准。网页可下载的最大版本不一定是摄影师原始文件。',
    '图片来源链接用于核对出处；正式公开使用前请核对原站署名与授权范围。',
    '案例经验需结合当前项目的场地、功能、成本与规范条件由设计人员判断。',
  ]);
  const filePath = path.resolve(outputPath);
  await pptx.writeFile({ fileName: filePath, compression: true });
  return { filePath, slideCount, imageCount: usableImages.length, sourceCount: sources.length, warnings };
}

const BENCH = Object.freeze({ paper: 'F6F7F9', ink: '1C2430', muted: '6C7684', accent: '1B5FBF', soft: 'E8EFFA', rule: 'D7DEE7', white: 'FFFFFF' });
const DARK = Object.freeze({ bg: '101416', panel: '151A1E', ink: 'F3F5F6', muted: 'A5AEB5', gold: 'C9A063', rule: '394247', watermark: '242B30', soft: '20272C' });

function firstClause(value, max = 48) {
  const raw = text(value).replace(/\s+/g, ' ').split(/[。；;]/)[0];
  const chars = [...raw];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : raw;
}
function keyNumbers(value, max = 3) {
  const raw = text(value);
  const matches = raw.match(/约?\s*\d+(?:[.,]\d+)?(?:\s*[–\-~至]\s*\d+(?:[.,]\d+)?)?\s*(?:万㎡|㎡|m²|平方米|公顷|ha|%|层|处|座|km|m)/g) || [];
  const unique = [...new Set(matches.map(item => item.replace(/\s+/g, ' ').trim()))].slice(0, max);
  if (!unique.length) return firstClause(raw, 42);
  return `${unique.join(' / ')}${/(口径|分别|另有|三种)/.test(raw) ? '（多口径）' : ''}`;
}
function emphasis(value) {
  const raw = text(value);
  const parts = []; let last = 0;
  const pattern = /\d+(?:[.,]\d+)?(?:\s*[–\-~至]\s*\d+(?:[.,]\d+)?)?\s*(?:万㎡|㎡|m²|平方米|公顷|ha|%|层|处|座|km|m|年|月)?/g;
  let match;
  while ((match = pattern.exec(raw))) {
    if (match.index > last) parts.push({ text: raw.slice(last, match.index) });
    parts.push({ text: match[0], bold: true, accent: true });
    last = match.index + match[0].length;
  }
  if (last < raw.length) parts.push({ text: raw.slice(last) });
  return parts.length ? parts : [{ text: raw }];
}
function benchRuns(value, options = {}, breakLast = true) {
  const parts = Array.isArray(value) ? value : emphasis(value);
  return parts.map((part, index) => ({
    text: text(part.text || part),
    options: {
      ...options,
      bold: part.bold ?? options.bold,
      color: part.accent ? (options.accentColor || BENCH.accent) : (options.color || BENCH.ink),
      breakLine: index === parts.length - 1 ? breakLast : false,
    },
  }));
}
function benchModel(item) {
  const benchmark = item.benchmark && typeof item.benchmark === 'object' ? item.benchmark : {};
  const fields = item.fields || item.facts || {};
  const field = key => content(fields[key]);
  const references = list(item.references || item.referencePoints);
  const facts = list(benchmark.facts).length ? benchmark.facts : [
    { label: '业主 / 时间', value: [field('owner'), field('developer'), field('openingDate')].filter(Boolean).join(' · ') },
    { label: '区位', value: field('location') },
    { label: '体量', value: field('area') ? keyNumbers(field('area')) : '' },
  ].filter(fact => content(fact.value));
  const features = list(benchmark.features).length ? benchmark.features
    : references.map(point => firstClause(point.point || point.summary, 40)).filter(Boolean).slice(0, 4);
  const borrow = list(benchmark.borrow).length ? benchmark.borrow
    : references.map(point => firstClause(point.application || point.suggestion, 44)).filter(Boolean).slice(0, 4);
  const improve = list(benchmark.improve).length ? benchmark.improve
    : references.map(point => firstClause(point.limitation || point.caution, 44)).filter(Boolean).slice(0, 3);
  const editorial = benchmark.editorial && typeof benchmark.editorial === 'object' ? benchmark.editorial : {};
  return {
    title: text(benchmark.title || item.name || item.title || item.projectName || '对标案例'),
    subtitle: text(benchmark.subtitle || [field('typeLabel'), field('openingDate')].filter(Boolean).join(' · ')),
    facts, features, borrow, improve,
    conclusion: text(benchmark.conclusion),
    note: text(benchmark.note),
    editorial: {
      borrow: list(editorial.borrow).length ? list(editorial.borrow) : features.slice(0, 2),
      translate: list(editorial.translate).length ? list(editorial.translate) : borrow.slice(0, 2),
      caution: list(editorial.caution).length ? list(editorial.caution) : improve.slice(0, 2),
      quote: text(editorial.quote || benchmark.conclusion || improve[0] || ''),
    },
    imageCredit: text(benchmark.imageCredit),
    images: list(benchmark.images).map(text).filter(Boolean),
    imageIds: list(benchmark.imageIds || item.imageAssetIds).map(text).filter(Boolean),
    highlight: text(benchmark.highlight || '对标案例'),
  };
}
function pickBenchmarkImages(model, usableImages) {
  if (model.images.length) {
    const picked = model.images.map(name => usableImages.find(image => text(image.filename) === name || image.id === name || image.assetId === name)).filter(Boolean);
    if (picked.length) return picked.slice(0, 4);
  }
  if (model.imageIds.length) {
    const picked = model.imageIds.map(id => usableImages.find(image => image.id === id || image.assetId === id)).filter(Boolean);
    if (picked.length) return picked.slice(0, 4);
  }
  return usableImages.slice(0, 4);
}
function addBenchBlock(slide, pptx, x, y, w, label, lines, bodyHeight) {
  slide.addText(label, { x, y, w, h: .2, fontFace: FONT, fontSize: 9, bold: true, color: BENCH.accent, margin: 0, charSpacing: .6 });
  const runs = [];
  for (const line of lines) runs.push(...benchRuns(line, { fontFace: FONT, fontSize: 9, color: BENCH.ink }));
  if (!runs.length) return;
  slide.addText(runs, { x, y: y + .23, w, h: bodyHeight, fontFace: FONT, fontSize: 9, color: BENCH.ink, margin: 0, valign: 'top', lineSpacingMultiple: 1.2, fit: 'shrink' });
}
function addBenchmarkSlide(pptx, model, images, index, total, sources) {
  const slide = pptx.addSlide();
  slide.background = { color: BENCH.paper };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: .07, fill: { color: BENCH.accent }, line: { color: BENCH.accent, width: 0 } });
  const titleRuns = [
    { text: `对标案例 ${String(index + 1).padStart(2, '0')}｜`, options: { fontFace: FONT, fontSize: 24, bold: true, color: BENCH.accent, margin: 0 } },
    { text: model.title, options: { fontFace: FONT, fontSize: 24, bold: true, color: BENCH.ink, margin: 0 } },
  ];
  slide.addText(titleRuns, { x: .58, y: .3, w: 9.1, h: .62, valign: 'mid', margin: 0, fit: 'shrink' });
  slide.addText(model.highlight, { x: 10.1, y: .38, w: 2.65, h: .3, fontFace: FONT, fontSize: 9, bold: true, color: BENCH.accent, align: 'right', charSpacing: 1.1, margin: 0 });
  if (model.subtitle) slide.addText(model.subtitle, { x: .6, y: .93, w: 9.6, h: .26, fontFace: FONT, fontSize: 9.5, color: BENCH.muted, margin: 0, fit: 'shrink' });
  slide.addShape(pptx.ShapeType.line, { x: .58, y: 1.24, w: 12.18, h: 0, line: { color: BENCH.rule, width: .8 } });

  const textX = .58, textW = 3.18;
  const factLines = model.facts.slice(0, 3).map(fact => {
    if (Array.isArray(fact)) return fact;
    if (typeof fact === 'string') return emphasis(fact);
    const label = text(fact.label || fact.name);
    const value = Array.isArray(fact.value) ? fact.value : emphasis(fact.value || fact.text);
    const runs = [];
    if (label) runs.push({ text: `${label}：`, bold: true, accent: true });
    runs.push(...value);
    return runs;
  });
  const sections = [];
  if (factLines.length) sections.push({ name: '项目档案', lines: factLines, height: .5, step: .78 });
  if (model.features.length) sections.push({ name: '核心特色', lines: model.features.slice(0, 4).map(line => `· ${line}`), height: .95, step: 1.2 });
  if (model.borrow.length) sections.push({ name: '优势借鉴', lines: model.borrow.slice(0, 4).map(line => `· ${line}`), height: .95, step: 1.2 });
  if (model.improve.length) sections.push({ name: '项目改进', lines: model.improve.slice(0, 3).map(line => `· ${line}`), height: .72, step: 1.2 });
  let cursor = 1.42;
  sections.forEach((section, sectionIndex) => {
    addBenchBlock(slide, pptx, textX, cursor, textW, `${String(sectionIndex + 1).padStart(2, '0')}  ${section.name}`, section.lines, section.height);
    cursor += section.step;
  });

  if (model.note) slide.addText(model.note, { x: textX, y: 5.64, w: textW, h: .3, fontFace: FONT, fontSize: 7.5, color: BENCH.muted, margin: 0, fit: 'shrink' });
  if (model.conclusion) {
    slide.addShape(pptx.ShapeType.rect, { x: .58, y: 6.08, w: 3.18, h: .64, fill: { color: BENCH.soft }, line: { color: BENCH.rule, width: .5 } });
    const runs = [{ text: '结论  ', options: { fontFace: FONT, fontSize: 9, bold: true, color: BENCH.accent, margin: 0 } }];
    runs.push(...benchRuns(model.conclusion, { fontFace: FONT, fontSize: 9, color: BENCH.ink }, true));
    slide.addText(runs, { x: .7, y: 6.14, w: 2.96, h: .52, margin: 0, valign: 'mid', fit: 'shrink' });
  }

  const mx = 4.0, my = 1.42, mw = 8.78, mh = 5.22, gap = .13;
  let cells;
  if (images.length >= 4) {
    const col1 = 5.32, col2 = mw - col1 - gap, row1 = 2.66, row2 = mh - row1 - gap;
    cells = [
      { x: mx, y: my, w: col1, h: row1 },
      { x: mx + col1 + gap, y: my, w: col2, h: row1 },
      { x: mx, y: my + row1 + gap, w: col1, h: row2 },
      { x: mx + col1 + gap, y: my + row1 + gap, w: col2, h: row2 },
    ];
  } else if (images.length === 3) {
    const col2 = 3.18, rowH = (mh - gap) / 2;
    cells = [
      { x: mx, y: my, w: mw - col2 - gap, h: mh },
      { x: mx + mw - col2, y: my, w: col2, h: rowH },
      { x: mx + mw - col2, y: my + rowH + gap, w: col2, h: rowH },
    ];
  } else if (images.length === 2) {
    const width = (mw - gap) / 2;
    cells = [{ x: mx, y: my, w: width, h: mh }, { x: mx + width + gap, y: my, w: width, h: mh }];
  } else {
    cells = [{ x: mx, y: my, w: mw, h: mh }];
  }
  images.forEach((image, cellIndex) => {
    const cell = cells[cellIndex]; if (!cell) return;
    slide.addImage({ data: image.data, x: cell.x, y: cell.y, w: cell.w, h: cell.h, sizing: { type: 'cover', w: cell.w, h: cell.h }, altText: text(image.name || image.caption || model.title) });
    slide.addShape(pptx.ShapeType.rect, { x: cell.x, y: cell.y, w: cell.w, h: cell.h, fill: { type: 'none' }, line: { color: BENCH.white, width: 1 } });
  });
  slide.addText(`图片：${model.imageCredit || '本地归档原图'}`, { x: mx, y: 6.72, w: 5.8, h: .2, fontFace: FONT, fontSize: 7.5, color: BENCH.muted, margin: 0 });

  const urls = [...new Set(sourceObjects(sources).map(source => source.url))];
  const links = urls.map((url, i) => ({ text: i ? ` · ${i + 1}` : `来源：${new URL(url).hostname}`, options: { hyperlink: { url } } }));
  slide.addText(links.length ? links : '来源：见备注', { x: .58, y: 7.02, w: 10.2, h: .2, fontFace: FONT, fontSize: 7, color: BENCH.accent, margin: 0 });
  slide.addText(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 11.9, y: 7.02, w: .85, h: .2, fontFace: FONT, fontSize: 7, color: BENCH.muted, align: 'right', margin: 0 });
  slide.addNotes([
    model.title, model.subtitle, text(sources?.body), ...model.facts.map(fact => `${text(fact.label)}：${content(fact.value)}`),
    ...model.features, ...model.borrow, ...model.improve, model.conclusion,
    ...images.flatMap(image => [text(image.name), image.sourcePageUrl, image.sourceUrl, `${image.width} × ${image.height}`].filter(Boolean)),
    ...urls,
  ].filter(Boolean).join('\n'));
}

function addEditorialBlock(slide, x, y, w, label, english, lines, bodyHeight) {
  slide.addText([
    { text: label, options: { fontFace: FONT, fontSize: 8.5, bold: true, color: DARK.gold, margin: 0 } },
    { text: `  /  ${english}`, options: { fontFace: FONT, fontSize: 7, bold: true, color: DARK.muted, charSpacing: 1, margin: 0 } },
  ], { x, y, w, h: .2, margin: 0 });
  const runs = [];
  for (const line of lines) runs.push(...benchRuns(`— ${line}`, { fontFace: FONT, fontSize: 8.5, color: DARK.ink, accentColor: DARK.gold }));
  if (!runs.length) return;
  slide.addText(runs, { x, y: y + .22, w, h: bodyHeight, fontFace: FONT, fontSize: 8.5, color: DARK.ink, margin: 0, valign: 'top', lineSpacingMultiple: 1.18, fit: 'shrink' });
}
function addEditorialSlide(pptx, model, images, index, total, sources) {
  const slide = pptx.addSlide();
  slide.background = { color: DARK.bg };
  slide.addText(String(index + 1).padStart(2, '0'), { x: .38, y: .42, w: 2.5, h: 1.8, fontFace: FONT, fontSize: 108, bold: true, color: DARK.watermark, margin: 0, fit: 'shrink' });
  slide.addText([
    { text: 'BENCHMARK', options: { fontFace: FONT, fontSize: 8, bold: true, color: DARK.gold, charSpacing: 1.6, margin: 0 } },
    { text: `  /  ${model.highlight}`, options: { fontFace: FONT, fontSize: 8, color: DARK.muted, charSpacing: .8, margin: 0 } },
  ], { x: .6, y: .42, w: 4.15, h: .24, margin: 0 });
  slide.addText(model.title, { x: .58, y: 1.38, w: 4.2, h: .98, fontFace: FONT, fontSize: 27, bold: true, color: DARK.ink, margin: 0, valign: 'bottom', fit: 'shrink' });
  if (model.subtitle) slide.addText(model.subtitle, { x: .6, y: 2.46, w: 4.12, h: .5, fontFace: FONT, fontSize: 8.5, color: DARK.muted, margin: 0, valign: 'top', fit: 'shrink' });
  slide.addShape(pptx.ShapeType.rect, { x: .58, y: 3.04, w: 1.15, h: .025, fill: { color: DARK.gold }, line: { color: DARK.gold, width: 0 } });
  const editorial = model.editorial || {};
  addEditorialBlock(slide, .58, 3.2, 4.12, '借鉴', 'BORROW', list(editorial.borrow).slice(0, 2), .72);
  addEditorialBlock(slide, .58, 4.14, 4.12, '转译', 'TRANSLATE', list(editorial.translate).slice(0, 2), .72);
  addEditorialBlock(slide, .58, 5.08, 4.12, '警示', 'WATCH', list(editorial.caution).slice(0, 2), .68);
  if (editorial.quote) {
    slide.addShape(pptx.ShapeType.rect, { x: .58, y: 6.2, w: .035, h: .72, fill: { color: DARK.gold }, line: { color: DARK.gold, width: 0 } });
    slide.addText('TAKEAWAY  /  结论', { x: .74, y: 6.16, w: 3.95, h: .18, fontFace: FONT, fontSize: 7, bold: true, color: DARK.gold, charSpacing: 1, margin: 0 });
    slide.addText(editorial.quote, { x: .74, y: 6.36, w: 3.95, h: .55, fontFace: FONT, fontSize: 10.5, bold: true, color: DARK.ink, margin: 0, valign: 'top', fit: 'shrink' });
  }

  const hx = 4.95, hw = 13.333 - hx, gap = .08, strip = images.slice(1, 4);
  const heroHeight = strip.length ? 5.32 : 7.5;
  if (images[0]) slide.addImage({ data: images[0].data, x: hx, y: 0, w: hw, h: heroHeight, sizing: { type: 'cover', w: hw, h: heroHeight }, altText: text(images[0].name || model.title) });
  slide.addShape(pptx.ShapeType.rect, { x: hx - .035, y: 0, w: .035, h: 7.5, fill: { color: DARK.gold }, line: { color: DARK.gold, width: 0 } });
  if (strip.length) {
    const top = 5.42, height = 1.98, width = (hw - gap * (strip.length - 1)) / strip.length;
    strip.forEach((image, stripIndex) => {
      const x = hx + stripIndex * (width + gap);
      slide.addImage({ data: image.data, x, y: top, w: width, h: height, sizing: { type: 'cover', w: width, h: height }, altText: text(image.name || model.title) });
      slide.addShape(pptx.ShapeType.rect, { x: x + .08, y: top + .08, w: .38, h: .21, fill: { color: DARK.bg, transparency: 25 }, line: { color: DARK.gold, width: .5 } });
      slide.addText(String(stripIndex + 2).padStart(2, '0'), { x: x + .08, y: top + .08, w: .38, h: .21, fontFace: FONT, fontSize: 7.5, bold: true, color: DARK.gold, align: 'center', valign: 'mid', margin: 0 });
    });
  }

  const urls = [...new Set(sourceObjects(sources).map(source => source.url))];
  const links = urls.map((url, i) => ({ text: i ? ` · ${i + 1}` : `来源：${new URL(url).hostname}`, options: { hyperlink: { url } } }));
  slide.addText(`图：${model.imageCredit || '本地归档原图'}`, { x: .58, y: 6.96, w: 4.12, h: .17, fontFace: FONT, fontSize: 6.5, color: DARK.muted, margin: 0 });
  slide.addText(links.length ? links : '来源：见备注', { x: .58, y: 7.14, w: 3.55, h: .18, fontFace: FONT, fontSize: 6.5, color: DARK.gold, margin: 0 });
  slide.addText(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 3.96, y: 7.14, w: .74, h: .18, fontFace: FONT, fontSize: 6.5, color: DARK.gold, align: 'right', margin: 0 });
  slide.addNotes([
    model.title, model.subtitle, text(sources?.body), ...model.features, ...model.borrow, ...model.improve, model.conclusion,
    ...list(editorial.borrow), ...list(editorial.translate), ...list(editorial.caution), editorial.quote,
    ...images.flatMap(image => [text(image.name), image.sourcePageUrl, image.sourceUrl, `${image.width} × ${image.height}`].filter(Boolean)),
    ...urls,
  ].filter(Boolean).join('\n'));
}

async function exportCaseBenchmarkPresentation({ research, project, cases, images = [], outputPath, allowedImageRoots = [], convertImage, template = 'brief' } = {}) {
  if (!research || typeof research !== 'object') throw new Error('请先选择已返回成果的项目调研任务。');
  if (!outputPath || path.extname(outputPath).toLowerCase() !== '.pptx' || !path.isAbsolute(outputPath)) throw new Error('请选择本地 PPTX 保存位置。');
  const record = research.result && typeof research.result === 'object' ? { ...research, ...research.result } : research;
  const projectData = project?.project || project || research.projectContext?.project || research.contextSnapshot?.project || research.projectSnapshot || {};
  const planItems = list(record.slidePlan);
  let caseItems = (Array.isArray(cases) ? cases : list(record.cases)).filter(item => item && typeof item === 'object');
  if (planItems.length) {
    const pageCounts = new Map(), originals = caseItems;
    caseItems = planItems.map((plan, index) => {
      const original = plan.caseId ? originals.find(item => (item.caseId || item.id) === plan.caseId) : originals.length === 1 ? originals[0] : null;
      if (!original) throw Object.assign(new Error('请为每一页填写所选案例的 caseId；多案例不能合并成报告封面或目录。'), { code: 'CASE_PAGE_SCOPE' });
      const caseId = original.caseId || original.id || 'single-case', count = (pageCounts.get(caseId) || 0) + 1;
      if (count > 3) throw Object.assign(new Error(`“${original.name || caseId}”超过 3 页。请将该案例提炼为 1–3 页，完整分析放入 body 备注或 HTML 分析页。`), { code: 'CASE_PAGE_LIMIT' });
      pageCounts.set(caseId, count);
      for (const id of list(plan.imageAssetIds)) {
        const image = images.find(item => (item.id || item.assetId) === id);
        if (image && (image.caseId || list(image.caseIds).length) && image.caseId !== caseId && !list(image.caseIds).includes(caseId)) throw Object.assign(new Error('每页只能使用该页案例自己的归档图片，请核对 caseId 与 imageAssetIds。'), { code: 'IMAGE_CASE_SCOPE' });
      }
      return {
        ...original,
        name: text(plan.title) || `案例 ${index + 1}`,
        caseId,
        body: text(plan.body),
        imageAssetIds: list(plan.imageAssetIds),
        sourceUrls: list(plan.sourceUrls),
        benchmark: {
          title: text(plan.title) || `案例 ${index + 1}`,
          subtitle: text(plan.subtitle || plan.kicker || plan.eyebrow),
          facts: list(plan.facts).length ? list(plan.facts) : list(original.benchmark?.facts),
          features: list(plan.features).length ? list(plan.features)
            : text(plan.body).split(/[。\n]/).map(value => firstClause(value, 40)).filter(Boolean).slice(0, 4),
          borrow: list(plan.borrow),
          improve: list(plan.improve),
          conclusion: text(plan.conclusion),
          note: text(plan.note),
          imageCredit: text(plan.imageCredit),
          imageIds: list(plan.imageAssetIds),
        },
      };
    });
  }
  const warnings = [];
  const usableImages = await prepareImages(images, allowedImageRoots, convertImage, warnings);
  const sources = collectSources(record, caseItems, images);
  const style = template === 'editorial' ? 'editorial' : 'brief';
  const slides = caseItems.map(item => {
    const ids = new Set([item.caseId, item.id].filter(Boolean));
    let own = usableImages.filter(image => ids.has(image.caseId) || list(image.caseIds).some(id => ids.has(id)));
    if (!own.length) own = usableImages.filter(image => !image.caseId && !list(image.caseIds).length);
    const model = benchModel(item);
    return { model, images: pickBenchmarkImages(model, own), item };
  }).filter(slide => slide.model.title);
  if (!slides.length) throw new Error('本次尚无可导出的案例资料。');
  const pptx = withPresentationProvenance(new PptxGenJS());
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'AIDesignHub'; pptx.company = 'AIDesignHub'; pptx.lang = 'zh-CN';
  pptx.title = `${text(projectData.name) || '项目'} · 对标案例`;
  pptx.subject = style === 'editorial' ? '对标案例 · 杂志版' : '对标案例 · 研究简报'; pptx.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'zh-CN' };
  slides.forEach((slide, index) => {
    if (style === 'editorial') addEditorialSlide(pptx, slide.model, slide.images, index, slides.length, slide.item);
    else addBenchmarkSlide(pptx, slide.model, slide.images, index, slides.length, slide.item);
  });
  const usedImages = new Set(slides.flatMap(slide => slide.images.map(image => image.id || image.filename)));
  const filePath = path.resolve(outputPath);
  await pptx.writeFile({ fileName: filePath, compression: true });
  return { filePath, template: style, slideCount: slides.length, imageCount: usedImages.size, sourceCount: sources.length, warnings };
}

module.exports = { exportResearchPresentation, exportCaseBenchmarkPresentation };
