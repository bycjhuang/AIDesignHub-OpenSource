---
name: illustrator-automation
description: 通过内置 Illustrator 桥接（MCP，mcp__illustrator__* 工具）自动化本机 Illustrator：矢量图形、文本、颜色与 SVG/PDF 导出。
metadata:
  layer: modeling
  displayName: Illustrator 矢量设计
---

# Illustrator 矢量设计联动

桌面版内置 Illustrator MCP 服务器（工具名前缀 `mcp__illustrator__*`），通过 PowerShell COM 驱动本机 Illustrator（ExtendScript），无需安装任何插件。

## 前置条件

1. 用户本机已安装 Illustrator（2023 及以上为佳）。
2. Illustrator 需处于**运行状态**——COM 连接要求应用已启动；报错时先请用户打开 Illustrator 再重试。
3. 若装有多版本 Illustrator，先调用工具集中的版本选择能力（set_illustrator_version）指定目标版本，否则可能连接到错误的版本。

## 使用要点

- 常用能力：新建/打开文档、绘制与编辑路径、文本框、颜色与描边、导出 SVG / PDF / PNG。
- 直接操作用户文档；覆盖保存前需确认，建议先另存副本。
- 复杂矢量图建议分步构建并命名好图层，便于用户后续手工微调。
