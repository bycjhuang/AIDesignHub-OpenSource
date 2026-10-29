'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { LocalBackend } = require('../../backend/local-backend.cjs');
const { AgentHub } = require('../../backend/agent-hub.cjs');
const { ProjectHub } = require('../../backend/project-hub.cjs');
const { CaseResearchService } = require('../../backend/case-research.cjs');
const { ProjectResearchService } = require('../../backend/project-research.cjs');
const { ImageCollectionService } = require('../../backend/image-collection.cjs');
const { ResearchImageService } = require('../../backend/research-images.cjs');
const { AdhWorkbenchService } = require('../../backend/adh-workbench-service.cjs');

const a = 'https://architect.example.org/native-museum';
const b = 'https://design.example.org/native-museum';
function image(width, height, color) {
  const chunk = (type, bytes) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crcBytes = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, bytes])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ ((crc & 1) ? 0xedb88320 : 0); }
    crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, name, bytes, crcBytes]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, color); for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  return { bytes, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, contentType: 'image/png', width, height, byteLength: bytes.length };
}
function output() {
  return { summary: 'ADH 在本次对话中比较两个独立来源，阅读滨水美术馆资料。', sources: [{ url:a,title:'设计方项目原文' },{ url:b,title:'设计媒体项目原文' }],
    cases: [{ name:'滨水样例美术馆', area:'8000平方米', primarySourceUrl:a, sourceUrls:[a,b], summary:'阅读空间与公共步道围绕滨水庭院组织。',
      sources:[{url:a,imageUrls:[`${a}/courtyard.png`]},{url:b,imageUrls:[`${b}/gallery.png`]}],
      evidence:[{field:'name',value:'滨水样例美术馆',sourceUrl:a,quote:'项目名称：滨水样例美术馆'},{field:'area',value:'8000平方米',sourceUrl:b,quote:'建筑面积8000平方米'}],
      references:[{point:'公共步道连接文化庭院',application:'结合江湾的滨水公共界面复核步行节点。',limitation:'需核对岸线条件。',sourceUrls:[a,b]}] }],
    references:[{point:'公共开放与内部管理分区',application:'将江湾文化空间与滨水步道的分时开放边界一起研究。',limitation:'不能直接替代项目方案确认。',sourceUrls:[a,b]}] };
}
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'adh-native-backend-')), backend = new LocalBackend({dataDir:directory});
  const currentProjectId = backend.projectId(); let executionCalls=0, preflightCalls=0;
  const projectHub = new ProjectHub({backend});
  const hub = new AgentHub({backend,projectContext:id=>projectHub.context(id),execute:async()=>{executionCalls++;return {text:'外部协作测试回传',sessionId:'external-fixture'};}});
  const pictures = [image(1800,1080,120),image(1900,1140,210)];
  const fetchPage = options.fetchPage || (async (url,{signal}={})=>{
    signal?.throwIfAborted(); if(![a,b].includes(url))throw new Error('固定测试未授权该网页。');
    return {url,finalUrl:url,title:'滨水样例美术馆',text:'项目名称：滨水样例美术馆\n建筑面积8000平方米\n阅读空间与公共步道围绕滨水庭院组织。',retrievedAt:123,images:[{url:`${url}/${url===a?'courtyard':'gallery'}.png`,alt:'同一项目的滨水公共空间',contentScope:'article'}]};
  });
  const fetchImage = async url=>{const item=url.startsWith(a)?pictures[0]:url.startsWith(b)?pictures[1]:null;if(!item)throw new Error('固定测试图片地址无效。');return {...item,sourceUrl:url,finalUrl:url};};
  const cases = new CaseResearchService({backend,hub,fetchPage,fetchImage});
  const images = new ImageCollectionService({dataDir:directory,findCase:id=>backend.store.cases.find(item=>item.id===id),findProject:id=>backend.store.projects.find(item=>item.id===id),fetchPage,fetchImage});
  const research = new ProjectResearchService({backend,hub,cases,fetchPage,imageResearch:new ResearchImageService({collection:images,fetchPage}),projectContext:id=>projectHub.context(id)});
  const service = new AdhWorkbenchService({backend,hub,projectHub,cases,research,images,fetchPage,shell:{openPath:async()=>''},nativeImage:{createFromBuffer:()=>{throw new Error('PNG 资料不应要求格式转换。');}},beforeExternalDispatch:async()=>{preflightCalls++;}});
  const foreignId='project_other', foreignCase='case_foreign';
  backend.mutate(store=>{store.projects.push({id:foreignId,name:'另一项目',stage:'research'});store.members.push({id:'foreign_member',projectId:foreignId,name:'另一项目负责人',role:'pm',active:true});store.cases.push({id:foreignCase,projectId:foreignId,name:'另一项目案例',sourceUrl:a});return true;});
  const request=(action,args={},extra={})=>service.handle({action,sessionId:'adh_session_a',arguments:args,...extra});
  const archive=(sessionId='adh_session_a')=>request('research_archive',{title:'江湾的 ADH 原生研究',result:output()},{sessionId});
  const switchProject=(projectId=foreignId)=>backend.mutate(store=>{store.settings.currentProjectId=projectId;store.settings.currentMemberId=projectId===foreignId?'foreign_member':store.members.find(item=>item.projectId===projectId&&item.active!==false).id;return true;});
  const cleanup=async()=>{service.dispose();research.dispose();await research.idle();cases.dispose();images.dispose();hub.dispose();projectHub.dispose();const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('adh-native-backend-'))throw new Error('测试目录清理范围异常。');fs.rmSync(resolved,{recursive:true,force:true});};
  t.after(cleanup);
  return {directory,backend,hub,projectHub,cases,research,images,service,request,archive,switchProject,currentProjectId,foreignId,foreignCase,counts:()=>({executionCalls,preflightCalls})};
}
module.exports={a,b,output,setup};
