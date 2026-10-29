'use strict';

// Device pairing stores only fingerprints of locally discovered launch recipes.
// Never copy external client auth, project grants, working directories or model
// verification between the normal and demo project databases.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const SUPPORTED = new Set(['deepseek', 'openclaw', 'hermes']);
const copy = value => JSON.parse(JSON.stringify(value));
function fingerprint(config) {
  return crypto.createHash('sha256').update(JSON.stringify({ provider: config.provider, mode: config.mode, command: config.command, args: config.args || [] })).digest('hex');
}
function pairable(candidate) {
  return candidate?.installed === true && candidate.pairable !== false && SUPPORTED.has(candidate.provider)
    && candidate.config?.provider === candidate.provider && ['cli', 'acp'].includes(candidate.config.mode)
    && typeof candidate.config.command === 'string' && path.isAbsolute(candidate.config.command)
    && Array.isArray(candidate.config.args) && !candidate.config.cwd && !candidate.config.endpoint && !candidate.config.tokenEnv;
}
function placeholder(connection) { return ['inbound', 'handoff'].includes(connection.mode) && !connection.command && !connection.endpoint; }
class AgentPairingService extends EventEmitter {
  constructor({ hub, dataDir, clock = Date.now, planner = null }) {
    super();
    this.hub = hub; this.clock = clock; this.busy = new Set();
    this.planner = planner; this.running = false; this.disposed = false; this.progress = { stage: 'idle', message: '尚未运行自动配置。' };
    if (!path.isAbsolute(dataDir || '')) throw new Error('需要本机配对设置目录。');
    this.directory = dataDir; this.file = path.join(dataDir, 'agent-pairings.json');
  }
  assertActive() { if (this.disposed || this.hub.disposed) throw Object.assign(new Error('连接助手已停止。'), { code: 'SETUP_STOPPED' }); }
  dispose() { this.disposed = true; }
  read() {
    if (fs.existsSync(this.directory) && fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('配对目录不能是链接。');
    if (!fs.existsSync(this.file)) return [];
    if (fs.lstatSync(this.file).isSymbolicLink() || fs.statSync(this.file).size > 65536) throw new Error('配对设置文件无效。');
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.pairings) || data.pairings.length > 100) throw new Error('配对设置格式无效。');
    return data.pairings.filter(p => p && SUPPORTED.has(p.provider) && /^[a-f0-9]{64}$/.test(p.fingerprint) && Number.isFinite(p.pairedAt))
      .map(({ provider, fingerprint, pairedAt }) => ({ provider, fingerprint, pairedAt }));
  }
  remember(candidate) {
    const entries = this.read(), digest = fingerprint(candidate.config);
    const next = [...entries.filter(p => p.fingerprint !== digest), { provider: candidate.provider, fingerprint: digest, pairedAt: this.clock() }].slice(-100);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.pairings-${crypto.randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, pairings: next }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  connectionFor(candidate) {
    return this.hub.state.connections.find(connection => !connection.cwd && !connection.endpoint && !connection.tokenEnv
      && fingerprint(connection) === fingerprint(candidate.config));
  }
  save(candidate) {
    this.assertActive();
    const existing = this.connectionFor(candidate);
    if (existing) return existing;
    const empty = this.hub.state.connections.find(connection => connection.provider === candidate.provider && placeholder(connection));
    // Keep a user's custom configuration. Only replace the untouched catalog card.
    return this.hub.saveConnection({ ...candidate.config, ...(empty ? { id: empty.id } : {}) });
  }
  restore(legacyConnections = []) {
    const report = { restored: [], skipped: [], warning: '' };
    try {
      const remembered = this.read();
      if (!remembered.length && !legacyConnections.length) return report;
      const candidates = this.hub.discoverRuntimes().candidates.filter(pairable);
      for (const candidate of candidates) {
        const digest = fingerprint(candidate.config);
        const old = legacyConnections.find(connection => connection.provider === candidate.provider
          && !connection.cwd && !connection.endpoint && !connection.tokenEnv && fingerprint(connection) === digest);
        if (!remembered.some(p => p.fingerprint === digest) && !old) continue;
        const configured = this.hub.state.connections.filter(connection => connection.provider === candidate.provider && !placeholder(connection));
        if (configured.length) { report.skipped.push(candidate.provider); continue; }
        const saved = this.save(candidate);
        if (old) this.remember(candidate);
        report.restored.push({ provider: candidate.provider, connectionId: saved.id });
      }
    } catch { report.warning = '本机历史配对未自动恢复；原配置保留，可重新检测并配对。'; }
    return report;
  }
  async pair(input = {}) {
    this.assertActive();
    if (input.confirmLaunch !== true) throw new Error('请确认启动所选本机程序进行无模型连接检查。');
    if (typeof input.candidateId !== 'string' || input.candidateId.length > 200) throw new Error('请选择刚检测到的执行器。');
    if (this.busy.has(input.candidateId)) throw new Error('此执行器正在配对，请等待。');
    const candidate = this.hub.discoverRuntimes().candidates.find(item => item.id === input.candidateId);
    if (!pairable(candidate)) throw new Error('没有可自动配对的 CLI / ACP 入口。桌面应用请按客户端的 MCP 接入步骤授权。');
    this.busy.add(input.candidateId);
    try {
      const saved = this.save(candidate);
      const validation = await this.hub.probeConnection(saved.id);
      this.assertActive();
      let remembered = false;
      if (validation.ok && !validation.stale && ['cli', 'protocol'].includes(validation.level)) {
        try { this.remember(candidate); remembered = true; } catch { /* Pairing works even if persistence is unavailable; disclose it. */ }
      }
      return { ok: validation.ok && !validation.stale && ['cli', 'protocol'].includes(validation.level), connection: copy(this.hub.connection(saved.id)), validation, remembered,
        message: `${validation.message}${remembered ? ' 本机配对已记住，切换项目无需重复配置。' : validation.ok ? ' 尚未记住本机配对，重启后可能需要重新检查。' : ''}` };
    } finally { this.busy.delete(input.candidateId); }
  }
  update(stage, message, extra = {}) { if (this.disposed) return; this.progress = { stage, message, ...extra }; this.emit('progress', copy(this.progress)); }
  async autoPair({ confirmed = false, useModel = true } = {}) {
    this.assertActive();
    if (confirmed !== true) throw new Error('请确认由连接助手检测并启动受支持入口进行配对；不会派发项目任务。');
    if (this.running) throw new Error('自动配置正在进行，请等待本轮完成。');
    this.running = true;
    const results = [], needsUserAction = [];
    try {
      this.update('discovering', '正在识别已安装软件和受支持的启动入口…');
      const discovery = this.hub.discoverRuntimes();
      let candidates = discovery.candidates.filter(pairable), modelAssisted = false, plannerWarning = '';
      if (useModel && this.planner && candidates.length) {
        this.update('planning', 'DesignHub 正在根据软件名称、版本和接口选择配对顺序，不发送项目文件或密钥…');
        try {
          const plan = await this.planner({ candidates: discovery.candidates.map(c => ({ id: c.id, provider: c.provider, installed: c.installed, mode: c.config?.mode || 'inbound', version: c.version || '', pairable: pairable(c) })) });
          const ids = Array.isArray(plan?.candidateIds) ? plan.candidateIds : [];
          if (new Set(ids).size !== ids.length || ids.some(id => !candidates.some(c => c.id === id))) throw new Error('invalid candidate plan');
          candidates = [...ids.map(id => candidates.find(c => c.id === id)), ...candidates.filter(c => !ids.includes(c.id))];
          modelAssisted = true;
        } catch { plannerWarning = '内置模型暂未参与本次规划，已继续使用本机受控配对规则。'; }
      }
      this.assertActive();
      for (const provider of ['deepseek', 'openclaw', 'hermes', 'chatgpt', 'zcode']) {
        this.assertActive();
        const installed = discovery.candidates.filter(c => c.provider === provider && c.installed);
        const choices = candidates.filter(c => c.provider === provider).slice(0, 3);
        if (!choices.length) {
          const item = { provider, ok: false, code: installed.length ? 'CLIENT_AUTHORIZATION_REQUIRED' : 'INSTALLATION_NOT_FOUND',
            message: installed.length ? '已找到桌面应用，需通过它支持的 MCP 接入与授权流程完成连接；不会把应用安装误报为可主动派单。' : '暂未找到可用安装入口，已检查受支持的安装位置。' };
          results.push(item); needsUserAction.push(item); continue;
        }
        let completed = false;
        const attempts = [];
        for (const candidate of choices) {
          this.assertActive();
          this.update('pairing', `正在配对 ${candidate.label}；只做启动和协议检查…`, { provider, attempt: attempts.length + 1 });
          let result;
          try { result = await this.pair({ candidateId: candidate.id, confirmLaunch: true }); }
          catch { result = { ok: false, message: '此安装入口暂未通过检查，将尝试已发现的兼容备选入口。', code: 'PAIRING_FAILED' }; }
          this.assertActive();
          attempts.push({ candidateId: candidate.id, ok: result.ok, code: result.validation?.code || result.code });
          if (result.ok && ['cli', 'protocol'].includes(result.validation?.level)) {
            results.push({ provider, label: candidate.label, ...result, attempts }); completed = true; break;
          }
          this.update('repairing', `正在为 ${candidate.label} 检查另一条已安装入口，不修改外部账号或安全设置…`, { provider });
        }
        if (!completed) {
          const item = { provider, ok: false, code: 'PAIRING_NEEDS_ATTENTION', attempts, message: '已自动尝试发现的兼容入口，仍未完成协议检查；登录或账号授权需要在原客户端完成。' };
          results.push(item); needsUserAction.push(item);
        }
      }
      const paired = results.filter(r => r.ok).length;
      const summary = `${paired} 个执行器已完成启动／协议配对，${needsUserAction.length} 个需要后续处理。配对不等于模型任务验证。${plannerWarning}`;
      this.update('complete', summary, { results, needsUserAction, modelAssisted });
      return { ok: needsUserAction.length === 0, discovery, results, needsUserAction, modelAssisted, summary };
    } catch { this.update('failed', '自动检测未完成；现有模型与项目配置保留，可重试。'); throw new Error(this.progress.message); }
    finally { this.running = false; }
  }
}
module.exports = { AgentPairingService, fingerprint, pairable };
