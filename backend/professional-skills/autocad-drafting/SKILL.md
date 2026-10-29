---
name: autocad-drafting
description: 通过内置 AutoCAD 桥接（MCP，mcp__autocad__* 工具）驱动 AutoCAD 制图：图形/实体/图层/块/标注/P&ID/视图，双后端（AutoCAD 实时联动 + 无 AutoCAD 的 DXF 无头生成）。
metadata:
  layer: modeling
  displayName: AutoCAD 制图
---

# AutoCAD 制图联动

桌面版内置 AutoCAD 桥接（Python MCP 服务端随分发，双后端自动切换）。工具名前缀 `mcp__autocad__*`（8 个工具：`drawing`、`entity`、`layer`、`block`、`annotation`、`pid`、`view`、`system`，每个工具通过 `operation` 参数派发具体操作）。

## 双后端

| 后端 | 需要 AutoCAD？ | 用途 |
|------|----------------|------|
| File IPC | 需要（AutoCAD LT 2024+ 或完整版 AutoCAD，Windows） | 直接驱动正在编辑的图纸：画线、加图层、改实体、截图回显 |
| ezdxf | 不需要 | 无头生成/修改 DXF 文件（离线出图），截图用 matplotlib 渲染 |

默认 `auto`：有 AutoCAD 会话可用则走 File IPC，否则自动落到 ezdxf——所以**没开 AutoCAD 也能用**（做无头 DXF 任务）。

## 前置条件（File IPC 实时联动，一次性）

1. 本机装 AutoCAD（LT 2024+ / 完整版支持 AutoLISP 的版本）。
2. **加载 LISP 调度脚本**：在 AutoCAD 命令行输入 `APPLOAD`，选择随桌面版分发的 `mcp_dispatch.lsp`（位于桌面版安装目录 `<ADH_PROFESSIONAL_MCP>\servers\autocad\vendor\autocad-mcp\lisp-code\`），加载成功会提示 `=== MCP Dispatch v3.1 loaded ===`。建议在 APPLOAD 对话框里加入「启动组（Startup Suite）」，之后每次启动自动加载。
3. 通道目录 `C:\temp` 需可写（桥接与 LISP 通过其中的 JSON 文件 + Win32 窗口消息通信，固定路径）。

## 使用要点

- **先查状态**：调 `system` 工具的查询操作看当前生效后端（file_ipc / ezdxf）与连接状态，再决定能做什么。
- 常用能力：`drawing`（新建/打开/保存/信息）、`entity`（增删改查实体：线、圆、多段线、文字等）、`layer`（图层管理）、`block`（块定义与插入）、`annotation`（标注/尺寸）、`pid`（P&ID 工艺图元件库）、`view`（缩放/截图）。
- File IPC 模式下操作发生在**用户当前打开的图纸**里：破坏性操作（删除实体、覆盖保存）先向用户确认；截图回显（`view`）可用来复核结果。
- 单位与坐标系跟随图纸/文件设置（DXF 以该文件为准），几何参数先小步验证再批量。
- AutoCAD 未运行或 LISP 未加载时，File IPC 操作会报错并提示——此时要么引导用户处理，要么改用 ezdxf 无头模式完成 DXF 任务。
