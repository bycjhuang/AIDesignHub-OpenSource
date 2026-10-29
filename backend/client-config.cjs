'use strict';
const path=require('node:path');
const fs=require('node:fs');

// Create a user-copyable configuration, never write another application's files.
function buildClientConfig({transport='stdio',gateway,command,mcpScript,token}={}){
  if(!gateway?.running)throw new Error('请先开启本机工具入口，再生成客户端配置。');
  let url;try{url=new URL(gateway.url);}catch{throw new Error('本机接口地址无效。');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('仅生成本机受保护 Hub 的接入配置。');
  if(!['stdio','http'].includes(transport))throw new Error('请选择 stdio 或 HTTP 接入方式。');
  if(token!==undefined&&(typeof token!=='string'||!/^[A-Za-z0-9_-]{20,200}$/.test(token)))throw new Error('授权格式无效，请使用工作台刚生成的项目授权。');
  const credential=token||'<AIDESIGNHUB_TOKEN>';let server;
  if(transport==='stdio'){
    if(![command,mcpScript].every(file=>typeof file==='string'&&path.isAbsolute(file)&&fs.statSync(file,{throwIfNoEntry:false})?.isFile()))throw new Error('未找到有效的本地运行时或 MCP bridge。');
    const env={AIDESIGNHUB_URL:url.origin,AIDESIGNHUB_TOKEN:credential};
    if(/^electron(?:\.exe)?$/i.test(path.basename(command)))env.ELECTRON_RUN_AS_NODE='1';
    server={command,args:[mcpScript],env};
  }else server={type:'http',url:`${url.origin}/mcp`,headers:{Authorization:`Bearer ${credential}`}};
  return {format:'mcpServers JSON',config:{mcpServers:{AIDesignHub:server}},containsToken:Boolean(token),warning:[
    token?'此配置包含本次项目授权，只能粘贴到受信任的客户端；勿截图、发到聊天或提交源码。':'模板使用授权占位符；替换为有效项目授权后才可连接。',
    '生成配置不代表连接成功。不要覆盖客户端现有服务；ZCode 可在新建 MCP 的“完整配置”中粘贴。',
    transport==='http'?'HTTP 地址仅本机可达；ChatGPT 云端连接需另行配置其支持的私有隧道等入口。':'仅供支持本地 stdio MCP 的客户端使用；不要把它当作 ChatGPT 云端连接配置。'
  ].join('\n')};
}
module.exports={buildClientConfig};
