---
name: c4d-modeling
description: 通过内置 Cinema 4D 桥接（MCP，mcp__c4d__* 工具）驱动本机 C4D 完成建模、MoGraph、材质、灯光相机、关键帧、渲染与快照。
metadata:
  layer: modeling
  displayName: Cinema 4D 建模
---

# Cinema 4D 建模联动

桌面版内置 Cinema 4D 桥接（Python MCP 服务端随分发 + C4D 内 `.pyp` 插件，本机 127.0.0.1:5555 通信）。工具名前缀 `mcp__c4d__*`（25 个工具）。

## 前置条件

1. 用户本机已安装 Cinema 4D（R2024+ 推荐）。
2. **一次性安装插件**（复制 .pyp 到 Maxon 用户插件目录，无需管理员权限）：
   ```powershell
   & "$env:ADH_PROFESSIONAL_MCP\python\python.exe" `
     "$env:ADH_PROFESSIONAL_MCP\servers\c4d\launcher.py" install-plugin
   ```
   诊断：`launcher.py status`（同时探测 5555 端口连通性）。
3. **在 C4D 里启动服务**（每次重启 C4D 后都要）：扩展（Extensions）→ Socket Server Plugin → 弹窗里点 **Start Server**。
4. C4D 不开或没点 Start Server 时，工具会返回 “❌ Not connected to Cinema 4D”——先引导用户处理，不要连续重试。

## 使用要点

- **常用能力**（25 个）：`get_scene_info`、`list_objects`、`add_primitive`、`modify_object`、`create_material`、`apply_material`、`inspect_redshift_materials`、`apply_shader`
- MoGraph 与动力学：`create_mograph_cloner`、`add_effector`、`apply_mograph_fields`、`create_soft_body`、`apply_dynamics`
- 相机灯光动画：`create_camera`、`create_light`、`animate_camera`、`set_keyframe`
- 输出与存档：`render_frame`、`render_preview`、`snapshot_scene`（渲染/预览可用来自查画面）、`save_scene`、`load_scene`、`create_abstract_shape`、`group_objects`
- **`execute_python_script`** 是逃生口：在 C4D 内执行任意 Python（有安全限制——禁止 `import os`、`subprocess`、`exec(`、`eval(` 等关键字）。复杂自由建模优先用它。
- 工作流：先 `get_scene_info` / `list_objects` 摸清场景，再增改；按名称引用对象。

## 故障排查

- **“Not connected to Cinema 4D”**：①C4D 没开 → 引导打开；②插件没装 → 跑 `install-plugin`；③没点 Start Server → 扩展菜单里点开并 Start Server；④端口被占或被改——`launcher.py status` 能区分（端口不可达 vs 可达但无响应）。
- **C4D 里找不到 Socket Server Plugin**：装完插件后没重启 C4D，重启一次。
- **渲染类工具很慢**：属正常（渲染耗时），告知用户预期；用 `render_preview` 先低清预览再出大图。
