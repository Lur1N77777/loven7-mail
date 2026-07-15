# 项目结构与维护边界

这份文档规定仓库里每类文件应该放在哪里。目标是让根目录保持干净，让后续维护者能快速判断改动入口。

## 根目录契约

根目录只保留项目入口和横向能力：

| 路径                                          | 用途                         |
| --------------------------------------------- | ---------------------------- |
| `.github/`                                    | GitHub Actions 和仓库自动化  |
| `apps/`                                       | 可独立构建和部署的应用       |
| `docs/`                                       | 部署、维护、交接和截图文档   |
| `scripts/`                                    | 根级检查、发布、部署辅助脚本 |
| `package.json`                                | 跨应用脚本聚合               |
| `README.md`                                   | 面向使用者的项目说明         |
| `CONTRIBUTING.md` / `SECURITY.md` / `LICENSE` | 协作、安全和许可             |

不要把临时日志、备份摘要、实验截图、打包产物或私人配置放在根目录。需要临时保留的本地产物放进 `.codex-dev-logs/`、`tmp/` 或对应应用的本地 ignored 目录。

## 应用目录

### `apps/admin`

管理后台 PWA。这里放后台前端、后台专用 Pages Functions 和后台静态资源。

| 路径              | 放置内容                                                 |
| ----------------- | -------------------------------------------------------- |
| `src/App.tsx`     | 全局状态、路由、凭据、主题、移动端页面切换               |
| `src/views/`      | 后台页面级模块，例如地址、用户、邮件、设置               |
| `src/components/` | Shell、登录面板、通用后台组件                            |
| `src/lib/`        | API 客户端、本地存储、认证、邮件解析、品牌头像等后台工具 |
| `src/types/`      | 后台 API 类型                                            |
| `functions/`      | 后台 Pages Functions，主要用于代理上游 Worker 或后台状态 |
| `public/`         | 后台 favicon、PWA 图标、字体和登录/封面图片              |
| `scripts/`        | 后台本地 smoke 或发布辅助脚本                            |

新增后台页面时，优先改 `src/views/`、`src/components/Shell.tsx`、`src/App.tsx`。不要在多个页面重复写请求认证头，统一走 `src/lib/api.ts`。

### `apps/webmail`

用户邮箱站和分享站。这里放用户站前端、用户站 Pages Functions BFF 和用户站静态资源。

| 路径                | 放置内容                                          |
| ------------------- | ------------------------------------------------- |
| `src/App.tsx`       | 登录、邮箱列表、阅读器、分享邮箱切换、自动刷新    |
| `src/api.ts`        | 前端同源 `/api/*` 调用封装                        |
| `src/auth.ts`       | JWT / session 读取和保存                          |
| `src/mailParser.ts` | 用户站邮件解析、HTML 清洗、验证码提取             |
| `src/styles.css`    | 用户站视觉系统                                    |
| `functions/_lib/`   | Pages Functions 公共库，例如 HTTP、分享、用户认证 |
| `functions/api/`    | 用户站 API 路由                                   |
| `public/`           | 用户站 favicon、字体和门户图片                    |
| `scripts/`          | 用户站部署和 Functions 检查脚本                   |

新增用户站 API 时，优先复用 `functions/_lib/http.ts` 的响应头、CORS、上游请求和错误映射。分享相关逻辑优先集中在 `functions/_lib/share.ts`。

## 文档目录

| 路径                                  | 用途                                        |
| ------------------------------------- | ------------------------------------------- |
| `docs/ENGINEER_HANDOFF.md`            | 工程师交接和功能修改路线                    |
| `docs/PROJECT_STRUCTURE.md`           | 目录边界和维护约定                          |
| `docs/DEPLOYMENT_QUICKSTART.md`       | 最短部署路径                                |
| `docs/CLOUDFLARE_PAGES.md`            | Cloudflare Pages、Preview、KV、runtime 排错 |
| `docs/GITHUB_ACTIONS.md`              | CI/CD 配置                                  |
| `docs/CONFIGURATION_BOUNDARY.md`      | 公开源码与私有部署配置的长期边界            |
| `docs/VERSIONING.md`                  | 版本、兼容、升级与回滚策略                  |
| `docs/SECURITY_DESENSITIZATION.md`    | 发布前脱敏检查                              |
| `docs/screenshots/`                   | README 和文档引用截图                       |
| `docs/assets/`                        | 文档专用图片、logo 和图标                   |

面向用户的短说明放 `README.md`；面向维护者的细节放 `docs/`；不要把临时分析报告散落到根目录。

## 本地-only 与忽略规则

这些路径和文件不应提交：

| 模式                                                    | 说明                    |
| ------------------------------------------------------- | ----------------------- |
| `node_modules/`                                         | 依赖安装产物            |
| `dist/` / `dist-release/` / `release-cloudflare-pages/` | 构建和发布产物          |
| `.wrangler/`                                            | Wrangler 本地状态       |
| `wrangler.local.toml`                                   | 本地 Wrangler 私有配置  |
| `.dev.vars*` / `.env*`                                  | 本地运行时变量和 secret |
| `.codex-dev-logs/`                                      | 本地调试日志和整理归档  |
| `_backup_*.json` / `_backup_*.log`                      | 本地备份摘要和日志      |
| `qa-shots/` / `tmp/`                                    | 临时验证材料            |
| `apps/admin/*.png`                                      | 后台根目录 UI 验证截图  |

如果需要保留一次性的诊断输出，放进 `.codex-dev-logs/`；如果需要提交长期说明，把它整理成 `docs/` 下的文档。

## 新增文件放置规则

| 新增内容                 | 推荐位置                                              |
| ------------------------ | ----------------------------------------------------- |
| 后台页面                 | `apps/admin/src/views/`                               |
| 后台通用组件             | `apps/admin/src/components/`                          |
| 后台请求、缓存、认证工具 | `apps/admin/src/lib/`                                 |
| 用户站页面体验           | `apps/webmail/src/App.tsx` 或拆入 `apps/webmail/src/` |
| 用户站 API route         | `apps/webmail/functions/api/`                         |
| 用户站 API 公共逻辑      | `apps/webmail/functions/_lib/`                        |
| 跨应用部署脚本           | `scripts/`                                            |
| 单应用脚本               | 对应应用的 `scripts/`                                 |
| 文档截图                 | `docs/screenshots/`                                   |
| 前端公开图片和字体       | 对应应用的 `public/`                                  |

当前仓库没有共享 package。后台和用户站都有同名逻辑时，先确认是否确实需要保持双份；如果只是小型映射或运行时差异，维持双份通常比临时抽 package 更稳。

## 提交前检查

常规改动建议从根目录运行：

```bash
npm run check:public
npm run check:cloudflare
npm --prefix apps/admin run lint
npm --prefix apps/webmail exec -- tsc -p tsconfig.json
npm --prefix apps/webmail run check:functions:headers
npm --prefix apps/webmail run check:functions:cors
npm --prefix apps/webmail run check:functions:image
```

涉及构建或发布时再运行：

```bash
npm run build
```

提交前再看一眼：

```bash
git status --short
```

如果出现根目录临时文件，优先移动到 `.codex-dev-logs/` 或 `tmp/`；如果出现真实 Token、密码、Worker 私有地址或 KV ID，先按 `docs/SECURITY_DESENSITIZATION.md` 脱敏。
