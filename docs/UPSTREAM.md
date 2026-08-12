# 上游说明

本项目是 Cloudflare Temp Mail / `cloudflare_temp_email` 的增强前端套件。前端与 Pages Functions 由本仓库维护；新手安装器可以下载、校验并部署锁定的官方 Worker 版本，但不会把上游后端源码 Fork 进本仓库，也不会长期维护一套分叉后端。

## 关系

- 上游负责：邮件收发、地址、用户、管理员 API、数据库、Worker 逻辑。
- 本仓库负责：管理后台 UI、用户站 UI、分享链接 Pages Functions、浏览器端体验优化。
- 安装器负责：接入已有兼容 Worker，或克隆 `deployment/upstream-lock.json` 锁定的上游 release，创建 D1、写入部署配置与 Secret，并完成基础在线验收。

安装器生成的 Worker 配置会针对本套前端启用必要的用户地址能力并设置管理员角色域名。它不会修改上游仓库内容；配置只存在于安装器的临时克隆中，部署结束即清理。Email Routing、DNS 和真实邮件投递仍由部署者确认。

## 兼容假设

已有 Worker 模式要求部署者已经有一套可用的 Cloudflare Temp Mail Worker/API。新 Worker 模式则固定使用 `v1.10.0`（提交 `116ddc732431afd6f4154a74669804473b373baa`）。前端依赖的主要兼容接口包括：

- `/open_api/admin_login`
- `/open_api/site_login`
- `/admin/statistics`
- `/admin/address`
- `/admin/mails`
- `/admin/users`
- `/admin/show_password/{id}`
- `/api/mails`
- `/api/settings`

## 仓库边界

本仓库不长期保存：

- 上游 Worker 完整源码和数据库 schema 副本；安装器从锁定 release 临时读取 `db/schema.sql`
- Cloudflare 账号配置
- 私有域名、私有 API、密码、Token、KV ID

如果已有后端接口和锁定的官方上游不同，需要部署者按自己的 Worker 做适配。更新锁定版本时，必须同时更新 `deployment/upstream-lock.json`、安装器兼容测试和本文档。
