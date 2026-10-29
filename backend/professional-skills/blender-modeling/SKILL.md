---
name: blender-modeling
description: 通过内置 Blender 桥接（MCP，mcp__blender__* 工具）驱动本机 Blender 完成建模、材质、场景与导出操作。
metadata:
  layer: modeling
  displayName: Blender 建模
---

# Blender 建模联动

桌面版内置 Blender MCP 服务器（工具名前缀 `mcp__blender__*`），可直接读取/修改用户正在编辑的 Blender 场景、执行 Python 脚本、导出模型。

## 前置条件

1. 用户本机已安装 Blender（4.x / 5.x 均可）。
2. Blender 插件（addon）已安装并在场景中启动了 MCP 服务：
   - 安装/更新插件（路径基于 `ADH_PROFESSIONAL_MCP` 环境变量）：
     ```powershell
     & "$env:ADH_PROFESSIONAL_MCP\python\python.exe" `
       "$env:ADH_PROFESSIONAL_MCP\servers\blender\launcher.py" install-addon
     ```
     自定义 Blender 目录时加 `--addons-dir "<路径>"`（或设 `BLENDERMCP_ADDONS_DIR`）。
   - 在 Blender 中：编辑 → 偏好设置 → 插件 → 启用「Interface: MCP for Blender」（刚更新过插件时需先禁用再重新启用）。
   - 在 3D 视图按 N 打开侧栏 → BlenderMCP 选项卡 → 点击「Start MCP Server」（默认端口 9876）。
3. 连接失败时服务器会自动重连；工具报「Could not connect to Blender」即表示上述第 2 步未完成，先引导用户完成，不要反复重试。

## 使用要点

- 常用能力：场景快照、对象增删改、材质、相机/灯光、执行任意 Blender Python（bpy）脚本、下载/导出资产。
- 涉及删除对象、覆盖文件等破坏性操作前，先向用户确认；长脚本先小范围验证再执行。
- 中文路径与文件名可用；导出默认使用用户工作目录，不要写入程序安装目录。
