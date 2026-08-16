# Cloudflare Email Routing 收件核验与排错

全新 Worker 模式正常完成时，安装器已经为每个邮箱域名启用 Cloudflare Email Routing，并把 Catch-all 自动绑定到安装器 Worker。本页用于验证真实收件，或在自动配置失败、发生冲突时手工排查。

第一次托管域名请阅读包含名称服务器、Active 状态、邮件 DNS、Catch-all 图示和排错的 [Cloudflare 域名与邮箱路由完整教程](CLOUDFLARE_DOMAIN_AND_EMAIL.md)。已有 Worker 模式不修改后端邮件路由，要求原 Worker 本来就能正常收件。

## 自动配置成功的标志

安装器末尾会显示：

```text
Email Routing：已自动启用 your-domain.example，Catch-all 已绑定到 loven7-mail-worker
```

这代表安装器已经：

1. 核验域名属于本次选择的 Cloudflare 账号。
2. 通过 Cloudflare 官方命令启用 Email Routing 和必要邮件 DNS。
3. 使用 Worker 配置中的 `*@域名` 声明，把 Catch-all 绑定到 `<项目名前缀>-worker`。

Cloudflare Email Routing 绑定的是 Worker 服务名称，不需要用户先取得 `*.workers.dev` URL。该 URL 主要供 Admin 和 Webmail 连接后端。

## 真实验收

1. 打开安装器输出的 Admin 地址，使用安装时创建的管理员账号登录。
2. 创建一个使用目标域名的邮箱地址，例如 `check@your-domain.example`。
3. 使用 Gmail、Outlook、QQ 邮箱等与目标域名无关的外部邮箱，向该地址发送一封主题唯一的测试邮件。
4. 在 Admin 或 Webmail 中确认邮件出现，发件人、主题、正文和时间正确。
5. 每个已接入域名至少测试一次。
6. 创建一个分享链接，并在无痕窗口打开，确认分享链路也能读取邮件。

DNS 变更可能需要短暂传播。只有真实外部邮件出现，才能证明 MX、Email Routing、Catch-all、Worker、D1 和前端闭环全部正常。

## 自动配置失败或收不到邮件

登录 Cloudflare Dashboard，进入账号级 **Compute → Email Service → Email Routing**；旧版界面可能仍显示为域名内的 **Email → Email Routing**。对安装器列出的每个域名核对：

1. 域名状态是 **Active**，并位于安装时选择的同一 Cloudflare 账号。
2. Email Routing 已启用，Cloudflare 建议的 MX、SPF 和 DKIM 记录状态正常。
3. **Routing Rules** 中的 **Catch-all rule** 为 Active。
4. Action 是 **Send to a Worker**。
5. Worker 是安装器输出的 `<项目名前缀>-worker`。

如果安装器提示已有 Catch-all 或 destructive changes，它会先停止。只有你在中文提示和 Wrangler 官方变更计划中都确认后，安装器才会接管冲突规则；拒绝时不会覆盖现有邮件路由。

这里不需要在 Cloudflare 中逐个创建临时邮箱地址。邮箱地址应在 Loven7 Mail Admin 中创建，Catch-all 会把该域名的来信统一交给 Worker。

仍收不到时，打开 **Workers & Pages → 对应 Worker → Logs**，重新发送测试邮件：完全没有日志时优先检查 MX 和 Catch-all；已有日志但报错时再检查 Worker、D1 和管理员配置。

## 能力边界

- 安装器不会购买域名、更换名称服务器，域名必须预先托管到 Cloudflare 并显示 Active。
- 自动修改邮件 DNS 前必须得到明确确认；安装器不会静默覆盖已有 Catch-all。
- 发件不会随 Email Routing 自动开启，需要另行配置 Resend、SMTP 或 Cloudflare Send Email。
- Pages 能打开、`/api/runtime` 为 `ok: true` 只证明应用基础设施正常，不证明公网邮件已经投递成功。

完整闭环是：外部邮件 → Cloudflare MX/Email Routing → Catch-all → 邮件 Worker → D1 → Admin/Webmail。
