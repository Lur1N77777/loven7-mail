# Changelog

本项目的显著变更记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)；日期使用 `YYYY-MM-DD`。

## [Unreleased]

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

[Unreleased]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/tag/v0.1.0
