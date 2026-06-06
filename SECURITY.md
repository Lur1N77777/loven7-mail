# Security Policy

## 支持范围

当前主要维护 `main` 分支和最新发布版本。项目仍处于 `0.x` 阶段，安全修复会优先合入 `main`。

## 报告安全问题

如果你发现以下问题，请先私下联系维护者，不要直接公开完整利用细节：

- 真实密钥、Token、KV Namespace ID 或个人域名泄露。
- 邮件 HTML 渲染导致 XSS、跳转或隐私泄露。
- 分享链接越权访问、撤回失效或跨邮箱访问。
- Pages Functions CORS、认证头或运行时配置泄露。

可以通过 GitHub Security Advisory 提交。如果仓库没有开放 Advisory，请先创建一个不包含利用细节的 Issue，标题写“Security contact requested”，维护者会继续对接。

## 处理原则

- 不在 Issue、PR、README、Actions 日志里回显密钥原文。
- 分享功能的 KV 绑定名固定为 `SHARE_KV`，但真实 Namespace ID 不应提交到仓库。
- `SHARE_ENCRYPTION_SECRET`、`SITE_PASSWORD`、`MAIL_WORKER_BASE_URL` 应通过 Cloudflare Pages 运行时变量或 secret 配置。
- 管理后台的 Worker API 地址和管理员密码默认由用户在浏览器本地保存，不写入公开构建产物。
