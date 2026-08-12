<div align="center">

<img src="docs/assets/loven7-mail-logo.svg" alt="Loven7 Mail logo" width="96" height="96" />

# Loven7 Mail Cloudflare Suite

一套面向 Cloudflare Temp Mail / `cloudflare_temp_email` 的现代化双站前端：管理后台、用户邮箱、分享链接与 Pages Functions 集中维护。

<p>
  <a href="https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Lur1N77777/loven7-mail-cloudflare-suite?style=flat-square" /></a>
  <img alt="React" src="https://img.shields.io/badge/React-19-555?style=flat-square&logo=react&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-555?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Cloudflare Pages" src="https://img.shields.io/badge/Cloudflare-Pages-555?style=flat-square&logo=cloudflarepages&logoColor=white" />
  <a href="https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/actions/workflows/ci.yml"><img alt="Build" src="https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/actions/workflows/ci.yml/badge.svg" /></a>
</p>

[快速开始](#快速开始) · [界面预览](#界面预览) · [功能](#功能) · [收件配置](#收件配置) · [文档](#文档)

</div>

> 这是可复用的公开版前端仓库，不包含任何部署者的 Worker 地址、Cloudflare 资源 ID、域名、账号、密码、Token、密钥或生产运维记录。所有私有值都在部署平台或浏览器中注入。

## 快速开始

<table>
  <tr>
    <td width="33%" valign="top">
      <strong>1. 下载启动器</strong><br />
      Windows 用户下载并双击 <a href="https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/latest/download/Install-Loven7-Mail.cmd"><code>Install-Loven7-Mail.cmd</code></a>。
    </td>
    <td width="33%" valign="top">
      <strong>2. 授权 Cloudflare</strong><br />
      在浏览器完成 Wrangler OAuth，选择 Cloudflare 账号并按提示输入域名和管理员信息。
    </td>
    <td width="33%" valign="top">
      <strong>3. 接通真实收件</strong><br />
      为每个域名开启 Email Routing，将 Catch-all 指向安装器创建的 Worker。
    </td>
  </tr>
</table>

> **最短路径：** 只想部署并使用项目时，直接下载 [Windows 单文件安装器](https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/latest/download/Install-Loven7-Mail.cmd)。不需要 Git，不需要克隆仓库，也不需要先安装 Node.js。

### 部署前准备

| 需要准备 | 说明 |
| --- | --- |
| Cloudflare 账号 | 需要能管理目标域名，并允许 Wrangler OAuth 创建资源 |
| 已托管域名 | 域名状态为 Active，并使用 Cloudflare 权威 DNS；可一次填写多个域名 |
| 管理员信息 | 安装时输入首个管理员邮箱和密码，密码不会显示或写入仓库 |

> **重要边界：** 安装器可以部署 Worker、D1、Pages 和 KV，但不会替你修改 DNS、MX 或 Catch-all。完成部署后，必须按 [Email Routing 收件配置](docs/EMAIL_ROUTING.md) 完成最后一步，并发送真实测试邮件。

## v0.4.0 · 一键部署与多域名支持

这一版把“从源码到可用邮箱”的路径收拢到一个安装器中，同时保留已有 Worker 接入能力。管理后台继续采用 **Paper, Ink & Sealing Wax** 设计语言：暖灰纸面、墨黑主操作与陶土红强调色贯穿仪表盘、统计、地址、用户、收发件、系统设置和维护页面。

- Windows 用户可以下载一个 `.cmd` 文件完成安装器引导，失败后再次打开会从断点继续。
- 新 Worker 模式支持一次配置多个邮箱域名，第一个域名作为默认域名。
- 安装器会校验远端资源、保护 Secret、复用健康后端，并对 Admin、Webmail 和 `/api/runtime` 做有限重试验收。
- 默认能力覆盖收件、Admin、Webmail、分享和已读/星标同步；发件仍需要额外配置 Resend、SMTP 或 Cloudflare Send Email。

## 界面预览

### Admin · Paper, Ink & Sealing Wax

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>运营概览</strong><br />
      <sub>邮件流量、地址活跃、站点规模与能力状态。</sub><br /><br />
      <img src="docs/screenshots/admin-dashboard.png" alt="Admin 运营概览" />
    </td>
    <td width="50%" valign="top">
      <strong>收件箱工作区</strong><br />
      <sub>高密度邮件列表、阅读器与快捷操作。</sub><br /><br />
      <img src="docs/screenshots/admin-inbox.png" alt="Admin 收件箱工作区" />
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>系统设置</strong><br />
      <sub>界面、连接、邮件规则和账户策略分区管理。</sub><br /><br />
      <img src="docs/screenshots/admin-connection-settings.png" alt="Admin 系统设置" />
    </td>
    <td width="50%" valign="top">
      <strong>移动端地址管理</strong><br />
      <sub>完整保留地址列表、底部导航和快捷操作菜单；点击截图可查看原图。</sub><br /><br />
      <a href="docs/screenshots/mobile-address-list.png"><img src="docs/screenshots/mobile-address-list.png" alt="Admin 移动端地址列表完整截图" height="360" /></a>
      <a href="docs/screenshots/mobile-address-actions.png"><img src="docs/screenshots/mobile-address-actions.png" alt="Admin 移动端快捷操作完整截图" height="360" /></a>
    </td>
  </tr>
</table>

### Webmail · 登录与分享

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/webmail-login.png" alt="Webmail 邮箱登录" /></td>
    <td width="50%" valign="top"><img src="docs/screenshots/webmail-share.png" alt="Webmail 多邮箱分享" /></td>
  </tr>
</table>

## 项目组成

| 应用 | 目录 | 作用 |
| --- | --- | --- |
| Admin | `apps/admin` | 地址、用户、收发件、分享、系统设置与维护工具 |
| Webmail | `apps/webmail` | 用户登录、邮箱阅读、单/多邮箱分享与 Pages Functions |

本仓库提供前端和 Pages Functions，并通过安装器支持接入兼容的 Cloudflare Temp Mail / `cloudflare_temp_email` Worker，或从锁定的官方 `v1.10.0` 开始创建 Worker、D1 与首个管理员账号。新 Worker 模式支持一次配置多个邮箱域名，第一个为默认域名；每个域名的 DNS 和 Email Routing 仍由部署者最终确认。

## 功能

- 管理后台：仪表盘、地址/用户管理、收件箱、未知邮件、发件箱、分享管理与维护入口。
- 用户邮箱：邮箱密码/JWT 登录、自动刷新、验证码识别与复制、移动端自适应。
- 分享能力：单邮箱、多邮箱、聚合分享、仅新增邮件、撤回、过期与访客隐藏。
- 邮件安全：HTML 沙箱、远程图片保护、附件处理、品牌头像代理与请求预算。
- 工程能力：TypeScript、PWA、双 Pages 构建、运行时诊断、CI、脱敏门禁和发布检查。

## 一条命令部署

### Windows：下载一个文件启动

直接在 [GitHub Releases](https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/latest) 下载并双击 [`Install-Loven7-Mail.cmd`](https://github.com/Lur1N77777/loven7-mail-cloudflare-suite/releases/latest/download/Install-Loven7-Mail.cmd)。启动器会自动下载经过 SHA-256 校验的正式安装包，准备 Node.js 22，打开 Wrangler 的 Cloudflare 官方 OAuth 授权，并启动同一套新手安装器。安装文件会保存在当前 Windows 用户的 `%LOCALAPPDATA%\Loven7Mail\installer`，失败后再次双击会从断点继续。

首次从零部署官方 Worker 时，启动器会在缺少 Git 时自动下载官方 MinGit 便携版到用户目录；已有兼容 Worker 的接入不需要 Git。Git 只用于临时下载锁定的上游 Worker，安装结束后上游临时目录会自动删除。

克隆或 Fork 本仓库后运行：

```bash
npm run setup
```

安装器会先询问是否已有兼容 Worker。选择“是”时，它会只读验证 Worker、站点密码和管理员口令，再接入现有 Worker；选择“否”时，可以输入一个或多个邮箱域名（逗号分隔），安装器会锁定并克隆官方 `v1.10.0`、创建 D1、初始化 schema、写入 Worker Secret，再自动创建或复用两个 Pages 项目、分享 KV 和邮件状态 KV，完成 Admin 代理和 `/api/runtime` 验收。

密码不会显示，也不会保存到仓库或安装状态文件。失败后再次运行相同命令会复用已创建资源，并保留已有分享密钥。

一条命令默认覆盖收件、Admin、Webmail、分享和已读/星标同步。发件需要部署者另行选择并配置 Resend、SMTP 或 Cloudflare Send Email；安装器不会自动创建外部发件账号或写入发件凭据。

```bash
npm run setup:plan
```

上述命令只显示安装计划，不连接 Cloudflare。完整说明见 [新手安装器](docs/INSTALLER.md)；安装后必须按 [Email Routing 收件配置](docs/EMAIL_ROUTING.md) 为每个域名接通真实邮件。

首次完整部署优先使用本地交互式终端运行 `npm run setup`，因为密码需要在不回显的 TTY 中安全输入。无法使用交互式终端时，[AI Agent Pages-only 部署指令](docs/AGENT_DEPLOY_PROMPT.md) 和下面的人工步骤只适用于已有兼容 Worker 的前端接入，不会替你创建 Worker、D1 或 Email Routing。

## 收件配置

基础设施部署完成后，对每个邮箱域名执行一次：

1. 打开 Cloudflare **Email → Email Routing**，确认建议的 MX/TXT 记录已添加。
2. 进入 **Routing rules → Catch-all**，选择 **Send to a Worker**。
3. 选择安装器输出的 Worker，例如 `<项目名前缀>-worker`，保存规则。
4. 在 Admin 创建一个该域名的邮箱，用 Gmail、Outlook 或 QQ 邮箱发送真实测试邮件。

> 页面能打开或 `/api/runtime` 返回 `ok: true`，只代表应用基础设施正常；收到真实外部邮件，才代表收件链路完整。

详见 [Email Routing 收件配置](docs/EMAIL_ROUTING.md)。

## 手动部署（已有 Worker）

### 1. 准备

- 一个可用的 Cloudflare 账号。
- 一个已部署且 API 兼容的邮件 Worker。
- 将本仓库 Fork 到你自己的 GitHub 账号。

这一节只讲“已有 Worker”的人工接入。没有 Worker 的新手请优先运行 `npm run setup`；安装器会从锁定的官方版本创建 Worker 和 D1，人工流程仍需你自行部署上游后端。

### 2. 创建 Admin Pages

在 Cloudflare Dashboard 打开 **Workers & Pages → Create → Pages → Connect to Git**，选择你的 Fork：

| 设置 | 值 |
| --- | --- |
| Project name | `loven7-mail-admin`（可自定义） |
| Root directory | `apps/admin` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |

然后在 Admin Pages 的 **Settings → Variables and Secrets → Production** 设置：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | Secret | 你的邮件 Worker 根地址，例如 `https://worker.example.com` |
| `ADMIN_PASSWORD` | Secret | Worker 的管理员密码，仅由 Pages Functions 使用 |
| `SITE_PASSWORD` | Secret，可选 | Worker 开启站点密码时填写 |

不要设置 `VITE_API_BASE`。默认同域 Pages Functions 代理能避免把管理员密码打进浏览器构建产物。

### 3. 创建 Webmail Pages

先等待 Admin 的 Production 部署完成并记录实际 origin；Webmail 的 CORS 配置必须使用这个地址，不能提前猜测，也不能填写 Webmail 自己的 origin。

再次导入同一个 Fork：

| 设置 | 值 |
| --- | --- |
| Project name | `loven7-mail-webmail`（可自定义） |
| Root directory | `apps/webmail` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |

在 Webmail Pages 的 **Production** 运行时设置中添加：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | Secret | 与 Admin 相同的 Worker 根地址 |
| `SITE_PASSWORD` | Secret，可选 | Worker 开启站点密码时填写 |
| `SHARE_ENCRYPTION_SECRET_V2` | Secret | 至少 32 字节的高熵随机值；新部署推荐只写 V2 |
| `SHARE_ADMIN_CORS_ORIGINS` | Variable | Admin 的完整 origin，例如 `https://admin.example.com`；禁止 `*` |

在 **Settings → Bindings → KV namespace bindings** 创建或选择一个 KV Namespace，绑定名必须是 `SHARE_KV`。如需 Admin 与 Webmail 跨设备共享已读/星标状态，再给两个项目绑定同一个 KV，绑定名均为 `MAIL_READ_STATE_KV`。

Preview 与 Production 的变量、Secret 和 KV 绑定相互独立。需要预览完整功能时，请在 Preview 环境重复配置；否则只使用 Production。

使用直接上传脚本复用已有项目时，显式设置 `ADMIN_PAGES_PROJECT_NAME` 和 `WEBMAIL_PAGES_PROJECT_NAME`。只有确认 Preview 已配置完整运行时后，才设置本地确认标记 `WEBMAIL_PREVIEW_RUNTIME_CONFIRMED=1`。

### 4. 验收

如果 Pages 项目在运行时配置完成前已经自动构建，先各触发一次新的 Production 部署。随后依次检查：

1. 打开 Webmail 的 `/api/runtime`，确认 `ok: true`；接口只报告配置状态，不返回 Secret。
2. 使用上游用户账号登录 Admin，确认仪表盘和收件箱可加载。
3. 在 Admin 的“系统设置 → 前端登录链接前缀”填写 Webmail URL，例如 `https://webmail.example.com`。
4. 新建一条分享链接并在无痕窗口打开，确认邮件列表正常。

如 `/api/runtime` 不完整，按返回的 `missing` 和 `hints` 补配置后重新部署。

## 本地开发

要求 Node.js 22+。两个应用独立安装依赖：

```bash
npm --prefix apps/admin ci
npm --prefix apps/webmail ci
npm --prefix apps/admin run dev
```

另开一个终端启动 Webmail：

```bash
npm --prefix apps/webmail run dev
```

提交前运行完整检查：

```bash
npm run check:public
npm run check:release
```

部署后可执行只读运行时探针：

```bash
WEBMAIL_RUNTIME_URL=https://webmail.example.com npm run check:cloudflare:runtime
```

## 公开版与自用配置边界

公开仓库只保存通用代码、示例占位符和可复用文档；自用信息只存在于 Cloudflare/GitHub Secret、部署平台变量或本机 ignored 文件。

| 可以提交 | 不得提交 |
| --- | --- |
| `*.example`、`.dev.vars.example`、注释掉的 KV 占位符 | `.env`、`.dev.vars`、真实 Worker/站点域名 |
| 通用 Pages 项目名和构建说明 | Cloudflare Account ID、KV/D1/R2 ID |
| Loven7 品牌、通用截图和示例数据 | 密码、Token、JWT、Cookie、分享密钥 |
| 通用排错与升级说明 | 自用生产清单、内部审计报告、客户或真实邮箱数据 |

边界、同步方法和私有 overlay 建议见 [公开版与私有配置边界](docs/CONFIGURATION_BOUNDARY.md)。`npm run check:public` 会在 CI 中阻止常见私人域名、本机路径和生产材料重新进入公开仓库。

## 版本与升级

项目遵循 Semantic Versioning：修复用 PATCH，向后兼容功能用 MINOR，破坏性配置/API 变化用 MAJOR。每次升级先阅读 [CHANGELOG](CHANGELOG.md)，在 Preview 环境验证，再升级 Production。

公开代码与自用配置分离后，升级只同步源码；不要把生产变量反向复制到公开分支。完整策略见 [版本策略](docs/VERSIONING.md)。

## 文档

| 文档 | 用途 |
| --- | --- |
| [部署速查](docs/DEPLOYMENT_QUICKSTART.md) | 最短的人工部署清单 |
| [新手安装器](docs/INSTALLER.md) | 一条命令部署、重试与安全边界 |
| [Email Routing](docs/EMAIL_ROUTING.md) | 逐域名配置 Catch-all 和真实收件验收 |
| [AI Agent Pages-only 部署指令](docs/AGENT_DEPLOY_PROMPT.md) | 已有 Worker 时部署两个前端的安全提示词 |
| [Cloudflare Pages](docs/CLOUDFLARE_PAGES.md) | 变量、KV、Preview、探针与排错 |
| [GitHub Actions](docs/GITHUB_ACTIONS.md) | CI 与可选自动部署 |
| [配置边界](docs/CONFIGURATION_BOUNDARY.md) | 公开源码和自用配置如何长期分离 |
| [版本策略](docs/VERSIONING.md) | 发版、升级与兼容约定 |
| [项目结构](docs/PROJECT_STRUCTURE.md) | 模块职责和维护入口 |
| [安全脱敏](docs/SECURITY_DESENSITIZATION.md) | 发布前检查与响应流程 |
| [上游关系](docs/UPSTREAM.md) | 与邮件 Worker 的职责边界 |

## 开源与安全

MIT License。欢迎 Issue 和 PR；贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请不要公开披露，按 [SECURITY.md](SECURITY.md) 的方式报告。

感谢 [LinuxDo 社区](https://linux.do/) 对开源交流和开发者协作的支持。
