# AIDesignHub 技能中心重构设计方案

日期：2026-10-09。状态：设计草案，待确认后实施。

## 1. 背景与目标

### 1.1 现状

当前技能中心（`skill-center.cjs` + `project-hub-ui.js`）只管理一类资源——**技能（Skills）**，且完全项目隔离。每个技能包含名称、说明、方法文本（instructions）、输入输出描述和依赖列表。没有 MCP 服务器、指令、RTK 的概念。

### 1.2 参考：Magpie 资源库

Magpie（`D:\Funny Projects\magpie`）是一个 Go + Wails 桌面应用，管理 ~30 种 AI 编码 Agent 的共享资源：

| 资源类型 | 存储方式 | 作用 |
|---------|---------|------|
| **指令 (Instructions)** | Markdown 文本，写入 Agent 的 CLAUDE.md / AGENTS.md | 给 Agent 的通用行为规范 |
| **MCP 服务器** | 配置对象，写入 Agent 的 MCP 配置文件 | 外部工具服务（GitHub、Playwright 等） |
| **技能 (Skills)** | SKILL.md 文件夹，符号链接分发 | 可复用的任务方法 |
| **RTK** | 命令行工具，hook 注入 Agent | 精简 shell 输出，减少 token 消耗 |

核心机制：一个 `~/.magpie/library.json` 统一存储，同步引擎将资源写入各 Agent 的原生配置格式，支持从 Agent 反向导入。

### 1.3 目标：两层管理

AIDesignHub 与 Magpie 的关键区别——Magpie 管理的是**同一台电脑上不同 Agent** 的资源，AIDesignHub 需要同时管理：

1. **本机层**：当前电脑上不同 Agent（Qoder、Cursor、Claude Code 等）的 Skill / MCP / 指令 / RTK 统一管理，可从不同 Agent 导入
2. **团队层**：跨电脑、跨成员的资源共享——团队成员贡献的资源可以被其他人拉取使用

```
┌─────────────────────────────────────────────────────┐
│                    技能中心                           │
│                                                     │
│  ┌─ 本机资源 ──────────────────────────────────┐    │
│  │  从 Qoder / Cursor / Claude Code 等导入       │    │
│  │  统一管理当前电脑上所有 Agent 的 Skill/MCP/指令  │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ─ 团队共享 ──────────────────────────────────┐    │
│  │  成员贡献 → 项目/团队库 → 其他人拉取使用        │    │
│  │  跨电脑同步，按项目或团队范围共享               │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────
```

---

## 2. 资源类型定义

### 2.1 技能 (Skill)

**现有概念，扩展作用域。**

```
{
  id: "skill_<uuid>",
  familyId: "skill_<uuid>",       // 版本家族
  name: "建筑案例调研",
  description: "按项目名称联网研究...",
  category: "案例调研",            // 项目管理/案例调研/设计生产/知识整理/其他
  version: "1.1.0",
  instructions: "...",             // 方法文本（≤40000 字符）
  input: "...",                    // 输入说明
  output: "...",                   // 输出说明
  dependencies: ["联网搜索"],       // 工具名称列表

  // 新增字段
  scope: "local" | "team",        // 来源：本机 / 团队
  sourceAgent: "qoder",            // 来源 Agent（仅 scope=local 时）
  teamProjectId: "proj_xxx",      // 来源团队项目（仅 scope=team 时）
  teamAuthorName: "林澜",          // 团队贡献者姓名
}
```

### 2.2 MCP 服务器 (MCPServer)

**新增资源类型。** 对应 Magpie 的 MCP Servers。

```
{
  id: "mcp_<uuid>",
  name: "GitHub",
  description: "GitHub 仓库、Issue、PR 搜索",
  transport: "stdio" | "http" | "sse",
  command: "npx",                  // stdio 模式
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { "GITHUB_TOKEN": "..." },
  url: "https://...",              // http/sse 模式
  headers: { "Authorization": "..." },

  // 作用域
  scope: "local" | "team",
  sourceAgent: "qoder",
  enabledAgents: ["qoder", "cursor"],  // 本机已启用的 Agent
  teamProjectId: "...",
  teamAuthorName: "陈设计",

  // 状态
  status: "active" | "inactive" | "error",
  lastHealthCheck: 1728460800000,
}
```

### 2.3 指令 (Instruction)

**新增资源类型。** 对应 Magpie 的 Instructions——共享的 Markdown 文本，写入各 Agent 的系统提示词。

```
{
  id: "instr_<uuid>",
  name: "设计评审规范",
  content: "# 设计评审规范\n\n每次提交设计稿前...",  // Markdown（≤20000 字符）
  category: "通用" | "设计" | "项目管理" | "沟通",

  // 作用域
  scope: "local" | "team",
  sourceAgent: "qoder",
  enabledAgents: ["qoder", "cursor"],
  teamProjectId: "...",
  teamAuthorName: "周远",

  // 版本
  version: "1.0.0",
  updatedAt: 1728460800000,
}
```

### 2.4 RTK

**新增资源类型。** 对应 Magpie 的 RTK——命令行输出精简工具，减少 Agent 的 token 消耗。

```
{
  id: "rtk_<uuid>",
  name: "rtk",
  version: "0.3.2",
  path: "C:/Users/user/rtk.exe",    // 本机安装路径
  enabledAgents: ["qoder", "claude"],

  // 作用域
  scope: "local",                   // RTK 是纯本地工具，不参与团队共享
  teamProjectId: null,
  teamAuthorName: null,

  status: "installed" | "not-installed",
}
```

> **注意**：RTK 是纯本地资源，不参与团队共享。团队层只共享 Skill / MCP / 指令。

---

## 3. 数据模型与存储

### 3.1 存储位置

沿用现有 `LocalBackend` 的 JSON store 模式，在 `store` 中新增两个顶层字段：

```
store.resourceLibrary = {
  // 本机资源（从本地 Agent 导入或本地创建）
  local: {
    skills: [],
    mcpServers: [],
    instructions: [],
    rtk: null,
  },
  // 团队共享资源（从团队库拉取或本成员贡献）
  team: {
    skills: [],
    mcpServers: [],
    instructions: [],
  },
  // 同步状态
  sync: {
    lastSyncAt: null,
    lastSyncError: null,
    pendingPush: [],     // 待推送的本地变更
    pendingPull: [],     // 待拉取的远端变更
  }
}
```

### 3.2 与现有 SkillCenter 的关系

**渐进式迁移**，不破坏现有数据：

1. `store.skillCenter` 保持不变，继续服务当前的技能评分、贡献统计
2. 新增 `store.resourceLibrary` 作为统一资源库
3. 技能中心的 Skill Tab 同时读取两个数据源：
   - `resourceLibrary.local.skills`（本机）
   - `resourceLibrary.team.skills`（团队）
   - `skillCenter.skills`（现有的项目技能，标记为"项目内"）

长期目标：`skillCenter` 的功能（评分、贡献统计）合并到 `resourceLibrary` 的 Skill 类型中。

### 3.3 资源唯一性

同一资源可能同时存在于多个作用域。用 `scope + id` 作为唯一键：

```
resourceKey = `${scope}:${type}:${id}`
// 例："local:skill:skill_abc123"
//     "team:skill:skill_def456"
//     "local:mcp:mcp_ghi789"
```

---

## 4. UI 布局设计

### 4.1 整体结构

```
┌──────────────────────────────────────────────────────────────┐
│  技能中心                                      [+ 贡献资源]    │
│  TEAM KNOW-HOW · 把有效的方法，共享给团队                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [技能]  [MCP 服务器]  [指令]  [RTK]                          │
│  ─────  ────────────  ────  ───                             │
│                                                              │
│  ┌─ 筛选栏 ─────────────────────────────────────────────┐   │
│  │ [搜索...]  [全部分类 ]  [来源: 全部 ▾]  [刷新]        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ 本机资源 ───────────────────────────────────────────┐   │
│  │  从本地 Agent 导入的资源                                │   │
│  │  ┌──────┐ ──────┐ ┌──────┐                          │   │
│  │  │ 卡片  │ │ 卡片  │ │ 卡片  │  ...                    │   │
│  │  └──────┘ └──────┘ └──────┘                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ─ 团队共享 ───────────────────────────────────────────┐   │
│  │  团队成员贡献的资源                                    │   │
│  │  ┌──────┐ ┌──────┐ ┌──────┐                          │   │
│  │  │ 卡片  │ │ 卡片  │ │ 卡片  │  ...                    │   │
│  │  └──────┘ └──────┘ └──────┘                          │   │
│  └──────────────────────────────────────────────────────   │
│                                                              │
│  ┌─ 项目内技能（现有） ─────────────────────────────────┐   │
│  │  当前项目的技能（保持现有展示）                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 四个 Tab 的差异

| Tab | 本机资源 | 团队共享 | 操作 |
|-----|---------|---------|------|
| **技能** | 从 Agent 导入 / 本地创建 | 拉取 / 贡献 | 查看方法、用于 Agent 任务、评分 |
| **MCP 服务器** | 从 Agent 导入 / 手动添加 | 拉取 / 贡献 | 启用/禁用 Agent、健康检查、编辑配置 |
| **指令** | 从 Agent 导入 / 本地编写 | 拉取 / 贡献 | 编辑 Markdown、选择启用 Agent |
| **RTK** | 安装/卸载、启用 Agent | 无 | 安装、升级、配置 PATH |

### 4.3 资源卡片设计

每个资源卡片包含：

```
┌──────────────────────────────────────────────┐
│ [来源标签]  v1.0.0                            │
│  建筑案例调研                                  │
│                                              │
│  按项目名称联网研究，或分析公开链接...           │
│                                              │
│  来源：Qoder · 林澜贡献                        │
│  已启用：Qoder, Cursor                        │
│  复用 3 次 · 评分 4.5                          │
│                                              │
│  [查看]  [用于 Agent 任务]  [导入到本机]        │
└──────────────────────────────────────────────┘
```

来源标签颜色区分：
- **本机**：蓝色 `企业内置` / 灰色 `本地`
- **团队**：紫色 `团队共享`
- **项目内**：绿色 `项目内`（现有样式保留）

### 4.4 "贡献资源" 对话框

点击 `+ 贡献资源` 按钮，弹出对话框：

```
┌──────────────────────────────────────────────┐
│  贡献资源                                     │
│                                              │
│  资源类型：[技能 ▾]  [MCP 服务器]  [指令]       │
│                                              │
│  名称：[________________________]             │
│  说明：[________________________]             │
│  分类：[通用 ▾]                               │
│  版本：[1.0.0]                                │
│                                              │
│  方法文本 / 配置内容：                          │
│  ┌──────────────────────────────────────┐    │
│  │                                      │    │
│  │  (文本编辑区)                          │    │
│  │                                      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  共享范围：[○ 仅本机]  [● 团队共享]            │
│                                              │
│              [取消]  [保存草稿]  [发布]        │
└──────────────────────────────────────────────┘
```

### 4.5 从 Agent 导入

每个 Tab 的"本机资源"区域提供"从 Agent 导入"入口：

```
┌──────────────────────────────────────────────┐
│  本机资源里还没有 MCP 服务器                    │
│  添加一个，或从 Agent 里已有的导入进来            │
│                                              │
│              [+ 添加服务器]                     │
└──────────────────────────────────────────────┘

AGENT 中已有：
┌──────────────────────────────────────────────┐
│ [Z]  Qoder                                    │
│   GitHub  (npx -y @modelcontextprotocol/...)  │
│   Context7  (npx -y context7)                │
│   Filesystem  (npx -y @modelcontextprotocol/..│
│                                              │
│ [导入] [导入全部]                              │
└──────────────────────────────────────────────┘
```

---

## 5. 同步机制

### 5.1 团队同步模型

AIDesignHub 是 Electron 桌面应用，团队同步有两种方案：

**方案 A：Hub 服务中转（推荐）**

```
成员A 的 Electron  ←→  Hub 后端服务  ←→  成员B 的 Electron
     (push/pull)        (资源存储+分发)      (push/pull)
```

- 每个成员贡献资源时，资源上传到 Hub 后端
- 其他成员打开技能中心时，自动拉取团队资源
- 冲突处理：同一资源按 `updatedAt` 取最新，保留历史版本

**方案 B：P2P 局域网同步**

- 同一局域网内的成员直接交换资源
- 不需要中心服务器，但需要成员同时在线

> 建议先实现方案 A，因为项目已有 `hub-service.cjs` 后端服务。

### 5.2 同步数据流

```
贡献者发布资源
    │
    ▼
本地 resourceLibrary.team 写入
    │
    ▼
push 到 Hub 后端（带 contentHash）
    │
    ▼
Hub 后端存储 + 广播变更通知
    │
    ▼
其他成员的 Electron 收到通知
    │
    ▼
pull 变更 → 写入本地 resourceLibrary.team
    │
    ▼
UI 自动刷新
```

### 5.3 冲突处理

| 场景 | 策略 |
|------|------|
| 同一资源被多人修改 | 按 `updatedAt` 取最新，旧版本存入历史 |
| 资源被删除 | 软删除标记，同步时其他成员收到删除通知 |
| 网络离线 | 本地变更进入 `pendingPush` 队列，恢复后自动推送 |
| 版本冲突 | 保留两个版本，UI 提示用户选择 |

---

## 6. 与 Magpie 的差异对照

| 维度 | Magpie | AIDesignHub |
|------|--------|-------------|
| **管理对象** | 同一台电脑上的不同 Agent | 团队 + 本机 Agent |
| **资源作用域** | 本机全局 | 本机 + 项目 + 团队三层 |
| **同步方式** | 本地文件同步 | 网络同步（Hub 后端） |
| **RTK** | 支持 | 仅本地，不团队共享 |
| **技能评分** | 无 | 有（真实运行绑定、1-5 分） |
| **贡献统计** | 无 | 有（按成员统计复用/评分） |
| **项目隔离** | 无（全局资源库） | 有（技能可按项目隔离） |
| **Agent 写入** | 直接写 Agent 配置文件 | 通过 MCP 桥接 + 配置生成 |
| **行业定位** | 通用编码 Agent | 建筑设计行业 |
| **技术栈** | Go + Wails | Electron + Node.js |

---

## 7. 实施路线

### Phase 1：UI 框架（1-2 天）

- 将技能中心改为四栏 Tab 布局
- 每个 Tab 展示"本机资源"和"团队共享"两个区域
- 资源卡片组件复用现有 `.hub-skill-card` 样式，扩展来源标签
- RTK Tab 仅展示本机状态

**涉及文件**：
- `index.html` — 修改 `#view-skills` 结构
- `project-hub-ui.js` — 添加 Tab 切换逻辑
- `project-hub.css` — 添加 Tab 和卡片样式

### Phase 2：数据模型（2-3 天）

- 新增 `resourceLibrary` 后端类（`backend/resource-library.cjs`）
- 定义 MCP Server / Instruction / RTK 的数据结构和验证规则
- 实现本地资源的 CRUD
- 实现从 Agent 配置导入资源的功能

**涉及文件**：
- `backend/resource-library.cjs`（新建）
- `backend/local-backend.cjs` — 添加 `resourceLibrary` 字段
- `preload.cjs` — 添加 IPC 通道
- `electron-main.cjs` — 注册 IPC handler

### Phase 3：团队同步（3-5 天）

- Hub 后端添加资源存储和分发 API
- Electron 端实现 push/pull 同步
- 冲突处理和离线队列
- 团队贡献的 UI 流程（贡献 → 审核 → 发布 → 拉取）

**涉及文件**：
- `backend/hub-service.cjs` — 添加资源 API
- `scripts/hub-service.cjs` — 添加路由
- `backend/resource-library.cjs` — 添加同步逻辑

### Phase 4：Agent 写入（2-3 天）

- 实现将资源写入本地 Agent 配置（类似 Magpie 的 sync 引擎）
- 支持 Qoder、Cursor、Claude Code 等主流 Agent
- 资源启用/禁用控制

---

## 8. 风险与注意事项

1. **数据兼容性**：现有 `skillCenter` 数据必须完整保留，新系统不能破坏已有的技能评分和贡献统计
2. **安全性**：MCP 服务器配置可能包含密钥（token、API key），存储和同步时需要加密
3. **性能**：资源库可能包含大量 MCP 服务器和技能，UI 需要虚拟滚动或分页
4. **离线体验**：团队同步依赖网络，离线时本地资源必须正常使用
5. **Agent 配置格式**：不同 Agent 的配置文件格式差异大（JSON、TOML、YAML），需要为每种 Agent 维护编解码器
