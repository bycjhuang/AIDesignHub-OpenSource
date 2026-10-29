# AIDesignHub 开发约定

## 项目是什么

Windows 桌面工作台（"人主导、AI 辅助记录"的设计项目协作工具）：Electron 主进程 + 纯 JS 渲染层 + 本地 `.cjs` 后端。数据保存在本机，不连网站后端、不消耗网站积分。

- 进程结构：`electron-main.cjs`（主进程）→ `preload.cjs`（受限 IPC 桥）→ `index.html` + 各 `*-ui.js`（渲染层）
- 包名 `bycj-design-workbench-prototype` 是历史名称，以免迁移用户数据位置，**勿改**

## 代码发现（省 token 优先）

本项目已建立代码图谱索引 **`aid-design-hub`**（codebase-memory-mcp）：

1. 优先使用 `search_graph` / `trace_path` / `get_code_snippet`（传 `project="aid-design-hub"`）
2. 查字符串、配置、非代码文件，或结果不足时，再用 `rg`
3. 代码改动较多后刷新索引：`index_repository(repo_path="D:/AIDesignHUB", name="aid-design-hub", mode="moderate")`

## 关键文件地图

| 文件 | 作用 |
| --- | --- |
| `electron-main.cjs` | Electron 主进程：窗口、IPC、系统能力 |
| `preload.cjs` | 渲染层唯一通道；勿扩大其暴露面 |
| `index.html` | 渲染层入口，按序加载各 `*-ui.js`，`app-v2.js` 最后 |
| `app-v2.js` | 应用主逻辑（当前版本）；`app.js` 为旧版，未被 index.html 引用 |
| `backend/local-backend.cjs` | 本地持久化后端核心 |
| `backend/hub-chat.cjs` | 聊天后端（当前群聊为前端 Demo，不投递；后端代码保留） |
| `backend/agent-gateway.cjs`、`backend/agent-hub.cjs` | 外部 Agent 网关与协作 |
| `backend/model-service.cjs` | 模型服务调用（DeepSeek / 百炼 / OpenAI 兼容） |
| `scripts/start.cjs` | 启动入口（`npm start`） |
| `docs/CURRENT-STATE.md` | 当前状态单入口；先读它，再按需展开 docs 其他文档 |

## 常用命令

- `npm ci` 安装依赖（Node.js ≥ 22.12，建议 24）
- `npm start` 启动；`npm start -- --demo-company` 三项目八成员演示模式
- `npm test` 完整本地测试（不消耗真实模型额度）
- `node tests/backend.test.cjs` 验证后端持久化 / 知识 / 聊天 / 任务

## 硬性边界

- 渲染层没有 Node / 文件系统权限，系统能力只经 preload 白名单开放
- 模型密钥（加密保存于 `device-settings-v1/model-private/`）、用户数据、`.runtime` 一律不进 Git
- 不连接网站线上后端，不消耗网站积分。AI Design 已获用户授权接入 Loomic 本机画布与独立生图接口；图片／视频 API 在 Hub 模型设置统一分类，密钥只保存在本机加密配置中。保留 Loomic 原版云登录、数据库及积分代码供后续部署，本机测试默认走新增的本地模式。
- `docs/` 中带日期的文档是当次改造记录（历史快照）；当前口径以 `README.md` 和 `docs/CURRENT-STATE.md` 为准

## Token 与上下文纪律

1. 修改现有文件用最小范围 Edit，输出只给 diff / 片段；不重写整文件、不复述已知内容
2. 运行检查命令必须截断输出（`| head -40`、`| tail -20`），不把完整日志读进上下文
3. 一个任务一个会话；任务完成或切换到不相关工作即开新会话，并留 5 行交接笔记（任务 / 现状 / 关键文件 / 已定决定 / 下一步）
