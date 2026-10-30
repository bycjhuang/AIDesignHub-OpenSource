/* Runs before the original canvas bundle. All /api requests are handled in this
   frame; generation and external network connections are unavailable. */
(() => {
  'use strict';
  const nativeFetch=window.fetch.bind(window);
  const hub=new URLSearchParams(location.search).get('hubProjectId')||'demo_project_riverfront';
  const key='adh-public-canvas-v1:'+hub;
  const labels={demo_project_riverfront:'江湾文化商业中心',demo_project_garden:'云栖庭院住宅社区',demo_project_culture:'青岚地方文化中心'};
  const date=new Date().toISOString();
  const workspace={id:'demo-workspace',name:'AI Design Hub 网页演示',type:'personal',ownerUserId:'hub-local-user'};
  const initial={id:'demo-canvas',name:'概念设计 · 方案比较',projectId:'demo-design-project',content:{elements:[],files:{},appState:{viewBackgroundColor:'#f8fafc',scrollX:0,scrollY:0,zoom:{value:0.8}}}};
  let canvas=initial;
  try{canvas=JSON.parse(localStorage.getItem(key))||initial;}catch{}
  const project={id:'demo-design-project',name:labels[hub]||'设计项目演示',description:'网页公开案例；真实生成请下载桌面版',slug:'demo',workspace,primaryCanvas:{id:canvas.id,name:canvas.name,updatedAt:date,thumbnailUrl:null},brand_kit_id:null,createdAt:date,updatedAt:date};
  let sessions=[{id:'demo-session',canvasId:canvas.id,title:'概念设计讨论（演示）',createdAt:date,updatedAt:date}];
  const viewer={profile:{id:'hub-local-user',email:'',displayName:'网页演示',avatarUrl:null},workspace,membership:{workspaceId:workspace.id,userId:'hub-local-user',role:'owner'}};
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const persist=()=>{try{localStorage.setItem(key,JSON.stringify(canvas));}catch{}};
  const json=async init=>{try{return JSON.parse(init?.body||'{}');}catch{return {};}};
  sessionStorage.setItem('loomic-hub-capability','public-demo');
  sessionStorage.setItem('loomic-hub-project',hub);
  window.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin);
    if(url.origin!==location.origin)return response({error:'网页演示仅加载本站资源。'},403);
    if(!url.pathname.startsWith('/api/'))return nativeFetch(input,init);
    const route=url.pathname,method=(init?.method||'GET').toUpperCase();
    console.info('[canvas-demo]',method,route);
    if(/\/viewer$/.test(route))return response(viewer);
    if(/\/(?:image-models|video-models|models)(?:\/|$)/.test(route))return response({models:[],defaultModelId:null,configured:false});
    if(/\/brand-kits(?:\/|$)/.test(route))return response({brandKits:[],kits:[]});
    if(/\/skills(?:\/|$)|\/marketplace/.test(route))return response({skills:[],items:[],total:0});
    if(/\/projects$/.test(route)){
      if(method==='POST'){const body=await json(init);project.name=body.name||project.name;}
      return response(method==='GET'?{projects:[project]}:{project,canvas});
    }
    if(/\/projects\/[^/]+$/.test(route))return response({project,canvases:[{...canvas,updatedAt:date}],workspace});
    if(/\/sessions\/[^/]+\/messages$/.test(route))return response({messages:[]});
    if(/\/canvases\/[^/]+\/sessions$/.test(route)){
      if(method==='POST'){const row={...sessions[0],id:crypto.randomUUID()};sessions.push(row);return response({session:row});}
      return response({sessions});
    }
    if(/\/canvases\/[^/]+$/.test(route)){
      if(method==='PUT'||method==='PATCH'){const body=await json(init);canvas={...canvas,...body,content:body.content||canvas.content};persist();}
      return response({canvas});
    }
    if(/\/assets|\/artifacts/.test(route))return response({assets:[],artifacts:[],items:[]});
    if(/\/settings|\/preferences/.test(route))return response({settings:{},preferences:{},models:[]});
    if(/\/generations|\/agent\/runs|\/jobs|\/runs|\/generate/.test(route))return response({error:'网页演示不执行真实生成。请下载桌面版并配置模型。',message:'网页演示不执行真实生成。请下载桌面版并配置模型。'},400);
    return response({items:[],models:[],sessions:[],messages:[],skills:[],jobs:[],configured:false});
  };
  class DemoSocket extends EventTarget{
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    readyState=1;bufferedAmount=0;extensions='';protocol='';binaryType='blob';
    constructor(url){super();this.url=String(url);queueMicrotask(()=>{const e=new Event('open');this.dispatchEvent(e);this.onopen?.(e);});}
    send(){}close(){this.readyState=3;const e=new Event('close');this.dispatchEvent(e);this.onclose?.(e);}
  }
  window.WebSocket=DemoSocket;
})();
