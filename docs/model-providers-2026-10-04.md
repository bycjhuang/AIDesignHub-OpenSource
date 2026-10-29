# 内置项目助手模型服务：接口与限制

核实日期：2026-10-04。这里只记录官方资料及本地实现边界；未使用用户现有密钥，也未调用真实付费模型。

## 支持方式

- DeepSeek 官方 API：OpenAI 兼容 Base URL `https://api.deepseek.com`，本服务追加 `/chat/completions`。官方当前示例使用 `deepseek-flash`；模型 ID 可编辑，不把当前别名视为永久保证。[官方首次调用说明](https://api-docs.deepseek.com/)
- 阿里云百炼按量 API：使用控制台对应地域、业务空间和模型的 OpenAI 兼容地址。生产环境官方推荐 `https://{实际WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`；已有 `https://dashscope.aliyuncs.com/compatible-mode/v1` 等地域域名仍可使用。API Key 必须与地域、计费方案匹配。界面不预填缺少业务空间 ID 的假地址。[Base URL 总览](https://help.aliyun.com/zh/model-studio/base-url)、[OpenAI Chat 接口兼容说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- 自定义 OpenAI 兼容：用户明确填写服务商允许用于自定义应用的 Base URL、模型 ID、API Key。仅支持非流式 Chat Completions；兼容协议不保证每个模型支持相同参数，需要用户自行选择有效模型。保存配置不是联网验收。

## Token Plan / Coding Plan 不用于本服务后端直连

官方 Token Plan 端点是 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；Coding Plan 端点是 `https://coding.dashscope.aliyuncs.com/v1`。它们不是按量 API 的别名，密钥不能混用。

阿里云当前官方说明将 Token Plan 个人版、团队版和 Coding Plan 限于允许的 AI 编程工具及 OpenClaw 类型 Agent 场景，不支持工作流平台、自动化脚本或自定义应用后端直接调用。内置 ModelService 因此拒绝已知套餐域名，包括在“自定义兼容”下填写的相同地址；不伪装工具身份，不提供绕过或套餐后端中转。外部执行器是否属于允许场景仍须依具体工具和官方条款核实。[接入更多编程工具及不支持类型](https://help.aliyun.com/zh/model-studio/more-tools)、[Coding Plan 说明](https://help.aliyun.com/zh/model-studio/coding-plan)

已知域名检查不是对任意自定义代理的合同合规保证。用户不得通过自定义代理规避服务商限制。

## 本地接口合同

```js
const { ModelService, MODEL_PRESETS } = require('../backend/model-service.cjs');
const service = new ModelService({ dataDir, secretStore, fetchImpl });
// secretStore 由主进程注入 Electron safeStorage 的
// isEncryptionAvailable / encryptString / decryptString。
service.status(); // 仅公开配置与布尔状态，无明文 key 或密钥末尾字符。
service.save({ provider, baseUrl, model, apiKey, allowLocalHttp, timeoutMs });
await service.draft({ projectId, text, context }); // {summary, actions}，不执行业务修改。
```

- provider 仅 `deepseek`、`bailian`、`openai-compatible`。`MODEL_PRESETS` 为纯展示预设，不表示连接已验证。
- `save` 不联网。API Key 省略或空串保持旧值；首次配置必须填 key。更换 provider 或 origin 必须明确重新填写 key，防止把原密钥转送到新服务商。`clearApiKey:true` 清除后停用模型请求。
- 所有配置与密钥保存在 `dataDir/model-private/model-config.enc` 单一加密信封，不写业务 store。主程序的备份/导出功能必须排除整个 `model-private` 目录。加密不可用时拒绝读写，不降级明文；同一 Windows 登录用户下的恶意进程不是该机制能隔离的威胁模型。
- `draft` 只收到调用方明确提供的当前项目上下文；不扫描本地文件、不读取环境变量中的其他密钥、不连接其他 Agent、不上传整个项目。项目名称、任务、风险、决定等摘录会发送给用户选择的模型提供商，因此使用云端模型不等于资料全程留在本机。
- 当前上下文合同：`version:1,projectId,revision,project,members,tasks,risks,decisions,truncated`；任务最多 20、风险最多 10、决定最多 10。仅挑选约定字段；项目商务、私密内容应在 ProjectHub 形成上下文时按权限排除。
- 输出允许 `task.create/update`、`risk.create/update`、`decision.create/update`、`project.update`。动作最多 30，拒绝未知字段、工具调用、脚本和文件动作。ProjectHub 必须再次验证对象、字段、项目版本、权限和用户确认，不得把模型输出直接执行。

## 请求边界与测试

远程仅 HTTPS；显式 `allowLocalHttp:true` 时仅 localhost/127.0.0.1/::1 支持 HTTP。地址禁止用户信息、查询参数、锚点，禁止重定向；请求和正文读取均有 1–120 秒可设上限，默认 30 秒，响应最大 256 KiB。不记录原始网络错误/服务商错误正文，不把模型推理正文或 API Key 返回前端。返回密钥的模型结果会被拒绝。

本实现不请求联网、搜索或工具调用能力；不能保证第三方服务商在其服务内部如何实现推理。模型产出只是待确认草案，不是工具执行结果或进度事实。失败不触发自动重试、切换服务商或项目写入。

自动化测试使用临时目录、内存模拟的 HTTP 响应与测试加密实现；它验证边界，不代表 Windows DPAPI、真实密钥、额度或模型兼容性已完成实机验收。
