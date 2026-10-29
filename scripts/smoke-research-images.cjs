'use strict';

// Explicit network smoke; isolated temp data, no model calls or user Hub data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ImageCollectionService } = require('../backend/image-collection.cjs');
const { ResearchImageService } = require('../backend/research-images.cjs');
const { fetchPublicPage } = require('../backend/public-page.cjs');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adh-research-live-'));
  const collection = new ImageCollectionService({ dataDir, findProject: id => id === 'live_project' ? { id } : null,
    findCase: id => id === 'live_case' ? { id, projectId: 'live_project' } : null });
  try {
    const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
      'https://www.gooood.cn/seashore-library-by-vector.htm',
      'https://www.archdaily.com/zh/768089/hai-bian-tu-shu-guan-zhi-xiang-jian-zhu-vector-architects'
    ];
    const sources = [];
    for (const url of urls) {
      try { sources.push({ url, page: await fetchPublicPage(url, { maxImages: 600, includeSmallImages: true, timeoutMs: 20000 }) }); }
      catch (cause) { console.log(JSON.stringify({ url, error: cause.message })); }
    }
    fs.writeFileSync(path.join(dataDir, 'page-cache.json'), JSON.stringify(sources));
    const service = new ResearchImageService({ collection });
    const report = await service.archiveSources({ projectId: 'live_project', caseId: 'live_case', sources, maxPerSource: 20, maxImages: 30 });
    const files = report.images.map(image => ({ assetId: image.assetId, path: collection.getAsset(image.assetId).path,
      width: image.width, height: image.height, sourcePageUrl: image.sourcePageUrl, sources: image.sources }));
    const result = { testedAt: new Date().toISOString(), dataDir, report, files };
    fs.writeFileSync(path.join(dataDir, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ dataDir, status: report.status, sources: report.sources.map(({ url, status, discoveredCount, selectedCount, savedCount, rejectedCount, pendingReviewCount, errors }) => ({ url, status, discoveredCount, selectedCount, savedCount, rejectedCount, pendingReviewCount, errors })),
      images: files.map(({ path: file, width, height }) => ({ path: file, width, height })), reportPath: path.join(dataDir, 'report.json') }));
  } finally { collection.dispose(); }
}
main().catch(cause => { console.error(cause.stack); process.exitCode = 1; });
