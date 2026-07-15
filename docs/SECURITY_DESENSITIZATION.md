# 脱敏与发布检查

公开仓库的目标不是“当前文件看不到密码”，而是源码、文档、截图、构建配置和 Git 历史都不包含任何部署者的私有信息。

## 自动门禁

```bash
npm run check:public
```

门禁检查：

- 必要的公开文档、CHANGELOG 和版本策略是否存在。
- 内部审计、生产 runbook 和本机工作区材料是否被错误发布。
- 文档、配置和部署脚本是否含私人 URL 或本机绝对路径。
- Pages 项目名和包名是否仍绑定自用部署。
- `check:release` 与 CI 是否包含脱敏门禁。

## 人工检查

- [ ] 没有 `.env`、`.env.local`、`.env.production` 或真实 `.dev.vars`。
- [ ] 没有真实 Worker/API/Pages 域名、自定义域名或内部 IP。
- [ ] 没有 Cloudflare Account ID、KV/D1/R2 ID、Zone ID 或部署 ID。
- [ ] 没有管理员/站点密码、API Token、PAT、JWT、Cookie、OAuth client secret 或分享密钥。
- [ ] 没有真实邮箱、用户资料、邮件正文、客服工单或访问日志。
- [ ] README 截图全部来自本地 mock，使用 `.test`/`.example` 数据。
- [ ] 没有本机用户名、磁盘路径、临时目录、备份路径或编辑器会话文件。
- [ ] Release 附件没有额外打包 ignored 文件、环境文件或部署产物。
- [ ] Git 历史和 Actions 日志也经过检查，而不只是当前工作树。

## 允许出现

- Loven7 默认品牌、Logo、通用 UI 资产。
- `example.com`、`.example`、`.test`、`.invalid`、localhost 和明确占位符。
- GitHub、Cloudflare、npm、Node.js 等公开官方文档链接。
- `MAIL_WORKER_BASE_URL`、`ADMIN_PASSWORD` 等变量名，但不能出现真实值。
- 注释掉的 KV 配置模板和 `replace-with-*` 占位符。

## 推荐扫描

```bash
rg -n --hidden -S "password|secret|token|account[_-]?id|namespace[_-]?id|https?://" . \
  -g '!node_modules/**' -g '!dist/**' -g '!.git/**'
```

结果需要人工判断：变量名、测试数据和公开文档链接可以存在，真实值不可以。再用组织内部域名、用户名、项目名和 Secret 前缀做一次定向扫描，但不要把这些关键词写回公开扫描脚本。

## 截图

文档截图必须由 `npm run docs:screenshots` 的本地 mock 生成。生成后逐张检查：

- 地址使用 `.test` 或 `.example`。
- 连接设置使用 `https://webmail.example.com` 等保留示例。
- 不展示浏览器书签、账户头像、Cloudflare 控制台或系统路径。
- 不包含可用的 JWT、密码、验证码或分享 Token。

## 发现泄露

1. 立即撤销或轮换 Secret；不要等待 Git 历史清理。
2. 停止自动部署，评估 GitHub Fork、Release、Actions 日志和缓存范围。
3. 从当前工作树和 Git 历史删除敏感值。
4. 重新运行门禁和人工清单。
5. 按 [SECURITY.md](../SECURITY.md) 私密记录事件，不在公开 Issue 粘贴证据原文。

更完整的公开/私有分层方式见 [配置边界](CONFIGURATION_BOUNDARY.md)。
