'use strict';
// Website account/download gateway only. No project, model, CAD, or Agent API.
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const ALLOWED_FILES=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/;
function createAccountServer({apiBase='http://127.0.0.1:4000',gatewaySecret='',allowedOrigins=['https://aidesignhub.work','https://adh.bycjdesign.com'],downloads={},secureCookie=true,sessionTtlMs=7200000}={}){
  const base=new URL(apiBase);
  if(!['127.0.0.1','[::1]','localhost'].includes(base.hostname)||!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error('Account upstream must be loopback.');
  for(const file of Object.values(downloads))if(!ALLOWED_FILES.test(file)||file.includes('..'))throw new Error('Invalid download allowlist.');
  const origins=new Set(allowedOrigins),sessions=new Map(),rates=new Map();
  const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  const fail=(status,message)=>Object.assign(new Error(message),{status});
  function rate(key,limit,ms){const time=Date.now(),entry=rates.get(key);if(entry&&entry.until>time){if(++entry.count>limit)throw fail(429,'操作太频繁，请稍后再试。');}else rates.set(key,{count:1,until:time+ms});if(rates.size>10000)for(const [k,v]of rates)if(v.until<=time)rates.delete(k);if(rates.size>12000)throw fail(503,'账号服务繁忙，请稍后重试。');}
  function sid(req){const match=/(?:^|;\s*)__Host-adh_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'');return match?.[1];}
  function cookie(res,value,maxAge){res.setHeader('Set-Cookie',`__Host-adh_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie?'; Secure':''}`);}
  async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw fail(413,'提交内容过大。');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'提交格式无效。');}}
  function emailOf(value){if(typeof value!=='string'||value.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))throw fail(400,'请输入有效邮箱。');return value.trim().toLowerCase();}
  function safeUser(value){if(!value||!value.id||typeof value.email!=='string')throw fail(502,'账号服务返回的信息不完整。');return {id:String(value.id),email:value.email};}
  async function upstream(route,{payload,token}={}){
    const headers={'Accept':'application/json','X-Gateway-Secret':gatewaySecret,'Origin':'https://ai.bycjdesign.com'};
    if(token)headers.Authorization='Bearer '+token;
    if(payload)headers['Content-Type']='application/json';
    let response,data;
    try{response=await fetch(new URL('/auth/'+route,base),{method:payload?'POST':'GET',headers,body:payload?JSON.stringify(payload):undefined,redirect:'error',signal:AbortSignal.timeout(18000)});data=await response.json();}catch{throw fail(502,'BYCJ 账号服务暂时无法连接，请稍后重试。');}
    if(!response.ok){const msg=typeof data?.error==='string'?data.error:typeof data?.message==='string'?data.message:'账号验证失败，请检查邮箱和密码。';throw fail([400,401,403,409,422,429].includes(response.status)?response.status:502,msg.slice(0,300));}
    return data;
  }
  async function authenticate(req){const id=sid(req),entry=id&&sessions.get(id);if(!entry||entry.until<=Date.now()){if(id)sessions.delete(id);throw fail(401,'请先使用 BYCJ 账号登录。');}try{const result=await upstream('me',{token:entry.token});entry.user=safeUser(result.user||result);return entry.user;}catch(error){if([401,403].includes(error.status))sessions.delete(id);throw error;}}
  const server=http.createServer(async(req,res)=>{
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      const origin=req.headers.origin;
      if(origin&&!origins.has(origin))throw fail(403,'该来源不允许访问账号入口。');
      if(req.headers['sec-fetch-site']==='cross-site')throw fail(403,'请从 AIDesignHub 官网打开此入口。');
      if(req.method==='GET'&&path==='/api/account/health')return json(res,200,{ok:true,service:'aidesignhub-account-download',projectBackend:false});
      if(req.method==='POST'){
        if(!origin||!origins.has(origin))throw fail(403,'请从 AIDesignHub 官网提交。');
        if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'请使用 JSON 提交。');
      }
      if(req.method==='POST'&&path==='/api/account/logout'){sessions.delete(sid(req));cookie(res,'',0);return json(res,200,{ok:true});}
      if(req.method==='POST'&&['/api/account/login','/api/account/register/request'].includes(path)){
        const ip=req.headers['x-real-ip']||req.socket.remoteAddress;rate('ip:'+ip,20,600000);
        const input=await body(req),email=emailOf(input.email);rate('email:'+crypto.createHash('sha256').update(email).digest('hex'),10,600000);
        if(path.endsWith('/register/request')){const result=await upstream('register/request',{payload:{email}});if(result.ok!==true)throw fail(502,'账号服务未确认邮件发送成功。');return json(res,200,{ok:true});}
        if(typeof input.password!=='string'||!input.password||input.password.length>1024)throw fail(400,'请输入有效密码。');
        const result=await upstream('login',{payload:{email,password:input.password}});
        if(typeof result.token!=='string'||result.token.length>8192)throw fail(502,'账号服务未返回有效登录凭据。');
        const user=safeUser(result.user);
        for(const [id,entry]of sessions)if(entry.until<=Date.now())sessions.delete(id);
        if(sessions.size>=2000)throw fail(503,'登录会话已满，请稍后重试。');
        sessions.delete(sid(req));const id=crypto.randomBytes(32).toString('hex');sessions.set(id,{token:result.token,user,until:Date.now()+sessionTtlMs});cookie(res,id,Math.floor(sessionTtlMs/1000));
        return json(res,200,{user});
      }
      if(req.method==='GET'&&path==='/api/account/me')return json(res,200,{user:await authenticate(req)});
      const match=/^\/api\/downloads\/(windows|source)$/.exec(path);
      if(req.method==='GET'&&match){await authenticate(req);const name=downloads[match[1]];if(!name)throw fail(503,'下载文件正在准备，请稍后重试。');res.writeHead(200,{'X-Accel-Redirect':'/__adh_downloads/'+name,'Content-Type':match[1]==='windows'?'application/octet-stream':'application/zip','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end();}
      throw fail(404,'此入口不存在。');
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'服务暂时不可用，请稍后重试。'});else res.end();}
  });
  server.requestTimeout=20000;server.headersTimeout=15000;server.maxHeadersCount=40;
  return server;
}
if(require.main===module){
  const manifest=JSON.parse(fs.readFileSync(process.env.ADH_DOWNLOAD_MANIFEST,'utf8'));
  const server=createAccountServer({gatewaySecret:process.env.GATEWAY_SECRET,downloads:manifest,allowedOrigins:(process.env.ADH_PUBLIC_ORIGINS||'https://aidesignhub.work,https://adh.bycjdesign.com').split(',')});
  server.listen(Number(process.env.PORT||8789),'127.0.0.1',()=>console.log('AIDesignHub account/download gateway ready on loopback.'));
}
module.exports={createAccountServer};
