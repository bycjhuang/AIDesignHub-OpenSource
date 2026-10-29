---
name: sketchup-modeling
description: 通过内置 SketchUp 桥接（MCP，mcp__sketchup__* 工具）驱动本机 SketchUp 完成建模、材质、布尔运算、榫卯连接与导出。
metadata:
  layer: modeling
  displayName: SketchUp 建模
---

# SketchUp 建模联动

桌面版内置 SketchUp 桥接：Python MCP 服务端随软件分发，SketchUp 侧是一个 Ruby 扩展（一次性安装）。工具名前缀 `mcp__sketchup__*`。

## 前置条件

1. 用户本机已安装 SketchUp（2021 及以上均可；仅视口截图工具要求 2026+）。
2. **一次性安装 SketchUp 扩展**（装入用户插件目录 + 自动启动脚本，重启 SketchUp 生效）：
   ```powershell
   & "$env:ADH_PROFESSIONAL_MCP\python\python.exe" `
     "$env:ADH_PROFESSIONAL_MCP\servers\sketchup\launcher.py" install-extension
   ```
   卸载用 `uninstall-extension`。
3. **桥接随 SketchUp 启动自动拉起**（约 3-30 秒就绪，无需手动操作）。手动方案（备用）：SketchUp 菜单 Plugins/扩展程序 → MCP Server → Start Server；SketchUp 未运行时可用一键启动（自动拉起 SketchUp 并等桥就绪）：
   ```powershell
   & "$env:ADH_PROFESSIONAL_MCP\python\python.exe" `
     "$env:ADH_PROFESSIONAL_MCP\servers\sketchup\launcher.py" launch-sketchup
   ```
4. 诊断命令：`launcher.py status`——探测 localhost:9877 并向扩展发握手。工具报连接失败即第 2/3 步未完成——先引导用户处理，不要连续重试。自动启动失败时看 `%TEMP%\bycj-su-bridge-boot.log`（每次启动追加诊断行）。

## 使用要点

- **单位**：毫米；角度：度。`position` 是包围盒最小角的绝对坐标。每个返回实体的工具同时给 `bbox_mm`，实体 id 失效（做过破坏性操作后）可用包围盒重新定位。
- **常用能力**：`create_component`（cube/cylinder/cone/sphere）、`transform_component`、`delete_component`、`set_material`（命名色或 `#rrggbb`）、`boolean_operation`（并/差/交）、`chamfer_edge`/`fillet_edge`、榫卯 `create_mortise_tenon`/`create_dovetail`/`create_finger_joint`、图层 `list_layers`/`create_layer`、查询 `get_model_info`/`list_components`/`find_components`/`get_selection`、`export_scene`（skp/obj/dae/stl/png/jpg）、`undo`。
- **原子撤销**：每个写工具自动包 `start_operation`/`commit_operation`，一次 Edit → Undo 撤销一次工具调用。
- **`eval_ruby`** 是逃生口（在 SketchUp 内执行任意 Ruby，默认开启、Settings 里可关闭）：复杂自由建模优先用它写脚本。自写脚本内也请用 `model.start_operation`/`commit_operation` 包住，保证可撤销。
- **长脚本超时**：单次调用默认 60 秒上限（MCP 服务端环境变量 `SKETCHUP_MCP_TIMEOUT` 可调）。注意：超时只表示客户端停止等待，**操作可能仍在 SketchUp 里执行**——重试前先查询模型状态，确认未生效再重试，避免重复创建。
- **端口**：默认 9877（与 Rhino 社区桥 9876 错开，两个桥可同时使用）；扩展 Settings 对话框可改端口，改过以 Settings 为准。
- 破坏性操作（删除对象、覆盖导出文件）先向用户确认；先小步验证再批量执行。中文图层名/材质名可用。

## 故障排查

- **工具报连接失败**：①SketchUp 没开（引导用户打开，桥会自动起）②扩展没装（先跑 `install-extension`）③本会话桥没起（看 `%TEMP%\bycj-su-bridge-boot.log`，或引导用户点菜单 Start Server，不要替他反复重试）。`launcher.py status` 可区分：端口无监听=①/②/③；端口有监听但握手失败=端口被改或扩展版本不符。
- **Ruby 控制台报错**：扩展日志默认最低级别，菜单 MCP Server → Show Log 可看；也可在 Settings 里开启写文件日志。
- **扩展版本不匹配**：本桥内置的 Python 服务端与扩展为同一上游版本（MIT，derived from mhyrr/sketchup-mcp），握手时会自动校验，不匹配会在首次调用即报错——重跑 `install-extension` 重装扩展即可。
