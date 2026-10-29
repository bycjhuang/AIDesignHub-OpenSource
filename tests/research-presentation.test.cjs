'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { exportResearchPresentation, exportCaseBenchmarkPresentation } = require('../backend/research-presentation.cjs');
const fixture = require('./fixtures/smoke-case.cjs');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-research-ppt-'));
  const originals = path.join(directory, 'originals'); fs.mkdirSync(originals);
  const imagePath = path.join(originals, 'case.png'); fs.writeFileSync(imagePath, Buffer.from(fixture.imageDataUrl.split(',')[1], 'base64'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const research = {
    title: '滨水美术馆与开放公共空间', status: 'partial', brief: '比较庭院、滨水流线和分时开放机制。',
    summary: '已阅读两个公开页面，庭院连接公共步道的做法可供本项目核对。',
    sources: [
      { url: 'https://architecture.example.org/museum', title: '建筑案例全文', status: 'verified' },
      { url: 'https://landscape.example.org/museum', title: '公共空间设计', status: 'verified' },
      { url: 'https://mp.weixin.qq.com/s/unavailable', title: '待人工查看的文章', status: 'blocked', error: '需要网页验证' },
    ],
    cases: [{ name: '江湾美术馆', summary: '展厅围绕公共庭院组织。', facts: { area: '12000 平方米', designer: '测试设计院' }, sourceUrls: ['https://architecture.example.org/museum'] }],
    references: [{ title: '公共流线与展览流线分离', observation: '案例以院落连接公共步道。', projectRelevance: '本项目希望夜间开放滨水公共空间。', application: '复核门禁边界与通行时段。', limitations: '需结合场地边界核对。', sourceUrls: ['https://landscape.example.org/museum'] }],
    imageReport: { failedCount: 1 }, warnings: ['另有一张图片未下载成功。'],
  };
  return { directory, originals, research, image: { id: 'asset-1', path: imagePath, width: 9999, height: 9999, contentType: 'image/png', name: '庭院与滨水步道', sourcePageUrl: 'https://architecture.example.org/museum', sourceUrl: 'https://cdn.example.org/museum.png' } };
}

test('research export includes editable text, local image, project reference points and every clickable source', async t => {
  const { directory, originals, research, image } = setup(t);
  const result = await exportResearchPresentation({ research, project: { name: '本地滨水更新项目', stage: '方案', focus: '夜间公共空间开放', researchProfile: { isSynthetic: true, positioning: '中型滨水文化商业', siteAreaM2: 45000, aboveGroundAreaM2: 60000, plotRatio: 1.33 } }, images: [image], outputPath: path.join(directory, '研究.pptx'), allowedImageRoots: [originals] });
  assert(result.slideCount >= 8); assert.equal(result.imageCount, 1); assert.equal(result.sourceCount, 4);
  assert(result.warnings.some(warning => /400 × 240/.test(warning)), 'actual file dimensions override untrusted image metadata');
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slideFiles = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, result.slideCount);
  const slides = (await Promise.all(slideFiles.map(name => archive.file(name).async('string')))).join('\n');
  assert.match(slides, /<a:t>.*公共流线与展览流线分离/); assert.match(slides, /本地滨水更新项目/); assert.match(slides, /复核门禁边界与通行时段/);
  assert.match(slides, /400 × 240/); assert.match(slides, /部分完成/); assert.match(slides, /另有一张图片未下载成功/);
  assert.match(slides, /演示假设/); assert.match(slides, /中型滨水文化商业/); assert.match(slides, /用地面积：45,000㎡/);
  assert.equal(Object.keys(archive.files).filter(name => /^ppt\/media\/.*\.png$/.test(name)).length, 1);
  const relationships = (await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/slides\/_rels\/.+\.rels$/.test(name)).map(name => archive.file(name).async('string')))).join('\n');
  for (const source of research.sources) assert(relationships.includes(source.url), `missing clickable link: ${source.url}`);
  assert(relationships.includes(image.sourceUrl));
  const notes = (await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')))).join('\n');
  assert.match(notes, /需要网页验证/);
});

test('export never embeds images outside trusted archive roots and records skipped files', async t => {
  const { directory, originals, research, image } = setup(t);
  const outside = path.join(directory, 'outside.png'); fs.copyFileSync(image.path, outside);
  const result = await exportResearchPresentation({ research, images: [{ ...image, path: outside }], outputPath: path.join(directory, 'safe.pptx'), allowedImageRoots: [originals] });
  assert.equal(result.imageCount, 0); assert(result.warnings.some(warning => /不在本地归档目录/.test(warning)));
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  assert.equal(Object.keys(archive.files).filter(name => /^ppt\/media\//.test(name) && !archive.files[name].dir).length, 0);
});

test('long research content is paginated and sources are retained without dropping trailing facts', async t => {
  const { directory, research } = setup(t);
  research.summary = Array.from({ length: 80 }, (_, index) => `第${index + 1}条事实：请设计师结合项目要求核对来源页面中的建筑和景观关系。`).join('\n');
  research.sources = Array.from({ length: 17 }, (_, index) => ({ title: `来源 ${index + 1}`, url: `https://research.example.org/case/${index + 1}` }));
  const result = await exportResearchPresentation({ research, outputPath: path.join(directory, 'long.pptx') });
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slides = (await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')))).join('\n');
  assert.match(slides, /第80条事实/); assert.match(slides, /来源链接清单（4\/4）/); assert.equal(result.sourceCount, 19);
});

test('invalid destinations and missing research are rejected before writing files', async () => {
  await assert.rejects(exportResearchPresentation({ outputPath: 'relative.pptx' }), /调研任务/);
  await assert.rejects(exportResearchPresentation({ research: {}, outputPath: 'relative.pptx' }), /PPTX/);
});

test('long Chinese reference headings use at most two fixed-size lines and retain the full heading in notes', async t => {
  const { directory, research } = setup(t);
  const heading = '滨水与街巷的连续性靠节点放大实现，而不是靠一条通长步道：蟠龙用桥与环道串联公园，苏河湾用多处下沉开口和天桥连接公共活动空间，江湾需要结合自身场地尺度核对。';
  research.references = [{ point: heading, application: '根据本项目的现场条件核对节点组织。', sourceUrls: [research.sources[0].url] }];
  const result = await exportResearchPresentation({ research, outputPath: path.join(directory, 'heading.pptx') });
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slides = await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')));
  const reference = slides.find(xml => xml.includes('根据本项目的现场条件核对节点组织'));
  assert(reference, 'reference slide exists');
  const header = reference.match(/<p:sp\b[\s\S]*?<\/p:sp>/)[0];
  assert.equal((header.match(/<a:p>/g) || []).length, 2);
  assert.match(header, /wrap="none"/); assert.match(header, /sz="2400"/); assert.match(header, /…/);
  const notes = (await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')))).join('\n');
  assert(notes.includes(heading), 'full unshortened reference remains in notes');
});

test('quote verification states cannot overwrite authoritative page read or unavailable states', async t => {
  const { directory, research } = setup(t);
  const read = research.sources[0].url, unavailable = research.sources[1].url;
  research.sources[0].status = 'read'; research.sources[1].status = 'unavailable';
  research.cases[0].evidence = [
    { sourceUrl: read, field: 'area', value: '9999平方米', quote: '未独立核验的摘录', status: 'needs_verification' },
    { sourceUrl: unavailable, field: 'name', value: '江湾美术馆', quote: '项目名称：江湾美术馆', status: 'source-quoted' },
  ];
  const result = await exportResearchPresentation({ research, outputPath: path.join(directory, 'states.pptx') });
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slides = await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')));
  const sourcePage = slides.find(xml => xml.includes('来源链接清单'));
  assert.match(sourcePage, /建筑案例全文（已读取）/); assert.match(sourcePage, /公共空间设计（暂不可用）/);
  assert(!sourcePage.includes('needs_verification')); assert(!sourcePage.includes('source-quoted'));
  const notes = (await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')))).join('\n');
  assert.match(notes, /字段证据状态：needs_verification/); assert.match(notes, /字段证据状态：source-quoted/);
});

test('benchmark export defaults to one page per case and keeps every selected case', async t => {
  const { directory, originals, research, image } = setup(t);
  const cases = Array.from({ length: 4 }, (_, index) => ({
    caseId: `case-${index + 1}`, name: `对标案例${index + 1}`,
    benchmark: {
      title: `对标案例${index + 1}`, subtitle: `定位${index + 1} · 2024 开业`,
      facts: [{ label: '业主', value: '测试业主' }, { label: '体量', value: '商业 5万㎡' }],
      features: ['连续檐下界面，串联公共节点'], borrow: ['用街巷替代大体量'], improve: ['先统一面积口径'],
      conclusion: `结论${index + 1}`, images: ['case.png'],
    },
  }));
  const result = await exportCaseBenchmarkPresentation({ research: { ...research, cases }, cases, images: [{ ...image, filename: 'case.png' }], allowedImageRoots: [originals], outputPath: path.join(directory, 'benchmark.pptx') });
  assert.equal(result.slideCount, 4); assert.equal(result.imageCount, 1);
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slideFiles = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, 4);
  const slides = await Promise.all(slideFiles.map(name => archive.file(name).async('string')));
  assert.match(slides[0], /对标案例 01/); assert.match(slides[0], /01  项目档案/); assert.match(slides[0], /04  项目改进/); assert.match(slides[0], /结论/);
  assert.equal((slides[0].match(/<p:pic>/g) || []).length, 1);
  assert.match(slides[3], /对标案例4/);
});

test('both compact templates allow up to three pages per case, keep full analysis in notes and reject excess pages', async t => {
  const { directory, originals, image } = setup(t);
  const cases = [{ caseId: 'c1', name: '案例一' }, { caseId: 'c2', name: '案例二' }];
  const body = Array.from({ length: 30 }, (_, i) => `完整分析第${i + 1}条。`).join('\n');
  const slidePlan = ['c1', 'c2', 'c2', 'c2'].map((caseId, i) => ({ caseId, title: `案例页${i + 1}`, body,
    facts: [{ label: '区位', value: '上海' }], features: ['围绕水岸组织公共空间'], borrow: ['借鉴连续步行界面'], improve: ['核对运营时段'], conclusion: '按本项目条件转译', imageAssetIds: ['asset-1'] }));
  for (const template of ['brief', 'editorial']) {
    const result = await exportCaseBenchmarkPresentation({ research: { cases, slidePlan }, cases, images: [{ ...image, caseIds: ['c1', 'c2'] }], allowedImageRoots: [originals], outputPath: path.join(directory, `${template}-per-case.pptx`), template });
    assert.equal(result.slideCount, 4);
    const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
    const slides = await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')));
    assert.equal(slides.length, 4); assert.match(slides[3], /案例页4/); assert(!slides.join('').includes('分析续页'));
    const notes = await archive.file('ppt/notesSlides/notesSlide4.xml').async('string');
    assert.match(notes, /完整分析第30条/); assert.match(notes, /核对运营时段/);
    await assert.rejects(exportCaseBenchmarkPresentation({ research: { cases, slidePlan: [...slidePlan, slidePlan[3]] }, outputPath: path.join(directory, `${template}-too-long.pptx`), template }), error => error.code === 'CASE_PAGE_LIMIT');
  }
  await assert.rejects(exportCaseBenchmarkPresentation({ research: { cases, slidePlan: [{ title: '未指定案例的报告封面' }] }, outputPath: path.join(directory, 'ambiguous.pptx') }), error => error.code === 'CASE_PAGE_SCOPE');
  await assert.rejects(exportCaseBenchmarkPresentation({ research: { cases, slidePlan: [{ ...slidePlan[0], caseId: 'c2' }] }, images: [{ ...image, caseId: 'c1' }], outputPath: path.join(directory, 'wrong-image.pptx') }), error => error.code === 'IMAGE_CASE_SCOPE');
});

test('editorial template uses the dark magazine structure and keeps the one-case-per-page format', async t => {
  const { directory, originals, research, image } = setup(t);
  const cases = Array.from({ length: 2 }, (_, index) => ({
    caseId: `editorial-${index + 1}`, name: `杂志案例${index + 1}`,
    benchmark: {
      title: `杂志案例${index + 1}`, subtitle: '上海 · 2024 开业',
      features: ['连续檐下界面，串联公共节点'], borrow: ['用街巷替代大体量'], improve: ['先统一面积口径'],
      editorial: { borrow: ['学街巷尺度与连续檐下'], translate: ['把大体量拆成近地街区'], caution: ['不照搬古镇符号'], quote: '学尺度，不学符号。' },
      images: ['case.png'],
    },
  }));
  const result = await exportCaseBenchmarkPresentation({ research: { ...research, cases }, cases, images: [{ ...image, filename: 'case.png' }], allowedImageRoots: [originals], outputPath: path.join(directory, 'editorial.pptx'), template: 'editorial' });
  assert.equal(result.template, 'editorial'); assert.equal(result.slideCount, 2);
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slideFiles = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = await Promise.all(slideFiles.map(name => archive.file(name).async('string')));
  assert.equal(slideFiles.length, 2);
  assert.match(slides[0], /BENCHMARK/); assert.match(slides[0], /借鉴/); assert.match(slides[0], /转译/); assert.match(slides[0], /警示/); assert.match(slides[0], /TAKEAWAY/);
  assert.equal((slides[0].match(/<p:pic>/g) || []).length, 1);
});

test('native ADH image pages preserve the entire analysis body on continuation pages instead of silently truncating it', async t => {
  const { directory, originals, image } = setup(t);
  const body = Array.from({ length: 35 }, (_, index) => `第${index + 1}条案例事实及适用限制，需要保留完整内容以便核对。`).join('\n');
  const research = { origin: 'adh', title: '原生逐页方案', slidePlan: [{ title: '图像与长分析', body, imageAssetIds: ['asset-1'], sourceUrls: ['https://architecture.example.org/museum'] }] };
  const result = await exportResearchPresentation({ research, images: [image], allowedImageRoots: [originals], outputPath: path.join(directory, 'native-long.pptx') });
  const archive = await JSZip.loadAsync(fs.readFileSync(result.filePath));
  const slides = (await Promise.all(Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => archive.file(name).async('string')))).join('\n');
  assert.match(slides, /完整分析与事实说明见下一页/);
  assert.match(slides, /第35条案例事实及适用限制/);
  assert.match(slides, /分析续页/);
});
