# Loomic / AI Design 本机接入

更新：2026-10-28。

AI Design 直接复用 `Loomic-main/Loomic-main` 的原版 Home、CanvasPage、CanvasEditor 与 ChatSidebar；保留原侧栏、首页输入框、最近项目、灵感区、原生图片／视频工具、图片引用和 Agent 交互。`/hub` 初始化本机会话后进入原 `/home`，再从原项目卡片或创建入口进入原 `/canvas`。本机品牌使用现有 AI Design Hub 标志；本机积分位置显示 API 直连，云登录、Supabase、积分、支付及云端路由的原代码保留。构建仅以 `NEXT_PUBLIC_HUB_LOCAL_RUNTIME=1` 选择本机适配。

## 运行

在 Loomic 根目录安装 `pnpm install --frozen-lockfile --ignore-scripts`，在 Hub 根目录运行 `npm run build:ai-design`。构建脚本生成 shared 包和 web 静态导出，同时将 Excalidraw 字体复制到本机静态目录；首次安装不访问云数据库。正常从 Hub 左侧 AI Design 打开，主进程按需启动仅监听 127.0.0.1 的服务，退出 Hub 时停止。

画布位于应用数据目录的 `design-workbench-v1/ai-design-v1`，Hub 项目分别存放。接口每次核对当前项目，旧页面不能继续读取已切走项目的画布或素材。静态页面无 Node 和 Hub preload 能力；父子消息仅用于打开统一模型设置、刷新模型状态和收起画布侧栏，宿主校验消息来源及本机 origin。

## 模型配置

Hub 左下的模型设置分为对话与推理、图片生成、视频生成。原文本模型处理流程保留；媒体配置使用独立的本机加密目录，支持多个模型及分类默认值。空 Key 保留原密钥，更换服务地址需重新填写密钥；加密不可用时拒绝保存密钥，不明文降级。

首轮图片接入 OpenAI 兼容 `/images/generations`，生成结果保存在本机并加入当前画布。保存设置、打开画布均不调用模型。视频当前仅管理配置，未声称视频生成已经完成。生成按 requestId 持久化去重，超时或失败不自动重放可能已经计费的请求。图片 URL 读取复用安全下载器（8MB），base64 图片上限 25MB。

图片引用或编辑使用当前项目内的图片 ID，经校验后向兼容 `/images/edits` 发送真实 multipart 参考像素；不会把本机路径或任意 URL 当成可信参考。原 Agent REST／WebSocket 由本机适配，文本模型使用 Hub 既有配置；工具调用可检查和编辑当前画布、生图及编辑已有图片，结果通过原版事件流写回原画布与对话。当前文本模型只接收结构和文字摘要，不能冒充已经视觉阅读图片；生图／编辑模型收到用户指定的参考像素。本机素材的访问凭据在发送给文本模型前移除。

## 沉浸模式与验收

进入 AI Design 收起 Hub 导航、顶栏及项目聊天，保留 Loomic 原版 Home 和画布自身全部界面，原 Agent 侧栏默认展开。鼠标在最左 10px 停留 800ms 才展开 Hub 导航，移开收回；键盘聚焦或主动点击边缘按钮可展开。退出 AI Design 恢复正常 Hub 导航。

真实 Hub 已打开原版 Home，并通过原「新建项目」进入 Canvas 与 AI Design Hub Agent；原图片和视频工具入口实际可见。统一模型对话框的图片／视频分类及表单已检查，API Key 不回显。边缘展开实测约 807ms，切回项目驾驶舱后正常导航与顶栏恢复。

`tests/loomic-original-ui.test.cjs` 在独立 Electron 和临时数据中使用真正原版 Home／Excalidraw／Agent DOM，走原按钮与 WebSocket：新建、聊天生图、@ 图片引用编辑、两张图片写回画布、刷新恢复且没有重复请求。Provider 使用明确的模拟服务，完成的外网请求为 0；截图及结果在 `.runtime/test-artifacts/loomic-original-ui/`。图片编辑 multipart、媒体加密、项目撤权、工具调用和统一模型面板另有回归。没有发起真实付费生成。上游仍有部分原云模块类型检查与测试签名问题，静态构建成功不代表上游全仓类型检查通过。

最终核心定向回归 51/51；完整 Hub 测试 726 项中 717 通过，9 项仍为原有演示初始化和项目同步基线失败。顶部控件另在 1600／1024／760 宽度、Agent 展开／收起的 6 种真实 DOM 状态检查通过，收起时间距 14–16px；运行中的 Hub 实测约 16.7px。技能提示使用中性文字「试试这些技能」。更新前已备份 AI Design 工作区；更新后两张现有画布的元素序列 SHA256 完全一致，当前用户矩形仍可见。

图谱刷新已尝试，但 codebase-memory-mcp 的索引 worker 在文件处理阶段崩溃，工具保留旧索引；新模块发现需按本文件地图或字符串检索补充，后续重试工具刷新。

## 交接

任务：Loomic 接入 AI Design，并统一分类模型设置、提供沉浸式画布。
现状：本机模式与统一配置已接通，保留云端原模块；未调用真实生图／视频模型。
关键文件：`ai-design-ui.js`、`backend/loomic-local*.cjs`、`backend/canvas-agent-*.cjs`、`backend/media-model-service.cjs`、`setup-center-ui.js`、原 `CanvasEditor`／`ChatSidebar` 与本机传输适配。
已定决定：项目画布隔离、密钥本机加密、显式生成才调用服务、失败不自动重试。
下一步：由用户配置实际模型服务后验收真实生成；视频生成与云端部署按原模块继续接通。
