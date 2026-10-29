---
name: indesign-automation
description: 通过内置 InDesign 桥接（MCP，mcp__indesign__* 工具）驱动本机 InDesign 完成排版、文字表格、样式、置图与导出（PDF/图片/EPUB）。
metadata:
  layer: modeling
  displayName: InDesign 排版
---

# InDesign 排版联动

桌面版内置 InDesign 桥接（Node 单文件服务端 + Windows COM/ExtendScript 通道，随应用分发，无需安装）。工具名前缀 `mcp__indesign__*`，共 194 个工具。

## 前置条件

1. 用户本机已安装 InDesign。桥接会自动连接正在运行的 InDesign；未运行时会自动拉起（首次冷启动 30-60 秒，首调可能较慢，属正常）。
2. 无需任何手动安装或配置——桌面版 profile 已启用 COM 通道（`COM_BRIDGE_ENABLED=true`）。
3. 大多数操作作用于**当前活动文档**：先 `document_create`（新建，默认 A4）或 `document_open` 打开文件，再做后续操作。

## 使用要点

- **单位**：`document_create` 的宽高/边距为**毫米**（默认 210×297=A4）。其余几何参数以工具描述为准。
- **能力分组**（194 个工具）：
  - 文档/页面：`document_*`、`page_*`、`master_*`、`section_*`、`list_*`
  - 文字：`text_*`（文本框、故事、段落/字符样式、查找替换、GREP `text_search`、分栏、绕排、制表位等，27 个）
  - 表格：`table_*`（16 个）；样式：`style_*`、`tableStyle_*`、`cellStyle_*`
  - 图形/图像：`shape_*`、`image_place`、`image_getLinks`、`transform_*`、`group_*`
  - 颜色/资源：`color_*`、`resources_*`、`layer_*`、`font_*`
  - 高级：`dataMerge_*`（数据合并）、`xml_*`、`interactive_*`、`book_*`、`toc_*`、`index_*`、`xref_*`、`note_*`、`effect_*`
  - 导出：`export_document`（PDF/JPG/PNG/EPUB/HTML/package）、`export_batchFolder`（整文件夹批量转 PDF）、`export_preflight`、`export_getFonts`/`export_getSwatches`
  - 校验/可视化：`preview_document`（把某页渲染成 PNG/JPEG 返回，用于自查排版效果——重要产出建议先预览再交付）
  - 逃生口：`script_run` / `export_executeScript` 执行任意 ExtendScript（带行级错误栈的调试模式）；复杂排版优先直接写脚本
- **撤销**：`undo`/`redo`；连续多步可包成一步——`undo_beginGroup` … `undo_endGroup`，期间所有工具调用合并为一次撤销。
- 破坏性/覆盖操作（删除内容、导出覆盖已有文件、批量处理文件夹）先向用户确认；批量前先小步验证。

## 故障排查

- **报 "Cannot attach to InDesign"**：InDesign 未安装或 COM 被安全策略拦截。确认本机装有 InDesign；也可先手动打开 InDesign 后重试。
- **首次调用超时/很慢**：桥在拉起 InDesign 冷启动，稍等后重试一次即可，不要连续重试。
- **中途关闭/重启了 InDesign**：桥的 COM 引用可能失效——通常下一次工具调用会自动重连；报错则新开一个会话再试。
