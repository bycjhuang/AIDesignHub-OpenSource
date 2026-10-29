# Agent 弹窗与模型设置修复

- 任务：解决 Agent Hub 遮挡模型设置导致无法操作，以及 APIMart 弹窗嵌套、间距和选择逻辑问题。
- 现状：源码与当前安装版 4 个文件已更新；原生视图同步 HTML 模态状态；APIMart 接入在原窗口内显示，模型行约 53px，已保存项无锁定复选框。
- 关键文件：`app-v2.js`、`backend/dsh-view.cjs`、`setup-center-ui.js`、`setup-center.css`；回归为 `tests/dsh-modal-visibility.test.cjs`、`tests/setup-media-model-ui.test.cjs`。
- 已定决定：统一更新同一服务的文本及媒体密钥；新密钥仅经本机加密存储，2 个文本和 11 个媒体配置更新成功，APIMart 只读连接返回 HTTP 200；不把保存状态写成生图已验证。
- 下一步：生图网络、画幅／分辨率和错误展示由“排查生图失败原因”会话处理，本会话不修改其后端文件、不发起重复生图。

回归：真实 Electron 原生视图验证普通／嵌套弹窗、最后关闭恢复、窗口缩放、延迟 attach、节点移除和会话保留；模型设置验证单个 dialog、无锁定复选框、默认不勾选、紧凑行布局和共享密钥更新。均通过，未调用真实模型生成。
