'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {discoverAgentRuntimes,safeCliProbe}=require('../backend/agent-runtime-discovery.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aidesignhub-discovery-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^aidesignhub-discovery-/);fs.rmSync(root,{recursive:true,force:true});});return root;}
function put(root,name,content=''){const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);return p;}
test('discovery reads declared package bins without executing shell shims',t=>{
  const root=fixture(t);put(root,'node.exe');put(root,'dsh.cmd','this would be unsafe to execute');
  put(root,'node_modules/@deepseek-ai/dsh/package.json',JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1-test',bin:{dsh:'lib/bin.js'}}));
  const entry=put(root,'node_modules/@deepseek-ai/dsh/lib/bin.js','throw new Error("must never execute")');
  const result=discoverAgentRuntimes({env:{PATH:root},platform:'win32',clock:()=>123});
  assert.equal(result.checkedAt,123);const item=result.candidates.find(c=>c.installed);assert.equal(item.provider,'deepseek');assert.equal(item.version,'0.1-test');assert.deepEqual(item.config.args,[entry,'--profile','acp']);assert.equal(item.config.command,path.join(root,'node.exe'));
  assert.equal(result.candidates.find(c=>c.provider==='hermes').installed,false);
});
test('discovery rejects escaped or mismatched package bin declarations',t=>{
  const root=fixture(t);put(root,'node.exe');put(root,'openclaw.cmd');put(root,'node_modules/openclaw/package.json',JSON.stringify({name:'openclaw',bin:{openclaw:'../../elsewhere.js'}}));put(root,'node_modules/openclaw/openclaw.mjs');
  assert.equal(discoverAgentRuntimes({env:{PATH:root},platform:'win32'}).candidates.some(c=>c.installed),false);
});
test('CLI probe uses a fixed help recipe, never user task args or shell strings',t=>{
  const root=fixture(t);put(root,'node.exe');put(root,'node_modules/openclaw/package.json',JSON.stringify({name:'openclaw',bin:{openclaw:'openclaw.mjs'}}));const entry=put(root,'node_modules/openclaw/openclaw.mjs');
  const probe=safeCliProbe({provider:'openclaw',command:path.join(root,'node.exe'),args:[entry,'agent','--message','private input']});assert.deepEqual(probe.args,[entry,'agent','--help']);assert.equal(probe.outputFormat,'text');
  assert.equal(safeCliProbe({provider:'hermes',command:process.execPath,args:['-e','throw new Error()']}),null);
});
test('read-only discovery does not use unknown cwd or unbounded manifests',t=>{
  const root=fixture(t);put(root,'node.exe');put(root,'node_modules/openclaw/package.json','x'.repeat(300000));
  assert.equal(discoverAgentRuntimes({env:{PATH:`.;${root};${root}`},platform:'win32'}).candidates.filter(c=>c.installed).length,0);
});

test('all five product families have explicit discovery and connection states',t=>{
  const root=fixture(t);
  const result=discoverAgentRuntimes({env:{PATH:root},platform:'win32'});
  assert.deepEqual(result.candidates.map(c=>c.provider).sort(),['chatgpt','deepseek','hermes','openclaw','zcode']);
  for(const item of result.candidates){assert.equal(item.installed,false);assert.equal(item.modelVerified,false);assert.equal(item.pairable,false);assert.equal(item.config,undefined);}
});

test('Hermes bootstrap installation outside PATH is discovered with verified ACP entry',t=>{
  const root=fixture(t), install='hermes/installs/abc/environments/def/venv';
  const cli=put(root,`${install}/Scripts/hermes.exe`,'do not execute');
  const acp=put(root,`${install}/Scripts/hermes-acp.exe`,'do not execute');
  put(root,`${install}/pyvenv.cfg`,'home = fixture');
  put(root,`${install}/Lib/site-packages/hermes_agent-0.1.dist-info/entry_points.txt`,'[console_scripts]\nhermes = hermes_cli.main:main\nhermes-acp = acp_adapter.entry:main\n');
  put(root,`${install}/Lib/site-packages/hermes_agent-0.1.dist-info/METADATA`,'Name: hermes-agent\nVersion: 0.1\n');
  const result=discoverAgentRuntimes({env:{PATH:'',LOCALAPPDATA:root},platform:'win32'});
  const item=result.candidates.find(c=>c.provider==='hermes');
  assert.equal(item.installed,true);assert.equal(item.config.command,acp);assert.equal(item.config.mode,'acp');assert.deepEqual(item.config.args,[]);
  assert.equal(item.version,'0.1');assert.equal(item.pairable,true);assert.equal(item.connectionState,'not-paired');assert.equal(fs.readFileSync(cli,'utf8'),'do not execute');
});

test('Hermes source cache without installed package or pyvenv is not executable evidence',t=>{
  const root=fixture(t);
  put(root,'hermes/installs/abc/environments/def/venv/Scripts/hermes.exe');
  const item=discoverAgentRuntimes({env:{LOCALAPPDATA:root},platform:'win32'}).candidates.find(c=>c.provider==='hermes');
  assert.equal(item.installed,false);assert.equal(item.config,undefined);
});

test('Hermes user uv tool has a file-based CLI recipe without shell or task arguments',t=>{
  const root=fixture(t), command=put(root,'uv/tools/hermes-agent/Scripts/hermes.exe');
  const item=discoverAgentRuntimes({env:{APPDATA:root},platform:'win32'}).candidates.find(c=>c.provider==='hermes');
  assert.equal(item.config.command,command);assert.equal(item.config.mode,'cli');
  assert.deepEqual(item.config.args,['chat','--query-file','{promptFile}','--oneshot','--format','stream-json']);
  assert.deepEqual(safeCliProbe(item.config).args,['chat','--help']);
});

test('desktop applications are found but never become CLI dispatch configurations',t=>{
  const root=fixture(t), zcode=put(root,'Programs/ZCode/ZCode.exe');
  const item=discoverAgentRuntimes({env:{LOCALAPPDATA:root},platform:'win32'}).candidates.find(c=>c.provider==='zcode');
  assert.equal(item.installed,true);assert.equal(item.source,zcode);assert.equal(item.kind,'desktop');assert.equal(item.config,undefined);assert.equal(item.pairable,false);assert.equal(item.connectionState,'client-authorization-required');
});

test('Appx product identity distinguishes Codex from a standalone ChatGPT app',t=>{
  const root=fixture(t), executable=put(root,'OpenAI.Codex/app/ChatGPT.exe');
  put(root,'OpenAI.Codex/app/Codex.exe');
  const result=discoverAgentRuntimes({env:{},platform:'win32',windowsInventory:{items:[{kind:'appx',name:'OpenAI.Codex',version:'26.1',directory:path.join(root,'OpenAI.Codex')}],warnings:[]}});
  const items=result.candidates.filter(c=>c.provider==='chatgpt');
  assert.equal(items.length,1);assert.equal(items[0].source,executable);assert.equal(items[0].product,'OpenAI.Codex');assert.match(items[0].label,/Codex/);assert.equal(items[0].config,undefined);
});

test('a failed system inventory does not suppress filesystem discovery',t=>{
  const root=fixture(t);put(root,'Programs/ZCode/ZCode.exe');
  const result=discoverAgentRuntimes({env:{LOCALAPPDATA:root},platform:'win32',windowsInventory:{items:[],warnings:['inventory timed out']}});
  assert.equal(result.candidates.find(c=>c.provider==='zcode').installed,true);assert.ok(result.warnings.includes('inventory timed out'));
});

test('Windows metadata query is bounded, hidden and never executes a candidate binary',t=>{
  const {windowsInstallationInventory}=require('../backend/agent-installation-inventory.cjs');
  const root=fixture(t), executable=put(root,'System32/WindowsPowerShell/v1.0/powershell.exe');
  let observed;
  const result=windowsInstallationInventory({env:{SystemRoot:root},run:(command,args,options)=>{observed={command,args,options};return {error:{code:'ETIMEDOUT'},status:null};},timeoutMs:20000});
  assert.equal(observed.command,executable);assert.equal(observed.options.shell,false);assert.equal(observed.options.windowsHide,true);assert.ok(observed.options.timeout<=2500);assert.ok(result.warnings.length);
});
