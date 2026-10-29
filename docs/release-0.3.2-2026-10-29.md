# AIDesignHub 0.3.2 开源发布验收

日期：2026-10-29。平台：Windows x64，NSIS 安装向导。

## 交付物与源码基线

- 安装器：`AIDesignHub-Setup-0.3.2.exe`，661,332,698 字节（约 630.7 MiB）。
- 对应源码：`AIDesignHub-0.3.2-source.zip`，33,674,634 字节；包含工作台、Loomic 适配源码、许可材料和构建说明。
- 源码基线及 `v0.3.2` 标签：`ea041adf6bb616aa36f0e09496aada8ab8e97d37`。构建时工作树干净，源码 875 个文件；后续验收文档提交不改变该安装器的源码基线。
- 发布标识：`ADH-0.3.2-b63263e9-2101-482a-ba22-5c4d97a716a2`。
- 桌面交付目录：`%USERPROFILE%\Desktop\AIDesignHub-0.3.2-开源安装包`，附源码、清单、Ed25519 签名、独立 Node、Node 原许可和一键验证工具。

| 文件 | SHA256 |
| --- | --- |
| AIDesignHub-Setup-0.3.2.exe | `93d573c59229274f182d476d5a778b31fb71ab3d5a4b30bda6a3474db73d6814` |
| AIDesignHub-0.3.2-source.zip | `0830bfb918bffe958f7bcc6f273017add9ba9f3ab6063e89903fc7f7919defcf` |

## 许可处理

自有整合代码采用 AGPL-3.0-only；DeepSeek Harness 0.2.1-rc.2 保留 DeepSeek 的 MIT，Loomic 固定基线保留 Xinmin Zeng 的 MIT。原许可和版权既在源码中保留，也随安装器分发，关于页面可离线阅读。

补全 Apache 技能与字体版权材料，替换已核实来源的 Liberation Sans 2.1.5。elkjs 从 EPL-only 旧版本升级为带 GPL 次许可的 0.12.1，并随附相应 elkjs / ELK 源码及构建材料。详细证据、依赖例外和核对范围见 [许可审核记录](open-source-audit-2026-10-29.md)。

AGPL 允许合规商业使用、改名与再分发；本发行未添加竞品必须付费的限制。用户项目、知识资料、模型密钥和账号配置不随源码公开。

## 验收结果

- 串行全量测试 768 项通过，0 失败、0 跳过；干净源码副本中的针对性检查通过。
- 干净源码扫描 875 个文件，0 发现；许可检查通过，原版权和字体哈希保留。
- 最终 NSIS 安装器完整提取，容器及负载 CRC 检查通过；提取负载扫描 95,633 个文件，0 拦截发现。原始上游许可、捆绑 Harness 版本、234 个画布字体哈希及配套声明检查通过。
- 从该实际负载启动，确认 `app.isPackaged=true`；初始化前设置全新用户目录。文本模型未配置、媒体列表为空，关于页面显示本版 AGPL、源码入口和两家上游署名。
- 实际负载内的独立知识引擎启动未降级，合成 TXT 导入和检索通过；不使用真实模型、账号或额度。
- 同一 Ed25519 清单绑定安装器与对应源码。桌面独立 Node 验签返回 `valid: true`，两项产物摘要匹配。

本轮通过提取安装负载进行验收，未覆盖正在使用的安装目录，也未运行 NSIS 向导写入注册表。没有 Windows Authenticode 证书签名，未宣称字节一致的可复现构建或 SLSA 等级。

## 远端发布状态

[v0.3.2 正式发布页](https://github.com/bycjhuang/AIDesignHub-OpenSource/releases/tag/v0.3.2) 已公开，包含安装器、对应源码及全部 10 个附件。以未登录方式完整重新下载全部附件，逐个验证文件大小及 SHA256，并使用可信源码副本中的公钥验证下载后的清单、安装器和源码，结果通过；公开标签对应上述构建基线。

可核对 [发布清单](releases/0.3.2/AIDesignHub-0.3.2.manifest.json)、[分离签名](releases/0.3.2/AIDesignHub-0.3.2.manifest.json.sig.json) 和 [匿名下载验收记录](releases/0.3.2/public-download-verification.json)。

使用独立的 [AIDesignHub-OpenSource](https://github.com/bycjhuang/AIDesignHub-OpenSource) 发布干净源码；原私有仓库及真实资料历史保持私有。

## 五行交接

任务：完成 AGPL 开源与 0.3.2 对应源码、安装包发布。
现状：源码与 v0.3.2 已公开；实际安装负载、桌面独立验签及全部附件匿名下载复核通过。
关键文件：LICENSE、COPYRIGHT.md、THIRD-PARTY-NOTICES.md、third_party/、docs/releases/0.3.2/。
已定决定：仅公开独立干净仓库；原上游许可保留；不改动原私有历史与现有安装。
下一步：本次发布完成；后续版本继续按匹配源码、许可复核、负载验收和签名清单流程发布。
