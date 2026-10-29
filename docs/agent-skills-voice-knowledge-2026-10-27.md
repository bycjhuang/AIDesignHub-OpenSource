# Agent 技能、语音与知识库替换

日期：2026-10-27；项目：`D:/AIDesignHUB`。

## 范围

用户要求清理 Hub 中个人工作营、短视频封面等 Skill，参考 BYCJ Design 增加语音输入和直观技能列表，并用 BYCJ 桌面知识库的功能替换 Hub 原知识中心。用户明确选择：**只迁移功能，保留 Hub 原资料，不导入 BYCJ 实际资料**。

实现均在 Hub 内；BYCJ 项目作为只读参考。不迁移 BYCJ 账号、密钥、积分接口或网站模型网关，不修改用户全局 `.agents/skills` / `.codex/skills` 文件。

## 技能清理与列表

- 实际默认文件技能来源为 `~/.agents/skills`，原来发现 33 项。其中 `ai-workshop-video-cover`、`ai-workshop-video-editing`、`expedition-frog-digital-human` 是本次实际排除的个人流程；另外为明确的个人品牌封面等 ID 设置精确过滤名单。
- 过滤用于技能发现与加载两端，保留工作区根目录、自定义目录、优先级和更新监听。官方 Agent preset 的局部技能作用域也需受同一规则约束，避免只过滤全局清单。
- 按截图补充排除 `animate`、`carton-bitmap-to-editable-svg`，仅作用于 Hub。Hub 专用运行时的原生文件技能入口同步过滤，保存原始模块及哈希清单；完整 Host 验证覆盖 standard、ptc、cordis 三种预设。
- 重启实际 Hub 后，“Agent 技能”显示 29 项（含一个官方内置技能），上述个人技能均不在清单；针对技能策略和列表的 13 项测试全部通过。原有 22 份归档文件、聊天和密钥保存检查通过。
- ADH Agent 内左侧新增 **Agent 技能**：读取真实技能服务，按当前会话工作区与预设展示名称、用途、来源、可用方式；支持搜索与只读原文。没有选择会话时明确展示全局清单。
- 列表不执行 Skill，也不把 Skill 文本渲染为 HTML；详情名称重新向注册服务核验，不接受任意文件路径。

关键文件：`backend/dsh-skill-policy.cjs`、`backend/dsh-plugins/adh-skill-policy/`、`backend/dsh-plugins/adh-skill-library/`、`backend/dsh-runtime.cjs`。

## 本地语音输入

默认启用官方 `@deepseek-ai/dsh-experimental-voice-input-bundle`。一次性 `adhDesktopDefaults.voiceInput=1` 保留后续用户主动关闭的选择；本机按本次明确要求开启。使用独立 SenseVoice INT8、tokens 与 Silero VAD，共 241,357,257 字节，逐项与 rc.2 官方资产 SHA256 一致。

模型位于 Hub 的 `DSH_HOME/speech-to-text/sensevoice/models/`，没有运行依赖 BYCJ 的模型路径。输入框麦克风将识别结果放入草稿，不自动发送聊天。

Agent 使用独立持久分区 `persist:adh-agent`。麦克风授权仅允许当前可信 Agent 主文档的音频请求；摄像头、其他视图、其他来源和旧端口拒绝。没有扩大全局 Electron session 的权限。

验收使用合成中文 WAV 和虚拟设备，完成本地识别“这是一段语音输入测试。”及权限四场景检查；未录制真实麦克风、提交聊天或调用付费识别。

关键文件：`backend/dsh-voice.cjs`、`backend/dsh-view.cjs`、`backend/dsh-runtime.cjs`。

## 知识库功能

采用 BYCJ 的本地知识引擎、解析器、完整处理流程及原生 Office 导出，改接 Hub 的本机模型与项目作用域。界面为左侧资料库 / 文件树、右侧资料问答 / 本地搜索，包含：

- 资料库新建、改名、删除；文件与文件夹导入、更新解析、来源位置与原文引用。
- AnythingLLM 核心、LanceDB 本地向量索引、multilingual-e5-small，以及全文降级检索。
- PDF / Office / 文本解析与中文图片、扫描 PDF OCR；解析警告保留在来源与导出中。
- 基于命中资料的问答；整库处理分页遍历完整解析正文，检查快照、范围及引用，按固定规则计算统计与排序。
- 完整结果在主进程磁盘持久化，原生 `.docx` / `.xlsx` / `.pptx` 导出读取完整记录，不拿聊天预览补成文件。
- 取消、进度、错误恢复、按项目和资料库隔离的历史与草稿；保存提交阶段不会误报取消成功。

导入文件会复制到 Hub 自己的数据目录。重复导入相同原路径会复用该资料来源，不因内部 UUID 路径重复统计；重新解析保留原展示名与来源位置。删除知识库或来源只移除相关索引，原归档文件继续保留。

本地索引与 OCR 强制使用离线资源，缺资源明确降级，不后台下载。问答仅在用户发送问题时调用 Hub 已配置模型；发送的是本次相关文字，原文件留在本机。没有模型时明确标记为原文提取，完整范围也不冒称已完成语义整理或统计。失败或取消不自动重发模型请求。

当前沿用本机单个已配置模型，页面展示模型并可刷新；模型修改仍在 Hub 的模型设置完成。

## 原 Hub 资料迁移与恢复

首次打开每个项目的新知识库时，按原资料分类建立独立资料库，保留原资料 ID、归档路径、展示名和全部历史片段。每个 Hub 项目的引擎目录独立，不能使用另一个项目的资料库 ID 或结果 ID。

原项目当前为 **22 份资料、669 个历史片段**，22 份归档文件均存在；迁移不覆盖这些原文件。新库保留旧片段，提示“更新解析”；完整整理发现旧片段时先更新原件解析，再开始处理。原文件失联或解析失败保留旧索引并标明范围不足。

新状态位于业务数据目录下 `knowledge-workbench-v1/`。首次迁移前的工作台原始 JSON 保存在 `migrations/hub-original-v1.json`；项目迁移 manifest 记录来源数量和原备份哈希。原 `knowledge-files/` 继续保留。不要用删除索引或原文件的方式消除解析错误。

解析完成和 `coverage.complete` 表示可读索引经过处理，不代表每个原文件逐页零遗漏或 OCR / 模型无误。扫描 PDF 的 OCR 页数限制、复杂 Office 对象等边界沿用引擎警告。

## 资源与验收记录

自包含知识运行时位于已忽略的 `.runtime/knowledge`：独立 Node、133 个公开依赖、E5 / OCR 模型，7351 文件、692,608,532 字节。payload SHA256：`71dabbd93b382b835c9e28d630275e49113f5631802a7421aabad8eaa5a9e213`。维护源码、AnythingLLM 原源、许可证和变更来源位于 `backend/knowledge-engine/`；问答完整处理源码与校验记录位于 `backend/knowledge-upstream/`。

另一台机器需按 `backend/knowledge-engine/README.md` 先准备离线运行时；运行不依赖 BYCJ 源目录。独立运行时和真实资料不进入 Git，未制作或公开发布安装包。

临时数据验收覆盖真实本地 E5 / LanceDB、TXT / DOCX / XLSX / PPTX / PDF / 图片 OCR / 扫描 PDF、缺资源降级、长正文无截断、旧缓存保留、原生 Office 导出回读、重复导入、跨项目隔离与取消。模型侧通过本机 HTTP stub 验证单次请求、完整批处理、统计与失败不重放，未调用真实云模型。

完整测试当前为 532 项：523 通过，9 项原有失败，0 跳过。原有失败属于演示公司和历史项目同步，已在升级前原始 HEAD 复现。技能与语音、知识库证据主要位于 `.test-harness-upgrade/*acceptance.json` 与 `.test-agent-skills-voice-20261027/`。

## 五行交接

2026-10-27 补充：按 BYCJ 技能中心迁移分类卡片、搜索、返回会话及右侧详情，入口更名“技能中心”。配套 14 项专业软件 Skill 迁入 `backend/professional-skills/`，调整为 Hub 独立桥接路径，保留同名用户自定义技能。实际界面共 43 项，个人排除名单继续生效。技能库、专业技能分发和运行时 12 项检查通过；完整 Host 的六项策略检查通过，包含 standard / ptc / cordis 三种预设。

任务：清理个人 Skill、加入语音和技能列表、替换知识库功能。
现状：Hub 本地实现、合成资料与实际界面验收；原 22 份资料及历史片段保留。
关键文件：`backend/dsh-voice.cjs`、`dsh-skill-policy.cjs`、`dsh-plugins/adh-skill-library/`、`knowledge-workbench*.cjs`、`knowledge-engine/`、`knowledge-answer.cjs`、`knowledge-workbench-ui.js`。
已定决定：仅迁 BYCJ 功能，保持本机模型和项目隔离，全局 Skill 与实际资料不删，不接网站积分后端。
下一步：按资料解析提示更新旧索引，使用实际问题核对引用和 OCR；跨电脑运行先准备离线资源。
