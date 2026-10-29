---
name: premiere-editing
description: 通过内置 Premiere 桥接（MCP，mcp__premiere__* 工具）驱动本机 Premiere Pro 完成剪辑：导入素材、建时间线、放片段、加效果与导出。
metadata:
  layer: modeling
  displayName: Premiere 剪辑
---

# Premiere 剪辑联动

桌面版内置 Premiere 桥接（Node 单文件服务端 + CEP 面板，随应用分发）。工具名前缀 `mcp__premiere__*`。工具面很小：主入口是 `search_tools` 检索 283 个剪辑工具，再用 `invoke_tool` 调用。

## 前置条件

1. 用户本机已安装 Premiere Pro。
2. **一次性安装 CEP 面板**（写入 %APPDATA% 的 CEP 扩展目录、开启 CEP 调试模式、准备好共享桥接目录；已预置面板配置，无需手填路径）：
   ```powershell
   node "$env:ADH_PROFESSIONAL_MCP\servers\premiere\install-cep.mjs" install
   ```
   诊断：`install-cep.mjs status`；移除：`install-cep.mjs uninstall`。
3. 重启 Premiere Pro → 菜单 窗口 > 扩展程序 > MCP Bridge (CEP) → 点 **Start Bridge**（面板保持打开；不点则所有工具调用都会报未连接）。面板需要每次会话手动 Start。
4. 先跑 `verify_premiere_connection` 确认就绪，再开始剪辑操作。

## 使用要点

- **协作方式**：`search_tools`（支持自然语言 BM25 或正则 pattern）→ `get_tool_schema` 看参数 → `invoke_tool` 调用。不要臆造工具名。
- **先读后写**：`get_project_info`、`list_sequences`、`list_project_items`、`get_active_sequence` 先摸清工程状态。
- **导入素材用真实文件**：路径先确认存在 → `import_media` → 用返回的 project item ID 放上时间线。
- **生成/演示用途**：新建明确命名的序列，不要改动用户的活动序列。
- **破坏性/外发动作先确认**：删片段/删素材、覆盖导出文件、关闭工程、存档覆盖、发送文件到外部。
- 工具返回 `success:false` 时如实上报错误并先诊断，不要盲目重试。
- **桥接目录**：`%TEMP%\premiere-mcp-bridge`（服务端与面板共享；桌面版已通过环境变量与本面板配置固定一致，不要改）。

## 故障排查

- `verify_premiere_connection` 报 `premiere_not_running`：Premiere 没开 → 引导用户打开；面板没启动 → 引导点 Start Bridge；扩展没装 → 先跑第 2 步。
- 面板不可见（扩展程序菜单里没有 MCP Bridge）：装完面板后没重启 Premiere，重启一次。
- 调用超时/无响应：面板被关了或点了 Stop → 重新 Start Bridge。
- 面板提示版本不匹配：面板与服务端版本不一致，跑 `install-cep.mjs install` 重装面板。
