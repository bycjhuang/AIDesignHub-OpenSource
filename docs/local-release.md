# 本地安装包与源码发布

当前版本：0.3.1。平台：Windows x64。产物：`release/AIDesignHub-Setup-0.3.1.exe`，NSIS 安装向导，按当前用户安装，可选择安装位置。安装包尚未签名。

## 构建前提

1. 安装 Node.js 22.12+（建议 24）、Git 与 Loomic 声明的 pnpm；运行 `npm ci`。
2. 在 `Loomic-main/Loomic-main/` 运行 `corepack pnpm install --frozen-lockfile`。画布源码与 MIT 许可已经纳入仓库，依赖与输出目录不纳入 Git。
3. 准备 ADH Harness `0.2.1-rc.2` 的发布运行资源。优先使用当前用户的应用缓存 `cache/dsh-runtime/0.2.1-rc.2/`，也支持预置于 `.runtime/installer-resources/dsh-runtime/0.2.1-rc.2/`。必须包含 `node/`、`package/`、`runtime-manifest.json`；不复制整个用户配置目录。
4. 专业 MCP 发布资源预置于 `.runtime/professional-mcp/`，通过 `node scripts/stage-professional-mcp.cjs --source <桥接发布资源目录>` 校验和暂存。它是工具桥接运行资源，不包含目标商业软件。
5. 离线知识资源预置于 `.runtime/knowledge/`。完整生成方式见 [知识引擎说明](../backend/knowledge-engine/README.md)：需要独立 Node、生产依赖、公开 E5 / OCR 模型资源及对应许可。

知识引擎的 `node_modules/` 使用独立的 `extraResources` 映射。electron-builder 会跳过单个映射根部的同名目录，仅复制 `knowledge/` 根目录会漏带依赖；打包后钩子会检查全部根依赖是否实际存在。

仓库不提供这些体积较大的二进制资源自动下载服务。全新克隆的主工作台可通过 `npm start` 开发启动；缺少相应运行资源时，Agent / 知识功能会报告组件未就绪。仅克隆源码不等于具备完整的离线安装包构建环境。

## 一次发布

```powershell
npm run audit:release
npm test
npm run dist
```

`npm run dist` 依次重建画布、执行 `scripts/stage-installer-resources.cjs`，再调用 electron-builder。干净资源暂存在 `.runtime/installer-resources/public/`；只复制指定资源，排除账号配置、密钥、项目数据、npm 缓存和 Python 字节码缓存，并将 manifest 中的开发电脑来源路径替换为中性标记。源运行资源与使用者数据不被修改。

`scripts/release-after-pack.cjs` 检查打包后的实际目录，发现可识别的密钥、用户目录或私有文件即终止构建。扫描结果只包含文件位置、行号与规则，不输出凭据内容。公开 CA 信任证书和第三方许可证保留；合成测试凭据与真实凭据分开处理。

可通过构建进程的 `ADH_RELEASE_PRIVATE_TERMS` 环境变量提供需额外拦截的个人标识，以 `|` 分隔；不要将其值写入仓库。自动扫描有识别边界，新增截图、二进制文档与演示视频仍需人工核对。

## 验收与交付

- 使用独立临时安装目录和全新用户配置目录检查启动、模型设置未配置状态及项目初始化。
- 检查 `resources/dsh-runtime/`、`resources/professional-mcp/`、`resources/knowledge/` 与画布静态文件完整存在。
- 用合成资料验证安装资源中的知识库导入和检索，不接触维护者的知识库。
- 安装包和 SHA256 校验值留在本地交付；源码、文档、第三方来源及测试提交到既有 GitHub 仓库。
- 实际付费模型调用、专业软件操作和线上服务验证不包含在这套本地打包测试中。

`deliverables/`、`presentation/`、桌面汇报材料和 `.runtime/` 作为本地资料保留，不进入新提交。既有 Git 历史未被重写；本次清理不是历史凭据撤销或历史信息删除操作。
