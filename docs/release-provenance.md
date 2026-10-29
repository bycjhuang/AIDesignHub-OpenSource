# 版本来源、发布验证与成果标识

本轮采用版本级溯源，不采集使用者身份、不分配个人指纹、不联网追踪，也不改写导入的原始素材。

## 已接入的措施

- **官方包验证**：安装包附 SHA256、JSON 发布清单和 Ed25519 分离签名。公钥纳入源码，签名私钥通过 Windows DPAPI CurrentUser 加密保存在本机发布账户的应用数据目录，既不进入 Git，也不进入安装包。
- **版本来源**：`assets/release-identity.json` 保存版本唯一 ID 与源码 canary；界面标题栏的「关于」可查看。构建记录包含源码文件集合哈希、Git 基线、工作树是否有修改及构建时间。
- **导出标识**：知识中心的 Word 页脚、Excel 来源表和打印页脚、PPT 页脚及案例 PPT 标注 `Powered by AIDesignHub`、版本和短来源 ID；Office 元数据保留完整版本 ID。AI Design 的本机 PNG 下载追加来源标识底边，并在 PNG 文本元数据中记录版本 ID 和 canary。
- **源码证明工作流**：手动触发的 `.github/workflows/source-provenance.yml` 从指定 Git 提交产生源码归档与 SHA256，可选择调用 GitHub / Sigstore 构建证明。它证明的是源码归档，尚不是 Windows 安装包的 CI 重建证明。

## 验证安装包

从可信仓库副本获取 `assets/release-public-key.json`，不要仅信任安装包下载目录里附带的公钥。安装 Node.js 后执行：

```powershell
node scripts/release-manifest.cjs --verify --manifest release/AIDesignHub-0.3.2.manifest.json --signature release/AIDesignHub-0.3.2.manifest.json.sig.json --key assets/release-public-key.json
```

验签通过后，再逐个比较清单中的文件大小与 SHA256；工具会自动完成这两步。改动安装包、清单或替换签名公钥，都应验证失败。发布包也附带独立 `verify-release.cjs`，只依赖 Node 内置模块。

桌面交付目录另附独立 Node、Node 原许可和「验证安装包.cmd」，无需先安装开发环境。0.3.2 同一清单同时核验安装器与对应源码 ZIP，两者应放在清单旁。正式发布清单、签名及 SHA256 另存于本仓库 `docs/releases/0.3.2/`，可从可信仓库下载并核对。

当前公钥 SHA256：`34b7d1f9fc4c18f7d804c3ac5cb4ace049a43358fbfcd61c8e62df68b3546b1a`。应通过你信任的维护者渠道核对它；签名可靠性取决于公钥来源和私钥保管。

## 明确的限制

1. **没有 Windows Authenticode 代码签名证书。** 本轮分离签名提供发布包真实性检查，不消除 Windows 的未签名提示，也不是 CA 对发布者身份的认证。
2. **没有宣称可重现构建或 SLSA 等级。** 来源记录与构建证明不等于已实现字节一致的独立重建。0.3.2 Windows 发布在本机构建；新的源码仓库已经公开，GitHub / Sigstore 源码证明工作流尚未运行验收。
3. **水印与 canary 可被移除。** 它们是核对版本与来源的辅助材料，不是防拷贝机制，也不单独构成对作品权属或侵权的结论。未实现用户级指纹、LSB / DCT 隐写或泄露者身份追踪。
4. **导出格式范围有限。** 当前新增标记覆盖上述 Office 和本机 PNG 下载；复制到剪贴板、可编辑 Excalidraw 源文件、原始图片下载和既有历史成果不在同一水印覆盖范围。应用尚无统一 PDF 导出路径；Word 转成 PDF 时可保留页脚，但未经本轮 PDF 转换验收。
5. **本次 AGPL 发布允许合规商业使用和衍生发行。** 不额外附加竞品必须付费的限制；Loomic 等第三方原有 MIT 许可和版权继续保留。见 [许可范围](../COPYRIGHT.md) 与 [本仓库第三方说明](../THIRD-PARTY-NOTICES.md)。

保留 Git 提交、签名清单、发布时间、原始素材与授权记录，能形成比单个隐藏字符串更完整的来源记录。
