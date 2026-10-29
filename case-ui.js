(() => {
  'use strict';
  const api=window.bycjWorkbench;
  const $=id=>document.getElementById(id);
  if(!$('caseCollectForm'))return;
  const state={data:null,projectId:null,generation:0,connections:[],selectedId:null,selectedCases:new Set(),retryCaseId:null,loadingConnections:null,busy:new Map(),previews:new Map(),previewPending:new Map(),previewQueue:[],previewActive:0,articles:new Map(),articlePending:new Map(),articleTimer:null,previewPane:'article',galleryIndex:0,returnFocus:null,collectMode:'link'};
  const capture=()=>({generation:state.generation,projectId:state.projectId||state.data?.project?.id||null});
  const isCurrent=operation=>operation.generation===state.generation&&(!operation.projectId||operation.projectId===state.projectId);
  const statuses={queued:'采集排队中',fetching:'正在读取页面',page_extracted:'页面已提取 · 待核实',waiting_agent:'等待外部 Agent',researching:'Agent 调研中',validating_sources:'正在核对公开来源',needs_clarification:'需确认具体项目',awaiting_review:'待人工确认',verified:'已人工确认',failed:'调研未完成'};
  const statusLabel=research=>research?.status==='page_extracted'&&research.agentError?'页面已保存 · Agent 未完成':statuses[research?.status]||'旧案例 · 尚未做来源核验';
  const fieldNames={name:'项目名称',area:'面积 / 规模',typeLabel:'项目类型',location:'所在地',openingDate:'开业时间',designer:'设计方'};
  const processing=new Set(['queued','fetching','waiting_agent','researching','validating_sources','awaiting_review']);
  const el=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=String(value);return node;};
  const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'尚未读取';
  const valueText=value=>value===null||value===undefined||value===''?'未找到':typeof value==='object'?JSON.stringify(value):String(value);
  const current=()=>state.data?.cases.find(item=>item.id===state.selectedId);
  const getConnection=id=>state.connections.find(item=>item.id===id);
  const isAutomatic=item=>['cli','acp','openclaw-http'].includes(item?.mode);
  const canDispatch=item=>isAutomatic(item)&&Boolean(item.mode==='openclaw-http'?item.endpoint:item.command);
  const notice=(message,error=false)=>{window.aidesignHubToast?.(message,error?'error':'normal');};
  const changed=()=>window.dispatchEvent(new Event('case-hub-changed'));
  const cardFor=id=>$('caseGrid').querySelector(`[data-case-id="${CSS.escape(id)}"]`);
  const allCards=()=>[...$('caseGrid').querySelectorAll('[data-case-id]')];
  const pptStyle=()=>$('caseSelectionStyle')?.value==='editorial'?'杂志版':'简报版';
  function handOff(action='research',caseIds=[...state.selectedCases],prompt='') {
    const validIds=new Set((state.data?.cases||[]).map(item=>item.id));
    const selected=[...new Set(caseIds)].filter(id=>validIds.has(id));
    if(action==='presentation'&&!selected.length){notice('先选几个想分析的案例。');return;}
    if(action==='presentation'&&!prompt)prompt=`制作案例研究 PPT，使用${pptStyle()}固定版式，并保留来源。`;
    closeDetail(false);
    window.dispatchEvent(new CustomEvent('adh-workbench-request',{detail:{projectId:state.projectId,action,caseIds:selected,prompt}}));
  }
  function renderSelection() {
    const items=state.data?.cases||[],validIds=new Set(items.map(item=>item.id));
    for(const id of state.selectedCases)if(!validIds.has(id))state.selectedCases.delete(id);
    const selected=items.filter(item=>state.selectedCases.has(item.id));
    $('caseSelectionBar').hidden=!selected.length;
    $('caseSelectionCount').textContent=`已选 ${selected.length} 个案例`;
    $('caseSelectionNames').textContent=selected.map(item=>item.name||'未命名案例').slice(0,3).join('、')+(selected.length>3?' 等':'');
    for(const card of allCards()){
      const chosen=state.selectedCases.has(card.dataset.caseId);card.classList.toggle('is-chosen',chosen);
      const checkbox=card.querySelector('[data-case-select]');if(checkbox)checkbox.checked=chosen;
    }
    window.dispatchEvent(new CustomEvent('adh-case-selection-changed',{detail:{projectId:state.projectId,caseIds:selected.map(item=>item.id)}}));
  }
  const previewKey=item=>`${state.projectId||item.projectId||''}|${item.id}|${item.sourceUrl||''}|${item.research?.retrievedAt||0}`;
  const previewFor=item=>item&&state.previews.get(previewKey(item));
  const isOpen=()=>$('caseModal').classList.contains('is-open');
  const displayTitle=(item,preview)=>/^(新收集的|正在读取项目网页|项目名称未找到)/.test(item.name||'')&&preview?.title?preview.title:item.name||preview?.title||'未命名案例';
  // Only raster bytes returned by the bounded main-process reader may enter img.src.
  const raster=value=>typeof value==='string'&&value.length<=3*1024*1024&&/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
  const localImage=(value,item)=>typeof value==='string'&&value.startsWith(`adh-case://local/${encodeURIComponent(item.id)}/images/`)&&/^adh-case:\/\/local\/[a-z0-9_-]+\/images\/[a-z0-9_-]+(?:\?thumbnail=1)?$/i.test(value);
  const previewObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){previewObserver.unobserve(entry.target);const item=state.data?.cases.find(c=>c.id===entry.target.dataset.caseId);if(item)requestPreview(item);}}, {rootMargin:'160px'});

  function requestPreview(item,refresh=false,moreImages=false) {
    if(!validUrl(item.sourceUrl))return Promise.resolve(null);
    const key=previewKey(item);
    if(state.previewPending.has(key))return state.previewPending.get(key);
    if(!refresh&&!moreImages&&state.previews.has(key))return Promise.resolve(state.previews.get(key));
    let done;const pending=new Promise(resolve=>{done=resolve;});state.previewPending.set(key,pending);
    const work={item,key,refresh,moreImages,done,pending,...capture()};if(item.id===state.selectedId)state.previewQueue.unshift(work);else state.previewQueue.push(work);
    updateCardPreview(item);if(isOpen()&&current()?.id===item.id)renderPreview();drainPreviews();return pending;
  }
  function drainPreviews() {
    while(state.previewActive<2&&state.previewQueue.length){
      const work=state.previewQueue.shift();if(!isCurrent(work)){work.done(null);continue;}state.previewActive++;
      (async()=>{
        let result;
        try{if(!api?.casePreview)throw new Error('当前窗口仍在运行旧版本，请保存后重启 AIDesignHub 以加载预览接口。');result=await api.casePreview(work.item.id,{refresh:work.refresh,moreImages:work.moreImages});}
        catch(error){result={status:'unavailable',error:error?.message||'页面读取未完成，请稍后刷新。',images:[]};}
        if(!isCurrent(work)){work.done(null);return;}
        result={...result,images:(result?.images||[]).filter(image=>raster(image.dataUrl)||localImage(image.dataUrl,work.item)).slice(0,result?.local?600:24)};
        state.previews.set(work.key,result);if(state.previewPending.get(work.key)===work.pending)state.previewPending.delete(work.key);
        // Keep a bounded session cache; large galleries do not accumulate forever.
        let cacheBytes=[...state.previews.values()].reduce((total,p)=>total+(p.images||[]).reduce((n,i)=>n+i.dataUrl.length,0),0);
        for(const key of state.previews.keys()){if(state.previews.size<=16&&cacheBytes<=48*1024*1024)break;if(key!==work.key&&!key.startsWith(`${state.projectId}|${state.selectedId}|`)){cacheBytes-=(state.previews.get(key).images||[]).reduce((n,i)=>n+i.dataUrl.length,0);state.previews.delete(key);}}
        const latest=state.data?.cases.find(item=>item.id===work.item.id);
        if(latest&&previewKey(latest)===work.key){updateCardPreview(latest);if(isOpen()&&state.selectedId===latest.id){$('caseModalTitle').textContent=displayTitle(latest,result);renderPreview();}}
        work.done(result);
      })().finally(()=>{state.previewActive--;drainPreviews();});
    }
  }
  function setPreviewPane(pane) {
    state.previewPane=pane;
    for(const button of document.querySelectorAll('[data-case-pane]'))button.setAttribute('aria-selected',String(button.dataset.casePane===pane));
    for(const [id,name] of [['caseArticlePanel','article'],['caseImagesPanel','images'],['caseFactsPanel','facts']])if($(id))$(id).hidden=name!==pane;
  }
  function renderArticle() {
    const item=current(),panel=$('caseArticlePanel');if(!item||!panel)return;
    const article=state.articles.get(previewKey(item)),loading=state.articlePending.has(previewKey(item));
    const collecting=loading||['collecting','queued','fetching'].includes(article?.status),available=article?.available&&typeof article.url==='string'&&article.url.startsWith(`adh-case://local/${encodeURIComponent(item.id)}/index.html?`);
    const frame=$('caseArticleFrame');
    if(available){if(frame.getAttribute('src')!==article.url)frame.src=article.url;frame.hidden=false;frame.dataset.caseId=item.id;}
    else{frame.hidden=true;if(frame.dataset.caseId!==item.id){frame.removeAttribute('src');frame.dataset.caseId=item.id;}}
    const count=collecting?Math.max(article?.assetCount||0,item.imageArchive?.savedCount||0):article?.assetCount??article?.imageCount??item.imageArchive?.savedCount??0,missing=article?.missingCount??article?.failedCount??0;
    $('caseArticleStatus').textContent=collecting?`正在保存完整文章与原图${count?`，已保存 ${count} 张`:''}…`:available?`文章与 ${count} 张原图已保存在本地${missing?`，${missing} 张图片未完成`:''}。`:article?.error||article?.message||(api?.caseArticle?'正在准备本地文章…':'当前版本尚未提供本地网页阅读，可查看已提取的正文。');
    $('casePreviewFallbackText').hidden=Boolean(available||collecting);
    const failures=Array.isArray(article?.failures)?article.failures:[];
    $('caseArticleFailures').hidden=!failures.length;$('caseArticleFailureList').replaceChildren(...failures.slice(0,600).map(value=>el('p','',typeof value==='string'?value:[value.url||value.sourceUrl,value.message||value.error||'图片未能下载'].filter(Boolean).join('：'))));
    $('casePreviewRefresh').textContent=collecting?'保存中…':'更新本地副本';$('casePreviewRefresh').disabled=collecting||!validUrl(item.sourceUrl);
    if(article||loading)$('casePreviewNotice').textContent=collecting?`原图保存中${count?` · ${count} 张`:''}`:available?`已保存本地 · ${count} 张原图${missing?` · ${missing} 张未完成`:''}`:article?.error||'本地副本尚未完成';
    if(article)$('casePreviewNotice').classList.toggle('is-error',Boolean(article.error));
    setPreviewPane(state.previewPane);
  }
  function requestArticle(item,refresh=false,check=false) {
    if(!api?.caseArticle)return Promise.resolve(null);
    const key=previewKey(item);if(state.articlePending.has(key))return state.articlePending.get(key);
    const previous=state.articles.get(key);
    if(!refresh&&!check&&previous?.available&&!['collecting','queued','fetching'].includes(previous.status))return Promise.resolve(previous);
    const operation=capture();
    const pending=Promise.resolve().then(()=>api.caseArticle(item.id,{refresh})).then(result=>{
      if(!isCurrent(operation))return null;
      state.articles.set(key,result);
      if(result.available&&(!previous?.available||previous.url!==result.url))void requestPreview(item,false,true);
      return result;
    }).catch(error=>{if(isCurrent(operation))state.articles.set(key,{...(previous||{}),status:'failed',error:error?.message||'本地文章保存未完成，可点击更新重试。'});return null;}).finally(()=>{
      if(state.articlePending.get(key)===pending)state.articlePending.delete(key);
      if(!isCurrent(operation)||!isOpen()||current()?.id!==item.id)return;
      renderArticle();clearTimeout(state.articleTimer);
      if(['collecting','queued','fetching'].includes(state.articles.get(key)?.status))state.articleTimer=setTimeout(()=>{if(isCurrent(operation)&&isOpen()&&current()?.id===item.id)void requestArticle(item,false,true);},1800);
    });
    state.articlePending.set(key,pending);renderArticle();return pending;
  }
  function updateCardPreview(item) {
    const card=cardFor(item.id);if(!card)return;const preview=previewFor(item);const loading=state.previewPending.has(previewKey(item));
    const cover=card.querySelector('.case-cover');cover.replaceChildren();cover.classList.toggle('is-loading',loading&&!preview);
    const byName=item.research?.mode==='name';const researching=byName&&processing.has(item.research?.status)&&!validUrl(item.sourceUrl);
    const fallback=el('div','case-cover-fallback');fallback.append(el('strong','',researching?'AI 正在查找项目资料':byName&&item.research.status==='needs_clarification'?'需要确认具体项目':loading?'正在读取项目图片':preview?.error?'图片暂不可用':validUrl(item.sourceUrl)?'暂无可用项目图片':byName?'尚未确认公开来源':'尚未添加来源链接'),el('small','',researching?'来源确认后自动加载项目图片':loading?'从原网页加载预览':validUrl(item.sourceUrl)?'点击查看项目资料与原文':'点击查看已保存的项目资料'));cover.append(fallback);
    const image=preview?.images?.[0];
    if(image){const img=el('img','case-cover-image');img.alt=image.alt||displayTitle(item,preview);img.decoding='async';img.src=image.dataUrl;img.addEventListener('error',()=>{img.remove();cover.dataset.imageFailed='true';fallback.querySelector('strong').textContent='图片未能显示';fallback.querySelector('small').textContent='点击查看正文或打开原始来源';},{once:true});cover.append(img);}
    const hint=el('span','case-cover-open',preview?.images?.length?`${preview.imageCandidateCount||preview.images.length} 张图片 · 查看项目 ↗`:'查看项目 ↗');cover.append(hint);
    card.querySelector('h3').textContent=displayTitle(item,preview);card.setAttribute('aria-label',`预览案例：${displayTitle(item,preview)}`);
    card.querySelector('.case-card-description').textContent=(byName?item.notes||preview?.description:preview?.description||item.notes)||(researching?`正在调研：${item.research.query}`:loading?'正在提取网页简介…':validUrl(item.sourceUrl)?'点击卡片查看网页正文、项目图片和调研依据。':'尚无网页预览，已保留现有项目资料。');
  }
  function renderPreview() {
    const item=current();if(!item)return;const preview=previewFor(item);const loading=state.previewPending.has(previewKey(item));const hasUrl=Boolean(validUrl(item.sourceUrl));
    $('casePreviewRefresh').disabled=loading||!hasUrl;$('casePreviewRefresh').textContent=loading?'读取中…':'刷新预览';
    $('casePreviewMore').hidden=!preview?.hasMoreImages;$('casePreviewMore').disabled=loading;$('casePreviewMore').textContent=loading?'正在加载…':'加载更多项目图片';
    $('casePreviewGalleryNote').textContent=preview?.galleryLimitReached?'已达到本地预览容量上限，其余图片请打开原始来源。':preview?.hasMoreImages?`分批加载图片，当前 ${preview.images.length} 张。`:'更多原站内容可通过上方原始来源查看。';
    $('casePreviewNotice').textContent=loading?'正在读取原网页与图片…':preview?.error||(!hasUrl?'此案例尚未记录原始链接。':preview?.images?.length?`${preview.images.length} 张项目图片 · ${date(preview.retrievedAt)} 更新`:preview?'正文已读取；未找到可用图片。':'点击刷新读取预览。');
    $('casePreviewNotice').classList.toggle('is-error',Boolean(preview?.error));
    $('casePreviewSummary').textContent=preview?.description||item.notes||'暂无项目简介。';
    $('casePreviewPageTitle').textContent=preview?.title||'';$('casePreviewPageTitle').hidden=!preview?.title||preview.title===$('caseModalTitle').textContent;
    const text=preview?.text||'';const textNode=$('casePreviewText');
    if(textNode.dataset.previewKey!==previewKey(item)||textNode.dataset.retrievedAt!==String(preview?.retrievedAt||0)||textNode.dataset.status!==String(preview?.status||'loading')){
      textNode.replaceChildren();
      if(text){for(const paragraph of text.split(/\n+/).filter(line=>line.trim()))textNode.append(el('p','',paragraph));}
      else textNode.append(el('p','case-preview-empty',loading?'正在读取网页正文…':hasUrl?'暂时无法读取正文，可刷新重试或打开原始来源。':'没有原始链接，无法生成网页预览。下方仍可查看已保存的项目资料。'));
      textNode.dataset.previewKey=previewKey(item);textNode.dataset.retrievedAt=String(preview?.retrievedAt||0);textNode.dataset.status=String(preview?.status||'loading');
    }
    $('casePreviewTextMeta').textContent=text?`${text.length.toLocaleString('zh-CN')} 字符 · ${preview.textTruncated?'正文已截取，请查看原始来源':'只读提取'}`:'';
    renderArticle();
    const media=$('casePreviewMedia');media.replaceChildren();const images=preview?.images||[];
    if(!images.length){const empty=el('div','case-gallery-empty');empty.append(el('strong','',loading?'正在加载项目图片…':'暂无可用项目图片'),el('p','',loading?'图片将来自你保存的原始链接':'页面可能没有公开图片，或图片服务器拒绝了读取。'));media.append(empty);return;}
    state.galleryIndex=Math.min(state.galleryIndex,images.length-1);const selected=images[state.galleryIndex];
    const figure=el('figure','case-preview-figure');const img=el('img','case-preview-image');img.alt=selected.alt||displayTitle(item,preview);img.src=localImage(selected.originalUrl,item)?selected.originalUrl:selected.dataUrl;
    img.addEventListener('error',()=>{img.replaceWith(el('div','case-gallery-empty','这张图片未能显示，请选择其他图片或打开原始来源。'));},{once:true});figure.append(img);
    const caption=el('figcaption');caption.append(el('span','',selected.alt||'原网页项目图片'),sourceLink(selected.sourceUrl,'图片来源 ↗'));figure.append(caption);media.append(figure);
    if(images.length>1){const strip=el('div','case-preview-thumbnails');strip.setAttribute('aria-label','选择项目图片');images.forEach((image,index)=>{const button=el('button',index===state.galleryIndex?'is-active':'');button.type='button';button.setAttribute('aria-label',`查看第 ${index+1} 张项目图片`);button.setAttribute('aria-pressed',String(index===state.galleryIndex));const thumb=el('img');thumb.alt='';thumb.src=image.dataUrl;button.append(thumb);button.addEventListener('click',()=>{state.galleryIndex=index;renderPreview();$('casePreviewMedia').querySelectorAll('.case-preview-thumbnails button')[index]?.focus({preventScroll:true});});strip.append(button);});media.append(strip);}
  }

  function validUrl(value) {
    try{const url=new URL(String(value||''));return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
  }
  function sourceLink(value,label='原始来源 ↗') {
    const url=validUrl(value);
    if(!url)return el('span','case-source-missing','未提供可打开的 HTTP(S) 来源');
    const link=el('a','case-source-link',label);link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.title=url;
    const open=event=>{event.preventDefault();if(event.type==='auxclick'&&event.button!==1)return;const operation=capture();if(!api?.openExternalUrl){notice('当前版本没有安全打开来源的接口。',true);return;}Promise.resolve(api.openExternalUrl(url)).catch(error=>{if(isCurrent(operation))showError(error.message);});};
    link.addEventListener('click',open);link.addEventListener('auxclick',open);return link;
  }
  function field(item,key) {
    if(item.research){const found=item.research.fields?.[key];return found&&typeof found==='object'?found:{value:null,quote:null,sourceUrl:null,status:'not_found'};}
    return {value:item[key]??null,quote:null,sourceUrl:item.sourceUrl||null,status:'legacy'};
  }
  function verification(item,data) {return data.value===null||data.value===undefined||data.value===''?'未找到':item.research?.status==='verified'?'已人工确认':'待核实';}
  function showError(message) {notice(message||'操作未完成。',true);if($('caseModal').classList.contains('is-open')){$('caseDetailError').hidden=false;$('caseDetailError').textContent=message||'操作未完成。';}}
  async function action(button,callback,key=button.id) {
    if(state.busy.has(key))return;const operation=capture();state.busy.set(key,operation);button.disabled=true;
    try{return await callback(operation);}catch(error){if(isCurrent(operation))showError(error?.message||'操作未完成，请重试。');}
    finally{if(state.busy.get(key)===operation){state.busy.delete(key);if(isCurrent(operation)){if(button.isConnected)button.disabled=false;if(button.id==='caseRetryButton'&&processing.has(current()?.research?.status))button.disabled=true;}}}
  }
  function modeLabel(item) {
    if(!item)return '仅提取页面';
    return isAutomatic(item)?`${item.label} · 主动派单（需验证）`:item.mode==='handoff'?`${item.label} · 人工文件交接`:`${item.label} · 等待外部 Agent`;
  }
  function noteConnection() {
    $('casePageOnly').checked=true;
    $('caseCollectConnection').disabled=true;$('caseCollectConnection').required=false;
    $('caseCollectSubmit').textContent='收集案例';
    $('caseCollectSubmit').disabled=state.busy.has('caseCollectSubmit');
  }
  function setCollectMode(mode){
    if(mode!=='link'){handOff('research',[], $('caseCollectQuery').value.trim());return;}
    state.collectMode='link';const byName=false;$('casePageOnly').checked=true;
    $('caseModeName').setAttribute('aria-pressed',String(byName));$('caseModeLink').setAttribute('aria-pressed',String(!byName));
    $('caseNameField').hidden=!byName;$('caseCollectQuery').disabled=!byName;$('caseCollectQuery').required=byName;
    $('caseUrlField').hidden=byName;$('caseCollectUrl').disabled=byName;$('caseCollectUrl').required=!byName;
    $('casePageOnlyChoice').hidden=byName;$('casePageOnly').disabled=byName;
    $('caseCollectorTitle').textContent='保存案例链接';
    const previous=$('caseCollectConnection').value;fillConnections($('caseCollectConnection'));
    if(!byName&&previous==='__local__')$('casePageOnly').checked=true;
    noteConnection();
  }
  function fillConnections(select,allowPageOnly=false) {
    const previous=select.value;
    const usable=state.connections.find(item=>(['cli','acp'].includes(item.mode)&&item.command)||(item.mode==='openclaw-http'&&item.endpoint));
    const items=allowPageOnly
      ?[{id:'',label:'仅提取页面，不调用 Agent'},...state.connections]
      :state.collectMode==='name'?[{id:'__local__',label:'本机 · 内置模型整理（未联网核验）',local:true},...state.connections]:[{id:'',label:'仅采集页面和图片，不调用 Agent'},...state.connections];
    select.replaceChildren(...items.map(item=>{const option=el('option','',item.local?item.label:(item.id?modeLabel(item):item.label));option.value=item.id;return option;}));
    if(items.some(item=>item.id===previous))select.value=previous;
    else if(!allowPageOnly)select.value=state.collectMode==='name'?(usable?.id||'__local__'):(previous==='__local__'?'':usable?.id||'');
  }
  async function refreshConnections() {
    if(!api?.agentSnapshot)return;
    if(state.loadingConnections)return state.loadingConnections;
    const operation=capture();
    const loading=(async()=>{const snapshot=await api.agentSnapshot();if(!isCurrent(operation)||(state.projectId&&snapshot.projectId&&snapshot.projectId!==state.projectId))return;state.connections=snapshot.connections||[];fillConnections($('caseCollectConnection'));fillConnections($('caseRetryConnection'),true);noteConnection();})();
    state.loadingConnections=loading;
    try{await loading;}catch(error){if(isCurrent(operation))throw error;}finally{if(state.loadingConnections===loading)state.loadingConnections=null;}
  }
  function buildCaseCard(item) {
    const article=el('article','case-card case-research-card');article.dataset.caseId=item.id;article.tabIndex=0;article.setAttribute('role','button');article.setAttribute('aria-controls','caseModal');article.setAttribute('aria-expanded',String(isOpen()&&state.selectedId===item.id));article.classList.toggle('is-selected',isOpen()&&state.selectedId===item.id);
    article.addEventListener('click',event=>{if(!event.target.closest('a,button,input,label,select,textarea'))openDetail(item.id);});
    article.addEventListener('keydown',event=>{if(event.target===article&&['Enter',' '].includes(event.key)){event.preventDefault();openDetail(item.id);}});
    const cover=el('div','case-cover');
    const choose=el('label','case-select-choice');const checkbox=el('input');checkbox.type='checkbox';checkbox.dataset.caseSelect=item.id;checkbox.checked=state.selectedCases.has(item.id);checkbox.setAttribute('aria-label',`选择案例：${item.name||'未命名案例'}`);checkbox.addEventListener('change',()=>{if(checkbox.checked)state.selectedCases.add(item.id);else state.selectedCases.delete(item.id);renderSelection();});choose.append(checkbox,el('span','','选择'));article.classList.toggle('is-chosen',checkbox.checked);
    const body=el('div','case-body');const badge=el('span','agent-status case-research-state',statusLabel(item.research));badge.dataset.status=item.research?.status||'legacy';
    body.append(badge,el('h3','',item.name||'项目名称未找到'),el('p','',`${valueText(field(item,'location').value)} · ${valueText(field(item,'designer').value)}`),el('small','case-data-verification',item.research?.status==='verified'?'字段已人工确认':'字段待核实'));
    body.append(el('p','case-card-description'));
    const metrics=el('dl','case-fact-summary');for(const key of ['typeLabel','area']){const row=el('div');const data=field(item,key),fullValue=valueText(data.value),limit=key==='typeLabel'?44:56;const value=el('dd','',fullValue.length>limit?`${fullValue.slice(0,limit)}…`:fullValue);value.title=fullValue;row.append(el('dt','',fieldNames[key]),value);metrics.append(row);}body.append(metrics);
    const tags=el('div','case-tags');for(const tag of item.tags||[])tags.append(el('span','',tag));body.append(tags);
    if(item.research?.status==='waiting_agent')body.append(el('p','case-waiting-note','已保存页面，等待外部 Agent 接入并认领；尚无 AI 调研结论。'));
    if(item.imageArchive)body.append(el('p','case-waiting-note',item.imageArchive.status==='collecting'?`图片归档中：已保存 ${item.imageArchive.savedCount||0} / ${item.imageArchive.discoveredCount||0} 张`:`本地原图：${item.imageArchive.savedCount||0} 张${item.imageArchive.failedCount?`，${item.imageArchive.failedCount} 张未完成`:''}`));
    if(item.research?.error)body.append(el('p','case-card-error',item.research.error));
    const meta=el('div','case-meta');meta.append(sourceLink(item.sourceUrl));const buttons=el('span','case-card-actions');
    const details=el('button','text-button','查看项目 ↗');details.type='button';details.dataset.caseDetail=item.id;details.addEventListener('click',()=>openDetail(item.id));
    const remove=el('button','text-button','删除');remove.type='button';remove.dataset.caseRemove=item.id;
    buttons.append(details,remove);meta.append(buttons);body.append(meta);article.append(choose,cover,body);return article;
  }
  function caseSection(title,items,emptyText) {
    const section=el('section','resource-section case-tier');
    const heading=el('h3','',title);heading.append(el('span','hub-muted',` ${items.length} 个`));
    section.append(heading);
    if(items.length){const grid=el('div','case-grid-inner');grid.append(...items.map(buildCaseCard));section.append(grid);}
    else section.append(el('p','hub-muted',emptyText));
    return section;
  }
  function renderCards(cases,data) {
    if(state.projectId&&data?.project?.id!==state.projectId)return;
    if(!state.projectId)state.projectId=data?.project?.id||null;
    state.data=data;
    previewObserver.disconnect();
    const localCases=cases.filter(item=>item.scope!=='team'),teamCases=cases.filter(item=>item.scope==='team');
    $('caseGrid').replaceChildren(
      ...(localCases.length?[caseSection('已收集',localCases,'')]:[]),
      ...(teamCases.length?[caseSection('团队共享',teamCases,'')]:[]),
    );
    for(const item of cases){updateCardPreview(item);if(validUrl(item.sourceUrl))previewObserver.observe(cardFor(item.id));}
    if(!cases.length){const empty=el('article','card case-empty');empty.append(el('h2','','暂时没有匹配的案例'),el('p','','粘贴链接保存案例，或让 ADH 根据当前项目寻找参考。'));$('caseGrid').append(empty);}
    renderSelection();
    if(isOpen()){if(current())renderDetail();else closeDetail();}
  }
  function openDetail(id) {
    const switching=state.selectedId!==id;state.selectedId=id;const item=current();if(!item)return;
    state.returnFocus=cardFor(id)||document.activeElement;if(switching){state.galleryIndex=0;state.previewPane='article';clearTimeout(state.articleTimer);$('caseModal').querySelector('.case-preview-body').scrollTop=0;}
    if(state.retryCaseId!==id){state.retryCaseId=id;$('caseRetryConnection').value=item.research?.connectionId||'';$('caseRetryQuery').value=item.research?.query||'';}
    renderDetail();$('caseModal').classList.add('is-open');$('caseModal').setAttribute('aria-hidden','false');
    for(const card of allCards()){const selected=card.dataset.caseId===id;card.classList.toggle('is-selected',selected);card.setAttribute('aria-expanded',String(selected));}
    $('caseModal').querySelector('[data-close-modal]').focus({preventScroll:true});requestPreview(item);void requestArticle(item);
  }
  function closeDetail(restoreFocus=true) {
    clearTimeout(state.articleTimer);
    const wasOpen=isOpen();$('caseModal').classList.remove('is-open','is-expanded');$('caseModal').setAttribute('aria-hidden','true');$('casePreviewExpand').setAttribute('aria-expanded','false');$('casePreviewExpand').textContent='展开阅读';
    for(const card of allCards()){card.classList.remove('is-selected');card.setAttribute('aria-expanded','false');}
    if(wasOpen&&restoreFocus)(cardFor(state.selectedId)||(state.returnFocus?.isConnected?state.returnFocus:$('caseSearch')))?.focus({preventScroll:true});
  }
  function renderDetail() {
    const item=current();if(!item)return;const research=item.research;
    $('caseModalTitle').textContent=displayTitle(item,previewFor(item));renderPreview();
    $('caseDetailStatus').textContent=statusLabel(research);$('caseDetailStatus').dataset.status=research?.status||'legacy';
    $('caseDetailMeta').textContent=research?(research.mode==='local'?`本机内置模型整理 · ${research.localNote||'未联网核验来源，请自行核对'} · 调研版本 ${research.revision||1}`:`${research.mode==='name'?`检索：${research.query} · `:''}读取：${date(research.retrievedAt)} · 调研版本 ${research.revision||1}`):'现有资料保留；未提供字段级来源证据。';
    $('caseDetailOriginal').replaceChildren(sourceLink(item.sourceUrl,'原始来源 ↗'),el('span','',item.sourceUrl||'未记录原始链接'));
    const archive=item.imageArchive,sessionId=archive?.sessionId,articleId=archive?.articleId;
    const collectImages=el('button','secondary-button',sessionId||articleId?`查看归档图片（${archive.savedCount||0}/${archive.discoveredCount||0}）`:'采集全部网页原图');collectImages.type='button';collectImages.id='caseCollectImages';collectImages.disabled=!validUrl(item.sourceUrl);collectImages.title=collectImages.disabled?'请先为案例添加公开来源链接':sessionId||articleId?'查看已保存的原图、来源和未完成记录':'发现整篇文章的图片并保存可获取的最高分辨率版本';
    collectImages.addEventListener('click',()=>{if(!window.aidesignImageCollection){notice('请重启 AIDesignHub 以加载图片采集工作台。',true);return;}const context={projectId:state.projectId,caseId:item.id,sourceUrl:item.sourceUrl,title:displayTitle(item,previewFor(item)),sessionId,articleId,collectAll:!sessionId&&!articleId};closeDetail(false);window.aidesignImageCollection.open(context);});$('caseDetailOriginal').append(collectImages);
    if(archive)$('caseDetailOriginal').append(el('small','agent-field-note',archive.status==='collecting'?`图片归档中：${archive.savedCount||0}/${archive.discoveredCount||0} 张；Agent 调研不影响图片保存。`:`图片归档：已保存 ${archive.savedCount||0} 张，未完成 ${archive.failedCount||0} 张${archive.truncated?'；页面图片超过本次上限':''}${archive.error?`；${archive.error}`:''}。`));
    $('caseDetailError').hidden=!research?.error;$('caseDetailError').textContent=research?.error||'';
    const candidates=Array.isArray(research?.candidates)?research.candidates:[];
    $('caseMatchCandidates').hidden=!candidates.length;$('caseMatchCandidates').replaceChildren();
    if(candidates.length){$('caseMatchCandidates').append(el('h3','','可能匹配的项目'));for(const candidate of candidates){const row=el('div');row.append(el('strong','',candidate.name||'候选项目'),el('p','',candidate.description||''));if(validUrl(candidate.url))row.append(sourceLink(candidate.url,'查看候选来源 ↗'));$('caseMatchCandidates').append(row);}if(research.status==='needs_clarification')$('caseMatchCandidates').append(el('p','agent-field-note','请在下方补充城市、设计方或具体项目名称后重新调研，不会自动把同名项目合并。'));}
    $('caseDetailFields').replaceChildren(...Object.entries(fieldNames).map(([key,label])=>{
      const data=field(item,key);const section=el('section','case-evidence-field');section.dataset.caseField=key;
      const heading=el('header');heading.append(el('h3','',label),el('span','case-field-verification',verification(item,data)));
      section.append(heading,el('p','case-field-value',valueText(data.value)));
      section.append(el('blockquote','',data.quote||'未提供支持该字段的原文摘录。'));
      if(data.sourceUrl)section.append(sourceLink(data.sourceUrl,'查看字段来源 ↗'));
      if(data.status==='unsupported')section.append(el('small','case-evidence-warning','执行器提供了值，但没有可支持该值的来源证据。'));
      if(data.status==='needs_verification')section.append(el('small','case-evidence-warning','引文仍需打开来源核对，不能视为已验证。'));
      return section;
    }));
    $('caseDetailNotes').textContent=item.notes||'尚无调研摘要。';
    $('caseDetailNotesHeading').textContent=item.research?.status==='verified'?'调研摘要 · 已人工确认':'调研摘要 · 待核实';
    const sources=[...(research?.sources||[])];if(research?.finalUrl&&!sources.some(source=>source.url===research.finalUrl))sources.push({url:research.finalUrl,title:'页面最终地址'});
    $('caseDetailSources').replaceChildren(...sources.map(source=>{const row=el('div');row.append(sourceLink(source.url,`${source.title||'来源页面'} ↗`),el('small','',source.url));if(source.error)row.append(el('small','case-evidence-warning',`工作台未能读取：${source.error}`));else if(source.retrievedAt)row.append(el('small','',`工作台读取：${date(source.retrievedAt)}；字段仍以原文证据为准。`));return row;}));
    if(!sources.length)$('caseDetailSources').append(el('p','agent-field-note','未记录额外来源。'));
    $('caseRetryButton').hidden=true;$('caseRetryConnection').disabled=true;$('caseRetryConnection').closest('label').hidden=true;
    if(!$('caseSendToAdh')){const send=el('button','secondary-button','交给 ADH 分析');send.type='button';send.id='caseSendToAdh';send.addEventListener('click',()=>{const chosen=current();if(chosen)handOff('presentation',[chosen.id]);});$('caseRetryButton').parentElement.prepend(send);}
    $('caseShowRun').hidden=!research?.runId;
    $('caseReviewActions').hidden=!['page_extracted','awaiting_review'].includes(research?.status);
    updateRetryControls(item);
  }
  function updateRetryControls(item){
    $('caseRetryQueryField').hidden=true;$('caseRetryNote').hidden=true;
  }
  function focusCollector() {$('caseCollectorPanel').scrollIntoView({block:'center',behavior:'smooth'});$(state.collectMode==='name'?'caseCollectQuery':'caseCollectUrl').focus({preventScroll:true});}
  window.aidesignCaseUI=Object.freeze({render:renderCards,openDetail,closeDetail,focusCollector,handOff,getSelection:()=>({projectId:state.projectId,caseIds:[...state.selectedCases]})});
  $('caseSelectionClear').addEventListener('click',()=>{state.selectedCases.clear();renderSelection();});
  $('caseSelectionSend').addEventListener('click',()=>handOff('presentation',[...state.selectedCases],`先判断所选案例与当前项目是否适合对标，再阅读合适案例的完整资料和原图，制作案例研究 PPT，使用${pptStyle()}固定版式，并保留来源。`));
  $('casePreviewRefresh').addEventListener('click',()=>{const item=current();if(item){if(api?.caseArticle)void requestArticle(item,true);else requestPreview(item,true);}});
  for(const button of document.querySelectorAll('[data-case-pane]'))button.addEventListener('click',()=>setPreviewPane(button.dataset.casePane));
  $('casePreviewMore').addEventListener('click',()=>{const item=current();if(item)requestPreview(item,false,true);});
  $('casePreviewExpand').addEventListener('click',event=>{const expanded=$('caseModal').classList.toggle('is-expanded');event.currentTarget.setAttribute('aria-expanded',String(expanded));event.currentTarget.textContent=expanded?'收起阅读':'展开阅读';});
  $('casePageOnly').addEventListener('change',noteConnection);$('caseCollectConnection').addEventListener('change',noteConnection);
  $('caseModeName').addEventListener('click',()=>setCollectMode('name'));$('caseModeLink').addEventListener('click',()=>setCollectMode('link'));
  $('caseCollectQuery').addEventListener('input',()=>{if(state.collectMode!=='name')return;const url=validUrl($('caseCollectQuery').value.trim());if(!url)return;$('caseCollectUrl').value=url;$('caseCollectQuery').value='';setCollectMode('link');$('caseCollectUrl').focus();notice('已识别为公开链接，已切换到链接采集模式。');});
  $('caseRetryQuery').addEventListener('input',()=>{const item=current();if(item)updateRetryControls(item);});
  $('caseCollectForm').addEventListener('submit',event=>{event.preventDefault();action($('caseCollectSubmit'),async operation=>{
    if(!api?.caseCollect)throw new Error('当前桌面版本尚未提供案例采集接口，请重启到更新后的主进程。');
    const original=$('caseCollectUrl').value.trim();
    if(!validUrl(original))throw new Error('请输入不含用户名或密码的完整 HTTP(S) 公开页面链接。');
    if(!state.data){const data=await api.bootstrap();if(!isCurrent(operation)||(operation.projectId&&data.project?.id!==operation.projectId))return;state.data=data;state.projectId=data.project.id;operation.projectId=data.project.id;}
    if(!isCurrent(operation))return;
    const scope=$('caseCollectScope')?.value==='team'?'team':'local';
    if(!isCurrent(operation))return;
    const item=await api.caseCollect({projectId:operation.projectId,url:original,connectionId:null,scope});
    if(!isCurrent(operation)||(item.projectId&&item.projectId!==operation.projectId))return;
    $('caseSearch').value='';$('caseSearch').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-case-filter="all"]')?.click();
    $('caseCollectUrl').value='';changed();notice(item.research?.status==='queued'||item.research?.status==='fetching'?'正在保存文章和可获取的图片。':'该链接已收集，已保留现有资料。');
  }).finally(noteConnection);});
  $('caseRetryButton').addEventListener('click',()=>{const item=current();if(item)handOff('research',[item.id],$('caseRetryQuery').value.trim());});
  for(const [id,approved] of [['caseApproveButton',true],['caseRejectButton',false]])$(id).addEventListener('click',event=>action(event.currentTarget,async operation=>{const item=current();if(!item)return;if(!window.confirm(approved?'确认已逐项打开来源、核对面积口径和开业时间？未找到的字段仍保留为空。':'将本次调研退回，补充证据后重新调研？'))return;if(!isCurrent(operation))return;await api.caseReview(item.id,{approved});if(!isCurrent(operation))return;changed();window.dispatchEvent(new Event('agent-hub-changed'));notice(approved?'案例字段已人工确认；未找到的数据不会被补猜。':'调研已退回，请核实来源后重试。');}));
  $('caseShowRun').addEventListener('click',()=>{const item=current();if(!item?.research?.runId)return;closeDetail(false);document.querySelector('[data-view="agents"]')?.click();window.dispatchEvent(new CustomEvent('agent-focus-run',{detail:{runId:item.research.runId}}));});
  let changeTimer;
  function resetProject(projectId){
    state.generation++;state.projectId=projectId||null;state.data=null;state.selectedId=null;state.selectedCases.clear();state.retryCaseId=null;state.galleryIndex=0;state.returnFocus=null;state.connections=[];state.loadingConnections=null;state.busy.clear();
    previewObserver.disconnect();clearTimeout(changeTimer);for(const work of state.previewQueue)work.done(null);state.previewQueue=[];state.previewPending.clear();state.previews.clear();
    clearTimeout(state.articleTimer);state.articles.clear();state.articlePending.clear();state.previewPane='article';if($('caseArticleFrame')){$('caseArticleFrame').removeAttribute('src');$('caseArticleFrame').hidden=true;}
    closeDetail(false);$('caseGrid').replaceChildren();
    for(const id of ['caseCollectQuery','caseCollectUrl','caseRetryQuery','caseSearch'])$(id).value='';
    for(const id of ['casePreviewMedia','casePreviewText','caseDetailFields','caseDetailSources','caseMatchCandidates'])$(id).replaceChildren();
    for(const id of ['casePreviewSummary','casePreviewPageTitle','casePreviewNotice','caseDetailNotes','caseDetailError','caseModalTitle','caseDetailMeta'])$(id).textContent='';
    $('casePageOnly').checked=true;$('caseRetryButton').disabled=false;$('caseApproveButton').disabled=false;$('caseRejectButton').disabled=false;
    fillConnections($('caseCollectConnection'));fillConnections($('caseRetryConnection'),true);setCollectMode('link');renderSelection();notice('已切换项目，案例选择已清空。');
    refreshConnections().catch(error=>notice(error.message,true));
  }
  window.addEventListener('hub-project-changed',event=>resetProject(event.detail?.projectId));
  const unsubscribe=typeof api?.caseOnChanged==='function'?api.caseOnChanged(()=>{const operation=capture();clearTimeout(changeTimer);changeTimer=setTimeout(()=>{if(isCurrent(operation)){changed();const item=current();if(isOpen()&&item)void requestArticle(item,false,true);}},100);}):null;
  window.addEventListener('agent-hub-changed',()=>refreshConnections().catch(error=>notice(error.message,true)));
  window.addEventListener('beforeunload',()=>{state.generation++;previewObserver.disconnect();clearTimeout(changeTimer);clearTimeout(state.articleTimer);for(const work of state.previewQueue)work.done(null);state.previewQueue=[];if(typeof unsubscribe==='function')unsubscribe();});
  setCollectMode('link');refreshConnections().catch(error=>notice(error.message,true));
})();
