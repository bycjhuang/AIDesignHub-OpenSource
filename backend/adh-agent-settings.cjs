'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CATALOG, SCOPES } = require('./agent-hub.cjs');
const { buildClientConfig } = require('./client-config.cjs');
const { normalizeProgress } = require('./adh-collaboration.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const list = value => Array.isArray(value) ? value : [];
const fault = (code, message) => Object.assign(new Error(message), { code });
const MASK = '[已保护]';
const fields = ['id', 'provider', 'label', 'mode', 'command', 'args', 'cwd', 'endpoint', 'agentId', 'tokenEnv', 'timeoutMs'];
const ACTIONS = new Set(['collaboration_settings', 'collaboration_run', 'runtime_discover', 'runtime_pair', 'runtime_auto_pair', 'connection_save', 'connection_probe', 'connection_test', 'gateway_toggle', 'grant_create_copy', 'grant_revoke', 'client_config']);
const mutations = new Set(['runtime_pair', 'runtime_auto_pair', 'connection_save', 'connection_probe', 'connection_test', 'gateway_toggle', 'grant_create_copy', 'grant_revoke']);
const secretFlag = value => /^--?(?:api[-_]?key|token|access[-_]?token|secret|password|passwd|authorization|credential|auth)(?:=|$)/i.test(value);
const containsSecret = value => /(?:\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}|(?:api[-_]?key|access[-_]?token|password|secret)\s*[=:]\s*[^\s,;]+|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(value);
const safeMessage = value => typeof value === 'string' ? value.replace(/\bBearer\s+\S+/gi, 'Bearer [已保护]').replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, MASK).replace(/((?:api[-_]?key|access[-_]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, `$1${MASK}`).slice(0, 1500) : '';
function safeArgs(args) {
  let hiddenNext = false;
  return list(args).map(arg => {
    const text = String(arg);
    if (hiddenNext) { hiddenNext = false; return MASK; }
    if (secretFlag(text)) { if (text.includes('=')) return MASK; hiddenNext = true; return text; }
    return containsSecret(text) ? MASK : text;
  });
}
function safeValidation(value) {
  if (!value) return null;
  const result = {}; for (const key of ['ok', 'verified', 'level', 'code', 'modelCalled', 'checkedAt', 'stale', 'phase']) if (value[key] !== undefined) result[key] = value[key];
  result.message = safeMessage(value.message); return result;
}
function safeConnection(value) {
  const result = {}; for (const field of fields) if (value[field] !== undefined) result[field] = value[field];
  result.args = safeArgs(value.args); if (containsSecret(String(value.endpoint || ''))) result.endpoint = MASK;
  result.revision = value.revision; result.verifiedAt = value.verifiedAt || null; result.validation = safeValidation(value.validation);
  result.protectedFields = [...(result.args.some(arg => arg === MASK) ? ['args'] : []), ...(result.endpoint === MASK ? ['endpoint'] : [])];
  return copy(result);
}
function safeGrant(value) {
  const result = {}; for (const field of ['id', 'label', 'projectId', 'memberId', 'scopes', 'createdAt', 'expiresAt', 'revokedAt', 'lastCallAt', 'lastTool', 'callCount']) if (value[field] !== undefined) result[field] = value[field];
  return result;
}
const safeOutput = value => String(value || '').slice(0, 500000).replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已保护]').replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, MASK).replace(/((?:"?(?:api[-_]?key|access[-_]?token|token|password|secret)"?)\s*[:=]\s*")([^"\n]+)(")/gi, `$1${MASK}$3`);
class AdhAgentSettings {
  constructor(service) { this.service = service; this.backend = service.backend; this.hub = service.hub; }
  canConfigure() { try { this.service.assertLocalAgentSettings(); return true; } catch { return false; } }
  gateway() { const value = this.service.gatewayStatus?.() || { running: Boolean(this.hub.gateway), url: this.hub.gateway?.url || '' }; return { running: value.running === true, url: value.running ? value.url || '' : '' }; }
  progress() { const value = this.service.agentPairing?.progress || {}; return { stage: value.stage || 'idle', message: safeMessage(value.message || '尚未运行自动配置。'), running: this.service.agentPairing?.running === true }; }
  snapshot() {
    const projectId = this.backend.projectId(), project = this.backend.store.projects.find(item => item.id === projectId);
    return { project: { id: projectId, name: project?.name || '' }, catalog: copy(CATALOG), connections: this.hub.state.connections.map(safeConnection), progress: this.progress(), gateway: this.gateway(),
      grants: this.hub.access.grants.filter(item => item.projectId === projectId && !item.temporary).map(safeGrant),
      members: this.backend.store.members.filter(item => item.projectId === projectId && item.active !== false).map(({ id, name, role }) => ({ id, name, role })), scopes: [...SCOPES],
      capabilities: { canConfigure: this.canConfigure(), pairingAvailable: Boolean(this.service.agentPairing), clipboardAvailable: typeof this.service.clipboard?.writeText === 'function' } };
  }
  discovery(value) {
    return { scannedAt: value.scannedAt || value.discoveredAt || Date.now(), limitations: list(value.limitations).map(safeMessage), candidates: list(value.candidates).map(item => ({
      id: item.id, provider: item.provider, label: item.label, installed: item.installed === true, pairable: item.pairable !== false && item.pairingSupported !== false && Boolean(item.config),
      version: item.version || '', protocol: item.protocol || item.config?.mode || null, source: item.source || '', status: item.status || '',
      limitations: list(item.limitations).map(safeMessage), ...(item.config ? { config: safeConnection(item.config) } : {}),
    })) };
  }
  pairingResult(value) {
    return { ok: value.ok === true, ...(value.connection ? { connection: safeConnection(value.connection) } : {}), ...(value.validation ? { validation: safeValidation(value.validation) } : {}),
      ...(value.remembered !== undefined ? { remembered: value.remembered } : {}), message: safeMessage(value.message), provider: value.provider, label: value.label, code: value.code };
  }
  backup(connection) {
    if (!connection) return false;
    const directory = path.join(this.backend.dataDir, 'adh-connection-backups'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ version: 1, savedAt: Date.now(), connection }, null, 2), { mode: 0o600, flag: 'wx' }); return true;
  }
  save(args) {
    const input = args.connection; if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('INVALID_CONNECTION', '请填写有效的执行器配置。');
    if (Object.keys(input).some(key => /^(token|password|secret|apiKey|env|headers|credentials)$/i.test(key))) throw fault('SECRET_INPUT', '凭据请保存在执行器或环境变量中，不在此填写密钥。');
    const original = input.id ? this.hub.connection(input.id) : null;
    if (original && input.revision && input.revision !== original.revision) throw fault('CONNECTION_CHANGED', '连接配置已变化，请重新读取后保存。');
    const config = original ? copy(original) : {};
    for (const field of fields) if (input[field] !== undefined) config[field] = input[field];
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(item => typeof item !== 'string'))) throw fault('INVALID_CONNECTION', '启动参数需要使用文字数组。');
    if (!Array.isArray(config.args)) config.args = [];
    const hidden = original ? safeArgs(original.args) : [];
    config.args = config.args.map((arg, index) => {
      if (arg === MASK) { if (!original || hidden[index] !== MASK) throw fault('SECRET_INPUT', '受保护的启动参数不能新增或移动，请使用环境变量。'); return original.args[index]; }
      if (typeof arg !== 'string' || containsSecret(arg) || secretFlag(arg) && arg.includes('=')) throw fault('SECRET_INPUT', '启动参数中不要填写密钥，请改为执行器自身配置或环境变量。');
      if (index && secretFlag(config.args[index - 1]) && !(original && arg === original.args[index])) throw fault('SECRET_INPUT', '敏感参数请在执行器自身配置中管理。');
      return arg;
    });
    if (config.endpoint === MASK && original && containsSecret(original.endpoint || '')) config.endpoint = original.endpoint;
    else if (containsSecret(String(config.endpoint || ''))) throw fault('SECRET_INPUT', 'Gateway 地址不能包含密码或密钥。');
    const backupSaved = this.backup(original), connection = this.hub.saveConnection(config);
    return { connection: safeConnection(connection), backupSaved, message: '连接配置已保存，尚未派发任务。' };
  }
  clientConfig(transport = 'stdio', token) {
    const bridge = this.hub.gateway || {};
    return buildClientConfig({ transport, gateway: this.gateway(), command: bridge.command, mcpScript: bridge.mcpScript, token });
  }
  async handle(payload) {
    if (payload.caller !== 'client') throw fault('USER_ACTION_REQUIRED', '接入设置只能通过 Agent 协作中心的按钮操作。');
    const args = payload.arguments || {}, projectId = this.backend.projectId();
    if (payload.projectId && payload.projectId !== projectId) throw fault('PROJECT_CHANGED', '项目已切换，请重新打开接入设置。');
    if (payload.action === 'collaboration_settings') return this.snapshot();
    if (payload.action === 'collaboration_run') {
      const run = this.hub.state.runs.find(item => item.id === args.runId && item.projectId === projectId);
      if (!run) throw fault('RUN_SCOPE', '此任务不属于当前项目。');
      const labels = { queued: '等待执行', waiting_agent: '等待外部 Agent', running: '执行中', awaiting_review: '成果已返回，待人工审核', failed: '未完成', cancelled: '已取消', interrupted: '已中断', succeeded: '人工验收通过', rejected: '人工退回', cancel_requested: '已请求取消' };
      const job = this.hub.state.jobs.find(item => item.id === run.jobId && item.projectId === projectId);
      return { run: { id: run.id, runId: run.id, jobId: run.jobId, projectId, sessionId: run.adhSessionId || null, connectionId: run.connectionId, title: job?.title || run.input?.title || '协作任务', status: run.status, statusLabel: labels[run.status] || run.status, output: safeOutput(run.output), error: safeMessage(run.error), createdAt: run.createdAt, updatedAt: run.updatedAt },
        events: this.hub.state.events.filter(item => item.projectId === projectId && item.runId === run.id).slice(-100).map(item => ({ id: item.id, type: item.type, message: normalizeProgress(item.message), createdAt: item.createdAt })).filter(item => item.message) };
    }
    this.service.assertLocalAgentSettings();
    if (mutations.has(payload.action) && (args.confirmed !== true && !(['runtime_pair', 'connection_probe'].includes(payload.action) && args.confirmLaunch === true))) throw fault('USER_ACTION_REQUIRED', '请通过接入设置按钮确认本次操作。');
    switch (payload.action) {
      case 'runtime_discover': return this.discovery(this.hub.discoverRuntimes());
      case 'connection_save': return this.save(args);
      case 'connection_probe': return { validation: safeValidation(await this.hub.probeConnection(args.connectionId)) };
      case 'connection_test': {
        if (args.confirmed !== true || args.allowModel !== true) throw fault('MODEL_CONFIRMATION_REQUIRED', '最小测试会调用执行器模型，请在确认提示后再运行。');
        return { validation: safeValidation(await this.hub.testConnection(args.connectionId)) };
      }
      case 'runtime_pair': {
        if (!this.service.agentPairing) throw fault('PAIRING_UNAVAILABLE', '连接助手尚未就绪。');
        return this.pairingResult(await this.service.agentPairing.pair({ candidateId: args.candidateId, confirmLaunch: true }));
      }
      case 'runtime_auto_pair': {
        if (!this.service.agentPairing) throw fault('PAIRING_UNAVAILABLE', '连接助手尚未就绪。');
        const result = await this.service.agentPairing.autoPair({ confirmed: true, useModel: false });
        return { ok: result.ok, results: list(result.results).map(item => this.pairingResult(item)), needsUserAction: list(result.needsUserAction).map(item => this.pairingResult(item)), modelAssisted: false, summary: safeMessage(result.summary), discovery: this.discovery(result.discovery || {}) };
      }
      case 'gateway_toggle': {
        if (typeof args.enabled !== 'boolean' || !this.service.setGatewayEnabled) throw fault('GATEWAY_UNAVAILABLE', '本机工具入口尚未就绪。');
        await this.service.setGatewayEnabled(args.enabled); return { gateway: this.gateway() };
      }
      case 'client_config': return this.clientConfig(args.transport);
      case 'grant_revoke': {
        if (payload.projectId !== projectId) throw fault('PROJECT_CHANGED', '请从当前项目的接入设置操作授权。');
        const grant = this.hub.access.grants.find(item => item.id === args.grantId && item.projectId === projectId && !item.temporary);
        if (!grant) throw fault('GRANT_SCOPE', '授权不属于当前项目。'); return this.hub.revokeGrant(grant.id);
      }
      case 'grant_create_copy': {
        if (payload.projectId !== projectId) throw fault('PROJECT_CHANGED', '请从当前项目的接入设置创建授权。');
        if (typeof this.service.clipboard?.writeText !== 'function') throw fault('CLIPBOARD_UNAVAILABLE', '当前环境不能复制凭据，未创建新授权。');
        const mode = args.copy || 'config'; if (!['config', 'token'].includes(mode)) throw fault('INVALID_COPY', '请选择复制授权或完整配置。');
        if (!Array.isArray(args.scopes) || !args.scopes.length) throw fault('INVALID_SCOPES', '请明确选择本次授权的权限范围。');
        // Validate the gateway/template before minting a credential.
        if (mode === 'config') this.clientConfig(args.transport);
        const grant = this.hub.createGrant({ projectId, label: args.label, memberId: args.memberId, scopes: args.scopes, expiresInDays: args.expiresInDays });
        try {
          const value = mode === 'token' ? grant.token : JSON.stringify(this.clientConfig(args.transport, grant.token).config, null, 2);
          await this.service.clipboard.writeText(value);
          this.service.assertLocalAgentSettings(); if (this.backend.projectId() !== projectId) throw fault('PROJECT_CHANGED', '项目已切换，新授权已撤销。');
          return { copied: true, grant: safeGrant(grant), copy: mode, transport: mode === 'config' ? args.transport || 'stdio' : null, message: '已创建并复制到本机剪贴板，凭据不会显示在对话或页面中。' };
        } catch (error) {
          this.hub.revokeGrant(grant.id);
          throw fault(error.code === 'PROJECT_CHANGED' ? 'PROJECT_CHANGED' : 'CLIPBOARD_FAILED', error.code === 'PROJECT_CHANGED' ? error.message : '复制未完成，新授权已撤销；没有保留可用的新凭据。');
        }
      }
      default: throw fault('UNKNOWN_ACTION', '未知的接入设置操作。');
    }
  }
}
module.exports = { AdhAgentSettings, SETTINGS_ACTIONS: ACTIONS, safeConnection, safeGrant };
