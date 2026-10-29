# Easel / OpenClaw 只读审查与 Hub 接口取舍

审查日期：2026-10-04。源目录：`D:\Funny Projects\Easel-0.2.1`。这是本地源码静态审查，不是对其当前运行环境、上游最新版本或线上部署的验证。

审查只读取源码、仓库说明和许可证；未读取 `.env`、实际 OpenClaw 配置/设备身份/账户凭证、真实 `outputs` 内容；未运行、安装、启动或修改 Easel。先检查适用 AGENTS.md；本次可用工具未提供 codebase graph，因而回退到范围受限的源码检索。

## 结论

Easel 的主连接并不是 MCP 或 ACP：其 Web 服务把用户输入转换成 OpenClaw 消息，通过本机 OpenAI 兼容 HTTP 端点或 OpenClaw CLI 执行；再用专用 WebSocket RPC 补齐用户问答，用共享本地 JSONL 补齐细粒度流式事件。

可借鉴的是任务生命周期、后台执行与连接分离、可续播事件、按任务保存产物、技能发现和人设/上下文隔离。不要照搬对 OpenClaw 的 transcript、身份文件、配置 schema、工具名称和 workspace 布局的访问。Hub 应有自己的项目、任务、Run、审批、成果和事件模型，外部 Agent 仅通过受授权接口读写。

本轮 Hub 接口为独立编写；没有复制 Easel 或其第三方技能实现，也没有让 Hub 依赖 Easel/OpenClaw 运行时。

## 连接与执行链

| 环节 | Easel 具体机制 | 源码位置 |
| --- | --- | --- |
| Web 消息 | `ChatRequest`: `message`, `persona`, `sessionId`, `turnId`, `attachments`, `model`, `thinking` | [web/app.py:1701](<D:/Funny Projects/Easel-0.2.1/web/app.py:1701>) |
| 上下文包装 | `chat_turn_message` 拼接画像前缀、用户原文、每轮 Skill 行为提醒 | [easel/persona.py:58](<D:/Funny Projects/Easel-0.2.1/easel/persona.py:58>)、[91](<D:/Funny Projects/Easel-0.2.1/easel/persona.py:91>) |
| HTTP 执行 | `POST http://127.0.0.1:18789/v1/chat/completions`，body 为 `model: openclaw/default`, `stream: true`, 单条 user message | [web/app.py:2786](<D:/Funny Projects/Easel-0.2.1/web/app.py:2786>) |
| HTTP 路由 | `x-openclaw-session-key: agent:main:<sk>`；尝试附 `x-openclaw-session-id`；模型覆盖用 `x-openclaw-model` | [web/app.py:2801](<D:/Funny Projects/Easel-0.2.1/web/app.py:2801>) |
| CLI 执行 | argv 为 `openclaw --profile easel agent --agent main --session-key agent:main:<sk> --session-id <uuid5> --timeout ... --message ...`；可加 `--model` 和 `--thinking` | [web/app.py:2878](<D:/Funny Projects/Easel-0.2.1/web/app.py:2878>) |
| 子进程启动 | `subprocess.Popen`，工作目录为项目根；Windows 特别解析为 node + openclaw.mjs | [web/app.py:2927](<D:/Funny Projects/Easel-0.2.1/web/app.py:2927>)、[easel/openclaw_cmd.py:24](<D:/Funny Projects/Easel-0.2.1/easel/openclaw_cmd.py:24>) |
| 网关生命周期 | shell/PowerShell 设置 raw stream 环境变量并执行 `gateway run --force --allow-unconfigured --bind loopback` | [scripts/gateway.sh:122](<D:/Funny Projects/Easel-0.2.1/scripts/gateway.sh:122>)、[scripts/gateway.ps1:32](<D:/Funny Projects/Easel-0.2.1/scripts/gateway.ps1:32>) |

HTTP 路径虽然采用 OpenAI 兼容消息格式，实际接的是执行 Agent 的 OpenClaw 网关，不等价于一个普通 LLM chat endpoint。Hub 的外部 Agent 执行适配器与模型 provider 不应混为一类。

## 会话、任务与事件

1. `sessionId` 到 OpenClaw transcript id 用 UUIDv5 确定性映射（[web/app.py:1784](<D:/Funny Projects/Easel-0.2.1/web/app.py:1784>)）。同时直接依赖 `<home>/.openclaw-easel/agents/main/sessions/<id>.jsonl`（[88](<D:/Funny Projects/Easel-0.2.1/web/app.py:88>)）。Hub 不应该把外部会话 ID 当业务任务主键，也不应靠读写私有会话文件恢复任务。
2. 源码解释 HTTP 与 CLI 不共享同一 transcript，尝试把会话固定到某一 transport（[web/app.py:1807](<D:/Funny Projects/Easel-0.2.1/web/app.py:1807>)）。但实际选择中 `not req.thinking` 会把显式 thinking 请求强制送到 CLI（[2920](<D:/Funny Projects/Easel-0.2.1/web/app.py:2920>)）。这是静态发现的潜在历史分叉边界，未经运行复现；Hub 应使用显式连接能力矩阵，不隐式更换执行通道。
3. 后台 supervisor 与 SSE forward 分离；断开浏览器不会取消工作（[web/app.py:2743](<D:/Funny Projects/Easel-0.2.1/web/app.py:2743>)、[3272](<D:/Funny Projects/Easel-0.2.1/web/app.py:3272>)）。显式 `/api/chat/stop` 才触发停止（[3387](<D:/Funny Projects/Easel-0.2.1/web/app.py:3387>)）。HTTP 模式的停止主要取消本地 HTTP task（[110](<D:/Funny Projects/Easel-0.2.1/web/app.py:110>)）；仅凭这段代码不能保证远端执行及所有副作用都已停止。Hub 应区分取消请求与执行器确认。
4. 每轮用 `turnId` 保存 JSONL 事件，形状为 `{id,event,data}`；`GET /api/chat/jobs/{turn_id}/stream?after=N` 续播，`GET /api/chat/last/{session_id}?turn_id=...` 读最后快照（[web/app.py:1900](<D:/Funny Projects/Easel-0.2.1/web/app.py:1900>)、[1980](<D:/Funny Projects/Easel-0.2.1/web/app.py:1980>)、[2761](<D:/Funny Projects/Easel-0.2.1/web/app.py:2761>)）。事件有 token、thinking、activity、question、error、done；另有 heartbeat。
5. 事件日志在新执行开始时直接清空（[web/app.py:2764](<D:/Funny Projects/Easel-0.2.1/web/app.py:2764>)），不是完整的幂等提交契约。Hub 需要由服务原子创建 Run、拒绝重复执行或返回已有 Run，不能把“可续播”误认为“可安全重复提交”。
6. 同会话使用进程内 async lock 和跨进程文件锁（[web/app.py:1769](<D:/Funny Projects/Easel-0.2.1/web/app.py:1769>)、[2896](<D:/Funny Projects/Easel-0.2.1/web/app.py:2896>)）。这是可借鉴的并发意识；Hub 更适合在任务认领、版本更新和运行租约上落实约束。

## 最强的 OpenClaw 耦合点

| 耦合点 | 具体内容 | Hub 取舍 |
| --- | --- | --- |
| 私有流文件 | gateway 写共享 raw JSONL；Web 记尾偏移后监听并按首个 `runId` 闩锁（[web/app.py:1927](<D:/Funny Projects/Easel-0.2.1/web/app.py:1927>)、[2870](<D:/Funny Projects/Easel-0.2.1/web/app.py:2870>)） | 不复制。并发下“首个新事件”不必属于本请求，Hub 要求明确 request/run correlation，不能猜归属 |
| transcript 修复 | 请求前调用 `_heal_openclaw_session`，直接修复运行时会话记录（[web/app.py:178](<D:/Funny Projects/Easel-0.2.1/web/app.py:178>)） | 不复制。外部运行时历史不属于 Hub 数据库 |
| 用户问答桥 | OpenClaw `question.list/get/resolve`，等待期间每 2 秒轮询，向 UI 发 question event（[web/app.py:2980](<D:/Funny Projects/Easel-0.2.1/web/app.py:2980>)） | Hub 自有 `waiting_input`/Approval，adapter 将运行时特有问答映射为统一对象 |
| WS 握手 | 固定协议 4，Ed25519 v2 device signature，读取已有设备身份，operator admin/read/write scopes（[easel/gateway_questions.py:47](<D:/Funny Projects/Easel-0.2.1/easel/gateway_questions.py:47>)、[261](<D:/Funny Projects/Easel-0.2.1/easel/gateway_questions.py:261>)） | 不借用其他产品的设备身份或 token；Hub 独立授权，最小 scopes |
| 提问版本门 | bridge 以本地版本判断 question RPC 是否支持并熔断（[easel/gateway_questions.py:52](<D:/Funny Projects/Easel-0.2.1/easel/gateway_questions.py:52>)） | 可借鉴能力检测与明确降级；不复制版本常量假设 |
| 全局权限配置 | UI 档位写 `.openclaw-easel/openclaw.json` 的 `tools.exec.mode`, `tools.fs.workspaceOnly`, `tools.deny`（[web/app.py:2150](<D:/Funny Projects/Easel-0.2.1/web/app.py:2150>)） | 不以修改执行器全局配置代替项目/成员/运行级授权 |
| 技能目录 | Web 扫描 `skills/openclaw/*/SKILL.md`，解析 description/layer；执行是消息要求 Agent 使用 `/skill-name`，不是强类型工具调用（[web/app.py:510](<D:/Funny Projects/Easel-0.2.1/web/app.py:510>)、[3432](<D:/Funny Projects/Easel-0.2.1/web/app.py:3432>)） | Hub 管理独立版本化 Skill；适配器按客户端能力导出，不假设所有 Agent 自动读 SKILL.md |
| workspace 布局 | sync 拷贝技能/shared/AGENTS/SOUL，追加项目根；profiles/outputs 使用 symlink（[openclaw/sync.sh:60](<D:/Funny Projects/Easel-0.2.1/openclaw/sync.sh:60>)、[96](<D:/Funny Projects/Easel-0.2.1/openclaw/sync.sh:96>)、[125](<D:/Funny Projects/Easel-0.2.1/openclaw/sync.sh:125>)） | 不建立对另一个产品 workspace 的全局共享写入依赖 |

问答接口细节：`POST /api/chat/question/answer` 收 `{sessionId?,questionId,answers,resolvedBy?}`，转为 `question.resolve` 的 `{id,answers:{answers:<map>},resolvedBy?}`（[web/app.py:3330](<D:/Funny Projects/Easel-0.2.1/web/app.py:3330>)、[easel/gateway_questions.py:366](<D:/Funny Projects/Easel-0.2.1/easel/gateway_questions.py:366>)）。本次核心对话路径未发现面向任意外部 Agent 的认证任务回调协议；不能把内部 `task.add_done_callback` 或发布通知 webhook 当作通用 Agent callback。

## 文件和产物契约

`skills/shared/scripts/manifest.py` 用 `outputs/<topic>/.easel.json` 保存展示字段与 steps。展示字段包括 title/summary/platform/kind/status/tags/cover/deliverables；步骤包括 layer/skill/at/status/outputs/upstream/summary。步骤状态 done/failed 与项目状态 draft/ready/published 是两个不同维度（[manifest.py:9](<D:/Funny Projects/Easel-0.2.1/skills/shared/scripts/manifest.py:9>)、[127](<D:/Funny Projects/Easel-0.2.1/skills/shared/scripts/manifest.py:127>)）。

可借鉴“完整成果在文件、结构化元数据引用成果、摘要连接步骤”，但 Hub 应增加不可混淆的 projectId/taskId/runId、输入快照/Skill 版本、相对产物引用、校验与审批结果。不直接采用 `.easel.json` 名称和自媒体平台领域模型。

附件使用 session hash 隔离 inbox，服务端检查路径结构、所属会话及文件 ID，然后构建显式附件清单（[web/app.py:1711](<D:/Funny Projects/Easel-0.2.1/web/app.py:1711>)）。这是可借鉴的数据最小化思路，但清单提示词本身不是文件系统沙箱。Hub 的真实访问权限仍需服务端校验。

## 不依赖 MCP / ACP 的接入方式

| 方式 | 适合用途 | 必要边界 |
| --- | --- | --- |
| HTTP JSON API | 外部 Agent 读取项目、认领任务、报告事件、登记成果 | 独立 Bearer、项目/成员/scopes、幂等键、输入校验；本次实现 `/v1/tools` 与 `/v1/call` |
| Hub CLI | 已具备终端工具的 Agent 调用同一受控工具面 | JSON 输入输出；凭据用环境变量；CLI 不直接打开数据库；本次实现 `hub-cli.cjs` |
| Worker pull / lease | 本地 Agent 主动拉取待执行任务，避免 Hub 暴露公网端口 | 本轮已实现运行认领、报告续租、到期中断；客户端需主动调用，不会凭此自动产生一个已登录的 Agent |
| 指定执行器的官方 CLI / SDK | Hub 主动派单给确有自动化接口的 Agent | 本轮已实现 CLI、ACP、OpenClaw HTTP 适配与模拟协议测试；其它 SDK 需逐个增加，真实模型状态见兼容说明 |
| 显式任务包与成果导入 | 无可用自动化接口的 Agent，人工跨产品交接 | task manifest/输入引用/Skill/验收规则；外部回传 artifacts/result；导入时重新验证，不自动批准 |
| 认证回调 + 事件流/轮询 | 长任务返回进度、输入请求、完成通知 | run-scoped credentials、事件 ID、重放保护、原子状态机；“Agent 文本完成”不等于业务通过 |

因此 MCP/ACP 是可选接入适配层，不是 Hub 内核。工具 schema、权限、任务契约和产物验收规则由内核统一维护。

## 许可证边界

不能把目录整体标记成一种许可证。本地发现：

- 根 [LICENSE:1](<D:/Funny Projects/Easel-0.2.1/LICENSE:1>) 为 Apache License 2.0；其再分发条件见 [89](<D:/Funny Projects/Easel-0.2.1/LICENSE:89>) 起，涉及许可证副本、修改标记、原有声明及存在时的 NOTICE；商标条款见 [138](<D:/Funny Projects/Easel-0.2.1/LICENSE:138>)。
- `skills/openclaw/gzh-design` 有独立 [LICENSE:1](<D:/Funny Projects/Easel-0.2.1/skills/openclaw/gzh-design/LICENSE:1>)，声明 AGPL-3.0-or-later；网络交互条款见其 [553](<D:/Funny Projects/Easel-0.2.1/skills/openclaw/gzh-design/LICENSE:553>)。不应当作 Apache 技能拷入闭源 Hub。
- vendored `video-pipeline-sdk` 的 [LICENSE:1](<D:/Funny Projects/Easel-0.2.1/skills/openclaw/video-production/vendor/video-pipeline-sdk/LICENSE:1>) 为 MIT，有其自身版权/许可声明。

此次采用独立实现，仅参考架构机制，没有拷贝上述实现或资源。以上是源码许可识别，不是完整依赖许可证审计或法律意见；未来如果复制代码、引入 vendored 依赖或发布结合产品，需要逐项核对实际文件来源、许可义务及素材/商标授权。

## 本轮可验证交付

- `backend/agent-gateway.cjs`：只包装 `hub.authorize/listTools/callTool`，提供 loopback HTTP JSON 和 stateless MCP Streamable HTTP（JSON 响应模式；GET SSE 返回 405）。
- `scripts/hub-mcp.cjs`：stdio JSONL bridge，连接一个已经运行的 Hub，不启动数据库或第二个写入者。
- `scripts/hub-cli.cjs`：按类别发现工具和调用工具；不提供任意命令执行。
- `tests/agent-gateway.test.cjs`：fake core + 真实 TCP HTTP + 真实 stdio/CLI 子进程，验证 Bearer、Host/Origin、1 MiB 限制、schema、MCP 握手/通知/错误与无 stdout 杂音。运行命令：`node --test tests/agent-gateway.test.cjs`。

这里的 transport 测试不意味着已完成 Codex/ZCode/ChatGPT/OpenClaw 等真实客户端配置联调，更不表示具备通用 Agent 派单/执行能力。接口不自动修改任何外部客户端设置，也不导入其身份或密钥。
