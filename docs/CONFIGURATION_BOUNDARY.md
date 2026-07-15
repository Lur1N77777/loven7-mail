# 公开版与私有配置边界

本项目采用“公开核心 + 私有配置”的双轨维护方式。公开仓库负责可复用代码、测试和文档；每位部署者的品牌、域名、Cloudflare 资源和 Secret 只在自己的部署环境中存在。

## 为什么不维护两套源码

复制出两套长期分叉的源码会让安全修复、依赖升级和功能迭代重复劳动。推荐保留一个公开核心，通过部署平台和本机 ignored 文件注入自用差异：

```text
公开 GitHub 仓库
  ├─ 通用 Admin / Webmail 源码
  ├─ *.example 配置样例
  ├─ 测试、CI、CHANGELOG
  └─ Loven7 默认品牌资源

私有部署层（不提交）
  ├─ Cloudflare Variables / Secrets
  ├─ KV Namespace bindings
  ├─ 自定义域名与 DNS
  ├─ GitHub Actions Secrets / Variables
  └─ 本机 .env / .dev.vars / ignored overlay
```

## 数据放置规则

| 数据 | 公开仓库 | 私有位置 |
| --- | --- | --- |
| 通用源码、测试、README | 是 | 可同步副本 |
| Loven7 默认 Logo、通用演示截图 | 是 | 可覆盖 |
| Worker API 地址 | 否 | Pages Secret `MAIL_WORKER_BASE_URL` |
| Worker 管理员密码 | 否 | Admin Pages Secret `ADMIN_PASSWORD` |
| 站点密码 | 否 | 两个 Pages 的 `SITE_PASSWORD` Secret |
| 分享加密密钥 | 否 | Webmail Pages Secret `SHARE_ENCRYPTION_SECRET_V2` |
| Cloudflare Account/Namespace/资源 ID | 否 | Cloudflare 与 GitHub Secrets |
| 自定义域名、DNS、证书 | 否 | Cloudflare Dashboard |
| 自用 Pages/KV 项目名 | 否 | GitHub Variables 或部署平台 |
| 真实邮箱、用户、邮件和审计数据 | 否 | D1/KV/R2/日志系统 |
| 生产部署 ID、回滚清单和内部报告 | 否 | 私有运维库或工单系统 |

## 本地私有文件

以下文件已被 `.gitignore` 忽略，可用于本地测试，但仍应限制访问权限：

```text
.env
.env.local
.env.production
.dev.vars
wrangler.local.toml
```

仓库只保留 `.env.example`、`apps/admin/.env.example` 和 `apps/webmail/.dev.vars.example`。示例值必须使用保留域名和明确占位符，不能把真实值“暂时”写进去。

## 自用品牌覆盖

Loven7 是公开版默认品牌。需要自定义时，优先通过独立私有 overlay 或部署前脚本替换静态资源和显示名，不要把自定义域名或客户信息提交回公开分支。

建议流程：

1. 从公开 `main` 创建本地部署分支。
2. 在 ignored 的私有目录保存品牌源文件和部署清单。
3. 部署前将品牌文件复制到工作目录；部署后立即清理工作目录改动。
4. 运行 `npm run check:public`，确认公开提交中没有私有 overlay。
5. 只把通用修复反向合并到公开 `main`。

如果品牌覆盖逐渐复杂，应把注入逻辑设计为读取环境变量或构建时参数，而不是维护永久分叉。

## 同步公开更新到自用部署

```bash
git fetch upstream
git checkout private-deploy
git merge --no-ff upstream/main
npm --prefix apps/admin ci
npm --prefix apps/webmail ci
npm run check:release
```

先部署到 Preview，确认登录、收件箱、分享和 `/api/runtime`，再部署 Production。合并冲突只解决源码；不要把 Cloudflare Secret 导出到仓库用于“复现”。

## 发布前门禁

```bash
npm run check:public
git diff --check
git status --short
```

`check:public` 检查常见私人 URL、本机绝对路径、内部审计/生产材料、通用项目名和必要文档。它不能识别所有组织内部代号，所以发布前仍需按 [脱敏检查](SECURITY_DESENSITIZATION.md) 人工复核。

## 泄露后的处理

1. 立即撤销或轮换被公开的 Secret；删除当前文件不能使旧 Secret 重新安全。
2. 保存最少必要证据，但不要在公开 Issue 复制 Secret。
3. 清理当前分支和 Git 历史中的敏感值。
4. 检查 Fork、Release 附件、Actions 日志和缓存。
5. 运行完整门禁后再发布。

涉及安全事件时按根目录 [SECURITY.md](../SECURITY.md) 的私密渠道处理。
