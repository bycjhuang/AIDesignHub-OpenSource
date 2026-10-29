# Hub 专属技能发现策略

`index.js` 使用官方 filesystem provider 的公开注册接口过滤全局发现，保留原cwd、自定义目录、优先级与watcher。展示面板、Skill工具与目录提示均从真实SkillRegistry读取。

rc2 的 web preset 还会在 standard、ptc、cordis 等独立scope内注册 filesystem provider；仅禁用host层实例不会限制这些实例。因此 `backend/dsh-skill-policy.cjs` 中的 `ensureHubSkillPolicyRuntime` 在Host启动前，对Hub独立缓存的官方filesystem模块增加同一组精确ID过滤，直接作用于其list/get原生入口，覆盖所有scope。

该操作只修改Hub缓存，不修改BYCJ或任何技能文件。旁边的 `.adh-original` 保留原始字节，`.adh-policy.json` 记录原/修改后SHA256和名单；来源锚点不匹配或发现未知修改会保留文件并报错。传入 `enabled:false` 可恢复原模块。配置builder保持纯函数；运行时处理仅在 `DshRuntimeManager.ensureProfile` 调用，可独立注入用于测试。

回归包含实际官方web Host的standard、ptc、cordis preset，以及两个工作区切换；验证私有技能不能列出、不能get、不能通过实际Skill工具加载，通用及项目技能保持。
