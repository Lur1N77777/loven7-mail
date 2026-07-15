# 上游说明

本项目是 Cloudflare Temp Mail / `cloudflare_temp_email` 的增强前端套件，目标是复用上游官方 Worker/API，不替换上游后端。

## 关系

- 上游负责：邮件收发、地址、用户、管理员 API、数据库、Worker 逻辑。
- 本仓库负责：管理后台 UI、用户站 UI、分享链接 Pages Functions、浏览器端体验优化。

## 兼容假设

部署者需要已经有一套可用的 Cloudflare Temp Mail 官方 Worker/API，并且接口路径与上游保持兼容，例如：

- `/open_api/admin_login`
- `/open_api/site_login`
- `/admin/statistics`
- `/admin/address`
- `/admin/mails`
- `/admin/users`
- `/admin/show_password/{id}`
- `/api/mails`
- `/api/settings`

## 不包含内容

本仓库不包含：

- 上游 Worker 的数据库迁移脚本
- Cloudflare 账号配置
- 私有域名、私有 API、密码、Token、KV ID

如果后端接口和官方上游不同，需要部署者按自己的 Worker 做适配。
