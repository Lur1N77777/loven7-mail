# 部署速查

第一次部署不要只看速查表，请按 [Loven7 Mail 小白完整部署教程](BEGINNER_GUIDE.md) 操作。域名还没有托管到 Cloudflare 时，先完成 [Cloudflare 域名与邮箱路由教程](CLOUDFLARE_DOMAIN_AND_EMAIL.md)。

## 新手首选：一条命令

Windows 用户可以直接下载并双击 [Install-Loven7-Mail.cmd](https://github.com/Lur1N77777/loven7-mail/releases/latest/download/Install-Loven7-Mail.cmd)，不需要先克隆 GitHub 仓库。启动器会自动获取校验过的正式版本、准备 Node.js 22，并在从零部署时按需下载官方 MinGit 便携版，然后进入 Cloudflare OAuth 登录。已有 Worker 接入不要求 Git。

准备 Node.js 22+，克隆或 Fork 仓库后运行：

```bash
npm run setup
```

选择已有 Worker 时，安装器会接入它；选择没有 Worker 时，可以输入一个或多个邮箱域名（逗号分隔，第一个为默认域名），安装器会从锁定并校验的兼容后端 `v1.10.0` 创建 Worker、D1、首个管理员、两个 Pages 项目和两个 KV。密码不落盘，失败后可运行同一命令安全续装。

只预览资源和步骤：

```bash
npm run setup:plan
node scripts/installer/cli.mjs --plan --new-worker --domains mail.example.net,second.example.net
```

完整说明见 [新手安装器](INSTALLER.md)。安装器显示“应用基础设施部署完成”后，仍需对每个域名按 [Email Routing 收件配置](EMAIL_ROUTING.md) 启用 Email Routing、确认邮件 DNS，并将 Catch-all 指向安装器 Worker。真实外部邮件投递成功后才算完整可用。

安装器默认覆盖收件、Admin、Webmail、分享和已读/星标同步。发件需要额外配置 Resend、SMTP 或 Cloudflare Send Email，不会因一条命令安装自动启用。

## 人工部署（已有 Worker）

下面是一页式人工清单，前提是你已经有一个兼容 Cloudflare Temp Mail / `cloudflare_temp_email` API 的 Worker。

## 两个 Pages 项目

在 Cloudflare Pages 中导入同一个 GitHub Fork 两次：

| 项目 | Root directory | Build command | Output |
| --- | --- | --- | --- |
| Admin | `apps/admin` | `npm ci && npm run build` | `dist` |
| Webmail | `apps/webmail` | `npm ci && npm run build` | `dist` |

推荐通用项目名：`loven7-mail-admin` 和 `loven7-mail-webmail`。可以自定义，但两个项目不能同名。

首次部署推荐使用 Cloudflare Pages GitHub 集成。不要同时启用 Cloudflare Git 自动构建和仓库中的 `AUTO_DEPLOY_PAGES`，否则同一次提交可能触发两套 Production 部署。

## Admin Production

在 **Settings → Variables and Secrets** 设置：

- Secret `MAIL_WORKER_BASE_URL`：邮件 Worker 根地址。
- Secret `ADMIN_PASSWORD`：Worker 管理员密码。
- Secret `SITE_PASSWORD`：仅在 Worker 开启站点密码时设置。

不要设置 `VITE_API_BASE`，不要把密码写成 `VITE_` 变量。

## Webmail Production

设置：

- Secret `MAIL_WORKER_BASE_URL`：与 Admin 相同的 Worker。
- Secret `SITE_PASSWORD`：可选。
- Secret `SHARE_ENCRYPTION_SECRET_V2`：至少 32 字节的高熵随机值。
- Variable `SHARE_ADMIN_CORS_ORIGINS`：Admin origin，例如 `https://admin.example.com`；禁止 `*`。
- KV binding `SHARE_KV`：分享功能必需。

`SHARE_ENCRYPTION_SECRET` 只用于兼容旧的无 `kid` 分享记录。新部署使用 V2 即可；轮换时先新增 V2，保留旧 Secret 到旧记录迁移完成。

可选：给两个项目绑定同一个 KV Namespace，binding name 均为 `MAIL_READ_STATE_KV`，用于跨站同步已读/星标状态。

## 一次跑完的顺序

1. 创建或核实两个 Pages 项目，并为已有项目记录当前 Production 部署 ID 作为回滚点。
2. 配置 Admin Secret，先部署 Admin，等构建成功后记录实际 Production origin。
3. 配置 Webmail Secret 与 `SHARE_KV`，再把 Admin 的实际 origin 写入 `SHARE_ADMIN_CORS_ORIGINS`。
4. 部署 Webmail，并针对这次新部署运行 `/api/runtime` 探针。
5. 完成 Admin 登录和无痕分享验收；无法自动验证的项目明确留给部署者确认。

如果 Pages 在运行时配置完成前已经自动构建，配置完成后必须重新部署。页面能打开不代表 Functions 已拿到新的 Secret 或 KV binding。

## 验收

1. 确认上述两个最新 Production 部署均已成功。
2. 打开 `https://webmail.example.com/api/runtime`，确认 HTTP 200 且 `ok` 为 `true`。
3. 登录 Admin，确认仪表盘、收件箱和地址列表能加载。
4. 在 Admin 设置 Webmail URL。
5. 创建分享并在无痕窗口打开。

`/api/runtime` 只返回配置是否存在，不返回 Secret 原文。若 `ok` 为 `false`，按 `missing` 与 `hints` 修复后重新部署。

## Preview

Cloudflare 的 Preview 和 Production 配置互不继承。要测试完整 Preview 功能，必须在 Preview 中重复配置变量、Secret 与 KV；确认后才设置 `WEBMAIL_PREVIEW_RUNTIME_CONFIRMED=1` 运行本地预检。

## 本地检查

```bash
npm --prefix apps/admin ci
npm --prefix apps/webmail ci
npm run check:public
npm run check:release
```

部署后探针：

```bash
WEBMAIL_RUNTIME_URL=https://webmail.example.com npm run check:cloudflare:runtime
```

PowerShell：

```powershell
$env:WEBMAIL_RUNTIME_URL = "https://webmail.example.com"
npm run check:cloudflare:runtime
```

已有兼容 Worker、只需要部署两个前端时，可以复制 [AI Agent Pages-only 部署指令](AGENT_DEPLOY_PROMPT.md)。首次完整 Worker/D1 部署仍应运行 `npm run setup`。详细排错见 [Cloudflare Pages 部署说明](CLOUDFLARE_PAGES.md)。
