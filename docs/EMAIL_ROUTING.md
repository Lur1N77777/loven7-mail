# Cloudflare Email Routing 收件配置

安装器完成 Worker、D1、Admin、Webmail 和 KV 部署后，还必须为每个邮箱域名连接 Cloudflare Email Routing。完成本页并通过真实收件测试后，才能把邮箱视为完整可用。

本页是已经熟悉 Cloudflare 的速查表。第一次接入域名请阅读包含名称服务器、Active 状态、邮件 DNS、Catch-all 图示和排错的 [Cloudflare 域名与邮箱路由完整教程](CLOUDFLARE_DOMAIN_AND_EMAIL.md)。

## 开始前确认

- 每个邮箱域名都显示在本次安装所选的 Cloudflare 账号中，状态为 **Active**，且使用 Cloudflare 权威名称服务器。
- 你有权限修改这些域名的 DNS 和 Email Routing。
- 安装器最后输出的 Worker 名称已经存在，默认是 `<项目名前缀>-worker`。
- 如果域名当前正在使用企业邮箱、个人邮箱或其他邮件服务，先停止。启用 Cloudflare Email Routing 会修改 MX，可能中断原有收件；请先迁移或改用专门的子域名。

## 为每个域名开启收件

下面操作要对安装器列出的每个域名分别执行一次。当前入口位于账号级的 **Compute → Email Service → Email Routing**；旧版界面可能仍显示为域名内的 **Email → Email Routing**。

1. 登录 Cloudflare Dashboard，选择要部署的账号。
2. 打开 **Compute → Email Service → Email Routing**。
3. 选择 **Onboard Domain** 并接入一个邮箱域名；已接入时直接选择该域名。
4. 确认 Cloudflare 建议的 MX、SPF 和 DKIM 记录都已添加且状态正常。优先使用 Cloudflare 当前页面给出的值，不要从其他域名复制记录。
5. 打开 **Routing Rules**，找到 **Catch-all rule**；旧版界面可能叫 **Catch-all address**。
6. 将 Catch-all 设为 Active，并把 Action 设置为 **Send to a Worker**。
7. 在 Worker 列表中选择安装器输出的 Worker，例如 `loven7-mail-worker`。
8. 保存并确认 Catch-all 仍为 Active。
9. 对其余邮箱域名重复以上步骤，并始终选择同一个安装器 Worker。

这里不需要在 Cloudflare 中逐个创建临时邮箱地址。部署完成后，在 Loven7 Mail Admin 的地址或用户功能中创建邮箱；Catch-all 会把这个域名收到的邮件统一交给 Worker，再由 Worker 和 D1 处理。

## 真实验收

1. 打开安装器输出的 Admin 地址，使用安装时创建的管理员账号登录。
2. 创建一个使用目标域名的邮箱地址，例如 `check@your-domain.example`。
3. 使用 Gmail、Outlook、QQ 邮箱等与目标域名无关的外部邮箱，向该地址发送一封主题唯一的测试邮件。
4. 在 Admin 或 Webmail 中确认邮件出现，发件人、主题、正文和时间正确。
5. 每个已接入域名至少测试一次。
6. 创建一个分享链接，并在无痕窗口打开，确认分享链路也能读取邮件。

DNS 变更可能需要短暂传播。等待后仍收不到时，依次检查：域名是否 Active、Email Routing 是否已接入该域名、MX/SPF/DKIM 是否正常、Catch-all 是否 Active、Action 是否为 **Send to a Worker**、选择的 Worker 名是否正确。还可在 **Workers & Pages → 对应 Worker → Logs** 查看测试邮件到达时是否产生错误。

## 能力边界

- 本页完成的是收件。发件不会随 Email Routing 自动开启，需要另行配置 Resend、SMTP 或 Cloudflare Send Email。
- 安装器不会自动更改 DNS、MX 或 Catch-all，因为这些操作可能影响域名现有邮件业务。
- Pages 能打开、`/api/runtime` 为 `ok: true` 只证明应用基础设施正常，不证明公网邮件已经投递成功。

完成上述真实验收后，部署闭环才是：外部邮件 → Cloudflare MX/Email Routing → Catch-all → 邮件 Worker → D1 → Admin/Webmail。
