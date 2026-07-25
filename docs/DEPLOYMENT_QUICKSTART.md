# 部署速查

这是一页式清单。前提是你已经有一个兼容 Cloudflare Temp Mail / `cloudflare_temp_email` API 的 Worker。

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

需要 Agent 自动完成时，完整复制 [AI Agent 部署指令](AGENT_DEPLOY_PROMPT.md)。该指令要求 Agent 把两个站点作为一个连续任务执行，只在登录、平台 Secret 输入和真实账号验收时暂停。详细排错见 [Cloudflare Pages 部署说明](CLOUDFLARE_PAGES.md)。
