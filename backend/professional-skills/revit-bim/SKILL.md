---
name: revit-bim
description: 通过内置 Revit 桥接（MCP，mcp__revit__* 工具）读取与操作本机 Revit 模型：数据查询、视图、参数与批量编辑。
metadata:
  layer: modeling
  displayName: Revit BIM 联动
---

# Revit BIM 联动

桌面版内置 Revit MCP 服务器（工具名前缀 `mcp__revit__*`），连接 Revit 进程内的桥接插件，实现模型数据读取与编辑（基于开源项目 revit-mcp）。

## 前置条件

1. 用户本机已安装 Revit。
2. **Revit 侧插件**需要一次性安装：revit-mcp 插件（.msi 安装包）来自开源项目 `github.com/romanzarkhin/revit-mcp` 的 Releases；装好后重启 Revit。
3. Revit 需处于运行状态且已打开模型；若插件未安装，相关工具会报无法连接——此时应引导用户先安装插件，不要反复重试。

## 使用要点

- 常用能力：查询模型元素与参数、读取/创建视图、批量修改参数、导出数据。
- 修改模型（尤其参数写入、删除元素）前先确认并按小范围试验；事务性写入失败时向用户报告具体元素。
- 大型模型先做过滤（类别/标高/视图范围）再操作，避免全量遍历造成卡顿。
