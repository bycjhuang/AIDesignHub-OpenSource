'use strict';

const crypto = require('node:crypto');
const copy = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;

const MCP_SAVE_FIELDS = new Set(['id', 'name', 'description', 'transport', 'command', 'args', 'env', 'url', 'headers', 'scope', 'sourceAgent', 'enabledAgents', 'teamProjectId', 'teamAuthorName', 'status']);
const INSTR_SAVE_FIELDS = new Set(['id', 'name', 'content', 'category', 'scope', 'sourceAgent', 'enabledAgents', 'teamProjectId', 'teamAuthorName', 'version']);
const RTK_SAVE_FIELDS = new Set(['id', 'name', 'version', 'path', 'enabledAgents', 'scope', 'status']);

function text(value, label, max, required = false) {
  if (value === undefined || value === null) { if (required) throw new Error(`${label}不能为空。`); return ''; }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label}必须是最多 ${max} 字符的文本。`);
  const result = value.trim(); if (required && !result) throw new Error(`${label}不能为空。`); return result;
}

function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请提供资源记录对象。');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`不接受字段 ${key}。`);
}

function defaultLibrary() {
  return {
    local: { skills: [], mcpServers: [], instructions: [], rtk: null },
    team: { skills: [], mcpServers: [], instructions: [] },
    sync: { lastSyncAt: null, lastSyncError: null, pendingPush: [], pendingPull: [] },
  };
}

class ResourceLibrary {
  constructor({ backend }) {
    if (!backend?.store || typeof backend.mutate !== 'function') throw new Error('资源库需要本地项目数据库。');
    this.backend = backend;
    if (!backend.store.resourceLibrary) {
      backend.mutate(store => { store.resourceLibrary = defaultLibrary(); return true; });
    }
    const lib = this.state;
    if (!lib.local || !lib.team || !lib.sync) {
      backend.mutate(store => {
        const current = store.resourceLibrary || {};
        store.resourceLibrary = { local: { skills: [], mcpServers: [], instructions: [], rtk: null, ...current.local }, team: { skills: [], mcpServers: [], instructions: [], ...current.team }, sync: { lastSyncAt: null, lastSyncError: null, pendingPush: [], pendingPull: [], ...current.sync } };
        return true;
      });
    }
  }

  get state() { return this.backend.store.resourceLibrary; }

  member() {
    const id = this.backend.store.settings.currentMemberId;
    const projectId = this.backend.store.settings.currentProjectId;
    const member = this.backend.store.members.find(item => item.id === id && item.projectId === projectId && item.active !== false);
    if (!member) throw new Error('当前成员不是此项目的有效成员。');
    return member;
  }

  // --- MCP Servers ---

  saveMcpServer(payload) {
    object(payload, MCP_SAVE_FIELDS);
    const member = this.member();
    const scope = payload.scope || 'local';
    const transport = text(payload.transport || 'stdio', '传输方式', 20, true);
    if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error('传输方式必须是 stdio、http 或 sse。');
    const server = {
      id: payload.id || uid('mcp'),
      name: text(payload.name, '服务器名称', 120, true),
      description: text(payload.description, '说明', 2000),
      transport,
      command: text(payload.command, '命令', 500),
      args: Array.isArray(payload.args) ? payload.args.map(a => text(a, '参数', 500)) : [],
      env: payload.env && typeof payload.env === 'object' ? payload.env : {},
      url: text(payload.url, 'URL', 500),
      headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
      scope,
      sourceAgent: text(payload.sourceAgent, '来源 Agent', 80),
      enabledAgents: Array.isArray(payload.enabledAgents) ? payload.enabledAgents : [],
      teamProjectId: scope === 'team' ? text(payload.teamProjectId, '团队项目 ID', 120) : null,
      teamAuthorName: scope === 'team' ? text(payload.teamAuthorName, '贡献者', 80) : member.name,
      status: payload.status || 'inactive',
      lastHealthCheck: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return this.backend.mutate(store => {
      const list = scope === 'team' ? store.resourceLibrary.team.mcpServers : store.resourceLibrary.local.mcpServers;
      const index = list.findIndex(item => item.id === server.id);
      if (index < 0) list.push(server); else { server.createdAt = list[index].createdAt; list[index] = server; }
      return server;
    });
  }

  listMcpServers(scope) {
    const lib = this.state;
    if (scope === 'team') return copy(lib.team.mcpServers);
    if (scope === 'local') return copy(lib.local.mcpServers);
    return [...copy(lib.local.mcpServers), ...copy(lib.team.mcpServers)];
  }

  removeMcpServer(id, scope = 'local') {
    return this.backend.mutate(store => {
      const list = scope === 'team' ? store.resourceLibrary.team.mcpServers : store.resourceLibrary.local.mcpServers;
      const index = list.findIndex(item => item.id === id);
      if (index < 0) throw new Error('MCP 服务器不存在。');
      return list.splice(index, 1)[0];
    });
  }

  // --- Instructions ---

  saveInstruction(payload) {
    object(payload, INSTR_SAVE_FIELDS);
    const member = this.member();
    const scope = payload.scope || 'local';
    const instr = {
      id: payload.id || uid('instr'),
      name: text(payload.name, '指令名称', 120, true),
      content: text(payload.content, '指令内容', 20000, true),
      category: text(payload.category || '通用', '分类', 80),
      version: text(payload.version || '1.0.0', '版本', 40),
      scope,
      sourceAgent: text(payload.sourceAgent, '来源 Agent', 80),
      enabledAgents: Array.isArray(payload.enabledAgents) ? payload.enabledAgents : [],
      teamProjectId: scope === 'team' ? text(payload.teamProjectId, '团队项目 ID', 120) : null,
      teamAuthorName: scope === 'team' ? text(payload.teamAuthorName, '贡献者', 80) : member.name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return this.backend.mutate(store => {
      const list = scope === 'team' ? store.resourceLibrary.team.instructions : store.resourceLibrary.local.instructions;
      const index = list.findIndex(item => item.id === instr.id);
      if (index < 0) list.push(instr); else { instr.createdAt = list[index].createdAt; list[index] = instr; }
      return instr;
    });
  }

  listInstructions(scope) {
    const lib = this.state;
    if (scope === 'team') return copy(lib.team.instructions);
    if (scope === 'local') return copy(lib.local.instructions);
    return [...copy(lib.local.instructions), ...copy(lib.team.instructions)];
  }

  removeInstruction(id, scope = 'local') {
    return this.backend.mutate(store => {
      const list = scope === 'team' ? store.resourceLibrary.team.instructions : store.resourceLibrary.local.instructions;
      const index = list.findIndex(item => item.id === id);
      if (index < 0) throw new Error('指令不存在。');
      return list.splice(index, 1)[0];
    });
  }

  // --- RTK ---

  getRtk() {
    return copy(this.state.local.rtk);
  }

  saveRtk(payload) {
    object(payload, RTK_SAVE_FIELDS);
    const rtk = {
      id: payload.id || uid('rtk'),
      name: text(payload.name || 'rtk', '名称', 80),
      version: text(payload.version, '版本', 40),
      path: text(payload.path, '路径', 500),
      enabledAgents: Array.isArray(payload.enabledAgents) ? payload.enabledAgents : [],
      scope: 'local',
      status: payload.status || 'not-installed',
    };
    return this.backend.mutate(store => { store.resourceLibrary.local.rtk = rtk; return rtk; });
  }

  removeRtk() {
    return this.backend.mutate(store => { const prev = store.resourceLibrary.local.rtk; store.resourceLibrary.local.rtk = null; return prev; });
  }

  // --- Snapshot (for UI) ---

  snapshot() {
    const lib = this.state;
    return {
      resourceLibrary: {
        local: copy(lib.local),
        team: copy(lib.team),
        sync: copy(lib.sync),
      },
    };
  }
}

module.exports = { ResourceLibrary };
