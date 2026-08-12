# AI Agent Pages-only 安全部署指令

本页仅适用于已经有兼容 Worker、D1 和可用 Email Routing，只部署 Admin 与 Webmail 两个 Pages 前端的场景。全新 Cloudflare 账号或没有 Worker 时，请在交互式终端运行 `npm run setup`，再完成 [Email Routing 收件配置](EMAIL_ROUTING.md)；本提示词明确禁止创建或修改 Worker，因此不是首次完整部署的替代入口。

下面的部署规约可直接复制给 Codex、Claude Code、OpenCode 或其他编程 Agent。它刻意把目标、禁止项、执行顺序、停止条件和验收结果写死，避免 Agent 误改后端、泄露 Secret 或把两个 Pages 项目配反。

## 使用方法

1. 将下方整段 Prompt 复制给 Agent。
2. 把 `<REPOSITORY_URL>` 替换成你自己的 Fork 地址；这是唯一建议直接写进 Prompt 的值。
3. 开始前在浏览器登录 GitHub 与 Cloudflare，并准备好现有 Worker 的地址、管理员密码和可选站点密码，但不要把它们补进聊天。
4. Agent 无法安全写入 Secret 时，让它一次列出全部字段并打开对应的 Cloudflare 页面。你在平台表单中填写完后只回复“已配置”，Agent 应从断点连续完成剩余部署和验收。

## 可复制 Prompt

```text
你是本次 Cloudflare Pages 部署执行者。目标是把 <REPOSITORY_URL> 中的 Loven7 Mail Cloudflare Suite 安全部署成两个独立 Pages 项目：

- apps/admin：管理后台
- apps/webmail：用户邮箱与分享站

严格遵守以下规则。规则优先于“尽快完成”。

【连续执行与完成定义】
1. 这是一个从预检到验收的端到端任务。除下列明确的人为暂停外，不得在计划、预检、资源创建、Admin 部署或 Webmail 部署后结束，也不得逐阶段重复询问是否继续。
2. 只有三类操作可以暂停：GitHub/Cloudflare 登录或授权、用户在平台表单中填写 Secret、真实账号登录与分享验收。需要暂停时，一次列出全部待办并停在准确页面；用户回复“已配置”或“已登录”后，从当前断点继续，不要重跑已完成阶段。
3. 任何非敏感选择必须在首次变更前一次问完。用户没有特殊要求时，使用本文默认项目名、只配置 Production，并采用 Cloudflare Pages GitHub 集成完成首次部署。
4. 完成标准是两个 Pages 项目均部署成功、Webmail /api/runtime 通过、回滚点已记录，并清楚标记真实账号验收状态。只完成其中一个站点不算完成。
5. 首次部署只选择一种持续部署入口。默认使用 Cloudflare Pages GitHub 集成；不要同时启用 Cloudflare Git 自动构建和 GitHub Actions 的 AUTO_DEPLOY_PAGES，避免一次提交触发两套 Production 部署。只有用户明确要求时才配置 GitHub Actions 自动部署。

【绝对禁止】
1. 不得修改、迁移、删除或重新部署上游邮件 Worker、D1、R2、邮件路由或现有生产资源；不得修改上游 Worker。
2. 不得要求我在聊天、Issue、commit、README、终端命令参数或日志中粘贴密码、API Token、Account ID、KV ID、JWT、Cookie、Worker 私有地址或分享密钥。
3. 不得输出密钥原文，包括最终回复、调试日志、截图、环境变量回显和命令历史。
4. 不得把真实配置写入仓库内的 .env、.dev.vars、wrangler.toml、源码、构建产物或 GitHub Actions 日志。
5. 不得删除或覆盖无法确认归属的 Cloudflare Pages/KV 项目，不得强推 Git，不得关闭安全检查。
6. 不得声称“部署完成”，除非构建、Pages 部署和下方验收清单都有最新证据。

【执行原则】
- 先检查，再执行；每个阶段成功后再进入下一阶段。
- 优先使用 Cloudflare OAuth/浏览器登录、Cloudflare 控制台或支持 Secret 类型的 API/MCP。
- 读取 Secret 时只能判断“存在/缺失”，不得读取或显示原文。
- 所有创建操作必须可回滚；复用资源前先核实名称、账号和用途。
- 任何停止条件触发时，停止并向用户报告：已完成步骤、阻塞原因、不会受影响的资源、下一步的精确操作。

【阶段 1：只读预检】
1. 克隆仓库并记录当前 commit SHA，不做代码修改。
2. 确认 Node.js 22 或更高版本以及 Chrome/Chromium 可用；完整 release check 会运行浏览器 smoke。
3. 在仓库根目录依次执行：
   - npm --prefix apps/admin ci
   - npm --prefix apps/webmail ci
   - npm run check:release
4. 任何命令失败都停止部署，报告失败命令和非敏感错误摘要。不要跳过测试。
5. 只读确认当前 Cloudflare 账号、已有 Pages 项目和 KV Namespace；不要读取 Secret 原文。

【阶段 2：确定资源】
1. 为 Admin 选择项目名，默认 loven7-mail-admin；重名时使用用户确认的通用名称。
2. 为 Webmail 选择项目名，默认 loven7-mail-webmail；不得与 Admin 使用同一项目。
3. 为 Webmail 创建或复用一个专用 KV Namespace，绑定名固定为 SHARE_KV。
4. 可选：创建一个邮件状态 KV，并在 Admin 与 Webmail 两边都绑定为 MAIL_READ_STATE_KV。两个站点要共用状态时，必须指向同一个 Namespace。
5. Production 与 Preview 是两个独立环境。除非用户明确要求 Preview，否则先只配置 Production。
6. 复用已有项目时，先记录两个项目当前的 Production 部署 ID 和状态作为回滚点；无法确认项目归属或回滚点时停止。

【阶段 3：创建两个 Pages 项目】
使用 GitHub 集成或安全的 Cloudflare API 创建项目，参数必须准确：

Admin：
- Root directory: apps/admin
- Build command: npm ci && npm run build
- Build output directory: dist

Webmail：
- Root directory: apps/webmail
- Build command: npm ci && npm run build
- Build output directory: dist

不要把两个项目的 Root directory 配反。不要设置 VITE_API_BASE。

【阶段 4：安全写入运行时配置】
先尝试使用 Secret 类型的安全写入能力；命令或工具会回显值时禁止使用。需要用户手动填写时，把两个项目的全部字段集中到一次人工步骤，不要每个变量暂停一次。

Admin Production：
- MAIL_WORKER_BASE_URL：Secret，现有邮件 Worker 根地址
- ADMIN_PASSWORD：Secret，现有 Worker 管理员密码
- SITE_PASSWORD：Secret，仅在 Worker 启用站点密码时设置

Webmail Production：
- MAIL_WORKER_BASE_URL：Secret，与 Admin 指向同一个 Worker
- SITE_PASSWORD：Secret，仅在 Worker 启用站点密码时设置
- SHARE_ENCRYPTION_SECRET_V2：Secret，直接生成至少 32 随机字节并安全写入；不得输出密钥原文
- SHARE_ADMIN_CORS_ORIGINS：普通变量，等待 Admin 部署后填写其实际 Production origin；多个实际使用的 Admin origin 用逗号分隔。禁止使用 *，禁止填写 Webmail 自己的 origin
- SHARE_KV：KV Namespace binding，Binding name 必须完全一致
- MAIL_READ_STATE_KV：可选 KV binding；需要跨站共享已读/星标时设置

如果你没有安全收集 MAIL_WORKER_BASE_URL、ADMIN_PASSWORD 或 SITE_PASSWORD 的能力：
1. 不要索要这些值。
2. 告诉我打开 Cloudflare Dashboard → Workers & Pages → 对应项目 → Settings → Variables and Secrets → Production。
3. 给出上面的变量名和 Secret/Variable 类型，但不要提供示例密码。
4. 等我只回复“已配置”，再继续；不要要求截图 Secret。

如果你不能在不回显的情况下生成并写入 SHARE_ENCRYPTION_SECRET_V2，也按同样方式停止该步骤，让我在控制台创建 Secret。

【阶段 5：按依赖顺序部署】
1. 先确认 Admin 的运行时 Secret 已写入，再触发 Admin Production 部署。
2. 等待 Admin 构建成功，记录部署 ID、commit SHA、状态和最终公开 origin。不得用猜测的项目 URL 代替实际结果。
3. 将 Admin 的实际 origin 写入 Webmail Production 的 SHARE_ADMIN_CORS_ORIGINS，确认 Webmail Secret 与 SHARE_KV 均已配置，再触发 Webmail Production 部署。
4. 如果 GitHub 集成在运行时配置完成前已经自动触发过构建，配置完成后必须重新部署；验收只能针对这次新部署。
5. 等待 Webmail 构建成功，记录部署 ID、commit SHA、状态和公开 URL；不要记录任何 Secret。
6. 任一项目失败时不要连续重试。先读取非敏感构建错误，判断是依赖、构建还是运行时配置问题；不得通过关闭安全检查、删除 Functions 或硬编码配置来“让构建变绿”。

【阶段 6：验收清单】
逐项执行并记录状态：
1. Admin 根页面 GET 返回 200，主要 JS/CSS 资源可加载。
2. Webmail 根页面 GET 返回 200，主要 JS/CSS 资源可加载。
3. Webmail GET /api/runtime 返回 200 且 JSON 中 ok=true；只报告 checks 的布尔值、missing 和 hints，不输出环境变量内容。
4. 确认 SHARE_KV 已绑定到 Webmail Production。
5. 确认 SHARE_ADMIN_CORS_ORIGINS 包含实际使用的 Admin origin、没有 Webmail origin 且不是 *。
6. 用户自行用现有账号登录 Admin；你不得索要账号密码。若无法自动验证，标记为“等待用户确认”，不能伪造通过。
7. 用户自行创建分享并在无痕窗口打开；若无法自动验证，同样标记为“等待用户确认”。

【失败与回滚】
- 新项目部署失败：保留日志，停止流量切换，不删除旧项目。
- 更新已有项目失败：使用 Cloudflare Pages 的 Rollback to this deployment 恢复到本次操作前记录的部署 ID。
- /api/runtime 不完整：按 missing 修复绑定后重新部署；不得在代码里硬编码配置。
- CORS 错误：只修正 SHARE_ADMIN_CORS_ORIGINS 为 Admin origin，禁止 *。
- 无法确认目标账号、项目归属、旧部署 ID 或回滚点：立即停止并向用户报告。

【最终回复格式】
只输出以下内容：
- 仓库 commit SHA
- Admin 项目名、URL、部署 ID、构建/HTTP 状态
- Webmail 项目名、URL、部署 ID、构建/HTTP 状态
- 首次部署使用的持续部署入口，以及是否启用了 GitHub Actions 自动部署
- /api/runtime 的 ok、布尔 checks、missing、hints
- SHARE_KV 是否已绑定（是/否，不输出 Namespace ID）
- 用户验收项状态
- 未完成项或风险
- 回滚入口与部署 ID

最终回复不得输出密钥原文、Token、密码、Account ID、KV ID、JWT、Cookie 或私有配置值。
```

## Agent 应该返回什么

一份合格的结果应清楚区分“已由工具验证”和“等待用户确认”。例如 Pages 返回 200、`/api/runtime` 为 `ok: true` 可以由 Agent 验证；真实账号登录和真实邮件收发通常由用户确认。没有证据的项目不能标为通过。

## 常见错误

- 把两个 Pages 都设成仓库根目录：构建会拿错 `package.json`。
- 把 `ADMIN_PASSWORD` 设为 `VITE_` 变量：会进入浏览器构建产物，属于泄露。
- 只在 Preview 配变量：Production 上线后 Functions 仍缺配置。
- CORS 使用 `*`：分享管理接口不应接受任意来源。
- 只配置 `SHARE_KV`、不配置分享密钥：分享接口仍不可用。
- 复用同名 KV 但绑定错环境：Preview 成功不等于 Production 成功。
- 看见页面能打开就宣布完成：静态页面 200 不代表 Pages Functions 配置正确。

需要人工部署时，可改用 [部署速查](DEPLOYMENT_QUICKSTART.md)；变量、Preview 与探针细节见 [Cloudflare Pages 部署说明](CLOUDFLARE_PAGES.md)。
