# 生产运维 Runbook

这份文档记录当前生产资产、发布步骤、验证方式和回滚路径。以后维护项目时，先按这里确认基线，再改业务代码。

## 当前生产资产

| 用途            | Cloudflare Pages 项目 | 生产域名                     | 部署方式                               |
| --------------- | --------------------- | ---------------------------- | -------------------------------------- |
| 管理后台        | `loven7-mail-pwa`     | `https://mail.loven7.cc.cd`  | Wrangler Pages deploy / GitHub Actions |
| 用户站 / 分享站 | `cloudmail-webmail`   | `https://email.loven.qzz.io` | Wrangler Pages deploy / GitHub Actions |

GitHub 仓库：

```text
https://github.com/Lur1N77777/loven7-mail-cloudflare-suite
```

Cloudflare KV：

| Namespace title             | Binding              | 用途                   |
| --------------------------- | -------------------- | ---------------------- |
| `loven7_mail_read_state`    | `MAIL_READ_STATE_KV` | 管理后台已读和星标状态 |
| `loven7_mail_share`         | `SHARE_KV`           | 用户站生产分享数据     |
| `loven7_mail_share_preview` | `SHARE_KV`           | 用户站预览分享数据     |

不要把 KV Namespace ID、Worker 私有地址、管理员密码、Cloudflare Token、分享加密密钥写进仓库、文档或 Actions 日志。

## 使用 GitHub Actions 发布生产

推荐让 GitHub `main` 成为生产发布事实源。

先在 GitHub 仓库设置：

```text
Settings -> Secrets and variables -> Actions
```

Repository secrets：

| Secret                  | 说明                                          |
| ----------------------- | --------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token，至少需要 Pages 部署权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID                         |

Repository variables：

| Variable                     | 当前生产值                   |
| ---------------------------- | ---------------------------- |
| `ADMIN_PAGES_PROJECT_NAME`   | `loven7-mail-pwa`            |
| `WEBMAIL_PAGES_PROJECT_NAME` | `cloudmail-webmail`          |
| `WEBMAIL_RUNTIME_URL`        | `https://email.loven.qzz.io` |
| `VITE_FRONTEND_LOGIN_BASE`   | `https://email.loven.qzz.io` |

发布前在本地运行：

```bash
git status --short --branch --untracked-files=all
npm run check:release
```

确认本地改动都已经解释清楚，再推送：

```bash
git push origin main
```

`Deploy to Cloudflare Pages` workflow 会：

1. 校验正式仓库的 Cloudflare 部署配置。
2. 构建 `apps/admin`。
3. 上传管理后台到 `loven7-mail-pwa`。
4. 构建并检查 `apps/webmail`。
5. 上传用户站到 `cloudmail-webmail`。
6. 如果设置了 `WEBMAIL_RUNTIME_URL`，运行线上 runtime probe。

如果正式仓库缺少 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_PAGES_PROJECT_NAME` 或 `WEBMAIL_PAGES_PROJECT_NAME`，workflow 会失败。这样能避免“构建成功但没有上线”的绿色假象。

## 使用 Direct Upload 应急发布

只有在 GitHub Actions 不可用，或者你明确需要本地应急发布时才用 Direct Upload。

发布管理后台：

```powershell
cd D:\files\Aitest4\loven7-mail-pwa-1\apps\admin
npm run build
npx --yes wrangler@latest pages deploy dist --project-name loven7-mail-pwa --branch main
```

发布用户站：

```powershell
cd D:\files\Aitest4\loven7-mail-pwa-1\apps\webmail
$env:WEBMAIL_PAGES_PROJECT_NAME="cloudmail-webmail"
npm run deploy
```

`apps/webmail/scripts/deploy-pages.mjs` 默认会临时忽略本地 `wrangler.toml`，避免本地示例 KV 配置覆盖 Cloudflare Pages 控制台里的真实变量、secret 和绑定。只有确认要用本地 Wrangler 配置替换项目绑定时，才设置：

```powershell
$env:WEBMAIL_USE_LOCAL_WRANGLER_CONFIG="1"
```

应急发布也要记录：

```bash
git rev-parse --short HEAD
git status --short
```

如果工作区不干净，在发布记录里说明哪些本地改动一起进入了这次上传。

## 发布后验证

Webmail runtime probe：

```powershell
$env:WEBMAIL_RUNTIME_URL="https://email.loven.qzz.io"
npm run check:cloudflare:runtime
```

期望结果：

| 检查                       | 期望                        |
| -------------------------- | --------------------------- |
| 页面 HTML                  | `ok=true`                   |
| `/api/runtime`             | `available=true`，`ok=true` |
| `MAIL_WORKER_BASE_URL`     | true                        |
| `SHARE_KV`                 | true                        |
| `SHARE_ENCRYPTION_SECRET`  | true                        |
| `SHARE_ADMIN_CORS_ORIGINS` | true                        |
| 分享缺失 token             | `share_not_found`           |
| 假账号登录                 | `invalid_login`             |

人工抽查：

1. 打开 `https://mail.loven7.cc.cd`。
2. 打开 `https://email.loven.qzz.io`。
3. 在管理后台确认连接状态和前端登录链接前缀。
4. 从地址管理复制一个用户站登录链接并打开。
5. 创建一个分享链接，确认 Webmail 能访问。

## 回滚生产部署

优先使用 Cloudflare Pages 控制台回滚：

```text
Cloudflare Dashboard -> Workers & Pages -> 对应 Pages 项目 -> Deployments
```

选择上一个已知正常的 Production deployment，然后点 **Rollback to this deployment**。

需要同时回滚两个项目时，顺序建议：

1. 先回滚 Webmail `cloudmail-webmail`。
2. 跑 `npm run check:cloudflare:runtime`。
3. 再回滚 Admin `loven7-mail-pwa`。
4. 手动确认后台生成的用户站链接仍指向 `https://email.loven.qzz.io`。

不要通过改代码再推一次来充当回滚，除非已经确认旧部署不可用或必须热修。

## 常见故障

### GitHub Actions 构建成功但部署失败

先看 `Validate Cloudflare deploy configuration` 步骤。如果缺配置，补齐 GitHub Secrets/Variables 后重新运行 workflow。

### Webmail 显示邮箱 API 未配置

检查 `cloudmail-webmail` 的 Production 环境变量：

```text
MAIL_WORKER_BASE_URL
```

修改后重新部署，再跑 runtime probe。

### 分享接口提示 KV 或 secret 未配置

检查 `cloudmail-webmail` 的 Production 设置：

```text
SHARE_KV
SHARE_ENCRYPTION_SECRET
```

Preview 和 Production 的变量、secret、KV 绑定是分开的。只修 Production 不会自动修 Preview。

### 管理后台创建分享时 CORS 失败

在 `cloudmail-webmail` 的 Production 变量里确认：

```text
SHARE_ADMIN_CORS_ORIGINS=https://mail.loven7.cc.cd
```

这里填管理后台 origin，不是用户站 URL，也不要填 `*`。

### Direct Upload 后发现版本不对

先记录当前部署 ID，再回滚到上一个 Production deployment。然后回到本地确认：

```bash
git status --short --branch --untracked-files=all
git rev-parse --short HEAD
```

找出 Direct Upload 时是否包含了未提交改动。确认清楚后再重新发布。
