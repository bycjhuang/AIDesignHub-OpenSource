'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validatePublicUrl, validateRasterImage } = require('./public-page.cjs');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const list = value => Array.isArray(value) ? value : [];
const url = value => { try { return validatePublicUrl(value).href; } catch { return ''; } };
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '待补充';
const clip = (value, max = 200) => { const content = String(value || '').trim(); if (content.length <= max) return content; const part = content.slice(0, max), end = Math.max(part.lastIndexOf('。'), part.lastIndexOf('；')); return `${part.slice(0, end > max / 2 ? end + 1 : max)}…`; };
const link = (value, title) => url(value) ? `<a href="${escape(url(value))}" target="_blank" rel="noreferrer noopener">${escape(title || value)}</a>` : escape(title || '来源待补充');

// Prefer the Agent's published selections and the architect's project page;
// keep diagrams after spatial photographs. This is an ordering rule, not image
// recognition; every image has already passed the research archive policy.
function selectResearchImages(research, assets, maximum = 6) {
  const cases = list(research.cases), selected = [], seen = new Set();
  const score = (image, item) => {
    const published = list(item.sources).flatMap(source => list(source.imageUrls));
    const name = `${image.sourceUrl || ''} ${image.name || ''} ${image.alt || ''}`;
    let result = /typolog|diagram|(?:^|[\/_-])plan[\/_-]|section|axon|分析图|示意图|平面图|剖面图/i.test(name) ? 100 : 0;
    if (published.includes(image.sourceUrl)) result -= 6;
    if (image.sourcePageUrl === item.originalPrimarySourceUrl || image.sourcePageUrl === item.primarySourceUrl) result -= 8;
    if (image.width / image.height < 1.1) result += 10;
    return result - Math.min(image.width || 0, 3000) / 10000;
  };
  const queues = cases.map(item => assets.filter(image => image.caseId === item.caseId || list(image.caseIds).includes(item.caseId)).sort((a, b) => score(a, item) - score(b, item)));
  const take = image => { const key = image?.hash || image?.id || image?.sourceUrl; if (image && !seen.has(key) && selected.length < maximum) { seen.add(key); selected.push(image); } };
  for (let round = 0; round < maximum; round++) for (const queue of queues) take(queue[round]);
  for (const image of assets) take(image);
  return selected;
}

async function exportResearchAnalysisPage({ research, project, images = [], outputPath, allowedImageRoots = [] }) {
  if (!research || !project || !path.isAbsolute(outputPath || '')) throw new Error('案例分析页需要项目、调研结果和本地保存位置。');
  const warnings = [...list(research.warnings), ...list(research.errors)], pictures = [], roots = allowedImageRoots.map(root => { try { return fs.realpathSync(root); } catch { return ''; } }).filter(Boolean);
  for (const asset of images) {
    if (pictures.length >= 3) break;
    try {
      const file = fs.realpathSync(asset.path), within = roots.some(root => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); });
      if (!within || !url(asset.sourcePageUrl || asset.sourceUrl)) throw new Error('图片来源或归档目录无效');
      const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('图片文件过大');
      const bytes = fs.readFileSync(file), info = validateRasterImage(bytes, asset.contentType, { allowSmall: true, allowAnimation: true });
      pictures.push({ ...asset, ...info, data: `data:${info.contentType};base64,${bytes.toString('base64')}` });
    } catch { warnings.push('一张归档图片无法嵌入分析页，原始来源仍保留。'); }
  }
  const profile = research.projectSnapshot?.researchProfile || research.projectSnapshot?.project?.researchProfile || project.researchProfile || {};
  const sources = new Map();
  for (const source of [...list(research.sources), ...list(research.cases).flatMap(item => list(item.sources))]) {
    const href = url(typeof source === 'string' ? source : source.url || source.sourceUrl);
    if (href) sources.set(href, { ...(sources.get(href) || {}), ...(typeof source === 'string' ? {} : source), url: href });
  }
  const references = [...new Map([...list(research.references), ...list(research.cases).flatMap(item => list(item.references))].filter(item => item?.point || item?.title).map(item => [item.point || item.title, item])).values()].slice(0, 4);
  const metrics = [['用地面积', profile.siteAreaM2, '㎡'], ['地上建筑面积', profile.aboveGroundAreaM2, '㎡'], ['总建筑面积', profile.grossFloorAreaM2, '㎡'], ['容积率', profile.plotRatio, '']];
  const facts = item => Object.entries(item.fields || {}).filter(([key, value]) => key !== 'name' && value?.value).map(([key, value]) => `<span>${escape(({ area: '规模', location: '地点', designer: '设计方', typeLabel: '类型', openingDate: '开业' })[key] || key)}：${escape(clip(value.value, 90))}${value.status === 'source-quoted' ? '' : '（待核实）'}</span>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(project.name)} · 案例分析</title><style>
*{box-sizing:border-box}body{margin:0;background:#e9ece7;color:#23362e;font:15px/1.6 'Microsoft YaHei',sans-serif}.sheet{max-width:1500px;margin:30px auto;background:#fafbf7;padding:48px 58px;box-shadow:0 16px 70px #243b2812}header{display:flex;justify-content:space-between;gap:30px;border-bottom:2px solid #294b3b;padding-bottom:24px}h1{font-size:34px;line-height:1.3;margin:8px 0 10px}h2{font-size:20px;margin:0 0 14px}h3{font-size:17px;margin:0 0 8px}p{margin:7px 0}a{color:#316f58;text-decoration:none;border-bottom:1px solid #a4bcaa;overflow-wrap:anywhere}.eyebrow{font-size:11px;letter-spacing:2px;color:#52715f}.badge{padding:6px 12px;background:#efe7cc;color:#7d6332;border-radius:30px;font-size:12px;height:max-content;white-space:nowrap}.brief{display:grid;grid-template-columns:1.2fr 1fr;gap:36px;padding:25px 0}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.metric{padding:10px;border-left:1px solid #c8d3c9}.metric strong{font-size:24px;display:block;font-weight:500}.metric small{color:#788678}.grid{display:grid;grid-template-columns:1.05fr 1fr;gap:34px}.photos{display:grid;grid-template-columns:1fr 1fr;gap:10px}figure{margin:0;background:#eaf0e8}figure:first-child{grid-column:1/-1}img{display:block;width:100%;max-height:300px;object-fit:contain;background:#e5e8e2}figure:not(:first-child) img{max-height:150px}figcaption{padding:7px 10px;font-size:10px;color:#5e705f}.case{border-bottom:1px solid #dce2d9;padding:16px 0}.facts{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:#6b776d}.point{display:grid;grid-template-columns:28px 1fr;gap:12px;padding:15px 0;border-bottom:1px solid #dce2d9}.point>b{font-size:20px;color:#779383}.point p{font-size:13px}.limit{color:#81704f;font-size:11px!important}.sources{margin-top:28px;border-top:1px solid #9faf9d;padding-top:14px;font-size:11px}.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px 25px}.note{color:#6e786d;font-size:11px}.warnings{margin-top:16px;color:#897249;font-size:11px}footer{display:flex;justify-content:space-between;margin-top:22px;font-size:10px;color:#7e8b7b}@media(max-width:900px){.sheet{margin:0;padding:25px}.brief,.grid{grid-template-columns:1fr}header{display:block}.metrics{grid-template-columns:1fr 1fr}.source-grid{grid-template-columns:1fr}}@page{size:A3 landscape;margin:10mm}@media print{body{background:white}.sheet{box-shadow:none;margin:0;max-width:none;padding:10px}a{color:inherit}details{display:block}figure,.point,.case{break-inside:avoid}}
</style></head><body><main class="sheet"><header><div><div class="eyebrow">AIDESIGNHUB / CASE STUDY</div><h1>${escape(project.name)}<br>案例对标与设计借鉴</h1><p>${escape(clip(research.title || research.brief, 160))}</p></div><span class="badge">${profile.isSynthetic ? '项目背景：演示假设' : '项目背景待核实'} · 案例来源供人工复核</span></header>
<section class="brief"><div><h2>项目条件</h2><p>${escape(profile.positioning || project.description || '项目定位待补充')}</p><p class="note">${escape(list(profile.objectives).join('；'))}</p><p class="note">项目指标由用户授权编制为演示假设，不代表实际规划条件或已获批准的设计指标。</p></div><div class="metrics">${metrics.map(([name, value, unit]) => `<div class="metric"><small>${escape(name)}</small><strong>${number(value)}<small>${unit}</small></strong></div>`).join('')}</div></section>
<div class="grid"><section><h2>案例观察 · 真实来源</h2><div class="photos">${pictures.length ? pictures.map((item, index) => `<figure><img src="${item.data}" alt="${escape(item.caption || item.name || '案例项目实景')}"><figcaption>${String(index + 1).padStart(2, '0')} / ${item.width} × ${item.height} px · ${link(item.sourcePageUrl || item.sourceUrl, '查看原始页面')}</figcaption></figure>`).join('') : '<p class="note">尚未归档可用项目图，请查看来源链接。</p>'}</div>${list(research.cases).slice(0, 3).map(item => `<article class="case"><h3>${escape(item.name || item.title)}</h3><div class="facts">${facts(item)}</div><p>${escape(clip(item.summary, 200))}</p></article>`).join('')}</section>
<section><h2>结合当前项目的参考点</h2><p class="note">以下为依据案例资料作出的设计分析，适用性仍需结合真实场地复核。</p>${references.map((point, index) => `<article class="point"><b>${String(index + 1).padStart(2, '0')}</b><div><h3>${escape(clip(point.point || point.title, 65))}</h3><p>${escape(clip(point.application || point.projectRelevance, 160))}</p><p class="limit">适用限制：${escape(clip(point.limitation || point.limitations || '需结合实际场地与运营条件确认。', 100))}</p><div class="note">${list(point.sourceUrls).map((source, i) => link(source, `依据 ${i + 1}`)).join(' · ')}</div></div></article>`).join('') || '<p>本次尚未形成有来源支撑的项目借鉴建议。</p>'}<details class="warnings"><summary>采集范围与未完成事项（展开查看）</summary>${[...new Set([...list(research.limitations), ...warnings])].map(item => `<p>• ${escape(typeof item === 'string' ? item : item.message || '')}</p>`).join('')}</details></section></div>
<section class="sources"><h3>来源与可用链接</h3><div class="source-grid">${[...sources.values()].map((source, index) => `<div>${String(index + 1).padStart(2, '0')} ${link(source.url, clip(source.title || source.url, 75))} · ${source.status === 'read' || source.status === 'verified' ? '正文已读取' : '待人工查看'}${source.error ? ` / ${escape(source.error)}` : ''}</div>`).join('')}</div></section><footer><span>AI DesignHub · 项目假设 / 真实案例 / 设计分析分别标注</span><span>${escape(new Date().toISOString().slice(0, 10))} / ${escape(research.status || '待核实')}</span></footer></main></body></html>`;
  fs.writeFileSync(outputPath, html, 'utf8');
  return { filePath: outputPath, imageCount: pictures.length, sourceCount: sources.size, warnings };
}
module.exports = { exportResearchAnalysisPage, selectResearchImages };
