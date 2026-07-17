# 当前改动基线整理计划

更新时间：2026-06-25
目标：把当前混在一起的本地改动拆成可以理解、可以检查、可以提交、可以回滚的维护单元。

## 先不要整仓库一次性提交

当前工作区包含发布链路、后台账号体系、Webmail 用户接口、分享能力、视觉资源、样式和文档多类改动。不要直接运行：

```bash
git add .
git commit -m "update project"
```

这样会让后续维护很难回答三个问题：

1. 哪个改动导致线上行为变化。
2. 哪个改动只影响文档或部署。
3. 出问题时应该回滚哪一组。

正确做法是先分组，再逐组验证。

## 当前改动总览

当前 `git status --short --branch --untracked-files=all` 显示：

| 区域             | 状态                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `.github/`       | 部署 workflow 已修改                                                    |
| `scripts/`       | Cloudflare Pages 预检脚本已修改                                         |
| `docs/`          | 多份部署、交接、安全和优化文档已修改或新增                              |
| `apps/admin`     | 后台前端、Pages Functions、账号相关页面、视觉资源都有改动               |
| `apps/webmail`   | Webmail 前端、Pages Functions、用户 API、分享用户接口和视觉资源都有改动 |
| `.gitattributes` | 新增，用于统一换行和二进制文件规则                                      |
| `.gitignore`     | 已修改，用于本地产物和 secret 忽略规则                                  |

工作区还有 CRLF/LF 提示。`.gitattributes` 已经声明 `* text=auto eol=lf`，并把 `.png`、`.woff2` 等二进制文件标为 binary。后续提交时要把换行规则作为仓库卫生基线一起纳入，不要把它和业务功能混在一起解释。

## 推荐提交顺序

### 1. 仓库卫生和发布基线

这一组先提交。它不应该改变用户看到的业务行为，只负责让发布、检查和目录规则更可靠。

建议包含：

```text
.gitattributes
.gitignore
.github/workflows/deploy-cloudflare-pages.yml
apps/admin/wrangler.toml
scripts/check-cloudflare-pages-preflight.mjs
docs/OPERATIONS_RUNBOOK.md
docs/GITHUB_ACTIONS.md
docs/CLOUDFLARE_PAGES.md
docs/PROJECT_STRUCTURE.md
docs/PROJECT_OPTIMIZATION_REPORT.md
docs/CHANGE_BASELINE_PLAN.md
```

提交前检查：

```bash
npm run check:cloudflare
npm run check:release
```

自查重点：

| 检查                  | 标准                                                          |
| --------------------- | ------------------------------------------------------------- |
| GitHub Actions        | 正式仓库缺部署配置会失败，不再绿色跳过                        |
| 生产项目名            | `loven7-mail-pwa`、`cloudmail-webmail` 在文档和预检里清楚出现 |
| Webmail runtime probe | workflow 支持 `WEBMAIL_RUNTIME_URL`                           |
| Secret                | 没有真实 Token、密码、KV ID 写入文档                          |
| 换行规则              | `.gitattributes` 把文本和二进制文件边界说明清楚               |

### 2. 管理后台服务端代理和账号体系

这一组影响登录、权限、后台代理和服务端 secret 使用。它应该独立审查。

建议包含：

```text
apps/admin/functions/_lib/admin-proxy.ts
apps/admin/functions/admin/[[path]].ts
apps/admin/functions/api/[[path]].ts
apps/admin/functions/api/mail-state.ts
apps/admin/functions/open_api/[[path]].ts
apps/admin/functions/user/oauth2/callback.ts
apps/admin/functions/user_api/[[path]].ts
apps/admin/src/components/BackendLogin.tsx
apps/admin/src/lib/userAuth.ts
apps/admin/src/views/AccountConsole.tsx
apps/admin/src/lib/storage.ts
apps/admin/src/lib/constants.ts
apps/admin/src/lib/api.ts
apps/admin/src/App.tsx
apps/admin/src/components/AuthPanel.tsx
```

提交前检查：

```bash
npm --prefix apps/admin run lint
npm --prefix apps/admin run build
```

自查重点：

| 检查       | 标准                                                          |
| ---------- | ------------------------------------------------------------- |
| 管理员密码 | `ADMIN_PASSWORD` 只作为服务端 secret 使用，不进入前端构建变量 |
| 后台代理   | `/admin/*`、`/user_api/*`、`/open_api/*` 路由边界清楚         |
| 用户账号   | token 存储有作用域，不污染旧全局缓存                          |
| OAuth      | callback 不泄露 token，不把临时 state 长期留在 localStorage   |
| CORS       | 管理后台代理 CORS 后续需要收紧，不能把 `*` 当成最终状态       |

### 3. Webmail 用户能力和分享用户接口

这一组影响普通用户登录、用户地址、发件权限和分享用户视图。它应该和后台账号体系分开审查。

建议包含：

```text
apps/webmail/functions/_lib/user.ts
apps/webmail/functions/_lib/shareUser.ts
apps/webmail/functions/api/user/addresses/index.ts
apps/webmail/functions/api/user/login.ts
apps/webmail/functions/api/user/register.ts
apps/webmail/functions/api/user/settings.ts
apps/webmail/functions/api/user/verify-code.ts
apps/webmail/functions/api/user/open-settings.ts
apps/webmail/functions/api/user/oauth2/login-url.ts
apps/webmail/functions/api/user/oauth2/callback.ts
apps/webmail/functions/api/user/address/[id]/session.ts
apps/webmail/functions/api/user/address/[id]/send.ts
apps/webmail/functions/api/user/address/[id]/request-send-access.ts
apps/webmail/functions/api/share/user/[token].ts
apps/webmail/functions/api/share/user/list.ts
apps/webmail/functions/api/share/user/batch.ts
apps/webmail/src/api.ts
apps/webmail/src/auth.ts
apps/webmail/src/types.ts
apps/webmail/src/App.tsx
```

提交前检查：

```bash
npm --prefix apps/webmail run check:functions:headers
npm --prefix apps/webmail run check:functions:cors
npm --prefix apps/webmail run check:functions:image
npm --prefix apps/webmail run build
```

自查重点：

| 检查          | 标准                                                               |
| ------------- | ------------------------------------------------------------------ |
| 普通 JWT 登录 | 不被用户账号 session 破坏                                          |
| 分享访问      | 访客隐藏邮件仍然只隐藏分享视图，不删除真实邮件                     |
| CORS          | 管理分享接口和公开分享接口仍然区分 allowlist                       |
| 错误消息      | 不把 `MAIL_WORKER_BASE_URL` 等底层英文配置错误直接暴露给普通用户   |
| 类型          | 新增 API 的请求和响应类型集中在 `types.ts` 或 Functions normalizer |

### 4. 视觉资产和登录体验

这一组包含图片、字体、CSS 和登录页视觉改动。它需要单独看体积和引用情况。

当前未跟踪的大图中，最大的一批在 `apps/admin/public`，单张约 1.6 MB 到 2.7 MB。当前代码直接引用到：

```text
apps/admin/src/components/BackendLogin.tsx -> /loven7-anything-login-bg.png
apps/admin/src/index.css -> /fonts/loven7-brand-script-latin-v2.woff2
apps/webmail/src/styles.css -> /fonts/loven7-brand-script-latin-v2.woff2
apps/webmail/src/styles.css -> /loven7-portal-hero-v2.png
apps/webmail/index.html -> /loven7-portal-hero-v2.png
```

建议先只保留确定被使用的资源。其他封面图、风景图、设计图如果是素材库，应该先写清用途；如果只是生成备选图，先不要提交。

建议包含：

```text
apps/admin/public/fonts/*
apps/webmail/public/fonts/*
apps/admin/public/loven7-anything-login-bg.png
apps/webmail/public/loven7-portal-hero-v2.png
apps/admin/src/index.css
apps/webmail/src/styles.css
apps/admin/index.html
apps/webmail/index.html
apps/admin/src/components/BrandIcons.tsx
apps/admin/src/components/Shell.tsx
```

提交前检查：

```bash
npm run build
```

自查重点：

| 检查         | 标准                                     |
| ------------ | ---------------------------------------- |
| 图片引用     | 每张提交的大图都能说明在哪里被引用       |
| PWA precache | 大图不应无意进入后台 PWA precache        |
| 字体         | 后台和 Webmail 各自需要时再保留重复副本  |
| CSS 体积     | 后台主 CSS 当前约 356 KB，继续增长要拆分 |
| 移动端       | 登录页、底部导航、邮件详情不遮挡         |

### 5. 文档和 README 截图

这一组面向使用者和维护者，不应该和账号体系代码混在一起。

建议包含：

```text
README.md
apps/admin/README.md
docs/ENGINEER_HANDOFF.md
docs/SECURITY_DESENSITIZATION.md
apps/admin/preview-login.png
```

提交前检查：

```bash
npm run check:cloudflare
```

自查重点：

| 检查       | 标准                                            |
| ---------- | ----------------------------------------------- |
| 文档一致性 | 真实生产项目名和模板默认项目名不混淆            |
| 截图       | 图片真实存在，尺寸合理，不是临时截图            |
| Secret     | 不出现真实 Token、密码、Worker 私有地址或 KV ID |

## 不建议马上提交的内容

这些内容需要先确认用途：

```text
apps/admin/public/loven7-cover-*.png
apps/admin/public/loven7-designer-cover-*.png
apps/admin/public/loven7-landscape-*.png
apps/admin/public/loven7-login-generated-bg.png
apps/admin/public/loven7-admin-login-hero.png
apps/admin/preview-login.png
apps/webmail/public/loven7-portal-hero.png
```

原因：

1. 多数图片目前没有直接代码引用。
2. 单张文件较大，容易让仓库快速膨胀。
3. 如果它们是备用素材，应该移到文档资产、设计资产目录，或先保留在本地 ignored 目录。

如果确认要提交，先补一份资产清单，说明每张图的用途、页面、是否进入 precache。

## 建议的自我审查命令

每一组提交前都跑：

```bash
git status --short --branch --untracked-files=all
npm run check:cloudflare
```

涉及业务代码时跑：

```bash
npm run check:release
```

涉及线上验证时跑：

```powershell
$env:WEBMAIL_RUNTIME_URL="https://email.loven.qzz.io"
npm run check:cloudflare:runtime
```

提交前扫敏感信息：

```bash
rg -a -n --hidden -S "ghp_|CLOUDFLARE_API_TOKEN|ADMIN_PASSWORD|SHARE_ENCRYPTION_SECRET|MAIL_WORKER_BASE_URL|[a-f0-9]{32}" .github README.md docs apps scripts
```

命中文档变量名不一定是泄漏。真正要处理的是真实 token、真实密码、真实 Worker 私有地址和真实 KV ID。

## 下一步执行建议

先完成“仓库卫生和发布基线”这一组。它最独立，收益最大，风险最低。

完成后再审查“管理后台服务端代理和账号体系”。这组会碰权限和登录，必须严肃处理，不能和视觉资源一起提交。
