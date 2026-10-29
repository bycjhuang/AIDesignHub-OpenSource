# Harness 升级与专业软件 MCP 接入

日期：2026-10-26；项目：`D:/AIDesignHUB`。

## 当前结果

ADH Agent 从 DeepSeek Harness `0.2.0-rc.2` 升至 `0.2.1-rc.2`，已安装到本机并重启 Hub 验证。沿用原应用身份、业务数据目录和 `DSH_HOME`。原有聊天文件逐字节保留，默认模型、自定义插件、MCP、技能目录及未知 YAML 配置按语义保留。

版本依据为 [npm 默认 latest](https://registry.npmjs.org/@deepseek-ai/dsh/latest)。本次核对时 `next` 指向 `0.2.1-rc.4`，不是默认通道；没有把候选通道自动切到本项目。官方更新见 [DeepSeek Harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases)。

固定运行组合：Node `24.18.1`、Harness `0.2.1-rc.2`、pnpm `11.7.0`、pi-ai `1.1.0`。本机实际 CLI 版本及 295 个 DSH 包版本检查通过。

## 专业软件接口

借鉴 BYCJ Design 桌面端的专业 stdio 服务与工具发现插件，重新生成 Hub 自己的配置和本地资源。支持以下 14 类软件：

| 设计与建模 | 图像与排版 | 视频与后期 |
| --- | --- | --- |
| Blender | Photoshop | Premiere Pro |
| 3ds Max | Illustrator | After Effects |
| Revit | InDesign | Cinema 4D |
| Rhino | Lightroom Classic | |
| SketchUp | | |
| ArchiCAD | | |
| AutoCAD | | |

若本机已安装 Rhino 8/9 官方 MCP router，另外发现其接口。本次实际注册的是 14 个离线服务；没有将“本机存在某个软件”当作软件已连接。

离线副本位于 `.runtime/professional-mcp/`，包含 Python、服务依赖、软件侧桥接源文件及原许可；运行不依赖 BYCJ 项目目录，不引用 BYCJ 账号、密钥、模型路由、积分或网站后端。最终副本 18,613 文件、331,746,110 字节；树摘要 `748bc745e6e5c02fea492e28a56d6ff47e71f95c3e084352772fde862f5b503c`。

Lightroom 上游会在普通服务启动时自动安装插件。本项目保留原文件，使用只移除该启动调用的派生入口；显式 `install-plugin` 命令仍保留，补丁及原/派生哈希记录在本地 manifest。普通启动不安装软件侧插件。

## 使用与迁移

在左侧打开 **ADH Agent**，配置本机模型后用自然语言提出软件任务。Agent 使用 `adh_search_tools` 搜索，再通过 `adh_activate_tools` 激活所需 MCP 工具；下一轮模型请求才携带这些工具的原始参数。每个 Agent 最多激活 24 个 MCP 工具，schema JSON 总长最多 48,000 字符。搜索和激活本身不执行软件操作，工具权限与参数校验仍由原执行路径负责。

真正操作软件前，需要安装并启动目标软件、启用其对应桥接插件。各服务随附文档和插件源文件位于 `.runtime/professional-mcp/servers/<软件>/`。本轮完成了接口及协议验收，未执行真实建模、图像编辑或文件写入指令。

离线资源不进入 Git。另一台机器或全新克隆需准备同一套离线资源，再执行：

```powershell
node scripts/stage-professional-mcp.cjs --source <离线mcp-bridges目录>
```

staging 逐文件核对 SHA256，显式更新时保留前一个副本；普通启动只检查现有资源。没有资源时 Harness 仍可启动，运行状态中的 `professionalMcp.ready=false` 表示接口资源尚未准备。维护说明见 [专业接口说明](../backend/professional-mcp/README.md)。

## 配置与恢复

- 运行时先安装到新目录，核验版本和依赖后切换；旧 `0.2.0-rc.2` 保留，安装失败不破坏旧目录。
- profile 按插件 ID 合并；保留用户选择的默认模型、推理设置、其他 provider、MCP 和未知配置。无效 YAML 拒绝覆盖，连续模型/主题更新串行写入。
- 原 profile 首次更改前生成 `*.before-0.2.1-rc.2`，包元数据与 patch 使用临时文件再替换。
- 就绪检查验证真实 token 登录、首页 HTML 和品牌服务；支持新版 token 登录返回的 303。子视图在同端口更换 token 后也重新鉴权。
- 真实用户的升级前备份及证据位于已忽略的 `.test-harness-upgrade/`，包含原 `dsh` 配置和聊天；没有提交这些资料。

## 验收

| 检查 | 结果 |
| --- | --- |
| 新增 Harness、profile、安全合并、MCP 与工具发现测试 | 28/28 通过 |
| 完整 `npm test` | 481 项：472 通过，9 项原有失败，0 跳过 |
| 原有失败对照 | 独立提取原始 HEAD，两组测试复现同样 9 项失败；未改相关业务模块 |
| 14 个本地服务真实 MCP initialize / listTools | 14/14 通过，共 770 工具；0 软件工具执行、0 模型请求 |
| 完整 Host composition 的工具发现 | 实际注册 14 服务/770 MCP 工具；新 Agent 初始 0 个 MCP schema，搜索/激活可用；激活一个 Blender 工具后原 schema 完整保留，清空后恢复隐藏 |
| Lightroom 启动副作用 | 未自动安装软件侧插件 |
| 新 Host 鉴权与历史读取 | 登录、首页、品牌资源、session/list、projections、page 均通过；旧会话的 106 条记录可读取 |
| 本机应用 | 正常关闭旧窗口，再启动 Hub；ADH Agent 新版界面正常，原会话可见，deepseek-flash 模型保留 |
| 用户资料 | 53 个原文件核对：48 个不变；变更仅为 profile、进程锁与工作区增加空白会话；原会话文件不变，原工作区关联保留 |

全量测试的原有失败属于演示公司初始化与历史项目同步：`tests/demo-company.test.cjs` 5 项、`tests/project-isolation-sync.test.cjs` 4 项。基线 HEAD 为 `2091936ebef54aa0374d72e9fc408a4a4d5020d5`。本次没有扩大到这些业务问题。

本地证据包括 `.test-harness-upgrade/test-suite.log`、`baseline-head-evidence.json`、`host-probe-report.json`、`audit-host-report.json`、`preservation-report.json` 及 `.runtime/professional-mcp-protocol-report.json`。当前为本地源码和本机运行验证，没有制作或发布安装包。

## 五行交接

任务：升级 Hub 内置 Harness，迁入 BYCJ 专业软件 MCP。
现状：默认通道 rc.2 已本机运行，14 服务及按需工具发现已接入。
关键文件：`backend/dsh-provisioner.cjs`、`dsh-runtime.cjs`、`dsh-profile-patch.cjs`、`dsh-professional-mcp.cjs`、`dsh-plugins/adh-tool-discovery/`。
已定决定：保留原身份与资料，使用本机独立离线副本，按需加载工具，不自动安装 Lightroom 插件。
下一步：按实际需要启用目标软件桥接插件，再逐软件验收真实操作；跨电脑使用先准备离线 payload。
