# 产品边界与后端来源

Loven7 Mail 是独立维护和发布的开源 Cloudflare 邮箱系统。品牌、Admin、Webmail、Pages Functions、分享能力、安装器、文档和 Release 由本仓库维护。部署完成后，Worker、D1、Pages 和 KV 全部运行在部署者自己的 Cloudflare 账号中，不请求原项目的托管服务。

全新 Worker 部署目前会下载并校验一个锁定的兼容后端源码版本。这个来源用于实现邮件 Worker 和数据库 schema，不代表运行时依赖另一个公开站点；但它仍是安装阶段的源码供应链依赖。如果来源仓库不可访问，已有部署不受影响，全新部署则需要本项目提供镜像或内置源码后才能继续。

当前锁定信息如下，实际安装始终以 `deployment/upstream-lock.json` 为唯一依据：

| 项目 | 当前值 |
| --- | --- |
| 兼容后端源码 | [`dreamhunter2333/cloudflare_temp_email`](https://github.com/dreamhunter2333/cloudflare_temp_email) |
| Release | `v1.10.0` |
| Commit | `116ddc732431afd6f4154a74669804473b373baa` |
| 使用方式 | 安装时临时下载、校验、写入本次 Cloudflare 配置并部署；完成后删除临时目录 |

## 关系

- Loven7 Mail 负责：产品品牌、管理后台、用户站、分享 Pages Functions、新手安装器、部署体验、安全门禁和发行流程。
- 兼容后端源码负责：邮件收发、地址、用户、管理员 API、数据库 schema 和 Worker 逻辑。
- 安装器负责：接入已有兼容 Worker，或获取 `deployment/upstream-lock.json` 锁定的源码版本，创建 D1、写入部署配置与 Secret，并完成基础在线验收。

安装器生成的 Worker 配置会针对 Loven7 Mail 启用必要的用户地址能力并设置管理员角色域名。它不会修改来源仓库内容；配置只存在于临时目录中，部署结束即清理。Email Routing、DNS 和真实邮件投递仍由部署者确认。

## 兼容假设

已有 Worker 模式要求部署者已经有一套符合 Loven7 Mail API 契约的 Worker。新 Worker 模式固定使用来源项目的 `v1.10.0`（提交 `116ddc732431afd6f4154a74669804473b373baa`）。前端依赖的主要兼容接口包括：

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

- 兼容 Worker 完整源码和数据库 schema 副本；安装器从锁定 release 临时读取 `db/schema.sql`
- Cloudflare 账号配置
- 私有域名、私有 API、密码、Token、KV ID

如果已有后端接口和当前锁定的兼容来源不同，需要部署者按自己的 Worker 做适配。更新锁定版本时，必须同时更新 `deployment/upstream-lock.json`、安装器兼容测试和本文档。
