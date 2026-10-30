# 对外发布页部署（2026-10-29）

> 这是初次部署快照。随后确认国内无代理网络会被 Sites 防护拦截，当前入口、验证边界和迁移进展以 `public-website-domestic-access-2026-10-29.md` 及 CURRENT-STATE.md 为准。

1. **任务**：发布桌面 `AI Design Hub_对外发布版.html` 到 `aidesignhub.work` 与 `adh.bycjdesign.com`；保留原版 18 页、600 秒、配音、视频、目录和讲稿，不公开桌面应用后端或用户数据。
2. **现状**：Sites 静态部署已成功，公开地址 `https://aidesignhub.johnson.chatgpt.site`；`https://aidesignhub.work` 与 `https://adh.bycjdesign.com` 的 DNS、托管路由与证书均已激活。两域公网 HTTPS 首页 HTTP 200，标题及 18 页数据与源页面一致；主域名图片、配音和视频抽查均 HTTP 200 且文件字节与源素材一致，回执在独立站点目录 `aidesignhub-work-acceptance.json`，此前子域名媒体回执为 `adh-public-acceptance.json`。
3. **关键文件**：源文件 `%USERPROFILE%\Desktop\AI Design Hub_对外发布版.html`（SHA256 `ed8a6cfa7670f9b7de520b381547162b5cae056190dea38887b8e4a6747f160c`）；独立网站源码在 `.runtime/website-public-20261029/`，源提交 `8944bbec27bf98a54cd54183eb1b7a53855536f4`；Sites 项目 `appgprj_6ae301a158d0819183ca7ee67a4a9d46`，已保存版本 `appgprj_6ae301a158d0819183ca7ee67a4a9d46~appgver_06870683ab888191914c6f79dcce1b1a`，成功部署 `appgdep_6ae3031ffb3481919cb5ed74edfa85da`。
4. **已定决定**：原桌面文件不改；解出 35 个媒体资源和 4 个字体，首屏 HTML 124,699 字节、资源 49,823,438 字节。39 个文件哈希与原内嵌内容一致，2 段执行脚本语法通过，本机浏览器全部 18 个音视频可读且首次配音可播放；公网图片与视频完整字节一致。托管服务会在 HTML 末尾添加平台脚本，Range 请求当前返回完整视频 HTTP 200。Cloudflare 仅新增 `adh` 及其两条验证 TXT，现有业务记录未改；API 密钥只在既有服务器读取，未复制。Computer Use 本轮因无法可靠识别浏览器地址被系统停止，未通过浏览器修改 DNS。
5. **下一步**：部署与两个域名的访问验收已完成；后续更新页面沿用同一 Sites 项目和域名，不重复添加 DNS。子域名绑定 ID `appgdom_6ae3033fd7c08191bc39b357a7151cf1`、主域名绑定 ID `appgdom_6ae3033d0e5c8191859b90ff84611d11` 均为 active。主域名四条记录由用户在 DNSPod 手动添加，1.1.1.1 与 8.8.8.8 均已读到正确 A 记录，两个 TXT 值也已核对。Cloudflare 新增记录回执保存在原国内服务器 `/var/backups/aidesignhub-public-site/20261029-cloudflare-dns.json`，可按回执中精确记录 ID 回退。

## DNSPod：aidesignhub.work

以下四条已由用户添加并验证；线路为默认，TTL 600 秒，同一主机 `@` 保留两条 A 记录。

| 类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | `@` | `162.159.143.30` |
| A | `@` | `172.66.3.26` |
| TXT | `_openai-site-verification` | `openai-site-verification=Qqhf7CUZT2V93H418q2m1G6UVjC6dzdx1xKT1JQLcWw` |
| TXT | `_cf-custom-hostname` | `d84fb5f3-2990-44ce-a31f-7485dbe4039f` |

## Cloudflare：已添加

| 类型 | 完整名称 | 记录值 |
| --- | --- | --- |
| CNAME | `adh.bycjdesign.com` | `custom-domains.chatgpt.site`（仅 DNS） |
| TXT | `_openai-site-verification.adh.bycjdesign.com` | `openai-site-verification=ZYc8bm30YEqhArzIabG_G3MlMLGI8Nnw5Ax6xp6jgMk` |
| TXT | `_cf-custom-hostname.adh.bycjdesign.com` | `f1606b27-fdb7-4d9b-bf42-60b1c647d7f9` |
