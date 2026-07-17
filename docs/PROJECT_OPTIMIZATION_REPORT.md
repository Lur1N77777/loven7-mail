# Loven7 Mail Cloudflare Suite 项目优化报告

更新时间：2026-06-25
审计范围：当前本地工作区、GitHub 仓库、GitHub Actions、Cloudflare Pages 项目、Webmail 线上运行时探针。
目标读者：后续接手维护这个项目的工程师和发布负责人。

## 结论先行

这个项目已经具备比较完整的工程骨架：两个应用边界清楚，Cloudflare Pages Functions 的安全头、CORS、运行时诊断、图片代理检查都已经有自动化校验，Webmail 线上运行时也处于健康状态。它不是一个“需要推倒重来”的项目。

真正需要优先优化的是发布治理和可维护性：

| 优先级 | 问题                                                  | 影响                                               | 建议                                                                           |
| ------ | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| P0     | 本地、GitHub、Cloudflare 三份状态容易不一致           | 线上版本来源不够可追溯，后续维护容易覆盖或漏发改动 | 先建立发布基线，让 GitHub `main` 成为唯一事实源，或把 Direct Upload 流程显式化 |
| P0     | GitHub Actions 部署 workflow 当前会成功但跳过真正部署 | 绿色状态容易被误认为已经上线                       | 配齐 Actions Secrets/Variables，并增加部署后 runtime probe                     |
| P1     | 大文件和大组件过多                                    | 改动时认知成本高，移动端和分享逻辑容易回归         | 分阶段拆 `AddressView`、`MailWorkspace`、Webmail `App` 和后台 CSS              |
| P1     | 类型边界仍有不少 `any` 和上游 shape 容错散落          | 上游接口变化时错误会延迟到运行时暴露               | 建立 DTO normalizer 和共享类型约定                                             |
| P1     | 管理后台代理和浏览器凭据策略需要继续收敛              | 管理员入口和跨源头部更敏感                         | 收紧 admin proxy CORS，逐步减少浏览器侧管理员密码依赖                          |
| P2     | 视觉资产、性能预算、观测文档还可以标准化              | 长期迭代会增加资源体积和排障成本                   | 增加资产清单、bundle budget、日志和回滚 runbook                                |

建议先做 P0，不要先重构页面。现在最重要的是确定“什么代码对应线上”，再开始拆模块和优化体验。

## 当前系统画像

项目是一个 monorepo，包含两个独立部署的 Cloudflare Pages 应用：

| 子项目          | 路径           | 技术栈                                                  | 职责                                             |
| --------------- | -------------- | ------------------------------------------------------- | ------------------------------------------------ |
| 管理后台 PWA    | `apps/admin`   | React、TypeScript、Vite、Tailwind、PWA、Pages Functions | 管理地址、用户、邮件、设置、维护工具、分享链接   |
| 用户站 / 分享站 | `apps/webmail` | React、TypeScript、Vite、Pages Functions                | JWT 登录、用户邮箱、分享访问、图片代理、分享 API |

根目录脚本已经聚合了核心检查：

```bash
npm run check:cloudflare
npm run lint:admin
npm run check:webmail
npm run build
npm run check:release
```

`npm run check:release` 在本次审计中通过，包含 Cloudflare 预检、后台 TypeScript 检查、Webmail Functions 检查，以及两个应用构建。

## 当前远端与上线状态

GitHub 仓库：

| 项                              | 当前值                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| 仓库                            | `https://github.com/Lur1N77777/loven7-mail-cloudflare-suite` |
| 可见性                          | Public                                                       |
| 默认分支                        | `main`                                                       |
| 当前本地 `HEAD` / `origin/main` | `fbe920c`                                                    |
| GitHub Secrets                  | 当前为空                                                     |
| GitHub Variables                | 只有 `VITE_FRONTEND_LOGIN_BASE=https://email.loven.qzz.io`   |

Cloudflare Pages：

| 用途     | Pages 项目          | 域名                                                | Git Provider | 最新生产部署                           |
| -------- | ------------------- | --------------------------------------------------- | ------------ | -------------------------------------- |
| 管理后台 | `loven7-mail-pwa`   | `loven7-mail-pwa.pages.dev`、`mail.loven7.cc.cd`    | No           | Production / `main` / Source `fbe920c` |
| 用户站   | `cloudmail-webmail` | `cloudmail-webmail.pages.dev`、`email.loven.qzz.io` | No           | Production / `main` / Source `fbe920c` |

这说明 Cloudflare 当前不是直接从 GitHub 自动拉代码，而是使用 Wrangler Direct Upload。GitHub Actions 的最新 Deploy workflow 虽然成功，但两个上传步骤都被跳过：

| 步骤                               | 当前结论 |
| ---------------------------------- | -------- |
| Build admin                        | 成功     |
| Deploy admin to Cloudflare Pages   | skipped  |
| Build webmail                      | 成功     |
| Deploy webmail to Cloudflare Pages | skipped  |

跳过原因是缺少：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PAGES_PROJECT_NAME
WEBMAIL_PAGES_PROJECT_NAME
```

Webmail 线上 runtime 探针通过：

| 检查项                     | 结果                    |
| -------------------------- | ----------------------- |
| 页面 HTML                  | 200                     |
| `/api/runtime`             | available=true，ok=true |
| `MAIL_WORKER_BASE_URL`     | 已配置                  |
| `SHARE_KV`                 | 已绑定                  |
| `SHARE_ENCRYPTION_SECRET`  | 已配置                  |
| `SHARE_ADMIN_CORS_ORIGINS` | 已配置                  |
| `SITE_PASSWORD`            | 可选缺失                |
| 分享缺失 token 探针        | 返回 `share_not_found`  |
| 假登录探针                 | 返回 `invalid_login`    |

## 本地工作区状态

当前工作区不是干净状态。存在大量已修改和未跟踪文件，包括后台 Pages Functions、新增登录背景资源、Webmail 用户 API、`docs/PROJECT_STRUCTURE.md` 等。

这不是错误，但它改变了维护策略：

1. 任何维护前都要先确认哪些本地改动应该保留。
2. 不要直接用“当前本地目录”覆盖线上，除非已经跑完检查并确认这些改动就是要上线的版本。
3. 优化工作开始前最好先做一个基线提交，或者至少生成一份明确的“本地改动清单”。

推荐基线动作：

```bash
git status --short --branch --untracked-files=all
npm run check:release
```

如果要开始正式维护，建议先把当前本地改动分成几类：

| 类别                           | 处理方式                             |
| ------------------------------ | ------------------------------------ |
| 已确认功能改动                 | 整理成一次或多次 commit              |
| 文档和部署说明                 | 单独 commit，便于回滚                |
| 生成图片、字体、截图           | 检查是否真要进入仓库，确认大小和引用 |
| 临时验证产物                   | 移入 ignored 目录或删除              |
| 私有配置、真实 ID、真实 secret | 绝不提交                             |

## 已经做得好的地方

### 应用边界清楚

`apps/admin` 和 `apps/webmail` 的职责分离是合理的。后台承担管理视图和上游管理接口，Webmail 承担普通用户、分享访问者和 Pages Functions BFF。这个边界后续应该继续保留。

### Webmail Functions 有较成熟的安全基础

`apps/webmail/functions/_lib/http.ts` 已经集中处理：

- 安全响应头。
- no-store JSON 响应。
- CORS allowlist。
- 上游 Worker 请求封装。
- 运行时配置错误映射。
- 上游错误消息清洗。

这比在每个 route 里散写 `fetch()` 和 headers 更可维护。

### 分享数据没有明文裸存

`apps/webmail/functions/_lib/share.ts` 使用 AES-GCM 加密 KV payload，并区分 summary 索引和完整 payload。summary 不包含 JWT，这一点对分享功能很重要。

### 图片代理有 SSRF 防护意识

`apps/webmail/functions/api/image.ts` 有 host 校验、私网/IP 阻断、redirect 限制、大小限制和 MIME sniffing。对应的 `check:functions:image` 也覆盖了主要风险路径。

### 发布前检查已经成体系

根目录的 `check:release` 能覆盖：

- Cloudflare Pages 配置预检。
- 管理后台 TypeScript。
- Webmail Functions headers/CORS/image 检查。
- 两个应用构建。

本次运行结果是通过的。这给后续优化提供了一个可用的安全网。

## P0 优化：先让发布链路可追溯

### 让 GitHub `main` 成为唯一事实源

当前最容易出事故的点是：GitHub Actions 看起来成功，Cloudflare 也有线上部署，但真正的上传并不是 Actions 完成的。后续工程师如果只看 GitHub 绿色状态，会误以为 push 到 `main` 已经自动上线。

建议选择一种明确策略。

推荐策略：GitHub Actions 负责生产发布。

需要在 GitHub Actions 配置：

```text
Secrets:
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID

Variables:
ADMIN_PAGES_PROJECT_NAME=loven7-mail-pwa
WEBMAIL_PAGES_PROJECT_NAME=cloudmail-webmail
VITE_FRONTEND_LOGIN_BASE=https://email.loven.qzz.io
```

然后把上线流程固定为：

```bash
npm run check:release
git push origin main
```

GitHub Actions 成功后再运行：

```powershell
$env:WEBMAIL_RUNTIME_URL="https://email.loven.qzz.io"
npm run check:cloudflare:runtime
```

如果短期继续用 Direct Upload，也要把它写成明确 runbook：

```powershell
cd D:\files\Aitest4\loven7-mail-pwa-1\apps\admin
npm run build
npx --yes wrangler@latest pages deploy dist --project-name loven7-mail-pwa --branch main

cd D:\files\Aitest4\loven7-mail-pwa-1\apps\webmail
$env:WEBMAIL_PAGES_PROJECT_NAME="cloudmail-webmail"
npm run deploy
```

Direct Upload 不是不能用，但必须有规则：部署前本地必须干净或有明确说明，部署后必须记录 commit SHA 和探针结果。

### 修正文档默认项目名和真实项目名的落差

文档默认项目名是 `loven7-mail-admin` / `loven7-mail-webmail`，真实 Cloudflare 项目是 `loven7-mail-pwa` / `cloudmail-webmail`。这个落差本身不危险，危险的是部署时没显式设置变量。

建议：

1. 在 `docs/CLOUDFLARE_PAGES.md` 和 `docs/GITHUB_ACTIONS.md` 增加“本仓库当前生产项目名”小节。
2. 在 `check-cloudflare-pages-preflight.mjs` 中增加一个“已知生产项目提示”，当环境变量没设置时更明确提示当前仓库真实生产名。
3. 在 deploy workflow 的跳过日志里输出“当前没有部署到生产”的醒目说明。

### 给部署 workflow 增加上线后探针

当前 workflow 即使未来能上传，也还缺部署后的线上验证。建议在 Webmail deploy 后增加：

```bash
WEBMAIL_RUNTIME_URL="https://email.loven.qzz.io" npm run check:cloudflare:runtime
```

如果不想把域名写死，可以增加 GitHub Variable：

```text
WEBMAIL_RUNTIME_URL=https://email.loven.qzz.io
```

这样每次发布都能证明：

- 页面能打开。
- runtime 配置齐全。
- 分享 KV 和加密 secret 可用。
- 上游 Worker 可达。

### 给 Admin 增加 runtime 诊断接口

Webmail 已有 `/api/runtime`，Admin 目前没有同等级诊断。后台新增了 Pages Functions 代理后，也应该提供一个只返回布尔值的诊断接口，例如：

```text
GET /api/runtime
```

返回内容可以包含：

| 字段                | 说明                            |
| ------------------- | ------------------------------- |
| `mailWorkerBaseUrl` | 是否配置 `MAIL_WORKER_BASE_URL` |
| `adminPassword`     | 是否配置 `ADMIN_PASSWORD`       |
| `mailReadStateKv`   | 是否绑定 `MAIL_READ_STATE_KV`   |
| `sitePassword`      | 可选项是否配置                  |

不要返回任何 secret 原文、Worker URL、KV ID 或密码。

## P1 优化：拆复杂模块，降低维护成本

### 拆分后台 CSS

当前最大文本文件是：

```text
apps/admin/src/index.css  11564 lines
```

它承担了全局视觉系统、移动端布局、深色模式、最终覆盖和大量页面级样式。这个文件继续增长会带来三个问题：

1. 新样式很难判断放在哪里。
2. 后写规则容易无意覆盖旧规则。
3. 移动端和深色模式回归难排查。

建议分三步拆，不要一次性大迁移：

| 阶段   | 动作                                                            | 验证                             |
| ------ | --------------------------------------------------------------- | -------------------------------- |
| 第一步 | 把 token、reset、基础按钮、表单、弹窗提到 `src/styles/base.css` | 构建通过，核心页面视觉不变       |
| 第二步 | 按页面拆 `address.css`、`mail.css`、`users.css`、`settings.css` | 每拆一块只改 import 和选择器位置 |
| 第三步 | 清理最终覆盖区，建立命名规则                                    | 移动端和深色模式截图对比         |

拆 CSS 时不要顺手重做视觉。先保持像素级行为尽量不变，再考虑统一设计系统。

### 拆分 `AddressView`

当前地址页：

```text
apps/admin/src/views/AddressView.tsx  2117 lines
```

它同时负责地址列表、新建地址、用户筛选、批量检测、分享创建、分享管理弹窗、移动端操作菜单。建议按“业务能力”拆，不按 UI 位置硬拆。

推荐拆分：

| 新模块                                | 职责                                             |
| ------------------------------------- | ------------------------------------------------ |
| `views/address/AddressList.tsx`       | 桌面表格和移动卡片列表                           |
| `views/address/NewAddressForm.tsx`    | 新建地址表单和草稿记忆                           |
| `views/address/UserAddressFilter.tsx` | 用户筛选和 `/admin/users/bind_address/{id}` 逻辑 |
| `views/address/BatchMailScan.tsx`     | 批量检测、并发控制、进度状态                     |
| `views/address/ShareCreateDialog.tsx` | 单邮箱/多邮箱分享创建                            |
| `views/address/ShareAdminDialog.tsx`  | 分享列表、撤回、恢复、批量操作                   |
| `views/address/useAddressList.ts`     | 地址分页、排序、搜索、缓存                       |
| `views/address/useShareAdmin.ts`      | 分享管理 API 和状态                              |

拆分顺序建议：

1. 先抽纯函数和 hooks。
2. 再抽弹窗。
3. 最后抽列表渲染。

这样每一步的风险都小，回滚也容易。

### 拆分 `MailWorkspace`

当前邮件工作区：

```text
apps/admin/src/views/MailWorkspace.tsx  1687 lines
```

它包含 inbox、sent、unknown 三种模式，邮件搜索、堆叠、详情解析、移动端无限加载、自动刷新、已读/星标同步。

推荐拆分：

| 新模块                            | 职责                                   |
| --------------------------------- | -------------------------------------- |
| `views/mail/mailGrouping.ts`      | 同收件邮箱、同发件人、连续邮件堆叠规则 |
| `views/mail/useMailList.ts`       | 列表分页、搜索、刷新                   |
| `views/mail/useMailState.ts`      | 已读、星标、本地和 KV 同步             |
| `views/mail/MailListPane.tsx`     | 列表渲染                               |
| `views/mail/MailDetailPane.tsx`   | 邮件详情和解析状态                     |
| `views/mail/MobileMailLayout.tsx` | 移动端列表/详情切换                    |

这里有两个必须保持的业务不变量：

1. 后台邮件堆叠只能按“同一收件邮箱 + 同一发件人 + 连续邮件”堆叠。
2. 用户站不要启用邮件堆叠。

拆分前建议先给堆叠函数补单元测试，再动 UI。

### 拆分 Webmail `App`

当前用户站主文件：

```text
apps/webmail/src/App.tsx  1478 lines
```

它把登录、session、分享、邮箱列表、阅读器、自动刷新、移动端窗格都放在一起。建议保留单页体验，但拆出状态和视图。

推荐拆分：

| 新模块                               | 职责                        |
| ------------------------------------ | --------------------------- |
| `src/session/useMailboxSession.ts`   | JWT、邮箱密码、分享 session |
| `src/mail/useMailFeed.ts`            | 普通邮箱和分享邮箱分页      |
| `src/mail/MailList.tsx`              | 列表                        |
| `src/mail/MailReader.tsx`            | 详情阅读                    |
| `src/share/ShareMailboxSwitcher.tsx` | 多邮箱分享切换              |
| `src/refresh/useAutoRefresh.ts`      | 自动刷新圆环和周期          |

拆分目标不是“文件变短”本身，而是让每个功能可以单独测试和回归。

## P1 优化：补关键测试，而不是盲目堆测试

当前测试覆盖偏向脚本级 smoke 和 Functions 检查，这很好。但业务规则级别还缺更小的测试。

优先补这些：

| 模块                                       | 建议测试                                        | 原因                     |
| ------------------------------------------ | ----------------------------------------------- | ------------------------ |
| `apps/admin/src/lib/mailParser.ts`         | HTML 清洗、验证码提取、附件摘要                 | 邮件内容复杂，回归成本高 |
| `MailWorkspace` 拆出的 grouping 函数       | 不同收件邮箱不堆叠、非连续不堆叠                | 用户明确关注的规则       |
| `apps/webmail/functions/_lib/share.ts`     | `mailVisibility: new/all`、隐藏邮件、过期、撤回 | 分享是高风险用户功能     |
| `apps/webmail/functions/_lib/http.ts`      | CORS allowlist、错误映射、runtime config        | 已有脚本，可继续细化     |
| `apps/admin/functions/_lib/admin-proxy.ts` | 无 admin header 时的 token 校验、缺配置错误     | 后台代理是敏感入口       |
| `apps/admin/src/lib/storage.ts`            | 凭据作用域、过期清理、legacy key 清理           | 本地凭据策略复杂         |

建议工具：

```bash
npm --prefix apps/admin install -D vitest
npm --prefix apps/webmail install -D vitest
```

如果暂时不想引入 Vitest，也可以先把关键纯函数放在 `.mjs` 检查脚本里。但长期看，Vitest 更适合维护。

CI 建议分层：

| 层级       | 触发方式               | 内容                                              |
| ---------- | ---------------------- | ------------------------------------------------- |
| 快速检查   | 每次 push / PR         | TypeScript、Functions checks、核心单元测试、build |
| 完整 smoke | 手动或 nightly         | `smoke:local`、浏览器截图、移动端关键路径         |
| 发布后探针 | 每次 production deploy | `/api/runtime`、假登录、分享 token 探针           |

## P1 优化：收紧安全边界

### 收紧 Admin proxy CORS

`apps/admin/functions/_lib/admin-proxy.ts` 的 `proxyOptions()` 当前返回：

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: authorization,content-type,x-admin-auth,...
```

这对管理后台代理来说偏宽。即使真正请求还需要凭据，也建议收紧到：

1. 同源。
2. 显式配置的后台 origin。
3. 本地开发 origin。

可以参考 Webmail `http.ts` 的 allowlist 思路，给 Admin 增加：

```text
ADMIN_CORS_ORIGINS
```

默认只允许同源。这样后台代理不会对任意 origin 宣告可跨源携带敏感头。

### 逐步减少浏览器侧管理员密码依赖

当前后台有两种模式：

1. 浏览器直接带 `x-admin-auth`。
2. Pages Function 在服务端通过 `ADMIN_PASSWORD` 注入上游请求。

第二种更适合长期维护，因为管理员密码不必保存在浏览器。建议把路线定为：

| 阶段       | 动作                                                 |
| ---------- | ---------------------------------------------------- |
| 现在       | 保留兼容，继续支持旧浏览器缓存                       |
| 下一阶段   | UI 默认走账号登录 + 服务端注入，弱化“保存管理员密码” |
| 再下一阶段 | 对直接 `x-admin-auth` 增加警告和迁移提示             |
| 最终       | 只在本地调试或显式高级模式下允许直接密码             |

这条路线需要谨慎，不能一次改断用户现有登录。

### 保持 secret 不入库

当前 `wrangler.toml` 使用占位说明，没有提交真实 KV ID，这是正确的。后续继续遵守：

| 不应进入仓库     | 放置位置                                     |
| ---------------- | -------------------------------------------- |
| Cloudflare Token | GitHub Secrets 或本地登录                    |
| Account ID       | GitHub Secret 或受控文档，不放公开默认配置   |
| Worker 私有地址  | Cloudflare Pages secret / env                |
| 管理员密码       | Cloudflare Pages secret 或浏览器本地临时输入 |
| KV Namespace ID  | Cloudflare 控制台绑定，不提交                |
| 分享加密密钥     | Cloudflare Pages secret                      |

提交前建议跑：

```bash
rg -a -n --hidden -S "ghp_|CLOUDFLARE_API_TOKEN|ADMIN_PASSWORD|SHARE_ENCRYPTION_SECRET|MAIL_WORKER_BASE_URL|[a-f0-9]{32}" .
```

命中文档变量名不一定是泄漏，要重点看真实值。

## P1 优化：类型和 API contract

项目对上游 Cloudflare Temp Mail Worker 做了大量兼容，这是必要的。但现在一些兼容逻辑通过 `as any` 或散落字段判断实现，长期会让错误更难定位。

建议建立三个层次：

| 层级       | 作用                               |
| ---------- | ---------------------------------- |
| Raw DTO    | 描述上游可能返回的宽松 shape       |
| Normalizer | 把 Raw DTO 转成前端稳定模型        |
| View Model | 页面只使用稳定字段，不关心上游别名 |

优先处理：

| 领域                | 原因                                 |
| ------------------- | ------------------------------------ |
| 邮件列表 / 邮件详情 | 字段别名多，搜索、堆叠、验证码都依赖 |
| 地址列表            | 用户筛选、批量检测、分享创建都依赖   |
| 分享 payload        | 版本兼容和权限逻辑敏感               |
| 用户设置 / 角色     | Admin proxy 权限判断依赖角色 shape   |

示例方向：

```ts
type RawMail = Record<string, unknown>;

type NormalizedMail = {
  id: number;
  subject: string;
  from: string;
  to: string;
  createdAt: string;
  raw?: string;
};

function normalizeMail(raw: RawMail): NormalizedMail {
  // 只在这里处理 address、recipient、mailbox、to_address 等别名
}
```

页面里不要继续重复 `(mail as any).recipient` 这类逻辑。

## P2 优化：性能和资产治理

本次构建结果：

| 应用    | 主要产物             | 大小                     |
| ------- | -------------------- | ------------------------ |
| Admin   | `assets/index-*.css` | 约 356 KB                |
| Admin   | `assets/index-*.js`  | 约 291 KB                |
| Admin   | PWA precache         | 约 3417 KB               |
| Webmail | `assets/index-*.css` | 约 45 KB                 |
| Webmail | `assets/index-*.js`  | 约 303 KB，gzip 约 98 KB |

当前不是明显失控，但建议建立预算：

| 预算项           | 建议阈值 | 超过后动作                           |
| ---------------- | -------- | ------------------------------------ |
| Admin 主 CSS     | 400 KB   | 拆 CSS、清最终覆盖、减少重复规则     |
| Admin 主 JS      | 350 KB   | 继续 lazy views、检查 vendor         |
| Webmail 主 JS    | 350 KB   | 引入 manualChunks 或拆 parser/reader |
| PWA precache     | 4 MB     | 检查大图是否被 precache              |
| 单张 public 图片 | 500 KB   | 转 WebP/AVIF 或确认必须使用 PNG      |

后台 `vite.config.ts` 已经排除了部分大图 precache，这是正确的。Webmail 的 Vite 配置较简单，后续如果 Webmail 继续增长，可以参考后台加 manual chunks：

```ts
manualChunks(id) {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("postal-mime")) return "postal-mime";
  if (id.includes("react-dom")) return "react-dom";
  return "vendor";
}
```

资产治理建议：

1. 给 `apps/admin/public` 和 `apps/webmail/public` 增加资产清单。
2. 说明每张 hero/cover 图在哪里被引用。
3. 对未引用图片做清理。
4. 新增图片前先压缩，并记录来源和用途。

## P2 优化：文档和运维手册

现有文档已经不少，尤其是：

| 文档                            | 价值                             |
| ------------------------------- | -------------------------------- |
| `docs/ENGINEER_HANDOFF.md`      | 接手工程师入口                   |
| `docs/PROJECT_STRUCTURE.md`     | 目录边界和新增文件规则           |
| `docs/CLOUDFLARE_PAGES.md`      | Pages、Preview、KV、runtime 说明 |
| `docs/GITHUB_ACTIONS.md`        | Actions 配置                     |
| `docs/DEPLOYMENT_QUICKSTART.md` | 最短部署路径                     |

建议新增或加强一份 `docs/OPERATIONS_RUNBOOK.md`，专门写生产运维：

| 小节         | 内容                                                  |
| ------------ | ----------------------------------------------------- |
| 当前生产资产 | 两个 Pages 项目、域名、KV namespace 标题、GitHub 仓库 |
| 发布前       | `git status`、`check:release`、secret 扫描            |
| 发布中       | GitHub Actions 或 Direct Upload 命令                  |
| 发布后       | runtime probe、页面打开、分享测试、后台登录测试       |
| 回滚         | Cloudflare Pages 回滚到上一个 deployment 的步骤       |
| 排障         | CORS、KV、secret、Worker base URL、Preview 配置       |

这样后续维护者不用从多份文档里拼上线流程。

## 推荐路线图

### 第 1 周：稳定发布源

目标：任何人都能回答“当前线上来自哪次提交”。

任务：

1. 确认当前本地未提交改动哪些要保留。
2. 把保留改动拆成清晰 commit。
3. 配齐 GitHub Actions 部署 secrets 和 variables。
4. 手动触发一次 `Deploy to Cloudflare Pages`，确认 deploy 步骤不再 skipped。
5. 增加 Webmail 发布后 runtime probe。
6. 在文档中写清真实生产项目名。

验收：

```bash
gh run view <latest-deploy-run-id> --json jobs,conclusion
$env:WEBMAIL_RUNTIME_URL="https://email.loven.qzz.io"
npm run check:cloudflare:runtime
```

### 第 2 到 4 周：拆高风险模块

目标：把最高频改动区域拆成可测试、可定位的小模块。

任务：

1. 保持邮件逐封独立展示，并用冒烟测试阻止邮件折叠或堆叠回归。
2. 抽 `MailWorkspace` 的 grouping、state、list hooks。
3. 抽 `AddressView` 的分享弹窗和批量检测逻辑。
4. 抽 Webmail 自动刷新和 session 管理。
5. 开始拆后台 CSS 的基础层和页面层。

验收：

```bash
npm run check:release
npm --prefix apps/admin run smoke:local
npm --prefix apps/webmail run smoke:local
```

如果 smoke 对环境要求高，可以先把它放到手动检查或 nightly，不一定每次 PR 都跑。

### 第 1 到 2 个月：安全和观测收敛

目标：敏感路径默认安全，线上问题更容易定位。

任务：

1. 收紧 Admin proxy CORS。
2. 增加 Admin `/api/runtime`。
3. 给 Pages Functions 增加更明确的错误码文档。
4. 建立资产和 bundle 预算。
5. 增加 `docs/OPERATIONS_RUNBOOK.md`。
6. 把直接管理员密码模式降级为高级兼容路径。

验收：

1. 新增测试覆盖 admin proxy CORS。
2. Webmail 和 Admin runtime probe 都通过。
3. 发布 runbook 能让新工程师独立完成一次预览部署和回滚演练。

## 上线检查清单

每次生产发布前：

```bash
git status --short --branch --untracked-files=all
npm run check:release
```

确认：

| 检查                 | 通过标准                                       |
| -------------------- | ---------------------------------------------- |
| 工作区               | 没有未解释的修改或临时文件                     |
| Secrets              | 没有真实 token、密码、KV ID、私有 API 写入仓库 |
| Admin build          | 通过                                           |
| Webmail build        | 通过                                           |
| Functions checks     | headers、CORS、image 都通过                    |
| Cloudflare preflight | 无 errors                                      |

发布后：

```powershell
$env:WEBMAIL_RUNTIME_URL="https://email.loven.qzz.io"
npm run check:cloudflare:runtime
```

人工抽查：

1. 打开 `https://mail.loven7.cc.cd`。
2. 打开 `https://email.loven.qzz.io`。
3. 后台登录或账号信息显示正常。
4. 地址管理能生成用户站登录链接。
5. Webmail 能完成假登录错误映射，不暴露底层英文配置错误。
6. 分享链接创建、访问、隐藏邮件、撤回能跑通。

## 模块级优化清单

### Admin 前端

优先事项：

1. 拆 `index.css`。
2. 拆 `AddressView` 和 `MailWorkspace`。
3. 把本地凭据策略写成测试。
4. 保持移动端导航、三点菜单、邮件详情安全区不回归。

不要做：

1. 不要一次性重写 UI。
2. 不要把多个页面的 API 请求重新散写到组件里。
3. 不要把私有 Worker 地址或管理员密码变成 Vite 构建变量。

### Webmail 前端

优先事项：

1. 拆 `App.tsx` 的 session、mail feed、reader、refresh。
2. 给分享 mailbox 切换和自动刷新补测试。
3. 如果 JS 继续增长，做 chunk split。

不要做：

1. 不要让 Webmail 直接请求上游 Worker，除非有明确安全评审。
2. 不要让分享访客删除真实邮件。
3. 管理后台和用户站都不要重新启用邮件折叠或堆叠。

### Pages Functions

优先事项：

1. 保持 `http.ts` 作为统一响应层。
2. 分享逻辑继续集中在 `share.ts`。
3. Admin proxy CORS 收紧。
4. Admin runtime 诊断补齐。

不要做：

1. 不要在多个 route 里复制 CORS 和安全头。
2. 不要输出 secret、KV ID 或 Worker 私有地址。
3. 不要把 Preview 和 Production 运行时配置混为一谈。

### CI/CD

优先事项：

1. 配齐 GitHub Actions 部署配置。
2. 让 skipped deploy 变成显式失败或醒目警告。
3. 增加发布后 runtime probe。
4. 保留 Direct Upload 作为手动应急路径。

不要做：

1. 不要只看 workflow 绿色就认为上线成功。
2. 不要在本地脏树状态下直接 Direct Upload。
3. 不要把真实 Cloudflare IDs 写进公开仓库。

## 风险矩阵

| 风险                            | 概率   | 影响   | 当前控制                         | 建议补强                                   |
| ------------------------------- | ------ | ------ | -------------------------------- | ------------------------------------------ |
| GitHub Actions 绿色但未部署     | 高     | 高     | workflow 有 skip 日志            | 配齐 secrets，或让缺部署配置时明确失败     |
| 本地脏树 Direct Upload 覆盖线上 | 中     | 高     | 人工判断                         | 发布前强制 `git status` 和 commit SHA 记录 |
| 分享 KV/secret 缺失             | 低到中 | 高     | `/api/runtime`、Functions checks | 发布后自动 probe                           |
| Admin proxy 跨源过宽            | 中     | 中到高 | 请求仍需凭据                     | CORS allowlist                             |
| 大组件改动引发 UI 回归          | 高     | 中     | TypeScript 和 smoke 脚本         | 拆模块，补规则测试和截图检查               |
| 大图进入 precache 或仓库膨胀    | 中     | 中     | Admin 已排除部分大图             | 资产清单和大小预算                         |
| 上游 API shape 变化             | 中     | 中     | 多处兼容字段                     | DTO normalizer 和 contract tests           |

## 本次审计证据

| 证据                                                | 结果                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `git status --short --branch --untracked-files=all` | 本地 `main...origin/main`，大量 modified 和 untracked                       |
| `npm run check:release`                             | 通过                                                                        |
| Admin build                                         | 通过，主 CSS 约 356 KB，主 JS 约 291 KB                                     |
| Webmail build                                       | 通过，主 CSS 约 45 KB，主 JS 约 303 KB                                      |
| `gh repo view`                                      | 仓库为 public，默认分支 `main`                                              |
| `gh secret list`                                    | 当前无 Actions secrets                                                      |
| `gh variable list`                                  | 当前只有 `VITE_FRONTEND_LOGIN_BASE`                                         |
| `gh run view 27361461255`                           | Deploy workflow 成功，但 Cloudflare deploy 步骤 skipped                     |
| `wrangler pages project list`                       | `loven7-mail-pwa` 和 `cloudmail-webmail` 均为 Git Provider `No`             |
| `wrangler pages deployment list`                    | 两个项目最新生产部署 Source 为 `fbe920c`                                    |
| `npm run check:cloudflare:runtime`                  | Webmail 线上 runtime ok                                                     |
| 源码行数统计                                        | `index.css`、`AddressView`、`MailWorkspace`、Webmail `App` 是主要复杂度热点 |

## 最推荐的下一步

先不要重构。下一步最值得做的是“建立发布基线”：

1. 确认当前本地未提交改动是否都要保留。
2. 把保留改动提交到 GitHub。
3. 配齐 GitHub Actions 部署所需 secrets 和 variables。
4. 手动触发一次部署，确认两个 deploy 步骤不再 skipped。
5. 跑 Webmail runtime probe。

做到这里以后，后续维护才会稳。然后再开始拆大文件、补测试、收紧 Admin proxy。这个顺序能最大限度降低“优化过程中把线上状态弄乱”的风险。
