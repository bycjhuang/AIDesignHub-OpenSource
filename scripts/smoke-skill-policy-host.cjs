'use strict';

// Full official web Host + real preset scopes. Synthetic skills only; no model
// messages or external software operations. Does not touch the live profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DshRuntimeManager } = require('../backend/dsh-runtime.cjs');
const { linkBundleIntoProfile } = require('../backend/dsh-provisioner.cjs');

async function smokeSkillPolicyHost({ reportFile } = {}) {
  const realCache = path.join(process.env.APPDATA, 'bycj-design-workbench-prototype', 'cache');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adh-skill-preset-host-'));
  const originalEnv = { ...process.env };
  const fakeHome = path.join(root, 'home');
  const agentsHome = path.join(root, 'agents');
  const first = path.join(root, 'first-workspace');
  const second = path.join(root, 'second-workspace');
  const resultPath = path.join(root, 'report.json');
  let manager;
  async function skill(base, name) {
    const directory = path.join(base, name); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: synthetic ${name}\n---\nFixture body.\n`);
  }
  try {
    await fs.mkdir(path.join(first, '.git'), { recursive: true });
    await fs.mkdir(path.join(second, '.git'), { recursive: true });
    await fs.mkdir(path.join(fakeHome, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(fakeHome, 'AppData', 'Local'), { recursive: true });
    await skill(path.join(agentsHome, 'skills'), 'architecture-fixture');
    for (const name of ['ai-workshop-video-cover', 'ai-workshop-video-editing', 'expedition-frog-digital-human']) await skill(path.join(agentsHome, 'skills'), name);
    await skill(path.join(first, '.agents/skills'), 'first-project-design');
    await skill(path.join(second, '.dsh/skills'), 'second-project-design');
    await skill(path.join(second, '.agents/skills'), 'ai-workshop-video-cover');
    Object.assign(process.env, { APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'), USERPROFILE: fakeHome,
      HOME: fakeHome, DSH_AGENTS_HOME: agentsHome, ADH_POLICY_AUDIT_CONFIG: JSON.stringify({ first, second, resultPath }) });
    manager = new DshRuntimeManager({ userDataDir: path.join(root, 'user-data'), cacheRoot: realCache,
      pluginsSourceDir: path.resolve(__dirname, '../backend/dsh-plugins'), getModelStatus: () => null, emit: () => {} });
    const originalEnsure = manager.ensureProfile.bind(manager);
    manager.ensureProfile = async paths => {
      await originalEnsure(paths);
      const bundle = path.join(root, 'audit-bundle'); await fs.mkdir(bundle, { recursive: true });
      await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({ name: '@aidesign/temporary-skill-policy-audit', version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' }, dsh: { engines: { dsh: '>=0.2.1-rc.2' }, bundle: { patch: './cordis.patch.yml' } } }));
      await fs.writeFile(path.join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: adh-temporary-skill-policy-audit\n      name: "@aidesign/temporary-skill-policy-audit"\n');
      await fs.writeFile(path.join(bundle, 'index.js'), `import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const name='adh-temporary-skill-policy-audit';
export const inject=['skills','agents','tools','agentPresets'];
export function apply(ctx) {
 const config=JSON.parse(process.env.ADH_POLICY_AUDIT_CONFIG);
 const run=async()=>{
  const forbidden=['ai-workshop-video-cover','ai-workshop-video-editing','expedition-frog-digital-human'];
  const globalNames=(await ctx.skills.list({cwd:config.first})).map(item=>item.name);
  const presets=[];
  for(const preset of ['standard','ptc','cordis']) {
   const {agent}=await ctx.agents.create({sessionId:randomUUID(),agentOptions:{provider:'unused-offline-audit',model:'unused'},setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,preset);}});
   const read=async cwd=>(await ctx.skills.list({scope:agent,cwd})).map(item=>item.name);
   const first=await read(config.first), second=await read(config.second);
   const absent=[];
   for(const name of forbidden) absent.push(await ctx.skills.get(name,{scope:agent,cwd:config.second})===undefined);
   let skillToolDenied;
   if(preset==='standard') { const result=await ctx.tools.execute({callId:randomUUID(),name:'skill',arguments:{name:forbidden[0]},agent,signal:new AbortController().signal});skillToolDenied=result.isError===true; }
   const ok=forbidden.every(name=>!first.includes(name)&&!second.includes(name))&&absent.every(Boolean)
    &&first.includes('architecture-fixture')&&first.includes('first-project-design')&&!first.includes('second-project-design')
    &&second.includes('architecture-fixture')&&second.includes('second-project-design')&&!second.includes('first-project-design')
    &&(preset!=='standard'||skillToolDenied);
   presets.push({preset,composedPreset:ctx.agentPresets.composedPreset(agent.ctx),first,second,directGetDenied:absent.every(Boolean),skillToolDenied,ok});
  }
  const report={ok:presets.every(item=>item.ok)&&forbidden.every(name=>!globalNames.includes(name)),globalNames,presets,modelRequests:0,softwareOperations:0,realProfileTouched:false};
  await writeFile(config.resultPath,JSON.stringify(report,null,2));
 };
 setTimeout(()=>void run().catch(async error=>{await writeFile(config.resultPath,JSON.stringify({ok:false,error:error.message}));}),1000);
}
`);
      const profile = manager.profileDir();
      await linkBundleIntoProfile(profile, bundle, '@aidesign', 'temporary-skill-policy-audit');
      const packageFile = path.join(profile, 'package.json'); const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
      pkg.dsh.profile.bundles.push('@aidesign/temporary-skill-policy-audit');
      await fs.writeFile(packageFile, JSON.stringify(pkg));
    };
    await manager.start();
    if (manager.getState().status !== 'ready') throw new Error(manager.getState().message || 'Skill policy Host failed to start');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { await fs.access(resultPath); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    const report = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    if (reportFile) { await fs.mkdir(path.dirname(path.resolve(reportFile)), { recursive: true }); await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); }
    if (!report.ok) throw new Error(`SKILL_POLICY_HOST_AUDIT_FAILED: ${JSON.stringify(report)}`);
    return report;
  } finally {
    const child = manager?.child; manager?.stop();
    if (child) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 4000))]);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
}

module.exports = { smokeSkillPolicyHost };
if (require.main === module) {
  const index = process.argv.indexOf('--report');
  smokeSkillPolicyHost({ reportFile: index >= 0 ? process.argv[index + 1] : undefined })
    .then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
