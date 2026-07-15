# 版本与升级策略

## 版本号

Loven7 Mail Cloudflare Suite 使用 `MAJOR.MINOR.PATCH`：

- `PATCH`：向后兼容的 Bug、安全和性能修复。
- `MINOR`：向后兼容的新功能、新配置或 UI 能力。
- `MAJOR`：破坏性的 API、配置、KV 数据格式或部署结构变化。

预发布版本使用 `-alpha.N`、`-beta.N` 或 `-rc.N`。正式 Release 必须对应带签名或受保护的 `vMAJOR.MINOR.PATCH` Git tag。

## 兼容范围

本仓库与上游 Worker 的兼容关系以 API 行为而不是某个私人部署为准。Release 说明至少写明：

- 已验证的上游 Worker 版本或 commit 范围。
- 新增、变更、废弃的 Pages 运行时变量和 KV binding。
- 是否需要 Preview/Production 分别补配置。
- 是否存在分享密钥或 KV 数据迁移。
- 回滚是否安全。

## 发布流程

1. 把用户可见变更加入 `CHANGELOG.md` 的 `[Unreleased]`。
2. 在干净检出中安装锁定依赖并运行 `npm run check:release`。
3. 执行 `npm run check:public` 和人工脱敏复核。
4. 将 `[Unreleased]` 内容移动到新版本并写发布日期。
5. 同步根目录与两个应用的版本号及 lockfile。
6. 创建 PR，等待 CI 通过和代码审查。
7. 合并后创建 `vMAJOR.MINOR.PATCH` tag 与 GitHub Release。
8. 先部署 Preview 并验收，再批准 Production。

Release 附件只包含 Git 可追踪的公开源码与校验值，不能打包 `.env`、`.dev.vars`、`dist` 中的私有注入产物或本机缓存。

## 自用版本标识

自用部署不需要把私人差异提交到公开仓库。建议用部署元数据记录：

```text
public_version = v0.2.0
public_commit = <commit-sha>
private_revision = 3
deployed_at = <timestamp>
```

如果必须创建私有源码提交，使用独立私有仓库和后缀，例如 `v0.2.0-private.3`。不要把私有 tag 或 Release 发布到公开仓库。

## 升级顺序

1. 阅读从当前版本到目标版本的所有 CHANGELOG。
2. 备份需要保留的 KV 数据和当前 Pages 部署 ID。
3. 在 Preview 环境补充新变量、Secret 和 binding。
4. 部署目标版本，检查静态页面与 `/api/runtime`。
5. 验证登录、收件箱、发件、分享创建/撤回和移动端。
6. 部署 Production，并保留上一部署作为回滚点。

不要通过导出 Production Secret 到源码来复制环境；在 Cloudflare 中分别安全配置 Preview 和 Production。

## 废弃策略

- 非安全配置至少提前一个 MINOR 版本标记废弃。
- 破坏性删除只在 MAJOR 版本进行，并提供替代方案。
- 安全漏洞可能在 PATCH 中立即关闭危险行为；Release 说明应清楚标记升级优先级。
- `SHARE_ENCRYPTION_SECRET` 作为旧分享兼容密钥时，只有在确认旧记录全部迁移后才可删除；新写入优先使用 `SHARE_ENCRYPTION_SECRET_V2`。

## 回滚

静态前端可通过 Cloudflare Pages 回滚到前一部署。若版本引入不可逆 KV 或 API 数据变化，Release 说明必须明确指出不能只回滚代码，并提供恢复步骤。没有回滚证据的版本不应直接进入 Production。
