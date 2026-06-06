# Contributing

欢迎提交 Issue、部署反馈和 Pull Request。这个项目优先关注 Cloudflare Pages 部署体验、邮件阅读安全、移动端体验和上游 `cloudflare_temp_email` 兼容性。

## 开发前

```bash
npm --prefix apps/admin ci
npm --prefix apps/webmail ci
npm run check:release
```

`check:release` 会运行 Cloudflare 预检、管理后台 TypeScript 检查、Webmail Functions 检查和两个前端构建。

## 提交前检查

- 不提交 `.env`、`.dev.vars`、`.wrangler/`、`dist/`、`node_modules/`。
- 不提交真实 Worker API、Cloudflare Token、管理员密码、站点密码、JWT、KV Namespace ID。
- 如果改了 Cloudflare Pages Functions，请运行：

```bash
npm run check:webmail
```

- 如果改了部署文档，请确认 [docs/DEPLOYMENT_QUICKSTART.md](docs/DEPLOYMENT_QUICKSTART.md) 和 [docs/CLOUDFLARE_PAGES.md](docs/CLOUDFLARE_PAGES.md) 没有互相矛盾。

## Pull Request

PR 请说明：

- 解决了什么问题。
- 影响 `apps/admin`、`apps/webmail`、Cloudflare Pages Functions 或文档中的哪些部分。
- 已运行哪些检查。

安全相关问题请不要直接公开细节，先按 [SECURITY.md](SECURITY.md) 里的方式报告。
