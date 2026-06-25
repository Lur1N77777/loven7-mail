# 管理后台 PWA（apps/admin）

这是 Loven7 Mail Cloudflare Suite 的管理员后台前端，基于 Cloudflare Temp Mail / `cloudflare_temp_email` 上游 Worker 管理接口。

## 功能

- 管理员/站点认证：`x-admin-auth`、`x-custom-auth`、用户管理员 `x-user-access-token`，支持 Turnstile `cf_token`。
- 仪表盘统计、地址管理、用户管理、系统设置、发件权限、维护工具。
- 收件箱、未知邮件、发件箱：HTML 邮件沙箱渲染、验证码识别、品牌头像、附件/EML 下载、移动端手势。
- 单邮箱/多邮箱分享入口与共享链接管理。

## 部署到 Cloudflare Pages

- Root directory: `apps/admin`
- Build command: `npm ci && npm run build`
- Output directory: `dist`

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE` | 生产建议留空。留空时管理后台请求同域 Pages Functions，再由服务端代理到上游 Worker，避免在前端暴露管理员密码。 |
| `VITE_FRONTEND_LOGIN_BASE` | 可留空。用户站 URL，可部署后在“系统设置 → 前端登录链接前缀”里保存。 |
| `VITE_APP_NAME` | 显示名，默认 `Loven7-Mail`。 |
| `MAIL_WORKER_BASE_URL` | Cloudflare Pages 运行时变量/secret。上游 Temp Mail Worker/API 根地址。 |
| `ADMIN_PASSWORD` | Cloudflare Pages Production secret。管理员账号访问 `/admin/*` 时由 Pages Function 在服务端注入，绝不能写进前端环境变量或仓库。 |
| `SITE_PASSWORD` | 可选 Cloudflare Pages secret。上游 Worker 开启站点密码时填写。 |
| `MAIL_READ_STATE_KV` | 可选 KV 绑定。用于跨设备同步管理后台邮件已读/星标状态；公开仓库不要提交真实 KV Namespace ID。 |

## 本地运行

```bash
npm ci
npm run dev
```

## 构建检查

```bash
npm run lint
npm run build
```
