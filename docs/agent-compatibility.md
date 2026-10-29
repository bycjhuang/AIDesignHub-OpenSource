# 外部 Agent 执行器与兼容边界

核查日期：2026-10-04。本文将官方已发布协议、本机安装证据和本项目测试分开记录；搜索摘要不作为版本能力的最终证据。

## 已实现的统一入口

`backend/agent-executors.cjs` 导出：

```js
await executeAgent(connection, {
  prompt, cwd, signal, onEvent,
  runId, projectId, sessionId, sessionKey, promptFile, // Hub 为当前 run 生成，可选但相关占位使用时必需
  env: { AIDESIGNHUB_URL, AIDESIGNHUB_TOKEN }, // 可选、临时、只读项目授权
});
// => { text, sessionId?, metadata? }
```

`connection.mode` 支持 `cli`、`acp`、`openclaw-http`。调用方负责授权、连接配置、项目隔离和成果审核。适配器不选择模型供应商、不申请或保存模型密钥，也没有 OpenAI 直连默认地址。

| 模式 | 输入 | 进度 | 完成依据 | 取消边界 |
| --- | --- | --- | --- | --- |
| CLI | `command` 的绝对路径及 `args` 数组；含 `{prompt}` 或 `{promptFile}` 时单次替换，否则原文写 stdin | 文本，或 Hermes JSONL 的文本/工具事件 | 进程退出成功；结构化模式还检查最终结果 | 终止本次自有进程，Windows 使用 taskkill `/PID /T /F`；远程后端工作未必同步终止 |
| ACP | stdio JSON-RPC v1；新 session，绝对 cwd，临时 MCP 列表，文本 prompt | `session/update` 文本和工具状态 | `session/prompt` 返回 `end_turn` 且有答案 | 先 `session/cancel`，随后关闭/终止本次子进程 |
| OpenClaw HTTP | 显式 Gateway URL；Bearer 只从 `tokenEnv` 指定的环境变量读取 | Chat 或 Responses 的 SSE | 成功 JSON / 明确 SSE 终态；失败、截断与提前断流不能算成功 | AbortSignal 关闭请求；不将其表述为已确认远端停止 |

默认每执行器路径/端点并发 1，可配置上限 4；默认总时限 120 秒、stdout+stderr/HTTP 输出上限 4 MiB、进度事件最多 10,000 条。CLI 的 Windows 入口必须是 `.exe`；`.cmd/.bat/.ps1` 或 shell 字符串不被当作可执行入口。对 Node 程序使用 `node.exe` + 脚本参数。进度不附带环境、请求头、凭据或原始 stderr。外部 Agent 自身可能输出敏感内容，因此仍应遵守项目最小授权。

`input.env` 仅接纳 `AIDESIGNHUB_URL` 与 `AIDESIGNHUB_TOKEN`，只进入子进程，不修改父进程环境。CLI 通过授权工具获取资料；ACP 可在 `session/new.mcpServers` 中接入临时 Hub stdio bridge。凭据不写进 prompt。MCP 标准 env 数组只由可信调用方临时构造，不应接受来自网页/项目资料的任意启动指令。

### 运行占位与长提示词

子进程 args 支持 `{prompt}`、`{promptFile}`、`{runId}`、`{projectId}`、`{sessionId}`、`{sessionKey}`。只扫描原始参数一次，不解释插入后 prompt 里的任何模板或 shell 语法。未知 `{word}` 占位、缺少运行值、无效 ID 均拒绝；不同时使用 `{prompt}` 与 `{promptFile}`。ID 仅允许字母数字及 `._:-`，最多 512 字符。

`promptFile` 由 Hub 在该 run 输出目录中创建，必须是绝对路径、普通现存文件，UTF-8 字节须与本次最终 prompt 完全一致；适配器不创建、覆盖或删除它。文件不得含临时凭据，目录权限和保留/清理由 Hub 负责。使用文件或 argv prompt 时关闭 stdin，不重复发送文本。Hub 的输入上限为 1 MiB；OpenClaw 文件接口允许 4 MiB，不扩大 Hub 上限。

Windows 会在 spawn 前按 UTF-16、引号和反斜杠转义计算保守命令行上限，过长返回 `ARGUMENT_LIMIT`。本机无模型诊断实测普通 Node 子进程的 20,000 字符 argv 成功，40,000 字符返回 `ENAMETOOLONG`；因此不能因 Hub 接受 1 MiB 就把长任务直接放入 `{prompt}`。

## Hermes Agent

官方 CLI 已有一轮任务和 JSONL 输出。推荐合同：

```text
hermes chat --query-file - --oneshot --format stream-json
```

本适配器按 `provider: "hermes"` 解析 `system`、`text`、`tool_use`、`tool_result`、`result`；以 `result.text` 作为最终答案，检查 `result.exit_code`。官方 CLI 提供 `--resume`，但当前 Hub 默认每次新任务，不自动恢复历史。不要加 `--yolo`。来源：[Hermes CLI reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)。

示例（占位路径必须换成真实安装，不会由 Hub 安装）：

```json
{
  "provider": "hermes",
  "mode": "cli",
  "command": "C:\\path\\to\\hermes.exe",
  "args": ["chat", "--query-file", "-", "--oneshot", "--format", "stream-json"],
  "timeoutMs": 300000
}
```

官方还提供 `hermes acp`、TUI JSON-RPC（stdio/WebSocket）及 HTTP，均驱动同一 Agent 核心；并不存在统一 `--mode rpc` 开关。来源：[Programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)。

HTTP 原生 Runs 合同是 `POST /v1/runs`，body 可含 `input`、`session_id`；返回 `run_id`。之后可查询 `GET /v1/runs/{id}`、订阅 `/events`、发 `/stop`；后者先返回 stopping，需等最终 cancelled。`Idempotency-Key` 可防重复创建。默认监听 8642，配置开关是 `API_SERVER_ENABLED` 与 `API_SERVER_KEY`。这条 Hermes Runs HTTP 路线有官方依据，但本轮适配器未实现，不能用 OpenClaw 模式冒充。来源：[Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)。

本机只读检查：源码位于 `D:\Funny Projects\hermes-agent-main\hermes-agent-main`；本机 `hermes_cli/_parser.py` 第 235、264 行实际定义了 `--query-file` 和 `--format stream-json`。PATH 未发现 `hermes`，该源码的 `.venv`/`venv` 以及所查标准用户安装位置均无运行解释器。源码存在不等于可执行已安装；没有运行模型、安装依赖或读取 `.env`/凭据。

## OpenClaw

官方 Gateway 可启用 `/v1/chat/completions` 或 `/v1/responses`，端点默认不开启。本适配器默认为 Chat；完整 URL 以 `/v1/responses` 结尾即可选择 Responses。地址只有 origin 或 `/v1` 时，直接调用适配器可指定 `api: "responses"`，当前 Hub 配置请使用完整路由。Bearer Gateway token 是高权限凭据，应只用于可信本地服务，不向浏览器公开。支持 `agentId`→`x-openclaw-agent-id`，当前运行的 `input.sessionKey`→`x-openclaw-session-key`。返回 `metadata.sessionKey` 作为路由记录，不把它伪称为服务器生成的 sessionId。来源：[OpenResponses HTTP API](https://docs.openclaw.ai/gateway/openresponses-http-api)。

```json
{
  "provider": "openclaw",
  "mode": "openclaw-http",
  "endpoint": "http://127.0.0.1:18789/v1/chat/completions",
  "tokenEnv": "OPENCLAW_GATEWAY_TOKEN",
  "timeoutMs": 300000
}
```

Chat body 为 `{ "model": "openclaw", "messages": [{ "role": "user", "content": "..." }], "stream": true }`。Responses 为 `{ "model": "openclaw", "input": "...", "stream": true }`。远端只允许 HTTPS，禁 URL 内嵌凭据和自动重定向。会话 key 应使用 `agent:<agentId>:aidesignhub:<projectId>:<runId>` 形式，不能跨项目或重试运行复用；不使用 `subagent`、`cron`、`acp` 等保留命名空间。若 input.sessionKey 与 connection.sessionKey 冲突，或同时配置 previousResponseId，适配器在发送请求前返回 `SESSION_CONFLICT`。

本机 2026.9.8 的 `dist/http-utils-BGKndJpB.mjs` 中，未传会话 header/user 时会为每个请求创建随机会话；因此旧版 Hub HTTP 默认不是复用主会话，但也没有可追踪的 Hub run 路由。静态 sessionKey 才会令调用落到同一会话，不能把它作为可跨任务保存的连接参数。最新版官方 Responses 文档说明断连会取消 Agent，但实际安装版本/代理链尚未验证，因此 Hub 只保证已取消请求，不伪报服务器已停止。

CLI 应显式传每个 run 新生成的会话，例如 `openclaw agent --agent main --session-id <new-UUID> --message-file <absolute-path> --json`。仅 `--agent main` 并不创建隔离会话：本机 `dist/main-session-BFJFO581.mjs` 的 `resolveExplicitAgentSessionKey` 将它解析为 Agent 的主会话。不要增加 `--deliver`，否则可能发送消息到外部渠道。来源：[OpenClaw agent CLI](https://docs.openclaw.ai/cli/agent)。本机实际 `agent --help` 成功，版本 **2026.9.8**，确认支持 message、message-file、json、session-key、session-id；`--deliver` 默认 false。

本机可配置的准确入口（未执行付费任务）：

```json
{
  "provider": "openclaw",
  "mode": "cli",
  "command": "D:\\BYCJ\\tools\\node-v24.21.0-win-x64\\node.exe",
  "args": ["D:\\BYCJ\\tools\\node-v24.21.0-win-x64\\node_modules\\openclaw\\openclaw.mjs", "agent", "--agent", "main", "--session-id", "{sessionId}", "--message-file", "{promptFile}", "--json"],
  "timeoutMs": 300000
}
```

`main` 是否配置、模型登录、Gateway 运行、HTTP 开关都需要实际验证。本机 `agent-via-gateway-D-L8NW-V.mjs` 的 message-file 实现直接打开 UTF-8 文件，**普通 `agent --message-file -` 不表示 stdin**。使用上述每 run 文件避免 argv 长度限制和命令行暴露全文。该 CLI 的工作区由 OpenClaw Agent 自己的配置决定，仅传进程 cwd 或新 session 不等于已隔离远端工具/工作区。

另一个本机已发布接口是 `openclaw agent exec --message-file - --json`：真实 help/source 确认这个子命令支持 stdin、每次 randomUUID session、默认临时 stateDir，并可用 `--cwd` 同时设 Agent 和工具目录；其 JSON `{ok,status,final,sessionId}` 已符合当前解析器。但它是本地 embedded，不经过 Gateway，配置/认证和工具边界不同，默认工具配置包含 coding/full；不能为绕过 Gateway 认证而静默改用它。本轮仅检查 help/source，未执行其模型任务。

当前 Hub 保存并验证 `agentId`，HTTP 路由由完整 endpoint 决定；`api`、`stream`、`model`、`outputFormat`、`maxOutputBytes`、`maxConcurrency` 仍是直接调用适配器的选项，不是已提供的 Hub 配置字段，不能依赖它们经 saveConnection 持久化。后续若暴露这些配置，应增加白名单验证和 round-trip 测试。`sessionId`、`sessionKey`、`promptFile` 属于当前 run，不能从网页请求保存为可复用连接状态；`mcpServers`、任意 env 和凭据也不接纳为普通连接字段。

后续主线程发起的最小标记真实任务返回退出码 1，未获得成功答案，不能标记“模型连接已打通”。本次补充只读诊断中 health 返回 ok、status 的 RPC 探测成功，但默认 CLI 的只读日志调用在连接前触发“需要 Gateway 凭据”的固定错误类别。当前进程没有 Gateway token/password 环境变量；没有查看其值、改配置或重新提交模型任务。该证据指向 CLI 目标的授权缺口，而不是“Gateway 没启动”；由于第一次任务的原始 stderr 未保留，不能宣称已完全还原其唯一失败原因。适配器现在仅输出固定故障类别，不回显原始 stderr。

## DeepSeek Harness

官方当前启动入口是 `dsh --profile acp`；非 ACP 选项包括 `dsh --profile headless "job"` 和 `dsh --profile sdk`（stdio JSON-RPC）。headless 是单次任务，SDK 是另一个应用 profile，不能把普通模型 API 当成 Harness。来源：[官方 CLI README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)。

当前官方 ACP 支持 v1、新会话、prompt、进度、一次性权限、cancel，以及其声明的持久会话能力；具体能力必须看 initialize 返回，不能照抄旧搜索摘要。模型凭据仍由 Harness 管理。来源：[官方 ACP README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)。

本机 package 版本 **0.1.2-rc.1**；真实 `--help` 成功且列出 `--profile`。配置候选：

```json
{
  "provider": "deepseek",
  "mode": "acp",
  "command": "D:\\BYCJ\\tools\\node-v22.22.3-win-x64\\node.exe",
  "args": ["D:\\BYCJ\\tools\\node-v22.22.3-win-x64\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", "--profile", "acp"],
  "timeoutMs": 300000
}
```

本机真实 `.dsh/profiles` 有 desktop、headless、web，未发现 acp。为不改变真实配置，追加验证在新建的临时 `DSH_HOME` 中进行。先确认安装内已经带有 dsh-acp-app、dsh-acp、ACP SDK，再启动本机 CLI，只发送 initialize，不创建 session、不发送 prompt、不复制模型凭据，也未安装任何依赖。

第一次 12 秒窗口未回应；第二次放宽到 35 秒后握手成功，随后 EOF 正常退出 0，stderr 为空。返回值：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "deepseek-harness-acp", "version": "0.0.1" },
  "agentCapabilities": {
    "mcpCapabilities": { "http": true },
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
  },
  "authMethods": []
}
```

所以状态是“本机 ACP v1 initialize 已实测，模型认证与完整任务未验证”，不是“DeepSeek 模型已经连通”。安装 package 版本 0.1.2-rc.1 与协议 `agentInfo.version` 0.0.1 不同，分别保留。复现探针为 `tests/fixtures/probe-dsh-acp.cjs`，只可显式运行，不加入日常自动测试。它保留 `%TEMP%/aidesignhub-dsh-acp-*` 中的隔离测试 profile，不影响用户 `.dsh`。

## ZCode、ChatGPT 与 MCP 方向

ZCode 官方明确支持配置外部 MCP（stdio/HTTP/SSE）；这是 **ZCode 调用 Hub 工具** 的依据，不是 **Hub 主动驱动 ZCode headless Agent** 的依据。没有把社区逆向 headless/ACP 桥接器当作官方稳定接口，也没有安装它们。现阶段选择入站 MCP 或任务包人工交接。来源：[ZCode MCP 官方文档](https://zcode.z.ai/cn/docs/mcp-services)。

2026-10-04 经用户明确授权，已向 `C:\Users\user\.zcode\cli\config.json` 的原生 `mcp.servers` 新增 `AIDesignHub-Test`，修改前完整备份，原有插件配置保留。入口是本项目 `scripts/zcode-mcp-test.cjs`，使用已有 Electron 的 Node 模式。该入口每次强制创建全新临时合成项目，只授予 `project:read`、只暴露 `hub_project_context`，最长 30 分钟，配置没有原始 token，不能指定真实数据目录。

真实 ZCode 客户端（日志版本 0.16.9）完成 stdio initialize（协议 2025-11-25）与唯一工具发现；在新建无项目会话中，13:24:32 实际调用 `hub_project_context({})` 一次并正确回答合成项目名称和 ID。ZCode `tool.call.started/completed` 日志、对应进程父链与服务回执 `contextCallCount=1` 交叉验证通过。此结果证明 **ZCode → Hub 只读工具 → ZCode 回答** 的完整路径，不证明真实项目授权、任务成果写入、主动派单或 ZCode headless 接口可用。完整证据见 [实现记录](agent-case-implementation.md)。

ChatGPT 桌面接入取决于该客户端实际提供的 MCP/连接器入口；不要将 ChatGPT 订阅、Codex CLI、OpenAI API key 混为同一执行器。本适配层没有 GUI 操纵或私有桌面协议。

## ACP 实现范围与安全默认

连接后顺序为 initialize(v1) → session/new → session/prompt；只传文本 prompt，客户端文件系统读写和 terminal 能力均为 false。权限请求自动选择 `reject_once`；没有拒绝选项就返回 cancelled。未知 server→client 方法返回 -32601。不传 yolo、永远允许或隐式认证操作。HTTP/SSE MCP 只在 Agent 声明相应能力后发送。标准依据：[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。

当前每次调用拥有一个新子进程/新会话，任务后退出；尚未做 session/load、resume、多会话复用、图片、Agent 模式选择或人工 permission UI。ACP 允许不等于必然 sandbox：外部 Agent 的自有工具仍按它自己的权限设置执行，Hub 默认拒绝只约束实际收到的审批请求。

OpenClaw HTTP 不会把 Hub 的子进程环境变量转交给远端 Gateway。HTTP Agent 若要查询同一知识库，须在 Gateway 侧单独配置获授权的 Hub MCP，或由 Hub 在任务快照中附上最小必要摘录；不能把临时 token 写入 prompt，也不能伪称其能直接使用本机 CLI bridge。

## 验证证据

运行 `node --test tests/agent-executors.test.cjs`：29 项通过。测试启动真实 Node fixture 子进程和 loopback HTTP 服务，不调用任何模型。覆盖无 shell 插值、运行占位单次替换、未知/缺失占位拒绝、长中文 UTF-8 promptFile、错误文件拒绝、Windows 转义后 argv 超限预检、HTTP 每 run 路由及冲突拒绝、临时授权 env 不泄漏、JSONL/JSON、ACP 权限拒绝与 capability 协商、超时取消、并发输出限制、UTF-8/SSE 分片、失败/截断/非终态输出不能误报成功、错误信息不含远端 body 或 stderr 凭据、禁止凭据重定向。

这证明适配器的本地协议行为，不证明各外部 Agent 的模型登录、账户额度、工具或生产任务已可用。首次真实任务须由用户明确派单，使用隔离工作区与最小工具权限，最终成果仍需审核。
