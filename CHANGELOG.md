# Changelog

本项目的显著变更记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)；日期使用 `YYYY-MM-DD`。

## [Unreleased]

### Added

- 新增完整英文 README、英文小白部署教程和英文 Cloudflare 域名 / Email Routing 教程，并为中英文入口加入双向语言切换。

## [0.5.0] - 2026-08-16

### Added

- 全新 Worker 安装现在会在 Cloudflare OAuth 和账号选择后再询问邮箱域名，逐域名核验归属与 Active 状态，并自动启用 Email Routing。
- Worker 配置使用锁定版 Wrangler `4.116.0` 的 `addresses` 能力，将每个 `*@域名` Catch-all 自动绑定到安装器创建的 Worker。

### Changed

- 全新安装改为两阶段 Worker 部署：先用不含 `addresses` 的配置部署并验收核心 Worker，取得 `workers.dev` 地址后才启用 Email Routing，再通过第二次声明式部署应用 Catch-all。
- 新手流程不再要求用户部署完成后手工寻找 Worker 并配置 Catch-all；正常完成后只需登录 Admin 并发送真实外部测试邮件。
- 安装模式第一问改为“是否从零部署完整邮箱系统”，默认选择完整新安装，避免新手一路回车误入已有 Worker 高级模式。
- README、Release 中文说明和部署教程改为“OAuth → 选择 Active 域名 → 自动部署与邮件路由 → 真实验收”，并解释 Email Routing 绑定 Worker 名称而非 `workers.dev` URL。

### Security

- D1、Worker Secret、健康状态、域名配置和首个管理员会在任何 MX/Catch-all 变更之前完成验收；核心阶段失败不会接管邮件。
- 启用邮件路由和修改必要 MX 前必须得到明确确认；检测到已有 Catch-all、删除或接管冲突时，安装器停止并要求中文确认，再交由 Wrangler 展示变更计划，不会静默覆盖现有邮件服务。

### Fixed

- Windows PowerShell 引导脚本现在通过 npm 的 `--` 分隔符正确透传 `--new-worker`、`--plan` 等安装器参数。
- Windows 单文件启动器会在系统缺少 Git 时统一准备官方 MinGit，修复双击后临时选择“从零部署”却无法克隆锁定 Worker 源码的问题。

### Compatibility

- 新安装器继续锁定兼容 Worker `v1.10.0`、提交 `116ddc732431afd6f4154a74669804473b373baa`，并统一使用 Wrangler `4.116.0`。
- 本版本不新增 Pages 变量、Secret、KV binding 或数据格式迁移；已经完成部署的 `v0.4.1` 用户无需重建资源。
- 只有重新运行全新 Worker 安装流程时才会进入自动 Email Routing；任何 MX/Catch-all 变更仍需明确授权，旧版安装器可回退但不会自动撤销已经确认的 Cloudflare 路由变更。

## [0.4.1] - 2026-08-16

### Changed

- README 首屏改为“下载启动器 → Cloudflare 授权 → Email Routing → 真实收件验收”的新手路径，并补充部署前准备、能力边界和收件配置速查。
- Release workflow 现在会为创建或更新的 Release 同步中文正文，明确下载入口、版本变更和安装后的 Email Routing 必做项。
- 项目首页名称改为 `Loven7 Mail`，定位为开源、可自托管的 Cloudflare 邮箱系统，并明确部署后的运行资源完全位于用户自己的 Cloudflare 账号。
- 新增从域名托管、名称服务器、Cloudflare OAuth、自动部署、Email Routing 到第一封真实邮件的小白完整教程，以及独立的 Cloudflare 域名与邮箱路由图文页面。
- 教程按 Cloudflare 2026 年账号级 **Compute → Email Service → Email Routing** 入口更新，并补充 DNSSEC 切换、SPF/DKIM 与旧版控制台路径提示。

### Fixed

- 修复 Windows 单文件启动器把 PowerShell 变量错误写成转义文本，导致双击后在 `if (-not $line)` 处直接出现解析错误的问题。
- 启动器与 PowerShell 引导脚本现在只从当前 PowerShell 主机加载内置模块，避免 PowerShell 7 模块路径污染 Windows PowerShell 后造成 `Get-FileHash` 不可用。

### Compatibility

- 本补丁不修改 Cloudflare Worker、D1、Pages、KV、Secret 或 Email Routing 配置；已经完成部署的 `v0.4.0` 用户无需重新部署。
- 使用 Windows 单文件安装器的新用户应重新下载 `v0.4.1` 的 `Install-Loven7-Mail.cmd`，不要继续使用此前下载的 `v0.4.0` 文件。

## [0.4.0] - 2026-08-13

### Added

- 新增 `npm run setup` 新手安装器，可接入已有 Worker，或从锁定的官方 `cloudflare_temp_email` `v1.10.0` 创建 Worker、D1、首个管理员、双 Pages 与所需 KV。
- 新增可脱敏续装状态、同名资源归属确认、Worker/Pages 在线探针和安装器命令级回归测试。
- 新增多个邮箱域名的一次配置能力，第一个域名作为默认域名，并把完整列表写入 Worker 的 `DEFAULT_DOMAINS`、`DOMAINS` 与管理员角色配置。
- 新增逐域名 Cloudflare Email Routing、Catch-all 和真实外部收件验收教程。
- 新增 Windows 单文件启动器：双击 `Install-Loven7-Mail.cmd` 即可下载校验过的 Release、准备 Node.js 22 和便携 Git，并进入 Cloudflare OAuth 安装流程，无需先克隆仓库。

### Changed

- 安装器通过标准输入写入 Cloudflare Secret，不在仓库或断点文件中保存密码、Worker 私有地址和分享密钥。
- Worker、Admin 与 Webmail 发布验收增加有限重试；D1 与 KV 断点 ID 每次续装都会重新向 Cloudflare 核验。
- 新 Worker 模式只进行一次 Cloudflare 账号选择；同一前缀的域名或锁定上游版本变化时先要求确认。
- 新 Worker 部署与续装会在线核对 `DOMAINS` 和 `DEFAULT_DOMAINS`；线上配置损坏时重新部署修复，域名列表增删或顺序变化时要求确认。
- 安装器完成提示区分“应用基础设施部署完成”和“邮箱收件尚待配置”，并逐域名显示 Email Routing 的 Worker 目标。
- 主 CI 现在执行安装器回归测试；AI Agent 指令明确限定为已有 Worker 的 Pages-only 流程。
- Release workflow 现在同时发布 Windows 启动器、PowerShell 引导脚本和 SHA-256 校验文件。
- 修复安装检测到已有 Worker 的 `PASSWORDS` Secret 时要求重新输入当前站点密码，避免续装健康检查只返回不明确的 401。
- 已有 Worker 模式在创建前端资源前只读验证健康状态、站点密码和管理员口令；部署后继续验证 Admin Pages 代理链路。
- Pages 已保存 `SITE_PASSWORD` 时，空密码续装会停止并要求输入当前值或明确删除旧 Secret，避免前端继续携带过期站点凭据。
- 文档和完成提示明确区分默认可用的收件/前端/分享/状态同步，与需要额外凭据或 binding 的可选发件能力。
- 已完成 Worker 与管理员验收的同配置续装会复用已保存的安全 `*.workers.dev` 地址，只验证后端并修复前端，避免覆盖用户后来手工增加的 Resend、SMTP、Send Email 或其他 binding。
- README、部署速查与上游边界文档改为优先引导一条命令部署，并明确 Email Routing 仍需部署者最终确认。
- 新 Worker 安装通过 npx 调用锁定版 pnpm，不再要求新手额外启用 Corepack 或全局安装 pnpm。

### Fixed

- 修复 Windows 下 Node 子进程无法直接启动 `npm.cmd`、`npx.cmd`、`corepack.cmd`，以及误将 Git 当作 `git.cmd` 的安装器兼容问题。

## [0.3.0] - 2026-07-25

### Added

- README 新增 Admin 运营概览、收件箱、系统设置和移动端地址管理的新版界面截图。

### Changed

- Admin 管理后台采用 "Paper, Ink & Sealing Wax" 视觉主题，并统一仪表盘、统计、地址、用户、写信、设置和维护页面在桌面、平板、移动端及深色模式下的布局与控件样式。
- 仪表盘重组邮件流量、地址活跃、站点规模和能力状态，管理工作区统一表格、分页、筛选、弹层与工具面板视觉层级。
- README 增加 `v0.3.0` 大前端更新说明，并重排 Admin 与 Webmail 界面预览。

### Fixed

- 修复旧样式覆盖新版主题、平板表格横向溢出、移动端操作布局和深色模式表面不一致等问题。

### Compatibility

- 沿用 `v0.2.0` 支持的 Cloudflare Temp Mail / `cloudflare_temp_email` API 行为；没有新增 Pages 变量、Secret、KV binding 或数据迁移要求。
- 本版本仅更新前端与展示资源，可直接回滚到 `v0.2.0` 的静态部署。

## [0.2.0] - 2026-07-15

### Added

- 公开发布脱敏门禁 `npm run check:public`。
- 可复制的强约束 AI Agent 双 Pages 部署流程。
- 公开源码与自用配置边界、版本和升级策略。
- Dependabot 依赖更新与 CodeQL 静态安全扫描。

### Changed

- 部署配置改为通用项目名与示例域名，不再绑定任何维护者的 Cloudflare 生产资源。
- README 聚焦首次部署、运行时配置、验收和维护入口。

### Security

- 生产运维记录、内部审计材料、本机路径和自用站点信息不再属于公开发行内容。
- CI 在构建前检查公开文档、配置示例和部署脚本是否重新混入私人信息。
- 邮件 HTML 在无 DOMParser 时回退为转义纯文本，并以协议白名单拦截脚本型与未知 URL scheme。

## [0.1.0] - 2026-06-25

### Added

- Loven7 Mail Admin 与 Webmail 双应用结构。
- Cloudflare Pages Functions、分享 KV、PWA 和基础 CI/发布脚本。

[Unreleased]: https://github.com/Lur1N77777/loven7-mail/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Lur1N77777/loven7-mail/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Lur1N77777/loven7-mail/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Lur1N77777/loven7-mail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Lur1N77777/loven7-mail/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Lur1N77777/loven7-mail/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lur1N77777/loven7-mail/releases/tag/v0.1.0
