# 独立 Agent 协作与案例采集实现记录

日期：2026-10-04。源码：`D:\AIDesignHUB`。没有修改 BYCJ 生图网站、Easel 源码或外部 Agent 的登录，没有替用户安装 Agent。最初实现未修改外部客户端配置；后续经用户明确授权，仅为 ZCode 添加隔离测试项目的只读 MCP 入口，详见下方验收记录。

## 已实现

| 层 | 实现 | 边界 |
| --- | --- | --- |
| 本地业务核心 | 项目范围授权、版本化 Skill、任务前置条件、Run、认领租约、事件、成果、人工审核、取消/失败/重启恢复 | 不把模型回答等同于任务验收；不读取外部私有聊天记录恢复业务 |
| 入站工具 | MCP stdio bridge、MCP Streamable HTTP、HTTP JSON 工具、CLI bridge、JSON 任务包/成果导入 | 同一核心校验权限；仅 loopback 监听；鉴权、Host/Origin、body/schema 限制 |
| 出站执行器 | CLI、ACP v1、OpenClaw HTTP（Chat / Responses） | 配置与模型账号分离；无任意 shell；超时、取消、输出和并发限制 |
| 本地知识 | 获准项目的已有文本索引检索，通过工具提供必要片段 | 没有升级为语义向量 RAG / OCR；发送到外部 Agent 的内容可能离开本机 |
| 案例调研 | 粘贴链接→公开页安全读取→初步字段→外部 Agent 调研→有来源成果→人工确认 | 不绕过登录/验证码；不执行网页脚本；不批量下载图片；字段缺失留空 |
| 桌面 UI | Agent 协作页、执行器配置/授权、任务运行与审核；案例链接表单、字段证据、来源链接、重试 | 维持现有浅色风格与 logo；需要重启主进程，旧窗口不能热更新 IPC |

本轮借鉴 Easel 的后台任务与界面解耦、运行事件和成果归档思路，没有复制其 OpenClaw transcript、身份、私有 WebSocket 或全局权限配置依赖。详见 [只读审查](easel-openclaw-audit.md)。

## 测试结果

- `node --test tests/*.test.cjs`：**123/123 通过**（同日案例续轮补充）；包含原有后端/团队同步回归、执行器、Gateway、权限与状态机、案例服务、公开页面读取器、客户端配置生成、隔离只读 ZCode 测试服务的 5 项回归，以及隔离案例入口的 9 项回归。
- 使用官方 `@modelcontextprotocol/sdk` **1.32.0** 的真实 Client 同时通过 stdio 与 HTTP 访问同一 Hub，完成任务认领/回传及权限拒绝。
- CLI/ACP/HTTP 适配器测试启动真实 fixture 子进程/loopback 服务；这些测试不调用模型、不消耗真实账户额度，不证明第三方客户端已登录。
- Electron **43.1.1** 隔离数据目录 smoke：原有导航、角色、知识、群聊、团队同步；五个 Agent 配置卡；任务创建→等待认领→HTTP 成果回传→安全文本显示→人工验收。
- 案例桌面 smoke：表单粘贴→等待 Agent→结构化成果回传→字段/来源详情→来源链接 IPC→人工确认。系统浏览器打开动作在 smoke 中模拟；生产实现调用 `shell.openExternal`，没有在测试中真的打开外部浏览器。
- 后续补做生产路径手动探针：`tests/fixtures/open-source-browser-probe.cjs --open-public-link`（由 Electron 显式启动，需新建临时 `aidesignhub-open-source-*` 数据目录，不加入 `npm test`）。真实表单采集 Ennead 公开页→案例详情→点击原始来源→生产 IPC→真实 `shell.openExternal` 已通过，返回 `systemShellAccepted: true`、`simulated: false`。原始 URL 含 `#aidesignhub-source-check` 且未丢失。此项证明 Windows 接受打开请求；Chrome 观察接口连续报 `nodeRepl.fetch request failed`，因此浏览器实际渲染仍待人工确认，不能报已目视验收。
- MCP 配置桌面 smoke：生成 HTTP 占位模板、显式带本次密钥、刷新同时清除原始密钥与敏感模板、生成 Electron stdio 配置；创建授权期间隐藏/刷新/离页均不能晚回显密钥，普通后台快照更新仍保留有效新密钥，撤销清除原始显示。官方 SDK 测试直接消费新生成的配置，而非重复手工拼接参数。
- 截图已查看：`.smoke-agents.png`、`.smoke-cases.png`、`.smoke-case-detail.png`。测试样本不是用户真实项目成果。
- 官方 npm registry 审计报告本次锁定依赖 **0 项已知漏洞**。默认镜像不支持审计，已用单次 `--registry=https://registry.npmjs.org` 核查，没有改全局 npm 配置。这不是代码安全认证或安装包签名。

重点回归：跨项目越权/伪造 principal、两个客户端抢占、授权撤销、临时 token 泄漏与生命周期、取消后迟到结果、失败回滚后异步状态、旧进程晚清理不能覆盖新授权；外部采集跨异步过程不能因连接变更升级成主动派单；排队重试不会重复启动；字段与证据数字矛盾保持待核实。

续轮补充：逐 Run 生成独立会话 ID、CLI 模板单次替换、准确 UTF-8 prompt 文件、Windows 命令长度预检、HTTP 会话冲突拒绝、HTTP Agent ID 持久化；拒绝 OpenClaw 固定会话或向外部聊天投递的 CLI 配置。其它自定义 CLI 的历史复用取决于其参数，cwd 不是文件系统沙箱。外部案例采集工具的 MCP 元数据明确标记为会访问外部来源。独立审查发现并修复授权创建异步晚回显、显式刷新/撤销/离页原始密钥残留两项 UI 缺口，真实桌面回归通过。

## 真实公开网页验证

使用生产 `fetchPublicPage` 与 `CaseResearchService` 读取 [Ennead 上海天文馆项目页](https://ennead.com/work/shanghai-astronomy-museum/)，并在隔离临时目录保存案例记录。实际结果：

- `status: page_extracted`，无错误；原始链接保存且未被替换。
- 面积 `Size：420,000 GSF`；地点 `Shanghai, China`；功能保留官网 Program 原文。
- 开业日期、设计方没有明确可提取字段，保持为空。不把 Year 2021 或媒体文章日期替代开业日，也不推断/换算面积。
- 这是页面提取实测，不是外部模型调研完成，也没有写入用户真实工作台数据。

## 真实 Agent 状态（仍需后续联调）

| 客户端 | 已验证 | 尚未验证 / 问题 |
| --- | --- | --- |
| OpenClaw 2026.9.8 | 本机 CLI/help；Gateway health/RPC 可达 | 最小真实任务退出 1。后续只读诊断明确提示默认 CLI 目标缺调用凭据，但首次 stderr 未保留，不能宣称唯一根因完全还原 |
| DeepSeek Harness 0.1.2-rc.1 | 隔离 DSH_HOME 下 ACP v1 initialize 成功，正常退出 | 没有 session/prompt 或模型调用，不能称账号/模型已连通 |
| Hermes | 本机源码与官方 CLI 参数一致 | 所查路径没有可用安装解释器，未执行模型 |
| ZCode | 用户授权配置；真实客户端握手、列出唯一工具、新会话调用 `hub_project_context` 一次并正确回答，客户端日志与服务回执交叉确认 | 仅限虚构项目只读验收；未开放真实资料、任务写入或主动驱动 ZCode |
| ChatGPT 桌面 | 官方 MCP/私有隧道路线核查 | 未进行用户账号连接或隧道配置，不承诺桌面窗口主动派单接口 |

缺少用户实际客户端/账号配置的部分没有伪装成成功；没有将用户已有设备身份、密钥或外部会话复制到 Hub。具体命令见 [兼容说明](agent-compatibility.md)，使用步骤见 [操作指南](agent-and-case-guide.md)。

授权前的同日只读审计：当时 ZCode 用户级配置没有 AIDesignHub 命名入口，本工作区没有 `.zcode/config.json` 或 `.agents/mcp.json`。该 ZCode 状态已被下面的授权联调结果更新。其余审计结果：本进程 OpenClaw Gateway token/password 环境变量均未设置，18789 端口仍在监听；DSH CLI 存在，所查 Hermes PATH/源码 `.venv` 不存在可执行入口。没有输出或复制凭据，也没有把进程存在、端口监听或协议 fixture 当作真实模型成功。

## ZCode 最小权限真实验收（2026-10-04 13:24，Asia/Shanghai）

用户授权原文：“先接 ZCode，允许我为它添加 AIDesignHub 测试项目的最小权限 MCP 配置”。操作窗口被用户最小化后暂停输入，得到“可以，继续验证”的确认后，使用 Windows Computer Use 在 ZCode 新建无项目测试会话，没有继续或中断用户原有会话。

- 配置位置：`C:\Users\user\.zcode\cli\config.json`，新增 `mcp.servers.AIDesignHub-Test`，原有插件配置对比保持一致。修改前备份为同目录 `config.aidesignhub-before-20261004-131056.json`。ZCode 启动已有 `.runtime/electron.exe`，参数为 `scripts/zcode-mcp-test.cjs`，环境仅显式设置 `ELECTRON_RUN_AS_NODE=1`，配置不含原始令牌。
- 测试入口每次强制建立全新 `%TEMP%\aidesignhub-zcode-*`，不能指定真实数据目录；只含 `project_zcode_mcp_synthetic`（AIDesignHub MCP 虚构测试项目）。授权只有 `project:read`，工具只有 `hub_project_context`，最长 30 分钟。没有出站执行器、任务写入、知识检索、任意文件访问或终端工具。
- 标准 SDK 使用配置中的准确 Electron 命令预检通过；这与真实 ZCode 验收分开记录，不能冒充客户端验收。
- 真实 ZCode 首次握手：13:15:22，客户端 `zcode 0.16.9`、协议 `2025-11-25`、stdio、工具数 1，PID 69828。新测试会话另启 PID 13848，13:23:06 再次连接成功。
- 13:24:32.242 至 13:24:32.260，ZCode 日志出现 `mcp__AIDesignHub-Test__hub_project_context` 的 `tool.call.started → completed`，耗时 18 ms。`C:\Users\user\.zcode\cli\log\zcode-2026-10-04.jsonl` 当时第 1984–1985 行。父进程链为 `ZCode.exe(25636) → electron.exe(13848) → bridge(66612)`。
- 对应 `%TEMP%\aidesignhub-zcode-P12xm7\test-receipt.json`：`contextCallCount=1`、`toolCalled=true`、`deniedToolCallCount=0`。ZCode 界面显示 MCP 调用记录，并回答正确项目名称和 ID，明确这是虚构项目。不是只凭模型自述判断调用成功。

授权只约束该 MCP 服务，不改变 ZCode 自身已有的工具或全局权限；没有把“只读 MCP”声称为整个 Agent 的 OS 沙箱。测试资料可能经 ZCode 发送到其所选模型，所以这里只使用虚构内容。测试授权到期或正常断开后撤销并停止服务；Windows 强制杀进程无法保证正常清理回执。临时测试目录保留合成数据、令牌哈希与不含正文的回执，不自动删除。配置入口保留供复测，重连仍只产生虚构项目，不会切换到真实项目。

## 保留的产品边界

### 案例回归与用户自选来源（同日后续）

用户授权继续做隔离案例任务读取、认领与成果提交测试，随后明确“我自己来录入一些参考项目的连接，你来测试吧”。因此不再替用户选择真实模型验收案例，也没有把新增案例写权限写入 ZCode 配置；等待用户提供链接或确认已录入后，再限定到这些案例执行。

本次独立审查找到并修复两项问题：

1. 页面提取与 Agent 回传共用的分类逻辑与界面筛选值不一致。现在酒店对应 `hotel`，博物馆、天文馆、美术馆等对应 `culture`，住宅和商业分别对应现有筛选；未知类别保持 `other`。
2. Agent 显式返回 `null` 时，原初提取值及其证据未被清除。现在显式 `null` 会清空值、摘录和字段来源并标记 `not_found`；缺省字段仍兼容部分结果，不自动删除旧值。全部字段未知时，案例页和通用 Agent 审核都不能将其批准成已核实事实。

补充面积证据回归发现：`GSF` / `SF`（包括 `12000GSF` 这种无空格写法）此前未进入单位检查，可能把“数字相同但原文单位是平方米”的结果错误标为已有来源摘录。已先复现失败再修复；现在这类错配保持 `needs_verification`，不自动换算，也不删除原面积口径。

案例单元测试 16 项通过；案例、公开页面读取器、Agent 核心联跑 67 项通过。隔离 Electron 桌面回归通过，截图已查看：`cultureVisible=true`、`excludedFromHotel=true`，来源链接、未知开业日、待审核与确认状态均通过，无 JavaScript 错误。该桌面测试使用协议 fixture，打开浏览器动作为模拟，不是用户自选案例的真实 ZCode 调研验收。

新增 `scripts/zcode-case-test.cjs` 仅是显式启用的隔离验收工具，不是正式客户端连接。它固定新建临时测试项目，内部准备公开案例，只开放任务列表、运行列表、认领、进度报告、成果提交五个工具；不开放项目资料、知识检索、案例采集、任务创建/启动或审核。此工具尚未配置到 ZCode；原有 `AIDesignHub-Test` 仍保持一个只读工具不变。测试结果以该入口的专项回归及完整套件最终结果为准，不能由源码存在推断真实模型调用成功。

该入口专项最终 **9/9 通过**：官方 MCP SDK 读取任务→认领→报告→带证据 JSON 提交并停在待审核，越权拒绝，错误 JSON/证据保留失败，数字与引文矛盾保持待核实，来源失败不伪造任务，准备网页期间仍可握手，超时/EOF/信号清理，Windows 回执共享锁故障注入。没有调用真实模型。完整套件曾复现超时清理失败：Windows 同时读取回执导致原子替换报 `EPERM`，诊断写入异常中断了退出流程。修复仅对共享锁错误进行短且有界重试，诊断记录失败也不能阻止撤销授权和关闭自有进程；授权哈希及期限保存失败仍拒绝启动。补充确定性故障注入后，主线程完整套件 **123/123** 通过。

当前仍为本地 JSON 单写者持久化与锁，不是 SQLite 迁移；GUI 与 headless service 不能同时独立写同一数据目录，GUI 尚不能附着到已启动的 headless service。角色化授权不是 OS 沙箱。ACP 自动拒绝实际收到的权限请求，并不控制外部 Agent 自有的全部工具权限。

这一轮更新源码与文档，没有重新制作/签名公开发布安装包，没有完成干净 Windows 系统安装验收，也没有声称五种外部软件全部真实联调完成。
