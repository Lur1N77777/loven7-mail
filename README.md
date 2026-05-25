# Loven7 Mail Cloudflare Suite

> 基于 Cloudflare Temp Mail / `cloudflare_temp_email` 上游接口的增强前端套件。
> 本项目不包含上游 Worker 后端源码，不内置私人 API、密码、Token、KV ID 或个人域名。

仓库地址：

```text
https://github.com/Lur1N77777/loven7-mail-cloudflare-suite
```

---

## 1 分钟最快部署：复制这一段给 AI Agent

如果你使用 Claude Code、Codex、OpenCode、Hermes、OpenClaw 或其他 AI 编程 / 运维 Agent，直接复制下面这一段话即可。**不要把 API、密码、Token 或密钥写进 Prompt。**

```text
请帮我部署这个 GitHub 项目到我的 Cloudflare 账号：https://github.com/Lur1N77777/loven7-mail-cloudflare-suite 。这是基于 Cloudflare Temp Mail / cloudflare_temp_email 官方 Worker API 的增强前端套件，包含 apps/admin 管理后台和 apps/webmail 用户站/分享站。请创建两个 Cloudflare Pages 项目：管理后台使用 apps/admin，构建命令 npm ci && npm run build，输出目录 dist；用户站使用 apps/webmail，构建命令 npm ci && npm run build，输出目录 dist。不要让我在这段 Prompt 里填写任何 API、密码、Token 或密钥，也不要把这些信息写入仓库；管理后台部署完成后，我会在网页界面的“连接设置”里填写自己的 Worker API 地址和管理员密码。分享功能如果需要 KV 或运行时变量，请通过 Cloudflare 控制台/安全配置完成，并生成必要密钥，但不要在最终回复中泄露密钥原文。部署完成后请返回管理后台 URL、用户站 URL，以及我下一步需要在界面里完成的配置。
```

更完整的 AI Agent 专用部署文档在：

```text
docs/AGENT_DEPLOY_PROMPT.md
```

---

## 界面预览

下面的截图使用脱敏示例数据制作，不包含真实 API、邮箱、Token、密码或个人域名。

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/admin-dashboard.svg" alt="管理后台仪表盘预览" />
      <br />
      <sub>管理后台：仪表盘、统计卡片和共享链接状态。</sub>
    </td>
    <td width="50%">
      <img src="docs/screenshots/admin-inbox.svg" alt="管理后台收件箱预览" />
      <br />
      <sub>收件箱：品牌头像、验证码识别、邮件阅读区。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/mobile-address-actions.svg" alt="手机端地址管理操作菜单预览" />
      <br />
      <sub>手机端地址管理：紧凑列表、三点菜单和批量浮动操作。</sub>
    </td>
    <td width="50%">
      <img src="docs/screenshots/webmail-share.svg" alt="用户站共享收件箱预览" />
      <br />
      <sub>用户站 / 分享站：自动刷新、共享收件箱和验证码快捷复制。</sub>
    </td>
  </tr>
</table>

## 这个项目是什么

Loven7 Mail Cloudflare Suite 是一套给 Cloudflare Temp Mail / `cloudflare_temp_email` 使用的增强前端，包含两个站点：

```text
apps/admin    管理员后台 PWA
apps/webmail  用户邮箱站 / 分享站，包含 Cloudflare Pages Functions
```

你可以把它接到自己已经部署好的 Cloudflare Temp Mail 官方 Worker 上，用自己的 Cloudflare 账号、自己的域名、自己的邮箱系统运行。

### 管理后台 `apps/admin`

用于管理临时邮箱系统：

- 仪表盘统计
- 邮箱地址管理
- 用户管理
- 收件箱、未知邮件、发件箱
- 邮件 HTML 渲染、验证码识别、品牌头像
- 发件、设置、维护工具
- 单邮箱 / 多邮箱分享入口
- 共享链接管理、撤回、恢复、批量操作

### 用户站 / 分享站 `apps/webmail`

用于给普通用户访问邮箱：

- 单邮箱 JWT 登录
- 单邮箱分享链接
- 多邮箱分享链接
- 聚合分享页
- 仅显示分享后新增邮件
- 访客侧“删除邮件”只隐藏当前分享视图，不影响后台真实邮件
- 邮件 HTML 安全渲染和自动刷新

---

## 手动部署教程

### 部署前准备

你需要先准备：

| 名称 | 示例 | 说明 |
| --- | --- | --- |
| Cloudflare Temp Mail Worker/API | `https://your-worker.workers.dev` | 你自己的上游 Worker/API 地址 |
| 管理员密码 | 不要写进仓库 | 上游 Worker 的 `x-admin-auth` 管理密码 |
| 站点密码 | 可选 | 如果上游 Worker 配置了 `x-custom-auth` 才需要 |
| Cloudflare KV | `SHARE_KV` | 分享链接功能需要 |
| 分享加密密钥 | 32 字符以上随机字符串 | 用户站环境变量 `SHARE_ENCRYPTION_SECRET` |

如果你还没有部署上游后端，请先部署 Cloudflare Temp Mail / `cloudflare_temp_email` 官方 Worker。

---

### 第 1 步：部署管理后台

在 Cloudflare Pages 新建项目，连接本 GitHub 仓库。

管理后台 Pages 设置：

| 设置项 | 值 |
| --- | --- |
| Project name | `loven7-mail-admin`，也可以自定义 |
| Root directory | `apps/admin` |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |

环境变量可以先不填。

部署完成后打开管理后台，在“连接设置”里填写：

- Worker API 地址
- 管理员密码
- 站点密码（如果有）

这些信息会保存在当前浏览器本地缓存里，不会提交到 GitHub。

可选环境变量：

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE` | 否 | 默认 Worker API 地址。公开部署建议留空，让用户在浏览器里填写。 |
| `VITE_FRONTEND_LOGIN_BASE` | 否 | 用户站 URL。也可以部署后在后台“系统设置”里保存。 |
| `VITE_APP_NAME` | 否 | 显示名称，默认 `Loven7-Mail`。 |

---

### 第 2 步：部署用户站 / 分享站

在 Cloudflare Pages 再新建一个项目，仍然连接本 GitHub 仓库。

用户站 Pages 设置：

| 设置项 | 值 |
| --- | --- |
| Project name | `loven7-mail-webmail`，也可以自定义 |
| Root directory | `apps/webmail` |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |

用户站必须设置运行时环境变量：

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `MAIL_WORKER_BASE_URL` | 必填 | 你的 Cloudflare Temp Mail Worker/API 地址 |
| `SITE_PASSWORD` | 可选 | 如果上游 Worker 开启了站点密码就填写 |
| `SHARE_ENCRYPTION_SECRET` | 使用分享功能时必填 | 用于加密分享记录，建议 32 字符以上随机字符串 |

分享功能还需要绑定 Cloudflare KV：

| Binding name | 类型 | 说明 |
| --- | --- | --- |
| `SHARE_KV` | KV Namespace | 保存分享链接、撤回状态、仅新增邮件 cutoff 和隐藏邮件记录 |

如果你只需要单邮箱 JWT 登录，不使用分享功能，可以暂时不绑定 KV；但管理后台里的分享创建和分享管理会不可用。

---

### 第 3 步：把管理后台连接到用户站

两个 Pages 项目都部署好以后：

1. 打开管理后台。
2. 进入“系统设置”。
3. 找到“前端登录链接前缀”。
4. 填入用户站 URL，例如：

```text
https://your-webmail.pages.dev
```

5. 保存。
6. 回到“地址管理”，选择一个邮箱，复制登录链接测试。
7. 再选择一个或多个邮箱创建分享链接，确认用户站能打开。

---

## 本地开发

```bash
# 管理后台
cd apps/admin
npm ci
npm run dev

# 用户站
cd ../webmail
npm ci
npm run dev
```

本地预览用户站 Pages Functions：

```bash
cd apps/webmail
npm run build
npx wrangler pages dev dist \
  --compatibility-date=2026-05-11 \
  --binding MAIL_WORKER_BASE_URL=https://your-worker.example.workers.dev \
  --binding SHARE_ENCRYPTION_SECRET=replace-with-a-long-random-secret
```

---

## 常见问题

### 后台刷新后又要求输入密码

请固定使用同一个正式域名访问后台。浏览器缓存按域名隔离，如果你每次打开不同的 Cloudflare Pages 预览域名，缓存不会共享。

### 用户站打不开邮件

检查 `MAIL_WORKER_BASE_URL` 是否填的是 Cloudflare Temp Mail Worker/API 地址，不要填管理后台 Pages URL。

### 分享功能提示 `SHARE_KV is not configured`

用户站 Pages 没有绑定 KV Namespace。请到 Cloudflare Pages 的 Functions / Bindings 里绑定 `SHARE_KV`。

### 分享功能提示 `SHARE_ENCRYPTION_SECRET is not configured`

用户站 Pages 没有设置分享加密密钥。添加 `SHARE_ENCRYPTION_SECRET` 后重新部署。

---

## 安全说明

- 不要把 Worker API 密钥、管理员密码、站点密码、GitHub Token、Cloudflare Token 写进仓库。
- 管理后台的连接信息默认保存在浏览器本地。
- 用户站的 `SITE_PASSWORD` 和 `SHARE_ENCRYPTION_SECRET` 只应作为 Cloudflare Pages 运行时环境变量保存。
- 本仓库不应包含 `node_modules/`、`dist/`、`.env.production`、`.wrangler/` 等本地或私有产物。

---

## 上游与许可证

本项目是 Cloudflare Temp Mail / `cloudflare_temp_email` 的增强前端套件。后端 Worker 请遵循上游项目的许可证和部署文档。

本仓库新增的前端代码按 MIT License 开源。
