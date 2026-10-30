任务：三站统一 BYCJ产品矩阵（BYCJ Design设计工作台、AIDesignHub、PlanPalette填彩助手），仅 AIDesignHub/PlanPalette 统一顶栏，BYCJ 主站导航布局保留。
现状：已上线 AIDesignHub web-demo-20261030-8a2cf59a48ea、PlanPalette webtrial-20261030-product-matrix-v11 及 BYCJ 网站 main 986b49f；前两站沿用东京原服务器。
关键文件：web-public/toolbar.html、toolbar.js、website.css、demo-topbar.css、product-matrix-menu.css；另两站对应文件见各自交接；截图及验证在 .runtime/website-demo-20261030/。
已定决定：三站弹窗内容/样式一致，首次展开、关闭按钮及 Esc 关闭；ADH 顶栏不再重复放应用 Logo。网页补充源码随构建公开；既有登录下载和 PlanPalette 案例/视频/企业申请流程保留，桌面软件不变。
下一步：本次已完成。构建、PlanPalette 网页类型检查、BYCJ 类型诊断新增0、390/320窄屏及原入口回归、20项公网资源字节/SHA256与7项入口检查通过；BYCJ其余75项资源路径/字节/hash与已验版本相同。回退先查后续发布，ADH 用 deploy-public-demo.py rollback --apply，PlanPalette 用 update-web-workbench.py rollback --release webtrial-20261030-product-matrix-v11 --via-domestic --apply，BYCJ 窄回退986b49f的3文件。 本次 moderate 图索引刷新仍发生受控 worker 崩溃，新增网页文件以当前源码为准。
