# AI Design Hub 离线知识引擎

维护源码为 `runtime/knowledge/` 和 `vendor/anythingllm/`。功能参考 BYCJ Design 的知识库实现，来源与逐文件哈希见 `UPSTREAM.json`；这里没有 BYCJ 的知识库索引、文档、聊天、账户配置或密钥。

运行时位于项目已忽略的 `.runtime/knowledge/`，包含独立 Node、精确生产依赖闭包、公开 E5/OCR 资源及许可。worker 通过 Node IPC 工作，不运行于 Electron，也不读取 BYCJ 的目录。`ADH_KNOWLEDGE_DATA_DIR` 必须指向 Hub 专属数据目录。已有 Hub 资料由调用方先迁移为 v2 `knowledge-index.json`，worker 不自行寻找任何其他应用的数据。

安装包通过 `package.json` 的 `build.extraResources` 将完整运行时复制到 `resources/knowledge/`。主进程按 `app.isPackaged` 选择安装资源或开发目录；安装版不依赖开发项目所在盘符。打包前需准备上述离线运行时，不能仅打包 `backend/knowledge-engine/` 源码。知识库与原始资料始终保存在用户应用数据目录，更新运行组件不会替换这些资料。

首次 staging：

```powershell
node scripts/stage-knowledge-engine.cjs --source-root <只读参考代码目录> --node <独立node.exe>
```

之后只编译本仓库源码：

```powershell
node scripts/stage-knowledge-engine.cjs --source-root <含esbuild的只读参考目录> --compile-only
```

源目录仅提供公开依赖、公开模型资源及编译器；运行不依赖它。stage 只读取参考目录的 `node_modules/` 与 `desktop-assets/knowledge/`，不读取真实知识库数据。模型/OCR按公开资源manifest核对SHA256，payload包含每个文件的大小与哈希、生产包版本、源码哈希。完整重建会保留旧payload恢复目录。

`KnowledgeWorkerClient({dataDir, payloadRoot?, nodeExe?, assetsDir?})` 提供 `start()`、`request(method,args)`、`close()`。`start()` 返回初始化结果，`request` 支持 init、summary、listProjects、createProject、updateProject、removeProject、listSources、addFiles、addFolder、removeSource、reindex、search、corpus、export。search包含完整命中片段和引用，corpus以 `nextCursor` / `done` 分页遍历全部已保存正文，旧检索缓存会标明可能重叠或不完整；export返回原生docx/xlsx/pptx的 `base64/suggestedName/mimeType`。

已迁移资料重新解析时保留原展示文件名，并把同一名称传给索引与引用；Hub内部归档路径的ID前缀不会取代用户文件名。

默认使用公开量化 `Xenova/multilingual-e5-small`、LanceDB/AnythingLLM与本地Tesseract OCR。强制离线：模型和OCR不自动下载，worker网络fetch明确拒绝，缺资源报告degraded且保留全文检索。Office正文按文档/表格/幻灯片结构解析，PDF同时支持文字和扫描页OCR；图像OCR结果保留需人工核对提示。

验收：`node --test tests/knowledge-engine.test.cjs`。真实集成测试只使用临时合成资料，包括旧缓存分页、完整命中、E5混合检索、DOCX/XLSX/PPTX原生导出与回读、文字PDF、图片和扫描PDF OCR及缺资源降级，不接触真实资料。
