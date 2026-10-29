任务：完成 0.3.1 Windows 安装器、当前源码脱敏与 GitHub 推送、README 理念更新及版本溯源。
现状：安装器已在桌面交付，签名 / SHA256 / 一键验签及真实负载启动、空模型配置、知识导入检索通过；GitHub 保持私有。
关键文件：package.json、scripts/stage-installer-resources.cjs、scripts/release-*.cjs、docs/release-0.3.1-2026-10-29.md、docs/release-provenance.md。
已定决定：构建基线 3b23afb；内部包名不改；个人配置不分发；标记为版本级且不含使用者身份；第三方许可与既有 Git 历史保留。
下一步：代码图谱 moderate 重建两次因索引器崩溃未完成；Windows 证书、商业授权方案及安装包 CI 证明仍需另行配置。
