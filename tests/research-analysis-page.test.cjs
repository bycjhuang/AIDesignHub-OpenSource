'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportResearchAnalysisPage, selectResearchImages } = require('../backend/research-analysis-page.cjs');
const fixture = require('./fixtures/smoke-case.cjs');

test('single case analysis page embeds only trusted archived images and labels synthetic project conditions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-analysis-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originals = path.join(directory, 'originals'); fs.mkdirSync(originals); const image = path.join(originals, 'original.png'); fs.writeFileSync(image, Buffer.from(fixture.imageDataUrl.split(',')[1], 'base64'));
  const outputPath = path.join(directory, 'analysis.html');
  const result = await exportResearchAnalysisPage({ research: { status: 'partial', sources: [{ url: 'https://architecture.example/project', title: '<script>bad()</script>', status: 'read' }], cases: [{ name: '实景案例', summary: '正文资料' }], references: [{ point: '开放公共空间', application: '沿河组织连续步道', limitation: '需核对岸线条件', sourceUrls: ['https://architecture.example/project'] }] }, project: { name: '江湾文化商业中心', researchProfile: { isSynthetic: true, positioning: '演示定位', siteAreaM2: 42000, aboveGroundAreaM2: 75600, grossFloorAreaM2: 101600, plotRatio: 1.8 } }, images: [{ path: image, contentType: 'image/png', sourcePageUrl: 'https://architecture.example/project' }, { path: path.join(directory, 'secret.png'), sourcePageUrl: 'https://architecture.example/project' }], allowedImageRoots: [originals], outputPath });
  const html = fs.readFileSync(outputPath, 'utf8'); assert.equal(result.imageCount, 1); assert.equal(result.warnings.length, 1);
  assert.match(html, /演示假设/); assert.match(html, /42,000/); assert.match(html, /101,600/); assert.match(html, /沿河组织连续步道/); assert.match(html, /data:image\/png;base64/);
  assert(!html.includes('<script>bad()')); assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert(!html.includes(originals));
});

test('representative export images cover both cases and put spatial photographs ahead of a diagram', () => {
  const research = { cases: [{ caseId: 'c1', sources: [] }, { caseId: 'c2', originalPrimarySourceUrl: 'https://architect.example/project', sources: [] }] };
  const assets = [
    { id: 'diagram', caseIds: ['c1'], sourceUrl: 'https://images.example/landscape-typologies.jpg', width: 2000, height: 1200 },
    { id: 'photo1', caseIds: ['c1'], sourceUrl: 'https://images.example/waterfront.jpg', width: 2000, height: 1200 },
    { id: 'photo2', caseIds: ['c2'], sourceUrl: 'https://images.example/courtyard.jpg', sourcePageUrl: 'https://architect.example/project', width: 2000, height: 1125 },
  ];
  const selected = selectResearchImages(research, assets, 2); assert.deepEqual(selected.map(image => image.id), ['photo1', 'photo2']);
});
