---
name: 3dsmax-modeling
description: 通过内置 3ds Max 桥接（MCP，mcp__3dsmax__* 工具）驱动本机 3ds Max 执行 MaxScript：建模、场景组织与批量操作。
metadata:
  layer: modeling
  displayName: 3ds Max 建模
---

# 3ds Max 建模联动

桌面版内置 3ds Max MCP 服务器（工具名前缀 `mcp__3dsmax__*`），在 3ds Max 内执行 MaxScript，完成建模、对象与场景操作。

## 前置条件

1. 用户本机已安装 3ds Max（2023–2027）。
2. **Max 侧桥接插件**需要一次性安装（安装到 `C:\ProgramData\Autodesk\ApplicationPlugins\3dsmax-mcp`，需管理员权限）：
   - 安装包随桌面版本内置：`%ADH_PROFESSIONAL_MCP%\servers\3dsmax\installer\`
   - 以管理员身份运行 `bridge_manager.ps1 -Action Install`，或让用户参考其中的说明手动安装；
   - 安装后重启 3ds Max，桥接会随应用自动加载。
3. 3ds Max 需处于运行状态；工具报无法连接时，按第 2 步检查桥接是否已装好。

## 使用要点

- 常用能力：执行 MaxScript、场景对象查询/创建/变换、材质与批量操作。
- 破坏性脚本（删除、塌陷、覆盖保存）执行前先向用户确认；建议提醒用户开启自动备份。
- 首次连通后先用只读查询（如场景对象列表）验证链路，再执行写操作。
