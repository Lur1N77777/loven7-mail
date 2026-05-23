# Loven7 Mail Cloudflare Suite

基于 Cloudflare Temp Mail / `cloudflare_temp_email` 上游接口的增强前端套件。

> 上游后端项目：`dreamhunter2333/cloudflare_temp_email`（官方后端请按上游文档自行部署）。本仓库不包含后端 Worker 源码，不内置任何私有 API、密码、Token 或个人域名。

## 这是什么

本仓库包含两个可以独立部署到 Cloudflare Pages 的前端：

- `apps/admin`：管理员后台 PWA。用于管理地址、用户、邮件、设置、发件、共享链接等。
- `apps/webmail`：用户站 / 分享站。用于单邮箱 JWT 登录、多邮箱分享、聚合分享、共享链接撤回与访客侧邮件隐藏。

适合已经部署好 Cloudflare Temp Mail 官方 Worker/API 的用户，把这套增强前端接到自己的 Worker 上使用。

## 快速部署概览

你需要准备：

1. 一个已经可用的 Cloudflare Temp Mail 官方 Worker/API 地址，例如 `https://你的-worker.workers.dev` 或自定义域名。
2. Cloudflare Pages 两个项目：
   - 管理后台：部署 `apps/admin`
   - 用户站：部署 `apps/webmail`
3. 如果要用分享功能：给用户站 Pages 绑定 KV Namespace，并设置 `SHARE_ENCRYPTION_SECRET`。

### 管理后台 Pages

Cloudflare Pages 设置：

- Root directory: `apps/admin`
- Build command: `npm ci && npm run build`
- Output directory: `dist`

环境变量可以全部留空。首次打开后台时，在“连接设置”里填写自己的 Worker API 地址和管理员密码，浏览器会本地缓存。

可选构建变量：

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE` | 可留空。填入后会作为默认 Worker API 地址。公开部署建议留空，让用户在浏览器里配置。 |
| `VITE_FRONTEND_LOGIN_BASE` | 可留空。用户站 Pages URL，例如 `https://你的-webmail.pages.dev`；也可部署后在后台“系统设置”里保存。 |

### 用户站 / 分享站 Pages

Cloudflare Pages 设置：

- Root directory: `apps/webmail`
- Build command: `npm ci && npm run build`
- Output directory: `dist`

Pages 运行时环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | 是 | 你的 Cloudflare Temp Mail Worker/API 基址。 |
| `SITE_PASSWORD` | 否 | 如果上游 Worker 开启了站点密码，就填这里。 |
| `SHARE_ENCRYPTION_SECRET` | 分享功能必填 | 用于加密多邮箱/单邮箱分享记录，建议 32 字符以上随机字符串。 |

Pages 绑定：

| Binding | 类型 | 说明 |
| --- | --- | --- |
| `SHARE_KV` | KV Namespace | 分享链接、撤回状态、仅新增邮件 cutoff、访客隐藏邮件记录。 |

## 本地开发

```bash
# 管理后台
cd apps/admin
npm ci
npm run dev

# 用户站
cd ../webmail
npm ci
npm run dev
```

本地跑用户站 Functions 推荐使用 Wrangler：

```bash
cd apps/webmail
npm run build
npx wrangler pages dev dist \
  --compatibility-date=2026-05-11 \
  --binding MAIL_WORKER_BASE_URL=https://your-worker.example.workers.dev \
  --binding SHARE_ENCRYPTION_SECRET=replace-with-a-long-random-secret
```

## 共享链接功能怎么接起来

1. 先部署 `apps/webmail`，并配置好 `MAIL_WORKER_BASE_URL`、`SHARE_ENCRYPTION_SECRET`、`SHARE_KV`。
2. 打开 `apps/admin` 后台，进入“系统设置”。
3. 在“前端登录链接前缀”里填入用户站 URL，例如：`https://your-webmail.pages.dev`。
4. 回到“地址管理”，选择一个或多个邮箱，创建分享链接。
5. 后续可在“共享链接管理”里查看状态、批量撤回、恢复、改有效期。

## 安全与脱敏说明

- 本仓库不提交 `.env.production`、`dist/`、`node_modules/`、`.wrangler/`、本地缓存或任何私有部署产物。
- 管理后台默认不写死 API 地址；用户第一次填写后，只缓存在该浏览器本地。
- 用户站通过 Pages Functions 代理 Worker API，`SITE_PASSWORD` 和分享加密密钥只存在 Cloudflare Pages 运行时环境变量里，不会打进浏览器 JS。
- 发布前建议运行：

```bash
rg -n --hidden -S "<你的私有 API>|<你的私有域名>|<你的管理员密码>|<你的 Token 前缀>" . \
  -g '!node_modules/**' -g '!dist/**' -g '!.git/**'
```

## 许可证

本仓库新增的前端代码按 MIT License 开源。上游 Cloudflare Temp Mail / `cloudflare_temp_email` 后端请遵循其原项目许可证与文档要求。

