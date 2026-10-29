# 专业软件 MCP 离线接口

接口定义见 `../dsh-professional-mcp.cjs`；工具按需发现见 `../dsh-plugins/adh-tool-discovery/`。
移植参考为 BYCJ Design 统一桌面版 0.6.9 的 `desktop/dshRuntime.ts`、`desktop/dsh-plugins/bycj-tool-discovery/` 及 `desktop-assets/agent-extras/mcp-bridges/`。

本机离线资源复制到项目已忽略的 `.runtime/professional-mcp/`。副本含独立 Python、14 种软件的 stdio 服务、对应软件侧插件源文件、NOTICE 和 LICENSE；不读取 BYCJ 账号、聊天、密钥或线上模型服务。完成复制后，Hub 运行不依赖 BYCJ 目录。

维护时执行：

```powershell
node scripts/stage-professional-mcp.cjs --source <离线mcp-bridges目录>
```

默认写入本项目 `.runtime/`，可用 `--cache-root` 指定其他缓存根。仅显式传入来源才复制；普通启动只检查已装资源，不重复复制、不下载。复制逐文件比较 SHA256，保留来源的许可和依赖；排除日志、字节码和 `.env`。忽略目录内 `payload-files.json` 记录每个文件的大小和哈希，`payload-manifest.json` 记录来源、时间、总数和摘要。重新 staging 已装副本时保留 `.previous-<UUID>` 恢复目录。

服务包括 Blender、3ds Max、Photoshop、Illustrator、Revit、Rhino、SketchUp、InDesign、Premiere Pro、After Effects、Lightroom Classic、Cinema 4D、ArchiCAD、AutoCAD。若本机已装 Rhino 8/9 官方 MCP router，另外自动发现官方接口。软件侧所需的桥接插件和宿主版本要求沿用副本中的文档；注册 MCP 服务、列出工具和与真实软件连接是不同状态。staging 不启动设计软件，也不为其安装插件。

Lightroom 原上游 bundle 在普通 MCP 启动时会自动安装 `.lrplugin`。Hub 保留原文件，另生成 `lightroom/vendor/dist/adh-stdio.mjs`，只移除这一启动调用并将接口指向派生入口；显式 `install-plugin` 子命令仍可使用。`lightroom-explicit-install-v1` 补丁及原/派生文件哈希记入 manifest，更新后不认识的源代码会停止应用补丁并保留原文件。普通 Host 启动和协议检查均不会安装 Lightroom 插件。

工具名使用原软件命名空间 `mcp__<software>__<tool>`。每个 Agent 起始只获得搜索与激活入口：`adh_search_tools` / `adh_activate_tools`；活动 MCP 工具最多 24 个，schema JSON 总长最多 48,000 字符。搜索/激活不会操作软件，执行仍经过原工具权限和参数校验。软件连接失败不阻止 Hub Host 启动。
