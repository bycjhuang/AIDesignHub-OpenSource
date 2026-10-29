---
name: lightroom-catalog
description: 通过内置 Lightroom Classic 桥接（MCP，mcp__lightroom__* 工具）管理照片目录：搜索、评分/旗标、关键词、收藏夹、元数据、导入导出与预设。
metadata:
  layer: modeling
  displayName: Lightroom 照片
---

# Lightroom 照片管理联动

桌面版内置 Lightroom Classic 桥接（Node 单文件服务端 + Lightroom 内 Lua 插件）。工具名前缀 `mcp__lightroom__*`（28 个工具）。

## 前置条件

1. 用户本机已安装 Lightroom Classic。
2. **插件自动安装**：桌面版首次启动桥接时会把 `LightroomMCP.lrplugin` 复制到 `%APPDATA%\Adobe\Lightroom\Modules\`（无需手动操作）。若刚安装，需重启一次 Lightroom 才能看到插件。
3. **在 Lightroom 里启动服务**（每次重启 Lightroom 后都要）：文件（File）→ 增效工具管理器（Plug-in Manager）→ 左侧选 **Lightroom MCP** → 右侧点 **Start Server**，看到 "Server running"。此操作同时生成配对令牌（`~/.config/lightroom-mcp/token`）。
4. 通信走本机 TCP 58763/58764；Lightroom 不开或没点 Start Server 时，所有工具都会返回 “Lightroom plugin not connected”。

## 使用要点

- **常用能力**（28 个）：
  - 检索：`search_photos`、`get_selected_photos`（用户在 LR 里选中的照片）、`get_photo_metadata`、`get_photo_preview`（取预览图，可用于自查效果）
  - 整理：`set_rating`、`set_flag`、`set_keywords`、`list_keywords`、`rename_keyword`
  - 收藏夹：`list_collections`、`create_collection`、`add_to_collection`、`remove_from_collection`、`delete_collection`
  - 元数据：`set_metadata`、`set_gps`、`set_location`
  - 导入导出：`import_photos`、`export_photos`（长任务，超时上限较大）、`export_photo_metadata`
  - 预设：`list_develop_presets`、`get_develop_preset`、`compare_develop_presets`、`create_develop_preset`、`export_develop_preset`、`apply_develop_preset`、`copy_develop_settings`、`set_develop_settings`
- **工作流**：先用 `search_photos` / `get_selected_photos` 确定照片 id 集合，再对确定的范围做修改；批量操作前先小范围验证。
- **破坏性操作先确认**：`delete_collection`、覆盖导出文件、改动照片元数据/develop 设置（`copy_develop_settings`、`apply_develop_preset` 会直接改照片）——先向用户说明再执行。
- 导出照片（`export_photos`）耗时较长，告诉用户进度预期；结果引用导出目录路径。

## 故障排查

- **“Lightroom plugin not connected”**：①Lightroom 没开 → 引导打开；②没点 Start Server → 引导 File → Plug-in Manager → Start Server；③刚装插件没重启 LR → 重启一次。
- **Start Server 报错/令牌失效**：删除 `~/.config/lightroom-mcp/token` 后重新点 Start Server 重新配对。
- **端口被占用**：默认 58763/58764 被其他程序占用时，restart 桥接会话（桌面版重启）；保持默认即可，不要与用户其他工具抢端口。
- 报错后不要盲目重试批量操作；先确认 LR 端状态（是否忙碌、是否弹窗等待输入）。
