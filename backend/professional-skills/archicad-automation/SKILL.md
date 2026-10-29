---
name: archicad-automation
description: 通过内置 ArchiCAD 桥接（MCP，mcp__archicad__* 工具）驱动本机运行的 ArchiCAD：渐进式命令发现 + 调用，覆盖官方 JSON API 与 Tapir 社区命令集（191+ 命令）。
metadata:
  layer: modeling
  displayName: ArchiCAD 联动
---

# ArchiCAD 联动

桌面版内置 ArchiCAD 桥接（Python MCP 服务端随分发，multiconn 多实例连接库 + tapir-archicad-mcp 服务端）。工具名前缀 `mcp__archicad__*`。

## 前置条件

1. **ArchiCAD 正在运行且打开了项目**——桥接通过本机 socket 发现实例（官方 JSON API 内建，无需安装插件即可用官方命令集）。
2. 可选增强：安装社区 [Tapir 插件](https://github.com/ENZYME-APD/tapir-archicad-automation)（一次性，装入 ArchiCAD 后重启生效），可用完整的社区命令集（`dev_is_add_on_command_available` 可查某命令是否可用）。
3. 桥接本身零配置：软件启动即挂载；无 ArchiCAD 运行时 `discovery_list_active_archicads` 返回空列表（属正常，不要连续重试）。

## 工具面（5 个网关工具 + 渐进式发现）

服务端不直接暴露 191+ 个命令，而是给 5 个工具 + 「列表 → 查 schema → 调用」流程，节省上下文：

1. `discovery_list_active_archicads`——列出运行中的实例及各自 `port`（多开 ArchiCAD 时按 port 定向）。
2. `archicad_list_commands`——列出全部命令名 + 一句话描述（按关键字找命令，如「墙」→ `elements_get_elements_by_type`）。
3. `archicad_get_command_schema`——取某命令的精确参数结构（调用前必查，参数有运行时严格校验）。
4. `archicad_call_tool`——执行：命令名 + `port` + 参数。
5. `archicad_get_job`——长任务查询（见下）。

典型回放：「用 19723 端口，把所有墙元素取出来」→ `archicad_list_commands` 查到 `elements_get_elements_by_type` → `archicad_get_command_schema` 拿参数 → `archicad_call_tool`。

## 使用要点

- **长命令**：超过 45 秒返回 job 句柄（`{"status":"running","jobHandle":"job:…"}`），用 `archicad_get_job(job_handle=…)` 轮询到 `completed`/`failed`。**变更类命令响应丢失时，先 `archicad_get_job()` 列出最近任务再决定是否重发**——取消请求不会停止已开始的命令，盲目重试会重复改动画。
- 命令面覆盖：元素（墙/柱/梁/板/门窗…）创建与读取、属性/分类、图层与属性文件夹、导航器/视图映射、发布/导出、Teamwork 等；几何参数与单位以各命令 schema 及返回值说明为准。
- 破坏性操作（删除元素、覆盖发布/导出）先向用户确认；小命令先验证再批量。
- 服务端日志（排障）：`~\.tapir_mcp\logs\tapir_mcp_server.log`。

## 故障排查

- **discovery 返回空**：ArchiCAD 没开、项目没打开，或刚启动还没就绪——先引导用户处理，不要连续重试。
- **有实例但调用报连接错**：实例被关闭或端口变化，重新 `discovery_list_active_archicads` 拿新 port。
- **某命令报「add-on command unavailable」**：该命令来自 Tapir 社区插件，用户未安装或插件版本不支持——引导用户装/升级 Tapir 插件。
