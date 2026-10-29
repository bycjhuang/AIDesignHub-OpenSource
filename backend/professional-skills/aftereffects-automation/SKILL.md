---
name: aftereffects-automation
description: 通过内置 After Effects 桥接（MCP，mcp__aftereffects__* 工具）驱动本机 AE 完成合成、图层、关键帧、表达式、特效与动画测试。
metadata:
  layer: modeling
  displayName: After Effects 动效
---

# After Effects 动效联动

桌面版内置 AE 桥接（Node 单文件服务端 + AE 内的 ScriptUI 面板 `mcp-bridge-auto.jsx`）。工具名前缀 `mcp__aftereffects__*`（13 个工具）。

## 前置条件

1. 用户本机已安装 After Effects（2021 及以上）。
2. **一次性安装面板脚本**（复制到 AE 的 ScriptUI Panels 目录；若 Program Files 无写权限会弹一次 UAC 请用户批准）：
   ```powershell
   node "$env:ADH_PROFESSIONAL_MCP\servers\ae\install-bridge.mjs" install
   ```
   诊断：`install-bridge.mjs status`；移除：`install-bridge.mjs uninstall`。
3. **在 AE 里开启脚本权限**（一次性）：首选项（Edit > Preferences）→ Scripting & Expressions → 勾选 "Allow Scripts to Write Files and Access Network" → 重启 AE。
4. 打开面板：菜单 窗口（Window）→ mcp-bridge-auto.jsx。面板的 Auto-run 默认开启，每 2 秒轮询命令文件；面板不打开则所有命令不会被 AE 执行。

## 使用要点

- **命令白名单**：`run-script` 只接受固定命令集——`getProjectInfo`、`listCompositions`、`getLayerInfo`、`createComposition`、`createTextLayer`、`createShapeLayer`、`createSolidLayer`、`setLayerProperties`、`setLayerKeyframe`、`setLayerExpression`、`applyEffect`、`applyEffectTemplate`、`test-animation`、`bridgeTest`。不在此列表的脚本会被拒绝（本桥无任意 JSX 逃生口）。
- **先读后写**：先 `getProjectInfo` / `listCompositions` / `getLayerInfo` 摸清工程与图层结构，再做创建/修改。
- **异步通道**：命令写入 `~/Documents/ae-mcp-bridge/ae_command.json`（状态 pending→running→completed/error），结果写入 `ae_mcp_result.json`。执行命令后如需结果，隔几秒用 `get-results` 读取；结果里 `_responseTimestamp`/`_commandExecuted` 可判断是不是本次的新结果。
- **常用工具**：`create-composition`（建合成）、`apply-effect` / `apply-effect-template`（特效；`mcp_aftereffects_get_effects_help` 可查特效列表）、`setLayerKeyframe`（关键帧）、`setLayerExpression`（表达式）、`test-animation`。
- 破坏性操作（删除图层/合成、覆盖工程）先向用户确认；先小步验证再批量。

## 故障排查

- **命令一直 pending / 无结果**：面板没打开（引导用户开 Window > mcp-bridge-auto.jsx）或 Auto-run 被取消勾选；确认 AE 首选项里脚本写文件权限已开启。
- **结果文件提示 stale（超过 30 秒）**：AE 侧没在写结果——面板未运行或 AE 忙；不要盲目重试，先让用户在面板里点 "Check for Commands Now" 看状态。
- **面板菜单里找不到 mcp-bridge-auto.jsx**：第 2 步没装或没重启 AE；跑 `install-bridge.mjs status` 确认。
- **脚本被拒**：命令不在白名单内——改用白名单里的命令组合实现。
