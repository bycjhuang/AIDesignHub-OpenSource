const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {LocalBackend}=require('../backend/local-backend.cjs');
const {AgentHub,SCOPES}=require('../backend/agent-hub.cjs');
const {AgentGateway}=require('../backend/agent-gateway.cjs');
const {buildClientConfig}=require('../backend/client-config.cjs');

test('official MCP SDK: simultaneous stdio + HTTP clients share the same real Hub',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-sdk-'));
  const backend=new LocalBackend({dataDir:dir});const hub=new AgentHub({backend});const gateway=new AgentGateway({hub});
  const {url}=await gateway.start();const grants=['stdio','http'].map(label=>hub.createGrant({label,projectId:'project_jiangwan',memberId:'member_designer',scopes:SCOPES}));
  const clients=[new Client({name:'official-sdk-stdio',version:'1.0.0'}),new Client({name:'official-sdk-http',version:'1.0.0'})];
  try {
    const options={gateway:{running:true,url},command:process.execPath,mcpScript:path.join(__dirname,'..','scripts','hub-mcp.cjs')};
    const stdio=buildClientConfig({...options,token:grants[0].token}).config.mcpServers.AIDesignHub;
    const http=buildClientConfig({...options,transport:'http',token:grants[1].token}).config.mcpServers.AIDesignHub;
    await clients[0].connect(new StdioClientTransport({...stdio,stderr:'pipe'}));
    await clients[1].connect(new StreamableHTTPClientTransport(new URL(http.url),{requestInit:{headers:http.headers}}));
    for(const client of clients){const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='hub_artifact_submit'));const project=await client.callTool({name:'hub_project_context',arguments:{}});assert.equal(project.structuredContent.project.id,'project_jiangwan');}
    const created=await clients[0].callTool({name:'hub_task_create',arguments:{title:'双协议研究',instruction:'整理任务书',skillId:'design-brief',connectionId:'zcode',requestId:'shared'}});const job=created.structuredContent;
    const started=await clients[1].callTool({name:'hub_task_start',arguments:{jobId:job.id}});const run=started.structuredContent;
    const claimed=await clients[1].callTool({name:'hub_run_claim',arguments:{runId:run.id}});assert.equal(claimed.isError,false);
    const forbidden=await clients[0].callTool({name:'hub_artifact_submit',arguments:{runId:run.id,content:'冒领',requestId:'bad'}});assert.equal(forbidden.isError,true);
    const result=await clients[1].callTool({name:'hub_artifact_submit',arguments:{runId:run.id,content:'官方 SDK 双入口验证成果',requestId:'good'}});assert.equal(result.structuredContent.status,'awaiting_review');
    hub.reviewRun(run.id,true);const runs=await clients[0].callTool({name:'hub_run_list',arguments:{}});assert.equal(runs.structuredContent.result[0].status,'succeeded');
    hub.revokeGrant(grants[0].id);await assert.rejects(clients[0].listTools());
  }finally{await Promise.allSettled(clients.map(client=>client.close()));await gateway.stop();hub.dispose();}
});
