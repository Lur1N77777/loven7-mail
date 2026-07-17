# 工程师交接文档

这份文档给下一位接手工程师使用。它覆盖项目目标、目录结构、主要模块、修改入口、部署方式和排查路径。阅读顺序建议是：先看“项目概况”，再看“目录结构”，最后按要改的功能跳到对应模块。

## 项目概况

Loven7 Mail Cloudflare Suite 是一套基于 Cloudflare Temp Mail / `cloudflare_temp_email` 官方 Worker API 的增强前端套件。它不包含上游 Worker 后端源码，而是在现有临时邮箱 Worker 前面提供两套 Cloudflare Pages 前端：

| 子项目 | 路径 | 作用 |
| --- | --- | --- |
| 管理后台 PWA | `apps/admin` | 管理邮箱地址、用户、邮件、设置、维护工具和共享链接 |
| 用户邮箱站 / 分享站 | `apps/webmail` | 给普通用户用 JWT 登录邮箱，也承载单邮箱/多邮箱分享链接 |

核心原则：

- 不把私人 API、管理员密码、Token、KV ID 或个人域名写入仓库。
- 管理后台连接信息由浏览器本地缓存保存。
- 用户站的运行时配置放在 Cloudflare Pages 环境变量和 KV Binding 中。
- 分享功能由 `apps/webmail/functions` 的 Pages Functions 实现，不需要改官方 Temp Mail Worker。

## 快速开始

从干净仓库开始：

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

构建检查：

```bash
# 根目录
npm run lint:admin
npm run build
```

如果本地没有 `node_modules`，先运行 `npm ci`。仓库不应该提交 `node_modules`、`dist`、`.wrangler`、`.env.production` 等产物。

## 目录结构

```text
.
├─ .github/workflows
│  ├─ ci.yml
│  └─ deploy-cloudflare-pages.yml
├─ apps
│  ├─ admin
│  │  ├─ functions/api/brand-icon.ts
│  │  ├─ public
│  │  ├─ scripts
│  │  └─ src
│  │     ├─ components
│  │     ├─ lib
│  │     ├─ types
│  │     ├─ views
│  │     ├─ App.tsx
│  │     ├─ index.css
│  │     └─ main.tsx
│  └─ webmail
│     ├─ functions
│     │  ├─ _lib
│     │  ├─ _middleware.ts
│     │  └─ api
│     ├─ public
│     └─ src
├─ docs
│  ├─ assets
│  ├─ screenshots
│  ├─ AGENT_DEPLOY_PROMPT.md
│  ├─ CLOUDFLARE_PAGES.md
│  ├─ GITHUB_ACTIONS.md
│  ├─ PROJECT_STRUCTURE.md
│  ├─ SECURITY_DESENSITIZATION.md
│  └─ UPSTREAM.md
├─ scripts
├─ README.md
└─ package.json
```

### 根目录

| 路径 | 说明 | 修改建议 |
| --- | --- | --- |
| `package.json` | 根级脚本，统一调用两个子项目构建 | 新增跨项目脚本时改这里 |
| `.github/workflows/ci.yml` | GitHub Actions 构建检查 | 改 CI 步骤、Node 版本、构建命令时改这里 |
| `.github/workflows/deploy-cloudflare-pages.yml` | GitHub Actions 自动部署 Cloudflare Pages | 改自动部署策略、项目名变量时改这里 |
| `README.md` | 面向用户的项目介绍和部署教程 | 面向使用者的信息放这里 |
| `docs/` | 面向部署、AI Agent、工程师的详细文档 | 面向维护者的信息放这里 |
| `docs/PROJECT_STRUCTURE.md` | 目录边界、本地产物规则和新增文件放置建议 | 整理目录或新增模块前先看这里 |

## 管理后台 `apps/admin`

### 作用

管理后台是 React + TypeScript + Vite + Tailwind CSS 的 PWA。它直接访问官方 Temp Mail Worker 的管理接口，也会调用用户站 Pages Functions 管理分享链接。

主要能力：

- 管理员凭据缓存和连接设置。
- 仪表盘统计、系统能力状态。
- 邮箱地址创建、搜索、用户筛选、批量选择、批量检测、分享创建。
- 用户列表、用户绑定地址内联展开、跳转地址管理筛选。
- 收件箱、发件箱、未知邮件、邮件详情、验证码提取、品牌头像、移动端手势。
- 发件、系统设置、维护工具。
- 共享链接管理：列表、批量撤回/恢复/更新、仅新增邮件分享。

### 入口文件

| 文件 | 作用 |
| --- | --- |
| `apps/admin/src/main.tsx` | React 挂载入口 |
| `apps/admin/src/App.tsx` | 全局状态、导航、凭据、主题、视图路由、移动端页面滑动 |
| `apps/admin/src/index.css` | 全局视觉系统、移动端布局、深色模式、动画和大量最终覆盖样式 |
| `apps/admin/vite.config.ts` | Vite、PWA、Tailwind 配置 |

### 全局状态和视图切换

`apps/admin/src/App.tsx` 管理以下核心状态：

| 状态 | 说明 |
| --- | --- |
| `activeMenu` | 当前页面：`dashboard`、`address`、`users`、`inbox` 等 |
| `apiBase` | 上游 Worker API 地址，默认来自 `VITE_API_BASE` 或本地缓存 |
| `adminPassword` / `sitePassword` / `userAccessToken` / `addressJwt` | 请求凭据 |
| `theme` | 浅色/深色模式 |
| `addressUserFilter` | 用户 ID 驱动的地址筛选 |
| `mailboxAddressRequest` | 从地址页直达某个邮箱收件箱的事件式请求 |

如果要新增一个后台页面：

1. 在 `apps/admin/src/components/Shell.tsx` 的菜单类型和菜单列表中加入新项。
2. 在 `apps/admin/src/App.tsx` 增加 lazy import。
3. 在 `renderContent()` 中返回对应视图。
4. 如果移动端底部主导航需要调整，同步修改 `components/Shell.tsx` 中的 `mobilePrimaryMenus`；左右滑顺序由 `mobileSwipeMenus` 基于这份主导航顺序派生。
5. 写样式时优先复用现有按钮、胶囊、菜单、卡片样式，不要再单独硬写一套尺寸。

### API 请求层

文件：`apps/admin/src/lib/api.ts`

这是管理后台所有上游请求的统一入口。关键点：

- `createApiClient()` 生成 `request<T>()`。
- 自动添加：
  - `Content-Type: application/json`
  - `x-lang`
  - `x-fingerprint`
  - `x-admin-auth`
  - `x-custom-auth`
  - JWT / Access Token 相关头。
- GET 请求带内存缓存和并发复用。
- 写操作会根据 `INVALIDATION_RULES` 清理相关缓存。
- 统一抛出 `ApiError`。

修改 API 行为时优先改这里。不要在各个页面里重复写 `fetch()`、认证头和错误处理。

### 本地缓存和常量

文件：`apps/admin/src/lib/constants.ts`

重要缓存键：

| Key | 作用 |
| --- | --- |
| `loven7.apiBase` | Worker API 地址 |
| `loven7.adminPassword` | 管理员密码缓存 |
| `loven7.sitePassword` | 站点密码缓存 |
| `loven7.addressUserFilter` | 地址管理用户筛选 |
| `loven7.newAddressDraft` | 新建邮箱上次设置 |
| `loven7.frontendLoginBase` | 用户站 URL |
| `loven7.mailAutoRefreshEnabled` | 邮件自动刷新开关 |
| `loven7.mailReadIds` / `loven7.mailStarredIds` | 本地已读/星标状态 |

相关工具在 `apps/admin/src/lib/storage.ts`。新增本地缓存时，把 key 放到 `STORAGE_KEYS`，不要在组件里散落字符串。

### 组件目录

| 文件 | 作用 | 常见修改场景 |
| --- | --- | --- |
| `components/AuthPanel.tsx` | 管理员凭据面板、连接设置、保存缓存 | 改登录/连接设置 UI、默认高级选项 |
| `components/Shell.tsx` | 顶部栏、侧边栏、底部移动导航 | 改导航项、图标、页面框架 |
| `components/Common.tsx` | Toast、确认弹窗、Pagination、通用交互 | 改全局确认框、分页、提示样式 |
| `components/BrandIcons.tsx` | 后台装饰/功能图标 | 改仪表盘或分类图标视觉 |

### 视图目录

#### `views/DashboardView.tsx`

包含：

- `DashboardView`：仪表盘卡片、快捷入口、站点能力状态。
- `StatsView`：统计页和活跃度视图。

改统计布局、卡片、能力标签时看这里。统计数据来自 `/admin/statistics` 和 `/open_api/settings`。

#### `views/AddressView.tsx`

这是最大的后台模块之一，负责地址管理。

主要能力：

- 地址列表分页、排序、搜索。
- 用户筛选，下拉用户来自 `/admin/users`，实际地址来自 `/admin/users/bind_address/{userId}`。
- 新建邮箱表单，记忆上次域名、前缀和随机二级域名设置。
- 前缀清洗，允许 `.`、`_`、`-`。
- 批量选择、批量搜索检测、批量分享。
- 单邮箱/多邮箱分享创建。
- 共享链接管理弹窗：列表、筛选、批量操作。
- 移动端三点菜单和右下角浮动批量操作入口。

常见修改：

| 需求 | 修改位置 |
| --- | --- |
| 调整地址搜索逻辑 | `AddressView.tsx` 中列表加载、前端过滤和缓存相关函数 |
| 改新建邮箱默认值/记忆字段 | `readStoredNewAddressDraft()`、`writeStoredNewAddressDraft()`、`defaultNewAddress` |
| 改用户筛选 | `loadAllUserOptions()`、用户下拉状态、`/admin/users/bind_address/{id}` 调用 |
| 改批量检测 | `BATCH_MAIL_SCAN_PAGE_SIZE`、`BATCH_MAIL_SCAN_CONCURRENCY` 和批量扫描函数 |
| 改分享创建 | 分享弹窗、`/api/share` 调用和 payload |
| 改移动端菜单 | 地址卡片渲染和 action menu 相关状态 |

注意：地址页不要再用 `/admin/address?query={userEmail}` 来做用户筛选。实测应以 `/admin/users/bind_address/{userId}` 为准。

#### `views/UsersView.tsx`

负责用户管理。

主要能力：

- 用户列表、搜索、分页。
- 创建用户、删除用户、改角色、重置密码。
- 点击用户后内联展开绑定地址。
- 点击“在地址管理筛选”时传递 `{ userId, userEmail, requestId }` 给 `App.tsx`，再跳转地址页。

如果用户地址展开重叠、动画不顺或筛选跳转失效，优先看：

- `expandedUser`
- `closingUserId`
- `UserAddressInline`
- `onFilterUserAddresses`

#### `views/MailWorkspace.tsx`

负责管理后台收件箱、未知邮件、发件箱。

主要能力：

- 三种模式：`inbox`、`sent`、`unknown`。
- 地址筛选、状态筛选、实时搜索。
- 移动端无限加载，桌面端分页。
- 邮件详情、HTML/文本渲染、附件摘要。
- 验证码识别和快捷复制。
- 自动刷新、本地已读/星标状态。
- 从地址页直达邮箱并强制刷新。
- 管理后台所有邮件均逐封独立展示，不启用发件人折叠或邮件堆叠。

常见修改：

| 需求 | 修改位置 |
| --- | --- |
| 改邮件列表展示 | `MailWorkspace.tsx` 中的 `mailListEntries` 和 `MailListItem` |
| 改邮件搜索 | `getSearchText()` 和过滤逻辑 |
| 改验证码展示 | `getVerificationCodes()` 和邮件卡片/详情渲染 |
| 改移动端阅读区 | detail header、`mobile-mail-detail` 相关样式 |
| 改自动刷新 | `STORAGE_KEYS.mailAutoRefresh*`、刷新 effect |
| 改直达邮箱同步 | `addressRequest` 消费逻辑 |

邮件列表保持“一封一行”；不要重新引入按发件人折叠、会话聚合或连续邮件堆叠。

#### `views/ComposeView.tsx`

负责发件。

模式：

- 标准发件：调用 `/admin/send_mail`。
- Binding 发件：支持 cc、bcc、replyTo、headers、html/text 等结构化 payload。

改发件表单、校验、预览时看这里。

#### `views/SettingsMaintenance.tsx`

包含两个页面：

- `SettingsView`：账户规则、角色地址数量限制、Telegram、前端登录链接前缀、邮件自动刷新偏好。
- `MaintenanceView`：数据库版本、Worker 配置、清理任务、维护操作。

常见修改：

| 需求 | 修改位置 |
| --- | --- |
| 改前端登录 URL 配置 | `FrontendLoginBaseCard` |
| 改邮件自动刷新默认设置 | `MailRefreshPreferenceCard` 和 `STORAGE_KEYS.mailAutoRefresh*` |
| 改账号规则 | `AccountRulesPanel` |
| 改角色限制 | `RoleAddressConfigPanel` |
| 改维护按钮 | `MaintenanceView.action()` 调用路径 |

### 邮件解析和验证码

文件：`apps/admin/src/lib/mailParser.ts`

负责：

- 用 `postal-mime` 解析 raw mail。
- 提取发件人、收件人、主题、正文、附件。
- 生成预览文本。
- 识别验证码，包括中英文和日语语境。
- HTML 邮件安全处理。

如果验证码多出字符、漏识别或误识别订单号，优先改这里，再检查 `MailWorkspace.tsx` 的展示逻辑。

### 品牌头像

相关文件：

- `apps/admin/src/lib/brandIdentity.tsx`
- `apps/admin/functions/api/brand-icon.ts`
- `apps/admin/src/components/BrandIcons.tsx`

流程：

1. 前端从发件人地址提取域名。
2. 先做域名归一化和品牌显示名映射。
3. 请求 `/api/brand-icon?domain=example.com`。
4. Pages Function 尝试 BIMI、favicon、apple-touch-icon、manifest icon。
5. 成功则显示圆角头像，失败则显示首字母 fallback。

安全点：图标代理限制域名、私网 IP、图片 MIME、大小和缓存时间，避免直接把邮件 HTML 里的外链随意代理。

### 视觉系统

主要在 `apps/admin/src/index.css`。

这个文件现在承担大量历史迭代后的最终覆盖规则。维护时建议：

- 优先搜索现有 class，再改最终覆盖区。
- 同类按钮、胶囊、菜单、分页保持统一高度、圆角、字体、间距。
- 深色模式使用柔和中性灰，不要用纯黑、强蓝、绿色大块或发光边框。
- HTML 邮件正文尽量保持原始邮件视觉，不要全局强制反色。
- 移动端优先保证邮件正文和列表可视空间，低频操作收进菜单。

## 用户站 / 分享站 `apps/webmail`

### 作用

用户站是 React + TypeScript + Vite 前端，加 Cloudflare Pages Functions 作为轻量 BFF。它面对普通用户和分享访问者，不直接暴露官方 Worker 的完整接口。

主要能力：

- JWT 登录或邮箱密码登录。
- 单邮箱邮件列表、详情、删除真实邮件。
- 单邮箱分享、多邮箱分享、聚合分享。
- 分享访问者删除邮件时只隐藏当前分享视图，不删除后台真实邮件。
- 自动刷新圆环、品牌头像、HTML 邮件渲染、图片代理和缓存。

### 前端入口

| 文件 | 作用 |
| --- | --- |
| `apps/webmail/src/main.tsx` | React 挂载入口 |
| `apps/webmail/src/App.tsx` | 用户站主状态、登录、列表、阅读、分享邮箱切换、自动刷新 |
| `apps/webmail/src/styles.css` | 用户站完整视觉系统和动画 |
| `apps/webmail/src/api.ts` | 前端调用 Pages Functions 的 API 包装 |
| `apps/webmail/src/auth.ts` | JWT URL 读取、本地 session 保存、token hash |
| `apps/webmail/src/cache.ts` | 邮箱邮件缓存 |
| `apps/webmail/src/mailParser.ts` | 用户站邮件解析、HTML 清洗、验证码提取 |
| `apps/webmail/src/brandIdentity.tsx` | 用户站品牌头像 |
| `apps/webmail/src/imageMemoryCache.ts` | 邮件图片代理和内存缓存 |
| `apps/webmail/src/types.ts` | 用户站类型定义 |

### 用户站主流程

`apps/webmail/src/App.tsx` 核心状态：

| 状态 | 说明 |
| --- | --- |
| `session` | 当前邮箱 session，可能是 JWT 登录或分享 session |
| `shareInfo` | 分享链接公开信息 |
| `mails` | 当前列表邮件 |
| `selectedId` | 当前阅读邮件 |
| `nextOffset` / `hasMoreHistory` | 加载更多历史邮件 |
| `autoRefreshEnabled` / `refreshCycleKey` | 自动刷新圆环和刷新周期 |
| `mobilePane` | 移动端列表/阅读窗格 |
| `mailViewMode` | HTML / 文本 / 源码视图 |

如果要改“用户站自动刷新圆环”，看 `AUTO_REFRESH_MS`、`autoRefreshTimerRef`、`refreshCycleKey` 和 CSS 中 refresh circle 相关样式。

如果要改“分享页不显示某句话/提示”，通常在 `App.tsx` 的分享 session 渲染区或 `styles.css`。

### 用户站 API 包装

文件：`apps/webmail/src/api.ts`

前端只调用同源 API：

| 函数 | 对应接口 | 作用 |
| --- | --- | --- |
| `createSession()` | `POST /api/session` | JWT 或邮箱密码登录 |
| `fetchSafeSettings()` | `GET /api/settings` | 获取安全设置 |
| `fetchMailPage()` | `GET /api/mails` | 普通邮箱邮件分页 |
| `fetchShareInfo()` | `GET /api/share/:token` | 获取分享公开信息 |
| `fetchShareSettings()` | `GET /api/share/:token/settings` | 分享邮箱设置 |
| `fetchShareMailPage()` | `GET /api/share/:token/mails` | 分享邮箱邮件分页 |
| `hideSharedMail()` | `DELETE /api/share/:token/mail/:id` | 访客隐藏邮件 |
| `deleteMail()` | `DELETE /api/mail/:id` | 普通 JWT 登录删除真实邮件 |

不要让前端直接请求官方 Worker，除非明确需要。这样可以统一安全头、站点密码、错误处理和分享权限。

## 用户站 Pages Functions

### 运行时环境变量

文件：`apps/webmail/functions/_lib/types.ts`

| 变量 / Binding | 是否必需 | 说明 |
| --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | 必需 | 官方 Temp Mail Worker/API 根地址 |
| `SITE_PASSWORD` | 可选 | 如果官方 Worker 开启站点密码 |
| `SHARE_ENCRYPTION_SECRET` | 分享功能必需 | 加密 KV 中的分享记录 |
| `SHARE_ADMIN_CORS_ORIGINS` | 分站管理分享时必需 | 允许跨源调用分享管理接口的后台 origin，逗号分隔；不要设置 `*` |
| `SHARE_PUBLIC_CORS_ORIGINS` | 可选 | 公开分享 API 的额外跨源来源；正常同源分享页留空 |
| `SHARE_KV` | 分享功能必需 | 保存分享记录、summary 索引、撤回状态和隐藏邮件 |

后台与用户站按推荐方式部署成两个 Cloudflare Pages 项目时，`SHARE_ADMIN_CORS_ORIGINS` 必须配置在**用户站 Pages 项目**上，值是管理后台页面 origin。

### 通用 HTTP 工具

文件：`apps/webmail/functions/_lib/http.ts`

负责：

- 安全响应头。
- CORS。
- 从请求提取 JWT。
- 构建 Worker 请求头。
- 请求官方 Worker 并映射错误。
- 标准化邮件分页和安全设置。

新增 Pages Function 时优先复用这里的方法。

### 分享核心逻辑

文件：`apps/webmail/functions/_lib/share.ts`

负责：

- 分享数据类型和版本兼容。
- token 生成。
- AES-GCM 加密/解密 KV payload。
- summary 索引读写。
- 状态判断：`active`、`expired`、`revoked`。
- 分享列表扫描和筛选。
- 管理员认证。
- 分享邮箱解析。
- `mailVisibility: 'new' | 'all'` 过滤。
- `hiddenMailIds` 隐藏分享视图中的邮件。

重要规则：

- `hideMail` 只是隐藏分享视图，不删除后台真实邮件。
- 旧分享默认兼容为 `mailVisibility: 'all'`。
- 新分享默认可创建为 `mailVisibility: 'new'`，需要记录 `sinceMailId` / `sinceCreatedAt`。
- summary 索引用于让分享管理列表更快，不含 JWT。

### Pages Function 路由

| 路径 | 文件 | 作用 |
| --- | --- | --- |
| `POST /api/session` | `functions/api/session.ts` | JWT 或邮箱密码登录，返回前端 session |
| `GET /api/settings` | `functions/api/settings.ts` | 普通 JWT 邮箱设置 |
| `GET /api/mails` | `functions/api/mails.ts` | 普通 JWT 邮件分页 |
| `DELETE /api/mail/:id` | `functions/api/mail/[id].ts` | 普通 JWT 删除真实邮件 |
| `GET /api/image?url=` | `functions/api/image.ts` | 邮件图片代理，限制大小和私网地址 |
| `GET /api/brand-icon?domain=` | `functions/api/brand-icon.ts` | 品牌图标代理 |
| `POST /api/share` | `functions/api/share/index.ts` | 管理后台创建分享链接 |
| `GET /api/share/:token` | `functions/api/share/[token].ts` | 分享公开信息 |
| `GET /api/share/:token/settings` | `functions/api/share/[token]/settings.ts` | 分享邮箱设置 |
| `GET /api/share/:token/mails` | `functions/api/share/[token]/mails.ts` | 分享邮件列表，应用仅新增/隐藏过滤 |
| `DELETE /api/share/:token/mail/:id` | `functions/api/share/[token]/mail/[id].ts` | 访客隐藏分享邮件 |
| `GET /api/share/admin/list` | `functions/api/share/admin/list.ts` | 管理后台列出分享链接 |
| `GET/PATCH/DELETE /api/share/admin/:token` | `functions/api/share/admin/[token].ts` | 查看、更新、撤回分享 |
| `POST /api/share/admin/batch` | `functions/api/share/admin/batch.ts` | 批量撤回、恢复、更新、刷新索引 |

### 中间件

文件：`apps/webmail/functions/_middleware.ts`

负责给 Pages Functions 响应加安全头。新增接口时通常不需要改它。

## Cloudflare 部署

推荐创建两个 Cloudflare Pages 项目：

| 项目 | Root directory | Build command | Output directory |
| --- | --- | --- | --- |
| 管理后台 | `apps/admin` | `npm ci && npm run build` | `dist` |
| 用户站 / 分享站 | `apps/webmail` | `npm ci && npm run build` | `dist` |

更多说明：

- `docs/CLOUDFLARE_PAGES.md`
- `docs/AGENT_DEPLOY_PROMPT.md`
- `docs/GITHUB_ACTIONS.md`

## GitHub Actions

| Workflow | 文件 | 作用 |
| --- | --- | --- |
| Build & Validate | `.github/workflows/ci.yml` | PR、push、手动运行时构建检查 |
| Deploy to Cloudflare Pages | `.github/workflows/deploy-cloudflare-pages.yml` | push 或手动运行时构建；配置 Cloudflare 后自动部署 |

需要的 GitHub 配置：

```text
Secrets:
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID

Variables:
ADMIN_PAGES_PROJECT_NAME
WEBMAIL_PAGES_PROJECT_NAME
```

不要把这些值写入仓库。

## 常见改动路线

### 改后台地址管理

1. 看 `apps/admin/src/views/AddressView.tsx`。
2. 如果涉及 API 请求，确认 `apps/admin/src/lib/api.ts` 缓存和 invalidation 是否需要同步。
3. 如果涉及样式，搜索 `apps/admin/src/index.css` 中现有地址页 class。
4. 如果涉及分享，继续看 `apps/webmail/functions/_lib/share.ts` 和 `/api/share` 路由。

### 改后台邮件列表 / 邮件详情

1. 看 `apps/admin/src/views/MailWorkspace.tsx`。
2. 邮件解析和验证码先看 `apps/admin/src/lib/mailParser.ts`。
3. 品牌头像看 `apps/admin/src/lib/brandIdentity.tsx` 和 `functions/api/brand-icon.ts`。
4. 移动端细节通常在 `apps/admin/src/index.css` 的最终覆盖区。

### 改用户站阅读体验

1. 看 `apps/webmail/src/App.tsx`。
2. API 调用看 `apps/webmail/src/api.ts`。
3. 邮件解析看 `apps/webmail/src/mailParser.ts`。
4. 样式和动效看 `apps/webmail/src/styles.css`。
5. 如果涉及分享权限或隐藏邮件，改 `apps/webmail/functions/_lib/share.ts` 和对应 API route。

### 改分享管理

1. 创建分享：`apps/webmail/functions/api/share/index.ts`。
2. 管理列表：`apps/webmail/functions/api/share/admin/list.ts`。
3. 单条更新/撤回：`apps/webmail/functions/api/share/admin/[token].ts`。
4. 批量操作：`apps/webmail/functions/api/share/admin/batch.ts`。
5. 核心读写和状态判断：`apps/webmail/functions/_lib/share.ts`。
6. 后台 UI：`apps/admin/src/views/AddressView.tsx` 中共享链接管理弹窗。

### 改品牌头像

1. 前端归一化：`brandIdentity.tsx`。
2. 代理抓取：`functions/api/brand-icon.ts`。
3. 如果后台和用户站都要一致，需要同时改 `apps/admin` 和 `apps/webmail` 两边的同名逻辑。

### 改视觉 / 字体 / 深色模式

1. 后台：`apps/admin/src/index.css`。
2. 用户站：`apps/webmail/src/styles.css`。
3. 优先修改 token、同类控件规则和最终覆盖区。
4. 避免在 JSX 中继续堆大量一次性 Tailwind 尺寸，否则后续会再次不统一。

## 质量检查

提交前建议运行：

```bash
npm --prefix apps/admin run lint
npm --prefix apps/admin run build
npm --prefix apps/webmail run check:functions:headers
npm --prefix apps/webmail run check:functions:cors
npm --prefix apps/webmail run check:functions:image
npm --prefix apps/webmail run build
```

如果改了 Pages Functions 分享逻辑，建议额外验证：

- 单邮箱 JWT 登录。
- 单邮箱分享。
- 多邮箱分享。
- `mailVisibility: new` 初始不显示历史邮件。
- 访客隐藏邮件后刷新仍隐藏，后台真实邮件不受影响。
- 管理后台能撤回、恢复、批量操作分享链接。

如果改了移动端 UI，至少检查：

- 360px / 390px 宽度。
- 安卓返回/左右滑动。
- 底部导航 safe area。
- 邮件详情正文可视区域。
- 地址页三点菜单不被遮挡。

## 安全和脱敏注意事项

不要提交：

- GitHub Token。
- Cloudflare Token。
- Worker API 私人地址。
- 管理员密码。
- 站点密码。
- KV ID / Secret。
- `.env.production`、`.env.local`、`.wrangler`、`dist`、`node_modules`。

已有安全文档：`docs/SECURITY_DESENSITIZATION.md`。

建议提交前扫描敏感词。示例：

```bash
rg -a -n --hidden -S "实际Token|真实密码|真实域名|个人邮箱|私有API地址" README.md docs apps .github
```

注意：示例命令会命中文档中的变量名和说明，这不一定是泄漏。真正需要处理的是实际 Token、真实域名、真实密码和个人账号信息。

## 已知维护重点

这些地方是用户反复关注、也最容易回归出问题的区域：

1. 移动端地址页三点菜单必须浮在最上层，不能被列表容器裁切。
2. 管理后台和用户站都保持每封邮件独立展示，不启用邮件折叠或堆叠。
4. 地址页用户筛选必须使用 `/admin/users/bind_address/{userId}`，不要退回邮箱字符串搜索。
5. 从地址页“查看收件箱”必须强制刷新目标邮箱邮件。
6. 分享访客删除邮件只是隐藏分享视图，不能删除后台真实邮件。
7. HTML 邮件正文不要强制深色反色，避免破坏官方邮件样式。
8. README 截图要使用真实截图，并保持缩略图尺寸协调。

## 给下一位工程师的建议

- 先跑通两个子项目的 `npm ci` 和 build。
- 改业务前先确认是后台站、用户站，还是 Pages Functions。
- 任何分享相关改动都要同时看后台 UI 和用户站 Functions。
- 任何视觉改动都要检查浅色、深色、桌面、手机四种状态。
- 任何缓存/搜索改动都要检查“输入后实时反馈”和“清空按钮立即生效”。
- 不要把临时测试产物留在仓库根目录。正式项目目录是 `open-source`。
