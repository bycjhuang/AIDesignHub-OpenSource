const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { URL } = require('node:url');

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'access-control-allow-origin':'*', 'access-control-allow-headers':'authorization, content-type', 'access-control-allow-methods':'GET, POST, OPTIONS' });
  response.end(JSON.stringify(body));
}

function safeTokenEqual(expected, actual) {
  const a=Buffer.from(String(expected||''));const b=Buffer.from(String(actual||''));
  return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);
}

async function readJson(request, maxBytes=1_000_000) {
  const chunks=[];let total=0;
  for await (const chunk of request) { total+=chunk.length;if(total>maxBytes)throw new Error('Request body is too large.');chunks.push(chunk); }
  return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
}

function localIPv4() {
  const result=[];
  for(const entries of Object.values(os.networkInterfaces()))for(const entry of entries||[])if(entry.family==='IPv4'&&!entry.internal)result.push(entry.address);
  return result;
}

class TeamSyncServer {
  constructor(backend) { this.backend=backend;this.server=null;this.token=null;this.host=null;this.port=null; }

  async start({ host='127.0.0.1', port=0, token }={}) {
    if(this.server)return this.status();
    this.token=token||crypto.randomBytes(24).toString('base64url');this.host=host;
    this.server=http.createServer(async(request,response)=>{
      if(request.method==='OPTIONS'){jsonResponse(response,204,{});return;}
      const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
      if(url.pathname==='/health'){jsonResponse(response,200,{ok:true,service:'BYCJ Team Sync',version:1,time:Date.now()});return;}
      const bearer=String(request.headers.authorization||'').replace(/^Bearer\s+/i,'');
      if(!safeTokenEqual(this.token,bearer)){jsonResponse(response,401,{ok:false,error:'UNAUTHORIZED'});return;}
      try {
        if(request.method==='GET'&&url.pathname==='/api/bootstrap'){
          const snapshot=this.backend.bootstrap(url.searchParams.get('projectId')||undefined);
          const { settings, knowledgeDocs, connectorSettings, dataDir, ...teamData }=snapshot;
          // Personal cases stay on their own machine; only team-shared cases sync.
          teamData.cases=(snapshot.cases||[]).filter((item)=>item&&item.scope==='team');
          jsonResponse(response,200,{ok:true,data:teamData});return;
        }
        if(request.method==='GET'&&url.pathname==='/api/messages'){const projectId=url.searchParams.get('projectId');const since=Number(url.searchParams.get('since')||0);const messages=this.backend.searchMessages(projectId,'').filter((item)=>item.createdAt>since).sort((a,b)=>a.createdAt-b.createdAt);jsonResponse(response,200,{ok:true,data:messages});return;}
        if(request.method==='GET'&&url.pathname.startsWith('/api/attachments/')){const attachmentId=decodeURIComponent(url.pathname.slice('/api/attachments/'.length));jsonResponse(response,200,{ok:true,data:this.backend.getChatAttachment(attachmentId)});return;}
        if(request.method==='POST'&&url.pathname==='/api/messages'){const payload=await readJson(request);jsonResponse(response,201,{ok:true,data:this.backend.sendMessage(payload)});return;}
        if(request.method==='POST'&&url.pathname==='/api/attachments'){const payload=await readJson(request,40_000_000);jsonResponse(response,201,{ok:true,data:this.backend.importChatAttachmentBuffers(payload.files,payload.projectId)});return;}
        if(request.method==='POST'&&url.pathname==='/api/decisions'){const payload=await readJson(request);jsonResponse(response,201,{ok:true,data:this.backend.createDecision(payload)});return;}
        if(request.method==='POST'&&url.pathname.startsWith('/api/decisions/')){const decisionId=decodeURIComponent(url.pathname.slice('/api/decisions/'.length));const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.updateDecision(decisionId,payload)});return;}
        if(request.method==='POST'&&url.pathname==='/api/tasks'){const payload=await readJson(request);jsonResponse(response,201,{ok:true,data:this.backend.addTask(payload)});return;}
        if(request.method==='POST'&&url.pathname.startsWith('/api/tasks/')){const taskId=decodeURIComponent(url.pathname.slice('/api/tasks/'.length));const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.updateTask(taskId,payload)});return;}
        if(request.method==='POST'&&url.pathname==='/api/members'){const payload=await readJson(request);jsonResponse(response,201,{ok:true,data:this.backend.addMember(payload)});return;}
        if(request.method==='POST'&&url.pathname==='/api/channels'){const payload=await readJson(request);jsonResponse(response,201,{ok:true,data:this.backend.addChannel(payload)});return;}
        if(request.method==='POST'&&url.pathname==='/api/cases'){const payload=await readJson(request);jsonResponse(response,201,{ok:true,data:this.backend.addCase(payload)});return;}
        if(request.method==='POST'&&url.pathname.startsWith('/api/cases/')&&url.pathname.endsWith('/remove')){const caseId=decodeURIComponent(url.pathname.slice('/api/cases/'.length,-'/remove'.length));jsonResponse(response,200,{ok:true,data:this.backend.removeCase(caseId)});return;}
        if(request.method==='GET'&&url.pathname==='/api/knowledge'){const projectId=url.searchParams.get('projectId')||this.backend.projectId();const docs=this.backend.store.knowledgeDocs.filter((d)=>d.projectId===projectId&&d.scope==='team').map(({storedPath,originalPath,...rest})=>rest);jsonResponse(response,200,{ok:true,data:docs});return;}
        if(request.method==='GET'&&url.pathname.startsWith('/api/knowledge-file/')){const docId=decodeURIComponent(url.pathname.slice('/api/knowledge-file/'.length));const doc=this.backend.store.knowledgeDocs.find((d)=>d.id===docId&&d.scope==='team');if(!doc)throw new Error('Knowledge document not found.');const buffer=require('node:fs').readFileSync(doc.storedPath);jsonResponse(response,200,{ok:true,data:{id:doc.id,name:doc.name,contentBase64:buffer.toString('base64')}});return;}
        if(request.method==='POST'&&url.pathname==='/api/knowledge'){const payload=await readJson(request,80_000_000);jsonResponse(response,201,{ok:true,data:await this.backend.importTeamKnowledgeFromBuffers(payload)});return;}
        if(request.method==='POST'&&url.pathname==='/api/knowledge/remove'){const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.removeKnowledge(String(payload.id||''))});return;}
        if(request.method==='POST'&&url.pathname.startsWith('/api/risks/')){const riskId=decodeURIComponent(url.pathname.slice('/api/risks/'.length));const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.updateRisk(riskId,payload)});return;}
        if(request.method==='POST'&&url.pathname.startsWith('/api/milestones/')){const milestoneId=decodeURIComponent(url.pathname.slice('/api/milestones/'.length));const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.updateMilestone(milestoneId,payload)});return;}
        if(request.method==='GET'&&url.pathname==='/api/resource-library'){const lib=this.backend.store.resourceLibrary;jsonResponse(response,200,{ok:true,data:lib?{team:lib.team}:{team:{skills:[],mcpServers:[],instructions:[]}}});return;}
        if(request.method==='POST'&&url.pathname==='/api/resource-library/mcp'){const payload=await readJson(request);payload.scope='team';jsonResponse(response,201,{ok:true,data:this.backend.mutate(store=>{const server={...payload,id:payload.id||`mcp_${crypto.randomUUID()}`,scope:'team',createdAt:payload.createdAt||Date.now(),updatedAt:Date.now()};const list=store.resourceLibrary?.team?.mcpServers||[];const idx=list.findIndex(i=>i.id===server.id);if(idx<0)list.push(server);else{server.createdAt=list[idx].createdAt;list[idx]=server;}return server;})});return;}
        if(request.method==='POST'&&url.pathname==='/api/resource-library/mcp/remove'){const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.mutate(store=>{const list=store.resourceLibrary?.team?.mcpServers||[];const idx=list.findIndex(i=>i.id===payload.id);if(idx<0)throw new Error('MCP 服务器不存在。');return list.splice(idx,1)[0];})});return;}
        if(request.method==='POST'&&url.pathname==='/api/resource-library/instruction'){const payload=await readJson(request);payload.scope='team';jsonResponse(response,201,{ok:true,data:this.backend.mutate(store=>{const instr={...payload,id:payload.id||`instr_${crypto.randomUUID()}`,scope:'team',createdAt:payload.createdAt||Date.now(),updatedAt:Date.now()};const list=store.resourceLibrary?.team?.instructions||[];const idx=list.findIndex(i=>i.id===instr.id);if(idx<0)list.push(instr);else{instr.createdAt=list[idx].createdAt;list[idx]=instr;}return instr;})});return;}
        if(request.method==='POST'&&url.pathname==='/api/resource-library/instruction/remove'){const payload=await readJson(request);jsonResponse(response,200,{ok:true,data:this.backend.mutate(store=>{const list=store.resourceLibrary?.team?.instructions||[];const idx=list.findIndex(i=>i.id===payload.id);if(idx<0)throw new Error('指令不存在。');return list.splice(idx,1)[0];})});return;}
        jsonResponse(response,404,{ok:false,error:'NOT_FOUND'});
      } catch(error){jsonResponse(response,400,{ok:false,error:error.message||String(error)});}
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,host,()=>{this.server.off('error',reject);resolve();});});
    this.port=this.server.address().port;return this.status();
  }

  status() { const running=Boolean(this.server);const addresses=running?(this.host==='0.0.0.0'?localIPv4().map((address)=>`http://${address}:${this.port}`):[`http://${this.host}:${this.port}`]):[];return {running,host:this.host,port:this.port,addresses,token:this.token}; }
  async stop(){if(!this.server)return;await new Promise((resolve)=>this.server.close(resolve));this.server=null;this.port=null;}
}

class TeamSyncClient {
  constructor({url,token}) { this.url=String(url||'').replace(/\/$/,'');this.token=token; }
  async request(pathname,options={}) { const response=await fetch(`${this.url}${pathname}`,{...options,headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(8000)});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||`HTTP_${response.status}`);return body.data??body; }
  health(){return this.request('/health',{headers:{authorization:''}});}
  bootstrap(projectId){return this.request(`/api/bootstrap?projectId=${encodeURIComponent(projectId||'')}`);}
  downloadAttachment(attachmentId){return this.request(`/api/attachments/${encodeURIComponent(attachmentId)}`);}
  sendMessage(payload){return this.request('/api/messages',{method:'POST',body:JSON.stringify(payload)});}
  uploadAttachments(payload){return this.request('/api/attachments',{method:'POST',body:JSON.stringify(payload)});}
  createDecision(payload){return this.request('/api/decisions',{method:'POST',body:JSON.stringify(payload)});}
  updateDecision(decisionId,patch){return this.request(`/api/decisions/${encodeURIComponent(decisionId)}`,{method:'POST',body:JSON.stringify(patch)});}
  addTask(payload){return this.request('/api/tasks',{method:'POST',body:JSON.stringify(payload)});}
  updateTask(taskId,patch){return this.request(`/api/tasks/${encodeURIComponent(taskId)}`,{method:'POST',body:JSON.stringify(patch)});}
  addMember(payload){return this.request('/api/members',{method:'POST',body:JSON.stringify(payload)});}
  addChannel(payload){return this.request('/api/channels',{method:'POST',body:JSON.stringify(payload)});}
  addCase(payload){return this.request('/api/cases',{method:'POST',body:JSON.stringify(payload)});}
  removeCase(caseId){return this.request(`/api/cases/${encodeURIComponent(caseId)}/remove`,{method:'POST',body:'{}'});}
  updateRisk(riskId,patch){return this.request(`/api/risks/${encodeURIComponent(riskId)}`,{method:'POST',body:JSON.stringify(patch)});}
  updateMilestone(milestoneId,patch){return this.request(`/api/milestones/${encodeURIComponent(milestoneId)}`,{method:'POST',body:JSON.stringify(patch)});}
  getResourceLibrary(){return this.request('/api/resource-library');}
  getTeamKnowledge(projectId){return this.request(`/api/knowledge?projectId=${encodeURIComponent(projectId||'')}`);}
  downloadKnowledgeFile(id){return this.request(`/api/knowledge-file/${encodeURIComponent(id)}`);}
  uploadTeamKnowledge(payload){return this.request('/api/knowledge',{method:'POST',body:JSON.stringify(payload)});}
  removeTeamKnowledge(id){return this.request('/api/knowledge/remove',{method:'POST',body:JSON.stringify({id})});}
  saveTeamMcpServer(payload){return this.request('/api/resource-library/mcp',{method:'POST',body:JSON.stringify(payload)});}
  removeTeamMcpServer(id){return this.request('/api/resource-library/mcp/remove',{method:'POST',body:JSON.stringify({id})});}
  saveTeamInstruction(payload){return this.request('/api/resource-library/instruction',{method:'POST',body:JSON.stringify(payload)});}
  removeTeamInstruction(id){return this.request('/api/resource-library/instruction/remove',{method:'POST',body:JSON.stringify({id})});}
}

module.exports={TeamSyncServer,TeamSyncClient};
