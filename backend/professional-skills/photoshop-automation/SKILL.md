---
name: photoshop-automation
description: 通过内置 Photoshop 桥接（MCP，mcp__photoshop__* 工具）自动化本机 Photoshop：图层、选区、滤镜、批处理与导出。
metadata:
  layer: modeling
  displayName: Photoshop 图像处理
---

# Photoshop 图像处理联动

桌面版内置 Photoshop MCP 服务器（工具名前缀 `mcp__photoshop__*`），通过 Windows COM 自动化驱动本机 Photoshop（ExtendScript），可创建/编辑文档、管理图层、应用效果并导出。

## 前置条件

1. 用户本机已安装 Photoshop（2020 及以上均可）。
2. Photoshop 需处于**运行状态**——COM 自动化需要应用已启动；工具报连接失败时先请用户打开 Photoshop（首次自动化调用可能需要等待应用初始化完成，稍后重试一次）。
3. 非默认安装路径时可设环境变量 `PHOTOSHOP_PATH` 指向可执行文件（一般无需设置）。

## 使用要点

- 常用能力：打开/新建文档、图层与选区操作、文字、滤镜与调整、导出 PNG/JPG/PSD。
- 自动化会直接操作用户的文档；覆盖保存前必须确认，建议先「另存副本」。
- 大批量文件处理时分批执行并在每批后汇报进度；错误信息里出现提示框阻塞时，提醒用户手动处理对话框。
- 遥测已由桌面版统一关闭，无需处理（`POSTHOG_DISABLED=1`）。
