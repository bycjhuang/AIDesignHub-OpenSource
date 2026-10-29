'use strict';

// Renderer -> real local case/job/run workflow. Only the external executor and
// public-page reader are substituted; no model or public network is contacted.
const { imageUrl, sourceUrl: linkFixtureUrl, fetchPage: linkFixturePage } = require('./smoke-case.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const connectionId = 'smoke-case-name-agent';
const firstQuery = '名称烟测滨水美术馆';
const ambiguousQuery = '名称烟测文化中心';
const clarifiedQuery = '名称烟测文化中心 上海 滨江项目';
const firstUrl = 'https://projects.example.org/name-smoke-museum';
const clarifiedUrl = 'https://projects.example.org/name-smoke-culture-shanghai';
const secondCandidateUrl = 'https://projects.example.org/name-smoke-culture-hangzhou';
const summary = '合成名称调研摘要：临水展厅组织公共庭院。<img src=x onerror="window.caseNameXss=true">';

function syntheticPage(url, name, location) {
  return {
    url, finalUrl: url, title: name, description: '合成公开页面：临水展厅与公共庭院。',
    text: `项目名称：${name}\n建筑面积：12000平方米\n项目类型：美术馆\n项目地址：${location}\n设计单位：名称烟测设计院\n发布时间：2026年10月4日\n临水展厅组织公共庭院。\n<script>window.caseNameReaderXss=true</script>`,
    images: [{ url: imageUrl, alt: '名称调研隔离 PNG 样本' }], retrievedAt: Date.now(),
  };
}

function matchedResult(page) {
  const values = { name: page.title, area: '建筑面积 12000平方米', typeLabel: '美术馆', location: page.text.includes('上海市黄浦区') ? '上海市黄浦区' : '上海市浦东新区', designer: '名称烟测设计院' };
  const labels = { name: '项目名称', area: '建筑面积', typeLabel: '项目类型', location: '项目地址', designer: '设计单位' };
  return {
    matchStatus: 'matched', primarySourceUrl: page.url, ...values, openingDate: null, summary, candidates: [],
    evidence: Object.entries(values).map(([field, value]) => ({ field, value, sourceUrl: page.url, quote: `${labels[field]}：${field === 'area' ? '12000平方米' : value}` })),
  };
}

async function runCaseNameSmoke({ win, backend, hub, caseService }) {
  if (process.env.BYCJ_WORKBENCH_SMOKE !== '1') throw new Error('Isolated smoke mode required.');
  const original = { execute: hub.execute, fetchPage: caseService.fetchPage, previewFetchPage: caseService.previews.fetchPage };
  const pages = new Map([
    [firstUrl, syntheticPage(firstUrl, firstQuery, '上海市黄浦区')],
    [clarifiedUrl, syntheticPage(clarifiedUrl, '名称烟测文化中心（上海）', '上海市浦东新区')],
  ]);
  const calls = [], fetchedPages = [], observedStatuses = new Map();
  const observe = id => {
    const item = caseService.find(id);
    if (item?.research?.mode !== 'name') return;
    if (!observedStatuses.has(id)) observedStatuses.set(id, new Set());
    observedStatuses.get(id).add(item.research.status);
  };
  caseService.on('changed', observe);
  hub.saveConnection({ id: connectionId, provider: 'custom', mode: 'cli', label: '名称隔离测试 Agent', command: process.execPath, args: [], timeoutMs: 10000 });
  const fetchPage = async (url, { signal } = {}) => {
    if (url === linkFixtureUrl) return linkFixturePage(url);
    const page = pages.get(url);
    if (!page) throw new Error('名称烟测禁止访问未列出的网页。');
    fetchedPages.push(url);await pause(150);
    if (signal?.aborted) throw new Error('名称烟测读取已取消。');
    return structuredClone(page);
  };
  caseService.fetchPage = fetchPage;caseService.previews.fetchPage = fetchPage;
  hub.execute = async (connection, input) => {
    if (connection.id !== connectionId) throw new Error('名称烟测不能启动其他执行器。');
    calls.push({ prompt: input.prompt, hasProjectGrant: Boolean(input.env?.AIDESIGNHUB_TOKEN || connection.mcpServers?.length) });
    input.onEvent?.({ message: '名称烟测替身：读取合成公开来源，不调用真实模型。' });
    await pause(220);
    let output;
    if (input.prompt.includes(clarifiedQuery)) output = matchedResult(pages.get(clarifiedUrl));
    else if (input.prompt.includes(ambiguousQuery)) output = {
      matchStatus: 'ambiguous', primarySourceUrl: null, name: null, area: null, typeLabel: null, location: null, openingDate: null, designer: null,
      summary: '发现两个同名合成项目，请补充城市。', evidence: [],
      candidates: [
        { name: '名称烟测文化中心（上海）', url: clarifiedUrl, description: '上海滨江。<img src=x onerror="window.caseNameCandidateXss=true">' },
        { name: '名称烟测文化中心（杭州）', url: secondCandidateUrl, description: '杭州山麓，同名但不同项目。' },
      ],
    };
    else if (input.prompt.includes(firstQuery)) output = matchedResult(pages.get(firstUrl));
    else throw new Error('名称烟测收到意外任务。');
    return { ok: true, text: JSON.stringify(output), outcome: 'completed' };
  };
  try {
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const $=id=>document.getElementById(id);
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const wait=async(fn,label)=>{for(let i=0;i<220;i++){if(await fn())return;await sleep(30);}throw new Error('名称案例烟测等待超时：'+label);};
      const bootstrap=()=>window.bycjWorkbench.bootstrap();
      const itemByQuery=async query=>(await bootstrap()).cases.find(item=>item.research?.mode==='name'&&item.research.query===query);
      const card=id=>document.querySelector('[data-case-id="'+id+'"]');
      const select=id=>{$('caseCollectConnection').value=id;$('caseCollectConnection').dispatchEvent(new Event('change',{bubbles:true}));};
      const fill=query=>{$('caseCollectQuery').value=query;$('caseCollectQuery').dispatchEvent(new Event('input',{bubbles:true}));};
      const submit=()=>{if($('caseCollectSubmit').disabled)throw new Error('名称调研发送按钮未启用');$('caseCollectForm').requestSubmit($('caseCollectSubmit'));};
      const close=()=>{if($('caseModal').classList.contains('is-open'))$('caseModal').querySelector('[data-close-modal]').click();};
      const originalConfirm=window.confirm;window.confirm=()=>true;
      try {
        document.querySelector('[data-view="cases"]').click();
        document.querySelector('[data-case-filter="all"]').click();
        window.dispatchEvent(new Event('agent-hub-changed'));
        await wait(()=>[...$('caseCollectConnection').options].some(option=>option.value===${JSON.stringify(connectionId)}),'执行器列表');
        const defaultName=$('caseModeName').getAttribute('aria-pressed')==='true'&&$('caseCollectQuery').required&&$('caseCollectUrl').disabled&&!$('caseCollectUrl').required;
        const noLinkRequired=$('caseCollectUrl').value==='';
        const before=await bootstrap();const firstCount=before.cases.length;
        select('zcode');fill(${JSON.stringify(firstQuery)});
        const inboundDisabled=$('caseCollectSubmit').disabled;
        $('caseCollectForm').requestSubmit();await wait(()=>!$('caseCollectQuery').disabled,'MCP 拒绝');await sleep(180);
        const inboundDidNotDispatch=!(await itemByQuery(${JSON.stringify(firstQuery)}))&&(await bootstrap()).cases.length===firstCount;
        select(${JSON.stringify(connectionId)});submit();
        await wait(async()=>Boolean(await itemByQuery(${JSON.stringify(firstQuery)})),'名称建立卡片');
        const initial=await itemByQuery(${JSON.stringify(firstQuery)});const firstId=initial.id;
        await wait(()=>Boolean(card(firstId)),'初始案例卡片');
        await wait(async()=>(await itemByQuery(${JSON.stringify(firstQuery)}))?.research.status==='awaiting_review','来源核验后待审核');
        const matched=await itemByQuery(${JSON.stringify(firstQuery)});
        const realJobAndRun=Boolean(matched.research.jobId&&matched.research.runId);
        const sameCard=matched.id===firstId&&(await bootstrap()).cases.length===firstCount+1;
        const sourceAttached=matched.sourceUrl===${JSON.stringify(firstUrl)}&&matched.research.matchStatus==='matched';
        const unknownIsNull=matched.openingDate===null&&matched.research.fields.openingDate.value===null;
        const evidenceVerified=matched.research.fields.name.status==='source-quoted'&&matched.research.fields.area.status==='source-quoted';
        await wait(()=>card(firstId)?.textContent.includes('待人工确认'),'卡片状态更新');
        card(firstId).scrollIntoView({block:'center'});card(firstId).click();
        await wait(()=>$('caseModal').classList.contains('is-open')&&$('caseModalTitle').textContent===${JSON.stringify(firstQuery)},'卡片详情');
        await wait(()=>{const img=$('casePreviewMedia').querySelector('img');return img?.complete&&img.naturalWidth===400;},'来源种子预览图片');
        await wait(()=>{const img=card(firstId)?.querySelector('.case-cover-image');return img?.complete&&img.naturalWidth===400;},'真实卡片图片');
        const previewImage=true;
        const summaryAndEvidence=$('caseDetailNotes').textContent.includes('合成名称调研摘要')&&document.querySelector('[data-case-field="area"] blockquote').textContent.includes('12000平方米');
        const unsafeTextEscaped=!window.caseNameXss&&!window.caseNameReaderXss&&$('caseDetailNotes').textContent.includes('<img')&&$('casePreviewText').textContent.includes('<script>')&&!$('caseDetailNotes').querySelector('img');
        const unknownShown=document.querySelector('[data-case-field="openingDate"]').textContent.includes('未找到');
        close();
        const beforeDuplicate=await window.bycjWorkbench.agentSnapshot();
        fill(${JSON.stringify(firstQuery)});submit();await wait(()=>$('caseCollectQuery').value===''&&!$('caseCollectSubmit').disabled,'相同查询返回已有卡片');
        const afterDuplicate=await window.bycjWorkbench.agentSnapshot();
        const duplicateNotRedispatched=(await bootstrap()).cases.length===firstCount+1&&afterDuplicate.jobs.length===beforeDuplicate.jobs.length&&afterDuplicate.runs.length===beforeDuplicate.runs.length;
        fill(${JSON.stringify(ambiguousQuery)});submit();
        await wait(async()=>(await itemByQuery(${JSON.stringify(ambiguousQuery)}))?.research.status==='needs_clarification','同名项目待确认');
        const ambiguous=await itemByQuery(${JSON.stringify(ambiguousQuery)});const ambiguousId=ambiguous.id,oldRunId=ambiguous.research.runId;
        await wait(()=>Boolean(card(ambiguousId)),'歧义案例卡片');card(ambiguousId).click();
        await wait(()=>!$('caseMatchCandidates').hidden&&$('caseMatchCandidates').textContent.includes('杭州'),'歧义候选');
        const candidatesVisible=$('caseMatchCandidates').querySelectorAll('a').length===2&&$('caseMatchCandidates').textContent.includes('上海');
        const candidatesSafe=!window.caseNameCandidateXss&&!$('caseMatchCandidates').querySelector('img')&&$('caseMatchCandidates').textContent.includes('<img');
        const noAmbiguousAutofill=!ambiguous.sourceUrl&&Object.values(ambiguous.research.fields).every(field=>field.value===null)&&$('caseReviewActions').hidden;
        await wait(()=>!$('caseRetryButton').disabled,'歧义可补信息重试');
        const retryFieldVisible=!$('caseRetryQueryField').hidden&&!$('caseRetryQuery').disabled;
        $('caseRetryQuery').value=${JSON.stringify(clarifiedQuery)};$('caseRetryConnection').value=${JSON.stringify(connectionId)};
        $('caseRetryButton').click();
        await wait(async()=>{const item=(await bootstrap()).cases.find(item=>item.id===ambiguousId);return item?.research.revision===2&&item.research.status==='awaiting_review';},'补充条件后同卡回填');
        const retried=(await bootstrap()).cases.find(item=>item.id===ambiguousId);
        const retrySameCard=retried.id===ambiguousId&&(await bootstrap()).cases.length===firstCount+2&&retried.sourceUrl===${JSON.stringify(clarifiedUrl)}&&retried.research.query===${JSON.stringify(clarifiedQuery)};
        const retryHistoryPreserved=retried.research.runId!==oldRunId&&retried.research.history?.some(version=>version.runId===oldRunId&&version.query===${JSON.stringify(ambiguousQuery)});
        await wait(()=>$('caseModalTitle').textContent==='名称烟测文化中心（上海）'&&$('caseMatchCandidates').hidden,'原抽屉自动更新');
        await wait(()=>{const img=$('casePreviewMedia').querySelector('img');return img?.complete&&img.naturalWidth===400;},'重试后真实图片');
        const originalDrawerUpdated=$('caseModal').classList.contains('is-open')&&$('caseDetailStatus').textContent.includes('待人工确认');
        return {defaultName,noLinkRequired,inboundDisabled,inboundDidNotDispatch,realJobAndRun,sameCard,sourceAttached,unknownIsNull,evidenceVerified,previewImage,summaryAndEvidence,unsafeTextEscaped,unknownShown,duplicateNotRedispatched,candidatesVisible,candidatesSafe,noAmbiguousAutofill,retryFieldVisible,retrySameCard,retryHistoryPreserved,originalDrawerUpdated,firstId,ambiguousId};
      } finally {window.confirm=originalConfirm;close();}
    })()`);
    result.onlyExpectedExecutions = calls.length === 3;
    result.noProjectGrant = calls.every(call => !call.hasProjectGrant) && [result.firstId, result.ambiguousId].every(id => {
      const job = hub.state.jobs.find(item => item.id === caseService.find(id)?.research.jobId);
      return job?.allowProjectTools === false;
    });
    result.lifecycleObserved = ['researching', 'validating_sources', 'awaiting_review'].every(status => observedStatuses.get(result.firstId)?.has(status));
    result.publicEvidenceRead = fetchedPages.includes(firstUrl) && fetchedPages.includes(clarifiedUrl);
    const failures = Object.entries(result).filter(([name, value]) => !['firstId', 'ambiguousId'].includes(name) && value !== true).map(([name]) => name);
    if (failures.length) throw new Error(`名称案例烟测未通过：${failures.join(', ')}`);
    return { ...result, agent: 'synthetic-executor-not-real-model', network: 'synthetic-public-pages-only' };
  } finally {
    hub.execute = original.execute;caseService.fetchPage = original.fetchPage;caseService.previews.fetchPage = original.previewFetchPage;
    caseService.removeListener('changed', observe);
  }
}

module.exports = { runCaseNameSmoke };
