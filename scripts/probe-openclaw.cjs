'use strict';
// Explicit opt-in only. Uses an existing OpenClaw login and may consume its model quota.
// No project contents, external delivery, config edits, or tool use are requested.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {executeAgent}=require('../backend/agent-executors.cjs');
async function main(){
  const [command,moduleFile]=process.argv.slice(2);
  if(!command||!moduleFile)throw new Error('Pass the installed node.exe and openclaw.mjs absolute paths.');
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-openclaw-probe-'));
  const result=await executeAgent({id:'manual-live-probe',provider:'openclaw',mode:'cli',command,args:[moduleFile,'agent','--session-id',crypto.randomUUID(),'--message','{prompt}','--json','--timeout','45','--thinking','minimal'],timeoutMs:55000},{cwd,prompt:'This is a connection test. Reply with exactly AIDESIGNHUB_OK. Do not call any tools, read files, search the web, send messages, or change anything.',onEvent:()=>{}});
  const ok=result.text.trim()==='AIDESIGNHUB_OK';process.stdout.write(JSON.stringify({ok,transport:'openclaw-cli',realModelTurn:true,markerMatched:ok})+'\n');if(!ok)process.exitCode=1;
}
main().catch(error=>{process.stdout.write(JSON.stringify({ok:false,code:error.code||'PROBE_FAILED',message:error.message})+'\n');process.exitCode=1;});
