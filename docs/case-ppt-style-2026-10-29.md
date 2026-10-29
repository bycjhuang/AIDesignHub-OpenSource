# 案例 PPT 风格与短页恢复

用户要求恢复内置简报版／杂志版选择，每个案例只制作 1–3 页。截图中的 30 页文件来自安装版旧通用报告生成器；当时安装版没有接入工作目录中的风格更新。旧报告的正文续页机制进一步增加了页数。

## 当前行为

- 输入框右侧、ADH 执行器旁直接选择「PPT · 简报版／PPT · 杂志版」；Hub 任务弹窗共用同一选择，不再每次打开重置。
- 简报版为蓝白四图网格及项目档案／特色／借鉴／改进；杂志版为暗色大图及借鉴／转译／警示。
- 本机保存用户选择；调研命令、PPT 命令和直接调用 Hub 成果工具均带入当前风格。先生成 HTML 不会消耗或清空随后 PPT 的选择。
- 每个案例默认 1 页，允许 1–3 页。多案例方案逐页填写 caseId，生成器验证归属与数量；超限返回可修正错误，不静默截断。四个案例各一页会完整输出四页。
- 不另加报告封面、目录或分析续页。结构化短文用于版面，完整 body 与来源保存在备注；页脚来源均可点击。
- 原图按案例匹配，不用其他案例图片补空白。已有 30 页成果需重新生成，不覆盖原文件。

## 验证与安装

- 定向测试 66/66：客户端风格选择及失败保留、命令继承、服务权限／会话、HTML 后继续 PPT、两种模板的页数／备注／图片归属、原生 SDK。
- 首轮并行全量 754/756；失败为既有弹窗和画布刷新 UI 测试，串行单独复查 2/2 通过。日志位于 `.runtime/case-style-full-tests.log` 与 `.runtime/case-style-ui-recheck.log`。
- 语法检查及本次文件 diff 空白检查通过。安装版 4 个文件与工作目录 SHA-256 一致。
- 原生界面验收：重启当前安装版，进入「项目案例分析与PPT制作」原会话；底栏可见「PPT · 简报版」，展开可见简报／杂志两个选项，实际切换为杂志版后组合框显示正确，正式 store 中 `settings.casePresentationTemplate` 为 `editorial`。运行中的 Harness profile 两个插件文件也与源码一致。仅测试选择与保存，未发送模型消息或重新生成业务成果。
- 备份：`.runtime/installed-case-style-backup-20261029-012458/`。仅更新 `backend/adh-workbench-service.cjs`、`backend/research-presentation.cjs`、`backend/dsh-plugins/adh-project-workbench/{client,index}.js`；应用重启时重新复制原生插件到其本机 profile。
- 当前安装版目录：`C:\Users\user\AppData\Local\Programs\AIDesignHub\resources\app`。未重新发布安装包；本次验证未请求真实调研模型或生图。

## 交接

任务：恢复案例 PPT 两种风格入口及每案例 1–3 页规则。
现状：代码、定向检查与当前安装版已更新，原会话风格展开／切换及本机保存已实测。
关键文件：ADH 原生插件 client/index、adh-workbench-service、research-presentation 与对应测试。
已定决定：默认每案例一页，最多三页；完整分析留备注及 HTML，不扩成长篇 PPT。
下一步：用户在原会话选择风格后重新制作需要替换的长篇成果；本次没有自动重跑调研。
