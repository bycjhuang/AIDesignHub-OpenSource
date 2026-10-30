# AIDesignHub 网页演示

此入口复用桌面版的工作台、Loomic 画布及 DeepSeek Harness 前端。项目、知识资料与 Agent 回复均为公开的虚构演示；工作台状态只保留在浏览器，不连接桌面 IPC 或真实模型。

官网账号下载网关单独运行，沿用 BYCJ 邮箱账号。JWT 仅保留在网关进程内，浏览器使用短期 HttpOnly 会话 Cookie；它不提供项目、图纸、知识库、模型或专业软件接口。注册邮件由用户主动提交后，经现有 BYCJ 邮件流程发送。

## 构建

基础源码：[AIDesignHub-OpenSource v0.3.2](https://github.com/bycjhuang/AIDesignHub-OpenSource/tree/v0.3.2)。将本补充源码放到基础源码对应目录，安装原工程依赖，按原 `scripts/build-loomic.cjs` 构建本机画布。Harness 浏览器资源来自同版公开安装包的运行组件，不使用用户配置、密钥或本地会话。`agent-boot-builder.cjs` 的默认路径为 `.runtime/installer-resources/public/dsh-runtime/0.2.1-rc.2/package`，也可显式传入 `runtimePackageRoot`。

```text
python scripts/cache-public-demo-assets.py
node scripts/build-public-demo.cjs
node scripts/preview-public-demo.cjs
node --test tests/public-site-account.test.cjs
```

预览地址为 `http://127.0.0.1:8799`。本地预览不发送真实注册邮件，也不接受真实登录。公开产物在 `.runtime/website-demo-20261030/dist`；构建仅复制明确列出的前端与已公开资源。补充源码生成到 `licenses/web-demo-source.zip`。

## 网关部署

`server.cjs` 使用 Node 内置模块，监听回环地址。环境变量包括 `GATEWAY_SECRET`、`ADH_DOWNLOAD_MANIFEST`、`PORT`（默认 8789）、`ADH_PUBLIC_ORIGINS`。密钥经主机私有环境文件注入，不包含在本源码或公开目录。上游固定为本机 BYCJ 账号 API；下载清单只允许预先配置的两个文件名。

Nginx 将 `/api/account/`、`/api/downloads/` 转发到网关，将其 `X-Accel-Redirect` 指向只有 `internal` 位置可访问的独立下载目录。下载文件先按官方 0.3.2 发布清单验证摘要。公开展示文件与下载文件分开保存；共享服务器上其他业务独立部署。当前发布脚本按独立目录、版本软链接和专属 Nginx 配置更新，旧版本保留用于回退。

设计画布的静态 HTML 与 Next 导出的 `.txt` 导航文件均使用明确的路由白名单；后者使用 `text/x-component`，无需框架服务端。

## 开源材料

自有整合及本补充代码沿用 AGPL-3.0-only；Loomic、Harness 和其他第三方组件保留原许可证、版权与声明。基础源码、第三方材料和官方已签名安装包见公开仓库与 Release。本网页演示没有重新制作或重新签署桌面安装包。
