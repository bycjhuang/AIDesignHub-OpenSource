'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
}

const AGENTS = {
  qoder: {
    name: 'Qoder',
    configDir: () => path.join(os.homedir(), '.qoder-cn'),
    configFile: () => path.join(os.homedir(), '.qoder-cn', 'config.json'),
  },
  cursor: {
    name: 'Cursor',
    configDir: () => path.join(os.homedir(), '.cursor'),
    configFile: () => path.join(os.homedir(), '.cursor', 'config.json'),
  },
  claude: {
    name: 'Claude Code',
    configDir: () => path.join(os.homedir(), '.claude'),
    configFile: () => path.join(os.homedir(), '.claude', 'config.json'),
  },
};

function getAgentConfig(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`不支持的 Agent: ${agentId}`);
  return { agent, configPath: agent.configFile() };
}

function writeMcpServers(agentId, servers) {
  const { agent, configPath } = getAgentConfig(agentId);
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers || {};
  for (const server of servers) {
    const mcpConfig = { name: server.name };
    if (server.transport === 'stdio') {
      mcpConfig.command = server.command;
      mcpConfig.args = server.args || [];
      mcpConfig.env = server.env || {};
    } else if (server.transport === 'http' || server.transport === 'sse') {
      mcpConfig.url = server.url;
      mcpConfig.headers = server.headers || {};
    }
    config.mcpServers[server.id] = mcpConfig;
  }
  writeJson(configPath, config);
  return { agent: agent.name, path: configPath, servers: servers.length };
}

function removeMcpServer(agentId, serverId) {
  const { agent, configPath } = getAgentConfig(agentId);
  const config = readJson(configPath);
  if (config.mcpServers && config.mcpServers[serverId]) {
    delete config.mcpServers[serverId];
    writeJson(configPath, config);
  }
  return { agent: agent.name, path: configPath, removed: serverId };
}

function writeInstructions(agentId, instructions) {
  const { agent, configPath } = getAgentConfig(agentId);
  const config = readJson(configPath);
  config.instructions = config.instructions || [];
  const existingIds = new Set(config.instructions.map(i => i.id));
  for (const instr of instructions) {
    const instrConfig = {
      id: instr.id,
      name: instr.name,
      content: instr.content,
      category: instr.category || '通用',
    };
    if (existingIds.has(instr.id)) {
      const idx = config.instructions.findIndex(i => i.id === instr.id);
      if (idx >= 0) config.instructions[idx] = instrConfig;
    } else {
      config.instructions.push(instrConfig);
    }
  }
  writeJson(configPath, config);
  return { agent: agent.name, path: configPath, instructions: instructions.length };
}

function removeInstruction(agentId, instructionId) {
  const { agent, configPath } = getAgentConfig(agentId);
  const config = readJson(configPath);
  if (Array.isArray(config.instructions)) {
    config.instructions = config.instructions.filter(i => i.id !== instructionId);
    writeJson(configPath, config);
  }
  return { agent: agent.name, path: configPath, removed: instructionId };
}

function syncAgent(agentId, resourceLibrary) {
  const { agent } = getAgentConfig(agentId);
  const results = { mcp: { written: 0, removed: 0 }, instructions: { written: 0, removed: 0 } };
  const enabledMcp = resourceLibrary.local.mcpServers.filter(s => s.enabledAgents?.includes(agentId));
  const enabledInstr = resourceLibrary.local.instructions.filter(i => i.enabledAgents?.includes(agentId));
  if (enabledMcp.length) {
    const result = writeMcpServers(agentId, enabledMcp);
    results.mcp.written = result.servers;
  }
  if (enabledInstr.length) {
    const result = writeInstructions(agentId, enabledInstr);
    results.instructions.written = result.instructions;
  }
  return { agent: agent.name, ...results };
}

function listAgents() {
  return Object.entries(AGENTS).map(([id, agent]) => ({
    id,
    name: agent.name,
    configPath: agent.configFile(),
    exists: fs.existsSync(agent.configFile()),
  }));
}

module.exports = { writeMcpServers, removeMcpServer, writeInstructions, removeInstruction, syncAgent, listAgents, getAgentConfig };
