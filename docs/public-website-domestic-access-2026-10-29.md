# 对外网页：国内无代理访问修复（2026-10-29）

> 2026-10-30 更正：本文是迁移时的历史快照，服务器地域后确认为东京；正文中的“香港”是当时误称。当前网页已升级为完整前端演示，实际版本、服务及回退入口见 [部署与源码交接](HANDOFF-2026-10-30.md)。公司电脑 DNS 诊断的待办仍保留。

1. **任务**：修复原报错电脑不开 VPN 时被 `chatgpt.site` 安全防护拦截的问题；原网页内容、18 页、配音和演示视频保留。
2. **现状**：初次 Sites 发布虽已设为 public，国内无代理网络仍复现 Cloudflare 403。现已将 `https://aidesignhub.work` 与 `https://adh.bycjdesign.com` 全部迁至既有香港服务器 `43.163.231.31`。国内无代理服务器通过系统 DNS 访问两域均为 HTTPS 200，首页与源文件字节一致；主域名图片、配音字节一致，视频 Range 为 206 且片段哈希一致，两域 HTTP 均正确 301 至 HTTPS，ACME 路径不被跳转。8 项检查全通过；1.1.1.1 与 8.8.8.8 均解析到新 IP。用户也已确认原报错电脑不开 VPN 能打开备用地址。
3. **关键文件**：本机静态源码 `.runtime/website-public-20261029/dist/`；新主机 `/srv/aidesignhub-public/releases/20261029-43a4e7e7a2a9/`（40 个静态文件），`current` 指向该版本；Nginx 独立配置 `/etc/nginx/conf.d/aidesignhub-public.conf`，只配置两个发布域名，未改其他业务虚拟主机。香港回执目录 `/var/backups/aidesignhub-public-site/` 内含 `20261029-hk-static.json`、主域名配置备份 `20261029-primary-before-https.conf` 与 `20261029-primary-https-installed.json`；最终无代理验收回执位于国内服务器同目录 `20261029-primary-public-cn-acceptance.json`，已取回本机 `.runtime/website-public-20261029/aidesignhub-work-cn-final-acceptance.json`。此前国内验证与备用 DNS 回退回执也保留在国内服务器同目录。
4. **已定决定**：两个域名均直连独立静态站，不依赖 Sites 的访问入口；Sites 源项目保留作历史备份。Cloudflare 的 `adh` 为 DNS-only A `43.163.231.31`，DNSPod 主域名由用户改为同一 A 值并暂停旧入口，旧 TXT 暂留，其他业务记录未改。两域正式证书均在香港通过 webroot 签发，分别位于 `/etc/letsencrypt/live/adh.bycjdesign.com/` 与 `/etc/letsencrypt/live/aidesignhub.work/`，由既有且 active 的 `certbot-renew.timer` 续期，专用 deploy hook 为 `/etc/letsencrypt/renewal-hooks/deploy/aidesignhub-reload-nginx`；ACME 验证路径已保留。证书私钥不进本机工作区或 Git。Nginx 配置检查与重载均通过；主域名安装前配置已备份。此前 Computer Use 因无法可靠识别浏览器地址停止，未使用其他 UI 自动化绕过。
5. **下一步**：两个域名的迁移与服务器验收已完成，但用户随后报告公司电脑仍见旧 blocked 页面，客户端问题尚未关闭。该机系统 DNS 查询主域名与百度均超时，指定公共 DNS 则能查到主域名的新 IP；已确认须保留公司内网 DNS，当前等待该机单次指定目标 IP 的 HTTPS 检测输出，未修改公司电脑或重新切换服务端解析。诊断原始参数仅保存在本机忽略目录 `.runtime/website-public-20261029/company-client-diagnostics-20261029.json`。后续更新网页仍在独立静态站建立新 release 并切换 `current`，保留上一版本供回退；服务器测试与客户端验收须分别记录。

错误类别参考：[Cloudflare 403 说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-403/)。不能仅凭截图或本次检查确认具体命中了哪一条平台防护规则。
