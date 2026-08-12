# GitHub Actions

仓库提供三条通用 workflow：

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/ci.yml` | PR、`main` push 与手动触发时运行脱敏、类型、测试、构建和 smoke 检查 |
| `.github/workflows/deploy-cloudflare-pages.yml` | CI 成功后或手动触发时，可选部署两个 Pages 项目 |
| `.github/workflows/release-assets.yml` | `v*` tag 或手动触发时生成源码包、Windows 一键启动器和校验文件 |

Fork 后不配置 Cloudflare Secrets/Variables，CI 仍会运行，部署步骤会安全跳过。手动触发部署但配置不完整时，workflow 会失败并列出缺失的变量名，不输出 Secret。

这条部署 workflow 只更新已经创建、已经配置运行时 Secret/KV 的 Pages 项目，不负责首次创建 Worker、D1、Pages、KV 或写入 Cloudflare 运行时配置。全新部署先运行 `npm run setup`；只有已经有兼容 Worker、只初始化前端时，才使用 [AI Agent Pages-only 部署指令](AGENT_DEPLOY_PROMPT.md) 或 [部署速查](DEPLOYMENT_QUICKSTART.md)。

## CI 门禁

CI 使用 Node.js 22，并执行：

```bash
npm --prefix apps/admin ci
npm --prefix apps/webmail ci
npm run check:public
npm run check:cloudflare
npm run test:installer
npm run test:frontend
npm run check:webmail
npm run build
npm run smoke
```

`check:public` 阻止常见私人域名、本机路径、真实部署项目名和内部生产材料进入公开分支。它是自动门禁，不替代人工安全审查。

## 启用自动部署

如果 Pages 项目已通过 Cloudflare Git 集成自动构建，不要再启用本 workflow 的 `AUTO_DEPLOY_PAGES`。两种持续部署入口选择一种即可，避免一次 `main` push 重复发布 Production。

在 Fork 的 **Settings → Secrets and variables → Actions** 配置：

### Secrets

| 名称 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 最小权限 Token，只允许目标账号的 Pages 部署 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID；按敏感信息管理，不写入文档 |

### Variables

| 名称 | 示例 | 说明 |
| --- | --- | --- |
| `ADMIN_PAGES_PROJECT_NAME` | `loven7-mail-admin` | 已存在的 Admin Pages 项目名 |
| `WEBMAIL_PAGES_PROJECT_NAME` | `loven7-mail-webmail` | 已存在的 Webmail Pages 项目名 |
| `WEBMAIL_RUNTIME_URL` | `https://webmail.example.com` | 部署后 `/api/runtime` 探针根地址 |
| `VITE_FRONTEND_LOGIN_BASE` | `https://webmail.example.com` | 可选；也可部署后在 Admin UI 保存 |
| `AUTO_DEPLOY_PAGES` | `false` | 可选；只有明确设为 `true` 才在 `main` CI 成功后自动部署 |

这些值只决定部署目标和探针。`MAIL_WORKER_BASE_URL`、`ADMIN_PASSWORD`、`SITE_PASSWORD`、`SHARE_ENCRYPTION_SECRET_V2`、`SHARE_ADMIN_CORS_ORIGINS` 和 KV binding 必须在 Cloudflare Pages 项目的 Production/Preview 环境中设置，不要复制到 Actions 日志或仓库。

## Cloudflare Token 权限

使用最小权限 Token，并限制到目标账号。部署 Pages 通常需要 Cloudflare Pages 编辑权限；创建/绑定 KV 时需要相应 KV 编辑权限。不要使用 Global API Key。

Token 创建后直接写入 GitHub Secret；不要把它放进命令参数、截图、聊天或临时文件。Agent 自动配置时必须使用安全 Secret API，否则让用户在网页控制台手动填写。

## 首次启用步骤

1. 先在 Cloudflare 创建两个 Pages 项目，确认项目名与 Root directory。
2. 在 Cloudflare 配置两个项目的运行时 Secret 与 Webmail `SHARE_KV`。
3. 在 GitHub 添加上面的两项 Secrets 和必需 Variables；首次部署保持 `AUTO_DEPLOY_PAGES=false`。
4. 打开 Actions → **Deploy to Cloudflare Pages** → **Run workflow**。
5. 查看两个部署步骤与 Webmail runtime probe。
6. 只有 workflow 与 `/api/runtime` 都通过后，才把自动部署视为可用。

已有 Worker 且需要 Agent 执行 Pages-only 部署时，请直接使用 [AI Agent Pages-only 部署指令](AGENT_DEPLOY_PROMPT.md)，不要另写包含 Token 或密码的 Prompt。

## 工作流行为

- 默认只允许手动部署；只有 `AUTO_DEPLOY_PAGES=true` 时，`main` 的 `Build & Validate` 成功后才自动部署。
- 配置齐全时部署；未配置时自动 push 场景只构建并跳过部署。
- 手动触发会验证所选项目所需配置，缺失时快速失败。
- Admin 与 Webmail 使用同一个固定 concurrency group，避免两个 commit 交错覆盖。
- 部署脚本接受任意合法 Pages 项目名，不绑定维护者的自用资源。

## Runtime 探针

部署 Webmail 后执行：

```bash
npm run check:cloudflare:runtime
```

脚本读取 `WEBMAIL_RUNTIME_URL` 并访问 `/api/runtime`。只报告配置状态，不读取 Secret。若变量缺失或端点不完整，workflow 应失败，避免“静态页面上线成功”被误认为分享功能可用。

## Release

发版前更新 `CHANGELOG.md` 和版本号。创建 `vMAJOR.MINOR.PATCH` tag 后，Release workflow 只应打包公开源码。详细规则见 [版本策略](VERSIONING.md) 与 [脱敏检查](SECURITY_DESENSITIZATION.md)。
