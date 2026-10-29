# 本机 Agent 安装发现与配对边界

核对日期：2026-10-05。以下为这台开发电脑的只读安装证据，不是模型调用成功报告，也不包含凭据。

## 本机核对结果

| 产品 | 安装证据 | 可以自动准备的接入 | 仍需区别的状态 |
| --- | --- | --- | --- |
| DeepSeek Harness | PATH 中 `@deepseek-ai/dsh` 包为 `0.1.2-rc.1`；Windows 应用登记另有 `DeepSeek Harness 0.2.0-rc.2` | 使用可核验 npm bin 的 Node + ACP 模板 | CLI 包版本与桌面版本不是同一个值；发现安装不代表模型认证通过 |
| OpenClaw | PATH 中 `openclaw` 包为 `2026.9.8`，声明 `openclaw.mjs` | CLI 单任务模板，任务通过受管的输入文件交给执行器 | Gateway / 模型认证仍由 OpenClaw 自己管理 |
| Hermes Agent | `%LOCALAPPDATA%\hermes\installs\...\environments\...\venv\Scripts` 中存在 `hermes.exe` 和 `hermes-acp.exe`，有 `pyvenv.cfg` 和对应 `hermes_agent` 包元数据 | 优先使用声明为 `acp_adapter.entry:main` 的 ACP 启动入口；没有 ACP 时使用 CLI | 这次安装不在 PATH，因此旧探测漏掉；已安装包的版本字段为 `0.0.0`，不把它当可靠发行版号 |
| ZCode | `C:\Program Files\ZCode\ZCode.exe`，Windows 登记版本 `3.14.4`；开始菜单快捷方式指向相同程序 | 识别桌面程序，提供外部客户端 MCP 接入引导 | 不构造未经证实的 ZCode CLI / ACP 命令，不自动写入其配置 |
| OpenAI 桌面端 | Appx 名称为 `OpenAI.Codex`，版本 `26.930.3930.0`；程序包含 `app\ChatGPT.exe` | 显示实际产品身份及 MCP / 插件授权边界 | `ChatGPT.exe` 这个文件名不等于安装了独立的 ChatGPT 产品；没有发现独立 `OpenAI.ChatGPT` Appx 包 |

额外只读核对了用户 Python / uv / pipx 目录、有限已知应用目录、Windows 应用登记与相关快捷方式。WSL 分发清单只有 `docker-desktop`；没有进入 Linux 分发运行任何 Agent。没有扫描整盘，没有读取登录凭据或聊天数据。

## 新探测实现

- 保持 `discoverAgentRuntimes()` 同步接口兼容。
- PATH 和用户 npm 安装目录：核对准确的包名、bin 声明、入口文件和 Node 程序。
- Hermes：覆盖用户 Python Scripts、uv / pipx 工具环境、官方 bootstrap 的隔离安装环境。仅下载源码或安装缓存不算可派单入口。
- 桌面程序：覆盖有限已知应用目录、Windows 卸载登记和 OpenAI Appx 登记。目录或登记中指向的实际程序必须存在。
- Windows 元数据查询通过固定系统 PowerShell 命令读取，不使用用户 shell profile、不执行被发现的程序。单次最多 2 秒（辅助模块参数上限 2.5 秒），缓存 30 秒；失败会返回说明，其他探测继续。
- 不把 `installed`、协议配对成功、模型调用成功混为一谈。探测本身的 `modelVerified` 始终是 `false`。
- GUI 程序不生成 `config`，不会误被用于主动派单。发现的 CLI / ACP 配置也只有在配对工作流中被显式使用后才会启动。

## 供界面使用的候选字段

旧字段 `id / provider / label / installed / status / source / version / note / config?` 保留。

新增字段：

| 字段 | 含义 |
| --- | --- |
| `kind` | `runtime` / `desktop` / `missing` |
| `protocol` | CLI / ACP 运行入口对应 `cli` / `acp`；桌面应用的接入建议为 `mcp`，不是已连接证明 |
| `connectionState` | `not-paired` / `client-authorization-required` / `unavailable` |
| `pairable`、`pairingSupported` | 是否存在可用于配对的 CLI / ACP 配置 |
| `evidence` | 安装路径、包声明或系统登记证据；无密钥 |
| `product` | 桌面产品真实登记名称，例如 `OpenAI.Codex` |
| `supportedProtocols` | 已核验声明的 Hermes 入口类型；不代表协议已经测试 |
| `limitations` | GUI 授权与主动派单边界说明 |

同一个产品可以有多个候选（例如 DeepSeek 的 CLI 和桌面程序）。界面应按产品分组，优先呈现可配对运行入口，并保留桌面安装证据。候选 ID 只根据产品和程序路径稳定生成，不包含认证信息。

## 回归测试

`node --test tests/agent-runtime-discovery.test.cjs` 覆盖 12 项：包入口核验、路径穿越拒绝、无副作用检测、5 产品状态、Hermes 隔离环境、源码缓存拒绝、uv CLI 模板、桌面应用与运行入口分离、Codex 产品身份、单项失败隔离、系统查询超时。
