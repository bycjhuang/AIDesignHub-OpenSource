'use strict';

// Read-only discovery. Never execute Agent binaries, PATH shims or read auth files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { windowsInstallationInventory } = require('./agent-installation-inventory.cjs');
const RECIPES = [
  { provider: 'deepseek', label: 'DeepSeek Harness · ACP', name: '@deepseek-ai/dsh', bin: 'dsh', entry: 'lib/bin.js', mode: 'acp', args: ['--profile', 'acp'], help: ['--help'] },
  { provider: 'openclaw', label: 'OpenClaw · CLI', name: 'openclaw', bin: 'openclaw', entry: 'openclaw.mjs', mode: 'cli', args: ['agent', '--agent', 'main', '--session-id', '{sessionId}', '--message-file', '{promptFile}', '--json'], help: ['agent', '--help'] },
];
const LABELS = { deepseek: 'DeepSeek Harness', openclaw: 'OpenClaw', hermes: 'Hermes Agent', chatgpt: 'ChatGPT / OpenAI 桌面端', zcode: 'ZCode' };
function file(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function textFile(p, maxBytes = 256 * 1024) { try { const stat = fs.statSync(p); return stat.isFile() && stat.size <= maxBytes ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } }
function boundedJson(p) { try { return JSON.parse(textFile(p)); } catch { return null; } }
function children(p, limit = 48) { try { return fs.readdirSync(p, { withFileTypes: true }).filter(x => x.isDirectory() && !x.isSymbolicLink()).slice(0, limit).map(x => path.join(p, x.name)); } catch { return []; } }
function unique(values) { return [...new Set(values.filter(x => x && path.isAbsolute(x)))]; }
function directories(env, platform) {
  const values = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').map(value => value.trim().replace(/^"|"$/g, ''));
  if (env.APPDATA) values.push(path.join(env.APPDATA, 'npm'));
  if (env.USERPROFILE || env.HOME) values.push(path.join(env.USERPROFILE || env.HOME, '.local', 'bin'));
  return unique(values).slice(0, 256);
}
function packageRuntime(recipe, directory, nodePaths, platform) {
  const root = path.join(directory, 'node_modules', recipe.name);
  const manifest = boundedJson(path.join(root, 'package.json'));
  if (!manifest || manifest.name !== recipe.name) return null;
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[recipe.bin];
  if (typeof bin !== 'string' || bin.replace(/\\/g, '/').replace(/^\.\//, '') !== recipe.entry) return null;
  const entry = path.join(root, recipe.entry);
  const adjacentNode = path.join(directory, platform === 'win32' ? 'node.exe' : 'node');
  const command = file(adjacentNode) ? adjacentNode : nodePaths[0];
  return command && file(entry) ? { command, entry, version: String(manifest.version || '').slice(0, 100), root } : null;
}
function candidate(provider, source, fields = {}) {
  const config = fields.config;
  return { id: crypto.createHash('sha256').update(`${provider}:${source}`).digest('hex').slice(0, 16), provider,
    label: LABELS[provider], installed: true, status: 'detected', source, version: '', kind: 'runtime',
    protocol: config?.mode || null, connectionState: config ? 'not-paired' : 'client-authorization-required',
    modelVerified: false, pairingSupported: !!config, pairable: !!config, evidence: [], limitations: [], ...fields };
}
function hermesScripts(env, platform, dirs) {
  const scripts = platform === 'win32' ? 'Scripts' : 'bin';
  const roots = [], home = env.USERPROFILE || env.HOME;
  if (home) roots.push(path.join(home, '.local', 'pipx', 'venvs'), path.join(home, 'pipx', 'venvs'), path.join(home, '.local', 'share', 'uv', 'tools'));
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'uv', 'tools'));
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'uv', 'tools'));
  const result = dirs.map(directory => ({ directory, kind: 'path' }));
  for (const root of unique(roots)) for (const pkg of children(root).filter(p => /hermes/i.test(path.basename(p)))) result.push({ directory: path.join(pkg, scripts), kind: 'python-tool' });
  if (env.APPDATA) for (const version of children(path.join(env.APPDATA, 'Python'), 12)) result.push({ directory: path.join(version, scripts), kind: 'python-user' });
  if (env.LOCALAPPDATA) for (const version of children(path.join(env.LOCALAPPDATA, 'Programs', 'Python'), 12)) result.push({ directory: path.join(version, scripts), kind: 'python-user' });
  const installRoots = unique([env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'hermes', 'installs'), home && path.join(home, '.hermes', 'installs')]);
  for (const root of installRoots) for (const install of children(root, 12)) for (const generation of children(path.join(install, 'environments'), 8)) result.push({ directory: path.join(generation, 'venv', scripts), kind: 'hermes-installer', install });
  return result;
}
function hermesMetadata(directory, platform) {
  const venv = path.dirname(directory);
  const sites = platform === 'win32' ? [path.join(venv, 'Lib', 'site-packages')] : children(path.join(venv, 'lib'), 8).map(p => path.join(p, 'site-packages'));
  for (const site of sites) for (const info of children(site, 1024).filter(p => /^hermes[_-]agent[-_].*\.dist-info$/i.test(path.basename(p)))) {
    const points = textFile(path.join(info, 'entry_points.txt'), 16384);
    const metadata = textFile(path.join(info, 'METADATA'));
    if (/^hermes\s*=\s*hermes_cli\.main:main\s*$/m.test(points) && /^Name:\s*hermes-agent\s*$/m.test(metadata)) return { version: metadata.match(/^Version:\s*([^\r\n]+)/m)?.[1] || '', path: info, acp: /^hermes-acp\s*=\s*acp_adapter\.entry:main\s*$/m.test(points) };
  }
  return null;
}
function desktopEntries(env, inventory) {
  const paths = [];
  const add = (provider, executable, kind, version = '', label, product) => { if (executable && path.isAbsolute(executable) && file(executable)) paths.push({ provider, executable, kind, version, label, product }); };
  for (const base of unique([env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']])) {
    for (const [provider, dir, exe] of [['deepseek', 'DeepSeek Harness', 'DeepSeek Harness.exe'], ['deepseek', 'DSH Desktop', 'DSH Desktop.exe'], ['zcode', 'ZCode', 'ZCode.exe'], ['chatgpt', 'ChatGPT', 'ChatGPT.exe'], ['hermes', 'Hermes', 'Hermes.exe']]) add(provider, path.join(base, dir, exe), 'known-directory');
  }
  for (const row of inventory.items || []) {
    const name = String(row.name || '');
    const provider = /^(DeepSeek Harness|DSH Desktop)( |$)/i.test(name) ? 'deepseek' : /^ZCode( |$)/i.test(name) ? 'zcode' : /^(OpenAI\.(ChatGPT|Codex)|ChatGPT)( |$)/i.test(name) ? 'chatgpt' : /^Hermes( |$)/i.test(name) ? 'hermes' : null;
    if (!provider) continue;
    const label = name === 'OpenAI.Codex' ? 'OpenAI Codex 桌面端（ChatGPT.exe）' : undefined;
    const icon = String(row.icon || '').replace(/^"/, '').replace(/"(?:,\s*-?\d+)?$/, '').replace(/,\s*-?\d+$/, '');
    if (/\.exe$/i.test(icon)) add(provider, icon, row.kind, row.version, label, name);
    if (provider === 'zcode' && /\.ico$/i.test(icon) && path.isAbsolute(icon)) add(provider, path.join(path.dirname(icon), 'ZCode.exe'), row.kind, row.version, label, name);
    if (row.directory && path.isAbsolute(row.directory)) for (const exe of provider === 'chatgpt' ? ['ChatGPT.exe', 'app/ChatGPT.exe', 'Codex.exe', 'app/Codex.exe'] : [`${provider === 'zcode' ? 'ZCode' : provider === 'deepseek' ? 'DeepSeek Harness' : 'Hermes'}.exe`]) {
      const executable = path.join(row.directory, exe);
      if (file(executable)) { add(provider, executable, row.kind, row.version, label, name); break; }
    }
  }
  return paths;
}
function discoverAgentRuntimes({ env = process.env, platform = process.platform, clock = Date.now, windowsInventory, includeSystemInventory = env === process.env } = {}) {
  const dirs = directories(env, platform);
  const nodePaths = dirs.map(dir => path.join(dir, platform === 'win32' ? 'node.exe' : 'node')).filter(file);
  const candidates = [], seen = new Set(), warnings = [];
  const add = item => {
    const key = `${item.provider}:${item.source.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); candidates.push(item); }
    else {
      const existing = candidates.find(value => `${value.provider}:${value.source.toLowerCase()}` === key);
      if (!existing.version && item.version) existing.version = item.version;
      if (!existing.product && item.product) existing.product = item.product;
      for (const evidence of item.evidence) if (!existing.evidence.some(x => x.kind === evidence.kind && x.path === evidence.path)) existing.evidence.push(evidence);
    }
  };
  for (const recipe of RECIPES) for (const directory of dirs) {
    const runtime = packageRuntime(recipe, directory, nodePaths, platform);
    if (!runtime) continue;
    add(candidate(recipe.provider, runtime.entry, { label: recipe.label, version: runtime.version,
      note: '已找到本机运行入口；配对前不启动，配对后仍需单独验证模型是否可用。', evidence: [{ kind: 'npm-package', path: path.join(runtime.root, 'package.json') }],
      config: { provider: recipe.provider, label: recipe.label, mode: recipe.mode, command: runtime.command, args: [runtime.entry, ...recipe.args], cwd: '', timeoutMs: 300000 } }));
  }
  for (const location of hermesScripts(env, platform, dirs)) {
    const cli = path.join(location.directory, platform === 'win32' ? 'hermes.exe' : 'hermes');
    if (!file(cli)) continue;
    const metadata = hermesMetadata(location.directory, platform);
    // The official bootstrap registry plus installed package metadata distinguish an installation from a downloaded source directory.
    if (location.kind === 'hermes-installer' && (!metadata || !file(path.join(path.dirname(location.directory), 'pyvenv.cfg')))) continue;
    const acp = path.join(location.directory, platform === 'win32' ? 'hermes-acp.exe' : 'hermes-acp');
    const mode = metadata?.acp && file(acp) ? 'acp' : 'cli', command = mode === 'acp' ? acp : cli;
    const projectRoot = location.install ? textFile(path.join(location.install, 'inputs', '.project-root'), 4096).trim() : '';
    add(candidate('hermes', command, { label: `Hermes Agent · ${mode.toUpperCase()}`, version: metadata?.version || '',
      note: metadata ? '已定位 Hermes 的隔离 Python 安装环境，无需加入 PATH；可配对并验证协议。' : '已定位 Hermes 启动文件；配对时仍需检查 CLI 版本和来源。',
      evidence: [{ kind: location.kind, path: command }, ...(metadata ? [{ kind: 'python-package', path: metadata.path }] : []), ...(path.isAbsolute(projectRoot) && file(path.join(projectRoot, 'pyproject.toml')) ? [{ kind: 'registered-source', path: projectRoot }] : [])],
      supportedProtocols: mode === 'acp' ? ['acp', 'cli'] : ['cli'],
      config: { provider: 'hermes', label: `Hermes Agent · ${mode.toUpperCase()}`, mode, command, args: mode === 'acp' ? [] : ['chat', '--query-file', '{promptFile}', '--oneshot', '--format', 'stream-json'], cwd: '', timeoutMs: 300000 } }));
  }
  let inventory = windowsInventory || { items: [], warnings: [] };
  if (!windowsInventory && includeSystemInventory && platform === 'win32') inventory = windowsInstallationInventory({ env });
  warnings.push(...(inventory.warnings || []));
  for (const app of desktopEntries(env, inventory)) add(candidate(app.provider, app.executable, { kind: 'desktop', protocol: 'mcp', label: app.label || `${LABELS[app.provider]} · 桌面应用`, product: app.product || '', version: String(app.version || '').slice(0, 100),
    note: '已安装桌面应用。是否可接入取决于该客户端提供的 MCP / 插件入口；不会把桌面程序当成 CLI 执行器。',
    evidence: [{ kind: app.kind, path: app.executable }], limitations: ['需在客户端完成 MCP 授权或配对；安装不等于已经连接。', '此桌面入口不能用于 Hub 主动派单。'] }));
  for (const [provider, label] of Object.entries(LABELS)) if (!candidates.some(item => item.provider === provider)) candidates.push({ id: `${provider}-missing`, provider, label, installed: false, status: 'missing', kind: 'missing', source: '', version: '', protocol: null, connectionState: 'unavailable', modelVerified: false, pairable: false, pairingSupported: false, evidence: [], limitations: [],
    note: '本次未定位安装入口，不等于未安装。检查范围包含 PATH、用户 Python / uv / pipx、Hermes 安装环境及 Windows 应用登记。' });
  return { checkedAt: clock(), candidates, warnings: [...warnings, '只读检测不会启动 Agent、读取登录凭据或自动修改外部客户端；发现安装、配对协议和模型可用是三个不同状态。'] };
}
function safeCliProbe(connection) {
  const recipe = RECIPES.find(item => item.provider === connection.provider);
  const entry = connection.args?.[0];
  if (recipe && typeof entry === 'string' && path.isAbsolute(entry)) {
    const root = path.resolve(entry, ...recipe.entry.split('/').map(() => '..'));
    const manifest = boundedJson(path.join(root, 'package.json'));
    const declared = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.[recipe.bin];
    if (manifest?.name === recipe.name && declared?.replace(/\\/g, '/').replace(/^\.\//, '') === recipe.entry && path.resolve(root, recipe.entry) === path.resolve(entry) && file(entry)) return { ...connection, args: [entry, ...recipe.help], outputFormat: 'text' };
  }
  if (connection.provider === 'hermes' && /^hermes(?:\.exe)?$/i.test(path.basename(connection.command || ''))) return { ...connection, args: ['chat', '--help'], outputFormat: 'text' };
  return null;
}
module.exports = { discoverAgentRuntimes, safeCliProbe };
