'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {createAccountServer}=require('../web-public/server.cjs');
test('website uses existing account identity, keeps JWT server-side and gates only allowlisted downloads',async()=>{
  const received=[];
  const upstream=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;received.push({url:req.url,gateway:req.headers['x-gateway-secret'],authorization:req.headers.authorization,body:text});res.setHeader('Content-Type','application/json');if(req.url==='/auth/login')return res.end(JSON.stringify({token:'fixture-token',user:{id:'u1',email:'demo@example.test',wallet:'private'}}));if(req.url==='/auth/me'){if(req.headers.authorization!=='Bearer fixture-token'){res.statusCode=401;return res.end('{}');}return res.end(JSON.stringify({id:'u1',email:'demo@example.test',wallet:'private'}));}res.end('{"ok":true}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const app=createAccountServer({apiBase:'http://127.0.0.1:'+upstream.address().port,gatewaySecret:'fixture-gateway',downloads:{windows:'AIDesignHub-Setup-0.3.2.exe',source:'AIDesignHub-source-v0.3.2.zip'}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.address().port;
  const post=(route,body,origin='https://aidesignhub.work')=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(base+'/api/downloads/windows')).status,401);
    assert.equal((await post('/api/account/login',{email:'demo@example.test',password:'example'},'https://evil.example')).status,403);
    assert.equal(received.length,0);
    const login=await post('/api/account/login',{email:'demo@example.test',password:'example'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
    assert.deepEqual(await login.json(),{user:{id:'u1',email:'demo@example.test'}});const headers={Cookie:cookie.split(';')[0]};
    const download=await fetch(base+'/api/downloads/windows',{headers});assert.equal(download.status,200);assert.equal(download.headers.get('x-accel-redirect'),'/__adh_downloads/AIDesignHub-Setup-0.3.2.exe');
    assert.equal((await fetch(base+'/api/downloads/../../private',{headers})).status,404);
    assert.equal((await fetch(base+'/api/projects',{headers})).status,404);
    assert.equal((await fetch(base+'/api/downloads/windows',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.ok(received.every(row=>row.gateway==='fixture-gateway'));assert.equal(received[1].authorization,'Bearer fixture-token');
    const logout=await fetch(base+'/api/account/logout',{method:'POST',headers:{...headers,Origin:'https://aidesignhub.work','Content-Type':'application/json'},body:'{}'});assert.equal(logout.status,200);
    assert.equal((await fetch(base+'/api/downloads/source',{headers})).status,401);
    const register=await post('/api/account/register/request',{email:'demo@example.test'});assert.equal(register.status,200);assert.deepEqual(received.at(-1).body,'{"email":"demo@example.test"}');
  }finally{await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);}
});
test('website gateway refuses remote account origins and arbitrary download paths',()=>{
  assert.throws(()=>createAccountServer({apiBase:'https://untrusted.example'}),/loopback/);
  assert.throws(()=>createAccountServer({downloads:{windows:'../private'}}),/allowlist/);
});
