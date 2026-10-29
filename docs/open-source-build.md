# 从公开源码准备本地构建

源码仓库：https://github.com/bycjhuang/AIDesignHub-OpenSource 。使用与安装包相同的版本标签。
自有代码采用 AGPL-3.0-only；第三方许可见根目录 COPYRIGHT.md 和 THIRD-PARTY-NOTICES.md。

## 工作台与画布

安装 Node.js 22.12+（建议 24）和 Git，执行 `npm ci`。
在 `Loomic-main/Loomic-main/` 执行 `corepack pnpm install --frozen-lockfile`，回到根目录后执行：

```powershell
npm run prepare:licenses
npm run audit:licenses
npm run build:ai-design
npm start -- --demo-company
```

无模型密钥时可以查看演示项目和本地界面；真实推理或生成由使用者自行配置模型服务。

## 安装包的公开运行资源

安装包另外携带独立 Node、Harness npm 运行环境、专业 MCP 桥接和离线知识模型。
它们体积较大，源码树不附使用者缓存。可以从**同版本官方安装包的程序负载**取得构建输入：

| 安装负载中的路径 | 本地构建准备位置 |
| --- | --- |
| `resources/dsh-runtime/0.2.1-rc.2/` | `.runtime/installer-resources/dsh-runtime/0.2.1-rc.2/` |
| `resources/professional-mcp/` | `.runtime/professional-mcp/` |
| `resources/knowledge/` | `.runtime/knowledge/` |

先按发布清单核验官方安装包。只使用程序资源，不复制 Windows 用户配置、真实项目、密钥或账号。
这些位置不是维护者的私有业务仓库；各运行组件保留原许可证、版本清单、来源和适用的源代码记录。
独立 MCP 服务和上游运行环境的许可不因与工作台一起分发而被统一改为 AGPL。

修改知识引擎时，维护源码位于 `backend/knowledge-engine/`。安装后的画布构建依赖已有公开 esbuild，
可直接用锁定的编译器刷新 worker，不需要 BYCJ 私有仓库：

```powershell
node scripts/stage-knowledge-engine.cjs --source-root Loomic-main/Loomic-main/node_modules/.pnpm/esbuild@0.27.4 --compile-only
```

该步骤仅刷新程序 worker 及其发布清单，不接触用户知识库。
完整的新建运行资源准备方式见 local-release.md 与 backend/knowledge-engine/README.md。
缺少资源时开发界面会明确报告组件未就绪；不能把仅克隆源码描述为完整离线运行环境已准备。

## 发布配套

完成必要检查并提交源代码，再执行：

```powershell
npm run archive:source
npm run dist
node scripts/release-manifest.cjs --sign --artifact release/AIDesignHub-Setup-0.3.2.exe --source release/AIDesignHub-0.3.2-source.zip
```

源码 ZIP 使用当前干净 Git 提交生成；发布标签指向同一提交，安装包清单记录该构建基线。
通过同一发布页提供安装器、对应源码、许可证和验签材料。签名校验同时覆盖安装器与源码 ZIP。
这不等于承诺字节一致的可复现构建，也不需要把官方签名私钥交给源码使用者。
