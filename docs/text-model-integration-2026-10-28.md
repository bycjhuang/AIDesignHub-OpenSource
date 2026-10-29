# 本机文本模型接入与安装版修复

2026-10-28。修改 `D:\AIDesignHUB`（main），并更新当前安装目录 `C:\Users\user\AppData\Local\Programs\AIDesignHub\resources\app`。未重新发布安装包。

## 已接入

| 模型 | API | 用途 |
| --- | --- | --- |
| DeepSeek V4.1 Flash / `deepseek-flash` | DeepSeek 官方 Chat Completions | 当前 Hub 默认文本模型 |
| GPT 6.1 Sol / `gpt-6.1-sol` | APIMart Responses | 文本、推理、工具调用 |
| GPT 6 Astra / `gpt-6-astra` | APIMart Responses | 文本、推理、工具调用 |

用户确认口述“GPT 6 Ultra”指 Astra。APIMart 的实时 `/v1/models` 列表确认两款 GPT ID 可用。

## 修复原因与实现

- 旧模型设置只有一个配置槽。现在加密目录保留多个文本配置，各配置有稳定 ID，画布选中的 ID 在主进程解析成自己的地址、模型和密钥，切换不串用密钥。
- 本机 Node 请求 APIMart 超时，Electron 网络通道正常。主进程文本服务改用 `net.fetch`；Harness 通过鉴权的回环代理发送 Chat Completions / Responses，由 Electron 转发。侧车只持随机本机令牌，上游密钥不进入渲染层或 Harness 环境。
- DeepSeek 真实工具响应含 `index`。仅接收非负整数索引并规范化，继续拒绝未知工具和额外字段。
- APIMart GPT 6 在 Chat Completions 中默认推理加工具会返回 HTTP 400。两款 GPT 改用 Responses；画布保留当前工具循环的 reasoning/function output（仅内存），再提交工具结果；Harness 使用原生 Responses 协议，提供 low/medium/high 推理等级。
- 旧种子脚本使用 Electron 默认 `userData`（`%APPDATA%\Electron`）生成密文，与正式应用 `bycj-design-workbench-prototype` 的加密上下文不同，导致安装版无法解密。相同 `userData` 的独立只读验证已能解密，故问题不是单纯绑定可执行文件。本次用安装版自身重新加密现有文本密钥，并修复原有 11 个 APIMart 媒体配置密钥的相同问题；没有生成图片或视频。开发种子脚本现在拒绝正式数据根目录。
- 原始用户数据与加密配置已备份于 `.runtime/`；全部备份和验收结果受 Git 忽略规则保护。没有在文档、源码或测试报告中写入真实密钥。

## 验证

- 三款模型均返回真实固定文字。
- 三款模型均完成 `inspect_canvas` → 实际合成检查结果 → 最终回复的两轮工具流程；安装版进程再次验证通过。
- 三款模型的流式转发通过；GPT 6 Responses 路由与 reasoning 保留有独立回归测试。
- 完整 `npm test`：745 / 745；后续桥接元数据改动通过相关检查。
- 正式安装版退出重启后，三个文本配置仍可解密，默认 `deepseek-flash`；Harness 重新启动为 ready，Responses 模型的 low/medium/high 元数据加载正常。
- 原生 Agent 菜单列出三个模型，Astra 原生会话完成真实回复；AI Design Home 菜单也列出三个模型，Sol 从首页进入真实画布，完成“读取画布 → 实际结果 → Sol画布连接成功”的完整流程。
- 不将上述验收表述为全部专业软件、外部 Agent 或任意长任务都已通过；本轮没有付费图片／视频生成验收。

## 接手五行

任务：完成 DeepSeek 与 APIMart GPT 6.1 Sol / GPT 6 Astra 的统一文本模型接入。
现状：源码与当前安装版已更新，默认 DeepSeek；密钥由正式安装版加密保存。
关键文件：model-service、canvas-agent-completion/provider、text-model-protocol、dsh-model-proxy、dsh-llm-bridge、setup-center-ui。
已定决定：GPT 6 走 Responses；请求走 Electron 网络；不向 Harness 或页面分发上游密钥；脚本不再写正式配置。
下一步：新增模型在工作台内保存；发布下一安装包时包含本次源码，不从开发可执行文件重写正式密钥。
