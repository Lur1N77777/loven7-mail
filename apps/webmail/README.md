# 用户站 / 分享站（apps/webmail）

这是 Loven7 Mail Cloudflare Suite 的用户侧前端和分享链接服务，部署为 Cloudflare Pages + Pages Functions。

## 功能

- 地址 JWT 单邮箱登录。
- 单邮箱分享、多邮箱分享、聚合分享。
- 共享链接管理接口：列表、撤回、恢复、修改有效期、仅新增邮件模式。
- 访客侧显示“删除邮件”，底层只隐藏当前分享视图，不影响后台真实邮件。
- 邮件 HTML 安全渲染、品牌头像、自动刷新进度。

## Cloudflare Pages 设置

- Root directory: `apps/webmail`
- Build command: `npm ci && npm run build`
- Output directory: `dist`

## 运行时环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | 是 | Cloudflare Temp Mail 官方 Worker/API 地址。 |
| `SITE_PASSWORD` | 否 | 上游 Worker 如果配置了站点密码，就填写。 |
| `SHARE_ENCRYPTION_SECRET` | 分享功能必填 | 加密分享记录，建议 32 字符以上随机字符串。 |
| `SHARE_ADMIN_CORS_ORIGINS` | 分站管理分享时必填 | 允许跨源调用分享管理接口的后台来源，逗号分隔，例如 `https://your-admin.pages.dev`。 |
| `SHARE_PUBLIC_CORS_ORIGINS` | 否 | 公开分享 API 的额外跨源来源；默认空，仅允许同源分享页调用。 |
| `MAIL_READ_STATE_KV` | 推荐 | 邮件已读状态同步 KV。和管理后台绑定到同一个 Namespace 时，电脑端/手机端/后台/用户站可共享已读状态。 |

> 后台与用户站分开部署时，请把管理后台的完整 origin 写入 `SHARE_ADMIN_CORS_ORIGINS`。不要设置 `*`；公开分享页正常使用同源相对请求，不需要额外 public CORS。

## KV 绑定

分享功能需要绑定 KV Namespace：

- Binding name: `SHARE_KV`
- Namespace: 你自己创建的 KV Namespace

邮件已读同步推荐额外绑定同一个管理后台状态 KV：

- Binding name: `MAIL_READ_STATE_KV`
- Namespace: 与管理后台 `MAIL_READ_STATE_KV` 相同的 KV Namespace

如果没有配置 `MAIL_READ_STATE_KV`，用户站会退回使用 `SHARE_KV` 保存已读状态；这种情况下用户站内部可跨设备同步，但不会和管理后台共用同一份状态。

KV 不需要建表、迁移或 SQL；它保存分享链接、撤回状态、访客隐藏邮件记录以及邮件已读状态。

如果只使用单邮箱 JWT 登录、不使用分享功能，可以暂时不绑定 KV；但管理后台里的分享管理会不可用。

## 本地运行

```bash
npm ci
npm run dev
```

本地预览 Pages Functions：

```bash
npm run build
npx wrangler pages dev dist \
  --compatibility-date=2026-05-11 \
  --binding MAIL_WORKER_BASE_URL=https://your-worker.example.workers.dev \
  --binding SHARE_ENCRYPTION_SECRET=replace-with-a-long-random-secret \
  --binding SHARE_ADMIN_CORS_ORIGINS=http://localhost:5173
```
