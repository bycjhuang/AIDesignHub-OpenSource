'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

function resolveKnowledgePayloadRoot({ appDir = path.resolve(__dirname, '../..'), resourcesPath, isPackaged = false } = {}) {
  if (isPackaged) {
    if (!resourcesPath || !path.isAbsolute(resourcesPath)) throw new TypeError('Installed knowledge runtime requires an absolute resourcesPath');
    return path.join(resourcesPath, 'knowledge');
  }
  return path.join(appDir, '.runtime', 'knowledge');
}

class KnowledgeWorkerClient {
  constructor({ payloadRoot = path.resolve(__dirname, '../../.runtime/knowledge'), nodeExe, dataDir, assetsDir, requestTimeout = 300000 } = {}) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('Knowledge worker requires an absolute dataDir');
    this.payloadRoot = path.resolve(payloadRoot);
    this.nodeExe = nodeExe || path.join(this.payloadRoot, 'node', 'node.exe');
    this.dataDir = dataDir;
    this.assetsDir = assetsDir;
    this.requestTimeout = requestTimeout;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.starting = null;
    this.ready = false;
    this.stderr = '';
    this.capabilities = null;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.runStart().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }

  async runStart() {
    const worker = path.join(this.payloadRoot, 'worker.cjs');
    if (!existsSync(this.nodeExe) || !existsSync(worker)) throw new Error('KNOWLEDGE_RUNTIME_MISSING: 知识库离线运行组件缺失，请修复完整安装包；原有资料已保留。');
    if (/electron(?:\.exe)?$/i.test(path.basename(this.nodeExe))) throw new Error('KNOWLEDGE_NODE_REQUIRED: Electron cannot host native knowledge dependencies');
    const env = { ...process.env, ADH_KNOWLEDGE_DATA_DIR: this.dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    if (this.assetsDir) env.ADH_KNOWLEDGE_ASSETS_DIR = this.assetsDir;
    else delete env.ADH_KNOWLEDGE_ASSETS_DIR;
    const child = spawn(this.nodeExe, [worker], { cwd: this.payloadRoot, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child = child;
    child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000); });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('KNOWLEDGE_WORKER_READY_TIMEOUT')), 30000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`KNOWLEDGE_WORKER_EXIT(${code}): ${this.stderr.slice(-1000)}`)));
      child.on('message', response => {
        if (response?.type === 'ready') {
          clearTimeout(timer); this.ready = true; this.capabilities = response.capabilities; resolve(response);
        } else if (response && this.pending.has(response.id)) {
          const item = this.pending.get(response.id); this.pending.delete(response.id); clearTimeout(item.timer);
          response.ok ? item.resolve(response.result) : item.reject(new Error(response.error || 'Knowledge worker request failed'));
        }
      });
    });
    child.on('exit', code => {
      this.ready = false; this.child = null; this.starting = null;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(`KNOWLEDGE_WORKER_EXIT(${code})`)); }
      this.pending.clear();
    });
    try { await ready; return await this.request('init', {}); }
    catch (error) { child.kill(); throw error; }
  }

  async request(method, args = {}) {
    if (!this.ready || !this.child) await this.start();
    const child = this.child;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`KNOWLEDGE_REQUEST_TIMEOUT: ${method}`)); }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, method, args }, error => {
        if (!error) return;
        const item = this.pending.get(id); if (!item) return;
        clearTimeout(item.timer); this.pending.delete(id); item.reject(error);
      });
    });
  }

  async close() {
    const child = this.child;
    this.ready = false;
    if (!child) return;
    if (child.connected) child.disconnect();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (this.child === child) child.kill();
  }
}

module.exports = { KnowledgeWorkerClient, resolveKnowledgePayloadRoot };
