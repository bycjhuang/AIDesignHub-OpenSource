'use strict';
// The public site reuses the desktop renderer, never its preload or user data.
const fs = require('node:fs');
const path = require('node:path');
const {createDemoCompanyStore} = require('../backend/demo-company.cjs');
const {LocalBackend, seedStore} = require('../backend/local-backend.cjs');
const {TeamDirectory} = require('../backend/team-directory.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime', 'website-demo-20261030', 'dist');
fs.mkdirSync(output, {recursive:true});
const copy = (from, to=from) => { const target=path.join(output,to);fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(root,from),target,{recursive:true}); };
let html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const originals = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(match=>match[1]);
for(const file of new Set(originals)) copy(file);
for(const name of ['aidesignhub-icon.png','adh-brand-mark.png','aidesignhub-logo.png','release-identity.js','open-source-info.js']) copy('assets/'+name);
for(const name of ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.md']) copy(name,'licenses/'+name);
const store=createDemoCompanyStore();
store.demoCompany.initialized=true;
const example=seedStore();
store.cases=store.projects.flatMap(project=>example.cases.map((item,index)=>({...item,id:project.id+'_case_'+index,projectId:project.id,source:'网页阅读示例',sourceUrl:'https://aidesignhub.work/demo-case.html?'+new URLSearchParams({name:item.name}),scope:'local',isDemo:true,provenance:'synthetic_company_fixture'})));
const backend=Object.create(LocalBackend.prototype);backend.store=store;backend.dataDir='网页演示（仅此浏览器）';
const directory=new TeamDirectory({backend});
fs.writeFileSync(path.join(output,'demo-data.js'),'window.ADH_PUBLIC_FIXTURE='+JSON.stringify({store,directory:directory.snapshot()})+';\n');
for(const name of ['demo-bridge.js','toolbar.js','website.css','demo-topbar.css','product-matrix-menu.css','intro-video.js','intro-video.css','intro-media.json','intro-cover.jpg','canvas-mock.js','agent-mock.js','demo-case.html']) copy('web-public/'+name,name);
const introMedia=JSON.parse(fs.readFileSync(path.join(root,'web-public/intro-media.json'),'utf8'));
if(!/^\/media\/aidesignhub-intro-zh-[a-f0-9]{12}\.mp4$/.test(introMedia.url))throw new Error('Unexpected introduction media URL');
const toolbar=fs.readFileSync(path.join(root,'web-public/toolbar.html'),'utf8').replaceAll('{{INTRO_VIDEO_SRC}}',introMedia.url);
html=html.replace('<body>','<body>\n'+toolbar).replace('</head>','<link rel="stylesheet" href="website.css"><link rel="stylesheet" href="demo-topbar.css"><link rel="stylesheet" href="product-matrix-menu.css"><link rel="stylesheet" href="intro-video.css">\n</head>')
  .replace('<script src="case-ui.js">','<script src="demo-data.js"></script><script src="demo-bridge.js"></script><script src="toolbar.js"></script><script src="intro-video.js"></script>\n<script src="case-ui.js">')
  .replace(/<title>[^<]+<\/title>/,'<title>AI Design Hub · 在线工作台体验</title>');
// These changes apply to generated public copies only. The desktop loopback
// restriction and its IPC bridge stay intact.
let canvas=fs.readFileSync(path.join(output,'ai-design-ui.js'),'utf8');
canvas=canvas.replace("url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password", "url.origin !== location.origin || !['/home', '/canvas'].includes(url.pathname) || url.username || url.password");
fs.writeFileSync(path.join(output,'ai-design-ui.js'),canvas);
const casePath=path.join(output,'case-ui.js');
fs.writeFileSync(casePath,fs.readFileSync(casePath,'utf8').replace(
  'article.url.startsWith(`adh-case://local/${encodeURIComponent(item.id)}/index.html?`)',
  "article.url.startsWith(location.origin + '/demo-case.html?')"));
const setupPath=path.join(output,'setup-center-ui.js');
fs.writeFileSync(setupPath,fs.readFileSync(setupPath,'utf8')
  .replaceAll('所有项目共用本机配置。密钥在本机加密保存，不写入项目资料。','这是模型设置界面演示。请下载桌面版后配置，网页不保存模型密钥。')
  .replaceAll('会调用本页模型，可能消耗少量 API 额度。','网页演示不会调用模型，也不消耗额度。'));
fs.writeFileSync(path.join(output,'index.html'),html);
const canvasRoot='Loomic-main/Loomic-main/apps/web/out';
copy(canvasRoot,'design');
const discoveryCache=path.join(root,'.runtime/website-demo-20261030/discovery');
if(fs.existsSync(path.join(discoveryCache,'manifest.json'))){
  fs.cpSync(discoveryCache,path.join(output,'discovery'),{recursive:true});
  const replacements=JSON.parse(fs.readFileSync(path.join(discoveryCache,'manifest.json'),'utf8'));
  if(replacements.length!==16)throw new Error('Freeze all 16 discovery assets before building: python scripts/cache-public-demo-assets.py');
  const rewrite=dir=>{for(const row of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,row.name);if(row.isDirectory())rewrite(file);else if(row.name.endsWith('.js')){let text=fs.readFileSync(file,'utf8');for(const item of replacements)text=text.replaceAll(item.url,item.local);fs.writeFileSync(file,text);}}};
  rewrite(path.join(output,'design/_next'));
}
for(const file of fs.readdirSync(path.join(output,'design'))){
  if(!file.endsWith('.html')) continue;
  const target=path.join(output,'design',file);
  const content=fs.readFileSync(target,'utf8').replace('<head>','<head><script src="/canvas-mock.js"></script>');
  fs.writeFileSync(target,content);
}
const harness='.runtime/installer-resources/public/dsh-runtime/0.2.1-rc.2/package/node_modules/@deepseek-ai/dsh-web-frontend/dist';
copy(harness,'agent');
const agentIndex=path.join(output,'agent/index.html');
const {buildAgentBoot}=require('../web-public/agent-boot-builder.cjs');
copy('web-public/agent-mock.js','agent/agent-mock.js');
const agentBoot=buildAgentBoot({outputDir:path.join(output,'agent')});
let agentHtml=fs.readFileSync(agentIndex,'utf8').replace('<head>','<head><base href="/agent/">'+agentBoot.headHtml);
agentHtml=agentHtml.replace(/(["'])\/assets\//g,'$1/agent/assets/').replace(/(["'])\/favicon/g,'$1/agent/favicon');
fs.writeFileSync(agentIndex,agentHtml);
const packaged=require('node:child_process').spawnSync('python',[path.join(root,'scripts/package-public-demo-source.py'),path.join(output,'licenses/web-demo-source.zip')],{encoding:'utf8'});
if(packaged.status!==0)throw new Error('Public source packaging failed: '+packaged.stderr);
fs.writeFileSync(path.join(output,'licenses/index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Design Hub 开源信息</title><main style="max-width:760px;margin:60px auto;padding:24px;font:16px/1.8 system-ui"><h1>AI Design Hub 开源信息</h1><p>当前桌面安装包为 0.3.2；本网站是独立的前端演示。</p><ul><li><a href="https://github.com/bycjhuang/AIDesignHub-OpenSource/tree/v0.3.2">0.3.2 基础源码及构建说明</a></li><li><a href="web-demo-source.zip">网页演示补充源码与构建说明</a></li><li><a href="LICENSE">AGPL-3.0-only 许可证</a></li><li><a href="THIRD-PARTY-NOTICES.md">第三方声明</a></li><li><a href="../agent/HARNESS-LICENSE.txt">Harness MIT 许可证</a></li><li><a href="../agent/browser-plugin-notice.json">Harness 浏览器组件说明</a></li></ul><p>演示数据均为虚构；模型与工具调用不会在网页中执行。</p><a href="/">返回工作台</a></main></html>');
const files=[];
function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())visit(file);else if(file!==path.join(output,'build-manifest.json'))files.push({path:path.relative(output,file).replaceAll('\\','/'),bytes:fs.statSync(file).size});}}
visit(output);
const forbidden=files.filter(file=>/(?:^|\/)(?:preload\.cjs|store\.json|\.env|model-private|device-settings-v1|node_modules|[^/]+\.map)(?:\/|$)/.test(file.path));
if(forbidden.length)throw new Error('Public allowlist rejected: '+forbidden.map(file=>file.path).slice(0,5).join(', '));
fs.writeFileSync(path.join(output,'build-manifest.json'),JSON.stringify({version:'web-demo-20261030-v1',generatedAt:new Date().toISOString(),files},null,2));
console.log(JSON.stringify({output,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),originalRendererFiles:new Set(originals).size}));
