# Changelog

本项目的显著变更记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)；日期使用 `YYYY-MM-DD`。

## [Unreleased]

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

[Unreleased]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/tag/v0.1.0
