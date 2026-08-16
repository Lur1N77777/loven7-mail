# 发布到 GitHub

## 首次发布

先登录 GitHub CLI：

```bash
gh auth login -h github.com
```

在仓库根目录运行公开发布门禁：

```bash
npm run check:public
npm run check:release
git diff --check
git status --short
```

确认只包含预期公开文件后，可使用仓库脚本：

```powershell
.\scripts\publish-github.ps1 -RepoName loven7-mail
```

macOS / Linux / Git Bash：

```bash
bash scripts/publish-github.sh loven7-mail
```

脚本只负责创建/连接 GitHub 仓库并推送源码，不会配置 Cloudflare 或上传 Secret。

## 推送到已有仓库

```bash
git remote add origin https://github.com/<OWNER>/<REPOSITORY>.git
git branch -M main
git push -u origin main
```

`<OWNER>` 与 `<REPOSITORY>` 是明确占位符。不要在 remote URL 中嵌入 GitHub Token。

## 发版

1. 更新 `CHANGELOG.md` 与版本号。
2. 确认 CI 全绿。
3. 创建并推送 `vMAJOR.MINOR.PATCH` tag。
4. 检查 Release 附件只包含公开源码与校验文件。

完整规则见 [版本策略](VERSIONING.md)。Cloudflare 部署见 [GitHub Actions](GITHUB_ACTIONS.md)。

## 发布前禁止项

- 不提交 `.env`、`.dev.vars`、`wrangler.local.toml`、`dist` 或本机缓存。
- 不提交真实域名、Pages/KV 项目名、资源 ID、密码、Token 或生产运维记录。
- 不把自用配置写入 README 后再“稍后删除”；Git 历史仍会保留。
- 如果曾经提交 Secret，先撤销/轮换，再清理历史；只删除当前文件不够。
