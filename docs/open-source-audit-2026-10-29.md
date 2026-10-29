# AGPL 开源准备与两项主要上游许可审核

日期：2026-10-29。工作目录：本仓库。主许可：AGPL-3.0-only。
本记录区分源码准备、上游许可核对、安装包验收与正式公开，不把其中一项当作全部完成。

## 两项主要上游

| 组件 | 实际使用基线 | 核对结果 |
| --- | --- | --- |
| DeepSeek Harness | npm `@deepseek-ai/dsh@0.2.1-rc.2`；上游标签 `dsh-v0.2.1-rc.2`，提交 `687f282e8625c6b8d11ff58211a90524be2e4317` | 上游提交的 LICENSE、本机发行包 LICENSE 均为 MIT，Copyright (c) 2026 DeepSeek。下载官方 npm tarball 并核验 SHA512/SRI 后，对 CLI 包的 20 个发行文件逐一比较，20 个均未修改。此比较只覆盖 CLI 包本身，不冒充全部传递依赖均已逐字审核。 |
| Loomic | 原始 GitHub ZIP 的 comment 为 `21206c30054572291b9df000d84568aeca97aeda`；对应本机 `Loomic-main/Loomic-main/` | 上游 LICENSE 与本机保留文件一致：MIT，Copyright (c) 2026 Xinmin Zeng。原包 484 个文件中，402 个保持一致、82 个有适配修改、0 个缺失（比较时规范化文本换行和末尾空白）。修改说明单列 ADAPTATIONS.md，原 MIT 授权不被撤销。 |

MIT 允许使用、修改、整合、分发及销售；条件是副本或实质部分保留原版权和许可文本。
因此可以将 AIDesignHub 的原创整合代码按 AGPL 发布，同时保留两项上游及其原始 MIT 授权。
本项目不能把他人原始代码声称为自己的独占著作权，也不能声称上游为本产品背书。

固定许可证据：`third_party/UPSTREAMS.json`，含上游提交、LICENSE blob ID、官方 npm 地址与 SRI。
原始许可副本：`third_party/deepseek-harness/LICENSE`、`third_party/loomic/LICENSE`。

## 审核发现并处理的例外

1. Loomic 两项技能的 frontmatter 明确声明 Apache-2.0；canvas-design 还保留 `author: anthropic`。
   原包没有随附完整许可文本，现分别补 LICENSE.txt，不把技能笼统归入 MIT。
2. canvas-design 的 54 个 TTF 自带 OFL 1.1 元数据。保留原字体字节，新增 OFL 全文、逐文件 SHA256 和全部嵌入版权信息。
3. Excalidraw 0.18.0 的字体另有许可。对 234 个 WOFF2 提取原始 name 表，保留 OFL、Comic Shanns 的完整 MIT 与 Cascadia 的原始 Microsoft 字体条款；上游源文件补充了 Excalifont 和 Xiaolai 的 OFL 证据。
4. Excalidraw 所带旧 Liberation Sans 元数据为 1.05，不能用新字体的 OFL 声明直接覆盖。
   改用 Liberation Fonts 官方 2.1.5 OFL 发行物；随附原 TTF、LICENSE、下载来源及 SHA256。WOFF2 不裁剪字形、不改版权和名称；反解后逐表核验，仅有压缩必需的 head 标志和校验变化。公共字体目录和 webpack 字体导入均使用同一替换文件。
5. 旧 elkjs 0.9.3 仅标 EPL-2.0，不能自动断言可并入 AGPL 组合。
   上游已新增 GPL 次许可；现锁定 `elkjs@0.12.1`，其声明为 `EPL-2.0 OR GPL-3.0-or-later`，在本发行组合中采用 GPL-3.0-or-later 选项，仍完整保留上游 EPL/GPL 文本。`third_party/elkjs/sources/` 同时随附 elkjs 与对应 ELK 次版本源代码、构建脚本和许可原文。已补真实双节点布局检查，画布重新构建。
6. Harness 的传递依赖包含 LibreOffice Kit（MPL-2.0）、sharp/libvips（Apache/LGPL）等。
   其原包内许可证、NOTICE、引擎第三方说明、sources 和补丁目录继续保留；主项目 MIT 结论不覆盖这些组件。

## 已落实的发布规则

- 根 LICENSE 为未改写的 AGPL v3 全文；COPYRIGHT.md 和 NOTICE 明确自有与上游范围。
- package.json / package-lock.json 标明 AGPL-3.0-only，历史包名保持不变。
- 现有“关于”页面可离线阅读 AGPL、两家上游 MIT、Excalidraw MIT、Apache / OFL 文本及第三方声明，并提供本版本对应源码下载入口。
- 安装包明确携带 LICENSE、NOTICE、COPYRIGHT.md 和 third_party；构建前后检查原作者版权及许可是否丢失或改变。
- 贡献来源认证与商业再授权分开：DCO 不等于 CLA，不自动取得重许可社区代码的权利。
- 用户项目、知识资料、模型密钥、外部账号和私有技能不在公开范围；旧 0.3.1 安装器和签名保留。

## 验证与公开状态

针对性检查通过（含原始版权丢失、字体字节篡改、EPL-only 版本回退、安装负载丢失 Harness 许可的拦截，以及真实 ELK 布局）。串行全量 768 项通过、0 失败、0 跳过；此前并行运行的两项界面等待问题已分别复核通过。
画布静态构建通过；实际 Electron“关于”页面可离线查看 10 项许可/声明，源码链接指向 v0.3.2，对原作者署名的显示检查通过，未发起真实网络请求。版本升级后知识 worker 中的旧发布标识已通过重编译修复，真实 Office / PDF / OCR / E5 / 导出检查通过。全量测试、源码归档、新安装包与公开状态在本轮完成后补记。

不能把此处的主项目核对解释为完整法律尽调或所有第三方资源均为 MIT。
SBOM、完整构建可复现性、商业再授权合同及所有专业软件桥接的许可边界分别处理，不冒充已验收。

## 上游原始来源

- DeepSeek Harness LICENSE：https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE
- Loomic LICENSE：https://github.com/fancyboi999/Loomic/blob/21206c30054572291b9df000d84568aeca97aeda/LICENSE
- Apache skill license：https://github.com/anthropics/skills/blob/main/skills/canvas-design/LICENSE.txt
- Excalidraw 字体源：https://github.com/excalidraw/excalidraw/tree/817d8c553c3389650f8b4503984a6d4a5d2f0c11/packages/excalidraw/fonts
- elkjs：https://github.com/kieler/elkjs/tree/624ae90aa37110033a8af59c5ccbb292708b4317
- ELK GPL 次许可讨论：https://github.com/eclipse-elk/elk/issues/1185
- OFL WOFF / WOFF2 规则：https://openfontlicense.org/ofl-faq/
- AGPL v3：https://opensource.org/license/agpl-3.0

## 五行交接

任务：按 AGPL 推进 AIDesignHub 开源，保留 DeepSeek Harness 与 Loomic 的原始授权。
现状：两项主项目 MIT 已核对；资源例外、版权材料、关于页面和打包拦截已实现。
关键文件：LICENSE、COPYRIGHT.md、THIRD-PARTY-NOTICES.md、third_party/、scripts/open-source-license.cjs。
已定决定：AGPL-3.0-only；原 MIT / Apache / OFL 等继续有效；不宣称禁止合规商业 fork。
下一步：按本节最终验收记录取得对应源码与发布包，正式公开前核对历史和发布范围。
