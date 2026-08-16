# 新手安装器

新手安装器用于把 Loven7 Mail 的 Admin、Webmail、分享 KV 和邮件状态 KV 部署到 Cloudflare。它支持接入已有兼容 Worker，也支持从 `deployment/upstream-lock.json` 指定并校验的兼容后端 `v1.10.0` 开始创建 Worker、D1 和前端。

第一次部署请优先阅读 [Loven7 Mail 小白完整部署教程](BEGINNER_GUIDE.md)。如果域名还没有托管到 Cloudflare，或自动路由失败、发生 Catch-all 冲突，请阅读 [Cloudflare 域名与邮箱路由教程](CLOUDFLARE_DOMAIN_AND_EMAIL.md)。

## 安装器会做什么

运行一次安装器会自动完成：

1. 检查 Node.js 版本并通过 Wrangler OAuth 连接 Cloudflare。
2. 新 Worker 模式在 OAuth 选定账号后再读取邮箱域名，并验证每个域名属于当前账号且状态可用。
3. 明确询问邮件接管风险；同意只代表后续可以修改 MX，此时仍不更改 Email Routing。
4. 创建 D1，并用不含 `addresses` 的配置第一次部署核心 Worker。
5. 写入 Worker Secret，取得 `workers.dev` 地址，验证健康状态、完整域名列表和首个管理员。
6. 核心 Worker 验收成功后，才逐域名启用 Email Routing 和必要邮件 DNS。
7. 加入 `addresses = ["*@域名"]` 后第二次部署，并在线确认 Catch-all 指向正确 Worker。
8. 检测到已有 Catch-all、规则删除或接管冲突时停止；只有用户确认后才进入 Wrangler 官方交互式接管。
9. 安装前端依赖，执行公开配置检查、Cloudflare 预检和双应用构建。
10. 创建或复用两个 Pages 项目、分享 KV 与邮件状态 KV，写入 Secret 和 binding 后部署 Admin 与 Webmail。
11. 使用有限重试检查 Admin 代理链路和 Webmail `/api/runtime`，吸收发布和 Secret 生效的短暂延迟。

已有 Worker 模式输入的地址、管理员口令、站点密码和分享密钥不会保存到安装状态文件。新 Worker 模式只会在 Worker 与首个管理员验收成功后保存公开的 `*.workers.dev` 根地址，用于安全续装；不会保存任何凭据。分享密钥已经存在时，重复运行安装器会保留原值，避免旧分享链接失效。

## 前置条件

- Node.js 22 或更高版本。
- 一个可以登录的 Cloudflare 账号。
- 已有 Worker 模式：一个已经能够正常收件的兼容 Worker，且已绑定并初始化 D1、配置管理员口令和管理员角色。
- 新 Worker 模式：一个或多个已经托管在当前 Cloudflare 账号、状态为 Active 的邮箱域名。安装器会在用户授权后自动启用 Email Routing、更新必要邮件 MX，并配置 Catch-all。
- 如果域名已有企业邮箱或其他收件服务，不要直接替换它的 MX；请先规划迁移，或使用专门的邮箱子域名。
- 安装器使用随 Node.js 提供的 npm/npx，并自动调用上游锁定的 pnpm 版本；不需要另外全局安装 Wrangler、pnpm 或启用 Corepack。

上游锁定版本和提交记录在 `deployment/upstream-lock.json`。安装器只克隆该 release，不跟踪上游 `main`。

## 开始安装

Windows 用户可以从 GitHub Releases 下载并双击 [Install-Loven7-Mail.cmd](https://github.com/Lur1N77777/loven7-mail/releases/latest/download/Install-Loven7-Mail.cmd)。它会自动下载校验过的发行包，并在系统缺少时准备 Node.js 22 与官方 MinGit 便携版；不需要先克隆仓库。临时上游目录会在部署后删除。

同一个 Windows 启动器同时支持中文和 English。启动后选择 `1. 中文` 或 `2. English`，选择会贯穿整个安装流程；无需下载两个版本。自动化或重跑时可使用 `--lang zh-CN` 或 `--lang en`。

克隆或 Fork 本仓库后运行：

```bash
npm run setup
```

已有 Worker 模式只询问：

- 项目名称前缀，默认 `loven7-mail`。
- Worker HTTPS 根地址。
- Worker 管理员口令。
- 可选的 Worker 站点密码。

密码输入不会显示在终端。不要通过命令参数、聊天、Issue 或 `.env` 传递密码。

没有 Worker 时，运行同一个命令，第一问“是否从零部署完整邮箱系统”保留默认“是”即可。安装器先完成 Cloudflare OAuth 和账号选择，然后再输入：

- 项目前缀。
- 已托管到当前 Cloudflare 账号的完整邮箱域名，例如 `mail.example.net`。多个域名用逗号分隔，第一个是默认域名。
- Worker 管理员口令、首个管理员登录邮箱和登录密码，以及可选站点密码。

安装器会自动获取并校验锁定的兼容后端 `v1.10.0`、创建 D1，并远程执行 `db/schema.sql`。第一次 Worker 配置不含 `addresses`：安装器先部署核心 Worker，通过 Wrangler `secret bulk` 从标准输入写入 `JWT_SECRET`/`ADMIN_PASSWORDS`/`PASSWORDS`，取得公开地址，并完成 Worker、域名配置和首个管理员验收。只有这些检查全部通过后，才调用 Wrangler 官方 Email Routing 命令启用邮件路由，再生成含 `addresses = ["*@域名"]` 的配置进行第二次声明式部署，把 Catch-all 应用到该 Worker，并在线复核。Secret 不写入磁盘文件。修复安装时会保留已有 `JWT_SECRET`，避免现有用户登录令牌失效；若同邮箱已存在，安装器不会覆盖其登录密码，密码不匹配时也不会修改角色。

也可以显式选择模式：

```bash
node scripts/installer/cli.mjs --new-worker --domains mail.example.net,second.example.net
node scripts/installer/cli.mjs --existing-worker --worker-url https://worker.example.com
```

只查看安装计划，不连接 Cloudflare：

```bash
npm run setup:plan
```

也可以预览自定义名称：

```bash
node scripts/installer/cli.mjs --plan --prefix my-mail --worker-url https://worker.example.com
node scripts/installer/cli.mjs --plan --new-worker --prefix my-mail --domains mail.example.net,second.example.net
```

## 重试与复用

安装器把不含 Secret 的断点状态保存在 `.loven7-installer/state.json`，该目录已被 Git 忽略。

失败后重新运行 `npm run setup`：

- 相同 Cloudflare 账号和相同项目名前缀会复用已创建资源。
- 安装器创建的 Worker 已完成管理员验收，且域名、锁定上游、Worker 和 D1 都未变化时，即使前端部署中断，续装也只重新验证 Worker 并修复前端，不重新部署 Worker；这样不会覆盖后来手工增加的发件或其他 binding。
- 若断点停在 `worker-core-ready`，续装只重新验收核心 Worker，然后继续启用 Email Routing 和应用 Catch-all；若停在 `email-routing-ready`，不会重复启用路由，而是直接完成第二次声明式部署。
- Catch-all 已在线验收后，即使中断在 `built`、`resources-ready`、`secrets-ready` 或 `deployed` 等前端阶段，续装也只重新验证后端并继续 Pages，不会重复部署 Worker。
- 同名但不属于当前断点的 Pages、KV、D1 或 Worker 必须人工确认后才会复用；Worker 复用意味着更新它，安装器不会静默覆盖陌生项目。
- 断点中的 KV、D1 ID 会在每次重试时重新向 Cloudflare 核验；资源被人工删除后不会继续使用陈旧 ID。
- 同一前缀的邮箱域名列表发生增删、重新排序（默认域名变化）或锁定上游提交发生变化时，安装器会先要求确认，避免误改现有 Worker。
- 新安装成功后，断点只记录已自动配置的邮箱域名和 Worker 名称，不保存 Token 或 DNS 凭据；重复安装会先核验远端资源。旧版本断点若已完成 Worker 验收，会优先保留现有 Worker 和后来增加的可选 binding，不静默重写邮件路由。
- 已存在的分享密钥和 Worker `JWT_SECRET` 不会自动轮换。
- 已有 Worker 存在 `PASSWORDS` Secret 时，续装必须再次输入当前站点密码；Wrangler 只能列出 Secret 名称，安装器不会读取或移除其原值。
- Pages 已存在 `SITE_PASSWORD` 时，续装必须再次输入当前站点密码；如果 Worker 已关闭站点密码，请先在两个 Pages 项目中明确删除旧 Secret，避免前端继续发送过期凭据。
- 部署用的 KV ID 配置只存在于系统临时目录，部署结束后立即删除。

安装器不会自动删除项目或 KV。需要清理失败安装时，先在 Cloudflare Dashboard 核对名称和用途，再人工删除。

## 安装完成后的验收

新 Worker 模式正常完成时，Email Routing 与 Catch-all 已自动配置；已有 Worker 模式则要求原后端本来就能收件。无论哪种模式，自动探针都不能代替公网邮件投递，仍应按 [Email Routing 收件核验](EMAIL_ROUTING.md) 发送真实测试邮件并在失败时检查 MX、规则和 Worker Logs。

然后人工完成：

1. 新 Worker 模式使用安装时创建的首个管理员账号登录 Admin；已有 Worker 模式使用已有管理员角色账号。
2. 从与目标域名无关的外部邮箱发送测试邮件；每个已配置域名至少验证一次 Catch-all 投递。
3. 在 Admin 中设置 Webmail 地址。
4. 创建分享并在无痕窗口打开。
5. 如需发件，再按上游文档配置 Resend、SMTP 或 Cloudflare Send Email，并发送一封真实测试邮件。

自动探针会验证 Worker `/health_check`、管理员 API、Admin Pages 代理和 Webmail binding，并对 Worker Secret 和 Pages 发布的短暂最终一致性进行有限重试。它不能替代真实邮件投递和账号登录测试。

## 当前边界

新 Worker 模式会自动修改启用 Email Routing 所需的邮件 DNS 和 Catch-all，但必须先获得用户明确授权；任何已有 Catch-all、删除或接管冲突都会再次确认。安装器不会更换域名名称服务器，也不会替用户决定是否中断现有企业邮箱。真实收件测试仍必须人工完成。

发件不是新 Worker 模式的默认能力。它需要部署者选择并配置第三方 Resend/SMTP 凭据或 Cloudflare Send Email binding；安装器不会代替用户创建外部账号、写入发件凭据或决定发件策略。未配置发件服务时，收件、Admin、Webmail、分享和已读/星标同步仍可使用。

完成一次安装后再运行相同命令，不会覆盖后来手工加到 Worker 的发件 binding；只有域名、D1、锁定上游版本或站点密码策略发生变化，或者远端 Worker/必需 Secret 已损坏时，安装器才会重新部署 Worker。

新 Worker 第一次核心部署时，安装器会从 Wrangler 部署结果确定并验收公开的 `*.workers.dev` 根地址；首个管理员验收通过后，只把这个公开地址以 `managedWorkerOrigin` 保存到已忽略的断点文件，然后才进入 Email Routing 阶段。续装直接使用该已验证地址，不依赖 Wrangler 部署列表猜测 URL。已有 Worker 模式输入的自定义或私有地址仍不会保存。若核心部署无法确定安全地址，安装器会停止，不会修改邮件 MX。
