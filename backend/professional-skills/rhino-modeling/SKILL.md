---
name: rhino-modeling
description: 通过内置 Rhino 桥接（MCP，mcp__rhino__* / mcp__rhino-official__* 工具）驱动本机 Rhino 完成建模、图层管理、脚本执行与视口截图。
metadata:
  layer: modeling
  displayName: Rhino 建模
---

# Rhino 建模联动

桌面版内置两套 Rhino MCP 桥（工具名前缀区分）：

- **`mcp__rhino__*`（社区桥，Rhino 7 已验证；Rhino 8/9 需有可用许可）**：Rhino 内运行脚本监听本机 9876 端口。
- **`mcp__rhino-official__*`（官方桥，Rhino 8 / 9）**：用户用 Yak 安装官方 Rhino-MCP-Platform 后自动接入（重启桌面版生效），另有 Grasshopper 联动。

## 前置条件

### 社区桥

1. 用户本机已安装 Rhino（7 / 8 / 9）。
2. **Rhino 开着，且桥脚本已载入**（脚本随 Rhino 会话常驻，监听 localhost:9876；重启 Rhino 后需重新载入）：
   - 首选：请用户在 Rhino 命令行粘贴并执行下面这一行（粘贴即执行）——路径可先用 `launcher.py script-path` 打印：
     ```
     _-RunPythonScript "<ADH_PROFESSIONAL_MCP>\servers\rhino\loader.py"
     ```
     loader 是幂等的：重复载入会直接跳过，不会出问题。
   - 或由 agent 执行一键命令（Rhino 未开时自动启动，随后自动激活 Rhino 窗口注入加载命令；会短暂占用键盘焦点，先征得用户同意、并确认用户没在 Rhino 里操作中）：
     ```powershell
     & "$env:ADH_PROFESSIONAL_MCP\python\python.exe" `
       "$env:ADH_PROFESSIONAL_MCP\servers\rhino\launcher.py" open-rhino
     ```
     指定版本在末尾加 `7`/`8`/`9`（如 `open-rhino 7`）。成功时输出 `bridge ready ... scene query verified`。
   - 诊断：`launcher.py status` 会检测端口并做一次场景查询（打印 ready / not running / 需按 Esc）。
3. 工具报连接失败即第 2 步未完成——先引导用户完成，不要连续重试。

### 常见故障

- **端口开着但请求全部超时/挂起**：Rhino 命令行可能停在某个提示符上等待输入（例如 PythonScript 插件的 `( ResetEngine(R) )`），此时 Rhino 的空闲事件被冻结，所有桥请求都会卡住。请用户在 Rhino 里按一下 **Esc** 解除，再重试一次即可——不要反复重试。
- **不要向 Rhino 命令行发送多余的 Enter/回车**：会重复上一条命令并可能触发上述插件提示符卡死。手动载入时粘贴即可，不需要回车。

### 官方桥（Rhino 8 / 9，可选）

用户自行安装（安装后重启桌面版自动出现 `mcp__rhino-official__*` 工具）：

- Rhino 内执行 `PackageManager` 搜索安装 `Rhino-MCP-Platform`，或命令行安装：
  `"C:\Program Files\Rhino 8\System\Yak.exe" install Rhino-MCP-Platform`
- 需要 **有效的 Rhino 8/9 许可** 和 **较新的 Rhino SR**；若报 `No compatible distribution found`，先提示用户升级 Rhino。

## 使用要点

- 常用能力：场景概览、图层列表、带元数据的对象查询（short_id 会标注在视口截图里，便于对照定位）、视口截图、Rhino 内执行 Python、读取选中对象；官方桥另有 Grasshopper 联动。
- Rhino 内脚本需兼容 IronPython 2.7（Rhino 7 下运行）：无 f-string、无海象运算符等新语法；创建对象后调用 `add_rhino_object_metadata(对象, 名称, 描述)`，便于后续按元数据检索。
- 执行脚本后可用视口截图核对结果；破坏性操作（删对象、覆盖文件）先向用户确认，先小步验证再批量执行。
- 中文路径与名称可用；文件输出默认放用户工作目录，不要写入程序安装目录。
