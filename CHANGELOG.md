# Changelog

本项目的显著变更记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)；日期使用 `YYYY-MM-DD`。

## [Unreleased]

### Changed

- README 首屏改为“下载启动器 → Cloudflare 授权 → Email Routing → 真实收件验收”的新手路径，并补充部署前准备、能力边界和收件配置速查。
- Release workflow 现在会为创建或更新的 Release 同步中文正文，明确下载入口、版本变更和安装后的 Email Routing 必做项。

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

[Unreleased]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/tag/v0.1.0
