# Cloudflare Pages 部署说明

本仓库部署为两个独立 Pages 项目：

```text
apps/admin    管理后台与同域安全代理
apps/webmail  用户邮箱、分享页与 Pages Functions
```

最短路径见 [部署速查](DEPLOYMENT_QUICKSTART.md)。本文补充变量、KV、Preview、直接上传和排错细节。

## 构建设置

| 项目 | Root directory | Build command | Output directory |
| --- | --- | --- | --- |
| Admin | `apps/admin` | `npm ci && npm run build` | `dist` |
| Webmail | `apps/webmail` | `npm ci && npm run build` | `dist` |

推荐公开默认名为 `loven7-mail-admin` 与 `loven7-mail-webmail`。复用已有项目时，通过 `ADMIN_PAGES_PROJECT_NAME`、`WEBMAIL_PAGES_PROJECT_NAME` 显式指定；公开源码不记录任何部署者的真实项目名。

## Admin 运行时

Admin 的 Pages Functions 把浏览器请求代理到上游 Worker。Production 至少需要：

| 名称 | 建议类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | Secret | 是 | Worker 根地址，例如 `https://worker.example.com` |
| `ADMIN_PASSWORD` | Secret | 是 | Worker 管理员密码，仅服务端注入 |
| `SITE_PASSWORD` | Secret | 否 | Worker 启用站点密码时填写 |
| `MAIL_READ_STATE_KV` | KV binding | 否 | 跨设备同步已读/星标 |

不要将上述值改名为 `VITE_*`。`VITE_*` 会进入浏览器构建产物，不适合 Secret。

## Webmail 运行时

| 名称 | 建议类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | Secret | 是 | Worker 根地址 |
| `SITE_PASSWORD` | Secret | 否 | Worker 启用站点密码时填写 |
| `SHARE_ENCRYPTION_SECRET_V2` | Secret | 分享必填 | 当前写入密钥，至少 32 字节高熵随机值 |
| `SHARE_ENCRYPTION_SECRET` | Secret | 旧数据兼容 | 仅解密旧的无 `kid` 分享记录 |
| `SHARE_ADMIN_CORS_ORIGINS` | Variable | 双站分享管理必填 | Admin 完整 origin，逗号分隔；禁止 `*` |
| `SHARE_PUBLIC_CORS_ORIGINS` | Variable | 否 | 默认空；公开分享通常使用同源请求 |
| `SHARE_KV` | KV binding | 分享必填 | 分享、撤回、隐藏和相关索引 |
| `MAIL_READ_STATE_KV` | KV binding | 推荐 | 与 Admin 指向同一 Namespace 时可共享状态 |

`SHARE_ENCRYPTION_SECRET_V2` 和 `SHARE_ENCRYPTION_SECRET` 是变量名，不是示例值。Secret 原文只能写入 Cloudflare Secret，不得进入仓库或日志。

## KV

分享只需要 KV，不需要 SQL、D1 或迁移脚本。推荐：

- Production 使用专用 `SHARE_KV` Namespace。
- Preview 使用不同的测试 Namespace，避免预览操作污染正式分享。
- `MAIL_READ_STATE_KV` 可以由两个站点共享，但不要与 `SHARE_KV` 混用到无法分清数据归属的程度。

仓库中的 `wrangler.toml` 只保留注释示例，不含真实 Namespace ID。Dashboard Git 部署会读取项目设置中的 binding。

## Preview 与 Production

两套环境的变量、Secret 和 binding 彼此独立。Production 配置正常不代表 Preview 正常。

预览分支上线前：

1. 在 Webmail Pages 的 Preview 环境设置 `MAIL_WORKER_BASE_URL`。
2. 设置 Preview 专用分享 Secret。
3. 绑定 Preview 专用 `SHARE_KV`。
4. 设置 `SHARE_ADMIN_CORS_ORIGINS` 为对应 Admin Preview origin。
5. 重新部署 Preview，再访问 `https://preview.example.com/api/runtime`。

确认以上内容后，本地可设置 `WEBMAIL_PREVIEW_RUNTIME_CONFIRMED=1`；该变量只是预检确认标记，不替代 Cloudflare 运行时配置。

## 直接上传

优先使用 GitHub 集成。确实需要 Wrangler Direct Upload 时：

```powershell
$env:ADMIN_PAGES_PROJECT_NAME = "loven7-mail-admin"
$env:WEBMAIL_PAGES_PROJECT_NAME = "loven7-mail-webmail"
npm --prefix apps/admin run build
node apps/admin/scripts/deploy-pages.mjs
npm --prefix apps/webmail run build
node apps/webmail/scripts/deploy-pages.mjs
```

两个安全包装脚本默认临时忽略本地 `wrangler.toml`，避免空白示例覆盖 Dashboard 已有 binding。只有明确维护完整本地 Wrangler 配置时，才设置 `ADMIN_USE_LOCAL_WRANGLER_CONFIG=1` 或 `WEBMAIL_USE_LOCAL_WRANGLER_CONFIG=1`。

## 运行时诊断

Webmail 提供只读 `/api/runtime`。它只输出布尔检查、缺失项和提示，不输出 Worker 地址或 Secret 原文。

```bash
WEBMAIL_RUNTIME_URL=https://webmail.example.com npm run check:cloudflare:runtime
```

正常结果应为 HTTP 200 且 `ok: true`。若分享仍异常，再检查：

- 变量是否写在正确的 Production/Preview 环境。
- 修改变量后是否重新部署。
- binding name 是否严格为 `SHARE_KV`。
- `SHARE_ADMIN_CORS_ORIGINS` 是否是 Admin origin，是否误写 Webmail origin。
- Secret 是否至少 32 字节且具有足够随机性。

## 常见故障

### 页面能打开，但 API 返回配置错误

静态构建成功不代表 Pages Functions 已配置。查看 `/api/runtime`，补齐缺失项并重新部署。

### Admin 返回 `missing_worker_base`

Admin Pages Production 缺少 `MAIL_WORKER_BASE_URL`，或该值只设置在 Preview。

### Admin 返回 `missing_admin_password`

Admin Pages Production 缺少 `ADMIN_PASSWORD` Secret。不要把密码放入前端连接参数或 `VITE_*`。

### 分享管理出现 CORS 错误

将 `SHARE_ADMIN_CORS_ORIGINS` 设置为 Admin 的完整 origin，例如 `https://admin.example.com`。不要加路径，不要使用 `*`。

### 新分享可用，旧分享不可读

启用 V2 后过早删除了旧 `SHARE_ENCRYPTION_SECRET`。恢复旧 Secret 以解密旧记录，完成迁移后再移除。

## 回滚

Cloudflare Dashboard → Pages 项目 → Deployments → 选择上一条已验证部署 → **Rollback to this deployment**。代码回滚不会恢复被删除或改写的 Secret/KV，因此变更运行时配置前应记录非敏感配置清单与回滚点。
