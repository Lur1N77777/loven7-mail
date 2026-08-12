# 开发反思报告

**日期**: 2026-08-12
**提交类型**: feature
**修改文件数**: 21 个安装器、测试、配置与文档文件

## 1. 概述

为 Loven7 Mail 增加面向新手的一条命令安装器。安装器既能接入已有兼容 Worker，也能从单一锁定文件指定的官方 `cloudflare_temp_email` release 创建 Worker、D1、首个管理员、两个 Pages 项目和两个 KV，并在失败后安全续装。

## 2. 修改内容

- 新增 `npm run setup` 与只读的 `npm run setup:plan`。
- 锁定上游 release、完整提交、pnpm 和 Worker Wrangler 版本。
- 自动创建或复用 Pages、KV、D1 和 Worker，远程初始化 D1 schema。
- 通过标准输入写入 Worker 与 Pages Secret，不在仓库或断点状态中保存敏感值。
- 自动创建首个用户、验证登录密码、赋予管理员角色并验证管理员令牌。
- 为 Worker、Admin 和 Webmail 在线探针加入有限重试。
- 对断点中的 KV、D1 ID 和 Worker 归属证据重新核验，避免复用陈旧或陌生资源。
- 更新 README、部署速查、上游边界、Changelog 和公开发布门禁。

## 3. 遇到的错误

1. **Windows 子进程兼容问题（严重）**：Node.js 在 Windows 直接启动 `npm.cmd`、`npx.cmd` 和 `corepack.cmd` 返回 `EINVAL`；同时把所有命令统一追加 `.cmd` 会把可用的 `git.exe` 误写成不存在的 `git.cmd`。
2. **Cloudflare 最终一致性（重要）**：Worker Secret 和 Pages Production 发布完成后，健康检查与运行时 binding 可能短时间仍返回旧状态。
3. **陈旧断点资源（重要）**：本地保存 D1 或 KV ID 不代表远端资源仍存在，人工删除后直接复用会把无效 ID 写进部署配置。
4. **资源归属证据过早（重要）**：只保存计划中的 Worker 名称会把一个尚未成功部署的同名 Worker误判为安装器已经创建的资源。
5. **Pages 分支假设（重要）**：强制 `--branch main` 会在复用生产分支不是 `main` 的 Pages 项目时创建 Preview，而不是更新 Production。
6. **重复账号选择（重要）**：新 Worker 流程内部再次调用前端安装流程，会让多账号用户选择两次，且可能把 Worker 与 Pages 部署到不同账号。
7. **续装域名漂移（重要）**：断点只按账号和前缀匹配时，误输入新域名会静默更新现有 Worker 的域名配置。
8. **受保护 Worker 续装（重要）**：Wrangler 只能列出 `PASSWORDS` Secret 名称，不能读取原值；用户留空时安装器无法向受保护端点发起健康检查。
9. **测试与公开门禁冲突（次要）**：测试夹具中的绝对路径和非示例 Worker 域名会被脱敏门禁正确拦截；Pages 命令测试也需要自包含的最小 `dist/functions` 夹具。
10. **运行时配置只验存在性（重要）**：`/api/runtime` 能证明变量和 KV binding 存在，但不能证明 Worker 地址、站点密码、管理员口令或 Admin 代理链路真实可用。
11. **“所有功能”边界（重要）**：收件与前端能力可由 Cloudflare 内部资源完成，而发件仍需要 Resend、SMTP 或 Send Email 的额外凭据/binding，不能在无授权时自动配置。
12. **Pages 旧站点凭据（重要）**：Worker 已关闭站点密码但 Pages 仍保存旧 `SITE_PASSWORD` 时，前端会继续发送过期凭据；静默保留并不安全。
13. **重复部署覆盖扩展 binding（严重）**：用户安装后可能手工添加 Resend、SMTP 或 Send Email；无条件重部署锁定 Worker 配置会覆盖这些安装器不知道的扩展 binding。
14. **Wrangler 部署列表不保证返回公开 URL（重要）**：续装时依赖 `deployments list --json` 猜测 `workers.dev` 地址，在真实 CLI 返回结构不含 URL 时会让安全复用失效。
15. **部署模式切换污染断点（重要）**：同一项目前缀从新 Worker 模式切换到已有 Worker 模式时，旧托管后端元数据可能残留，并在后续续装中被误当作当前后端证据。

## 4. 根本原因分析

- 安装器最初把 Windows 命令 shim、原生可执行文件和 Node CLI 当成同一种启动方式，没有验证真实 Node 子进程行为。
- 云资源创建、Secret 发布和边缘部署不是强一致事务，单次立即探针不足以代表失败。
- 续装状态只能证明安装器曾观察到什么，不能替代每次运行时对远端资源的重新确认。
- “名称一致”不等于“资源归属一致”；归属必须来自成功完成的不可伪造阶段证据或用户确认。
- Pages 的 Production 分支属于项目配置，安装器不应把仓库默认分支硬编码为所有项目的部署分支。
- 一个连续安装事务应复用同一个已选择账号；续装中会改变现有 Worker 语义的输入必须再次确认。
- Secret 不可读时，安装器应明确要求用户再次提供验证所需的当前值，而不是在后续探针阶段给出模糊错误。
- 配置诊断和业务连通性是两个层次；完整部署验收必须同时覆盖 binding 存在性和只读 API 链路。
- 安装器应明确区分默认能力与需要第三方授权的可选能力，不能用“一键部署”暗示已经获得外部发件权限。
- 不可读的 Secret 不能靠“保留”解决配置漂移；如果无法确认当前值，安装器应停止并要求用户输入或明确删除。
- 修复型安装应优先验证并复用健康后端；只有后端资源或声明式核心配置变化时才重新发布，避免把前端修复变成后端配置回滚。
- 可复用的公开地址应在首次部署和业务验收成功时记录；CLI 的部署历史元数据不能替代安装器自己的已验证状态。
- 断点状态需要记录当前安装模式，并在模式切换开始时清除不属于该模式的字段，不能只在流程完成时清理。

## 5. 调试过程

1. 审查现有安装流程、状态文件、上游锁定版本和 Wrangler 命令参数。
2. 用真实 Node 子进程分别启动 npm、npx、Corepack 和 Git，复现 Windows `EINVAL`。
3. 改为通过当前 Node 可执行文件调用 npm/npx 的 JavaScript CLI，并最终用锁定版 pnpm 消除 Corepack 前置条件。
4. 为健康检查、Admin 和 `/api/runtime` 建立可配置的有限重试，并用零延迟测试验证失败后恢复。
5. 为 D1、KV 和 Worker 增加陈旧断点、同名陌生资源及部署阶段证据测试。
6. 使用已登录账号执行只读 Wrangler 命令，仅核对返回字段、错误码和 Secret 列表格式，不输出资源值。
7. 修正 Pages 直传为使用项目自身 Production 分支，并补命令级测试。
8. 让新 Worker 与前端阶段复用同一账号，并为续装域名或锁定提交变化增加确认测试。
9. 对已有 `PASSWORDS` Secret 增加前置检查，要求输入当前站点密码后才继续部署。
10. 在资源创建前验证 Worker 健康与管理员 API，部署后通过 Admin Pages Function 再验证一次代理链路。
11. 在文档与完成提示中标明发件服务的额外配置边界。
12. 对 Pages 残留 `SITE_PASSWORD` 增加前置阻断，避免续装后继续使用过期站点凭据。
13. 为已完成 Worker 与管理员验收的同配置续装增加复用快路径，只验证后端并重新部署前端。
14. 将公开 `*.workers.dev` 根地址作为专用的 `managedWorkerOrigin` 保存，续装不再依赖 Wrangler 部署列表猜测 URL；已有 Worker 私有地址继续脱敏。
15. 增加安装模式字段，并在切换到已有 Worker 模式时立即清理旧托管后端元数据。
16. 运行公开脱敏、Cloudflare 预检、安装器测试、双前端测试、Functions 回归、构建和浏览器 smoke。

## 6. 经验总结

- 跨平台 CLI 必须测试“真实进程能否启动”，只测试拼出的命令字符串不足以发现 Windows shim 问题。
- 云部署探针应区分短暂未就绪和持续失败，重试次数必须有限且最终错误要保留最后一次原因。
- 可续装安装器的状态文件应最小化、脱敏，并把远端资源重新核验视为正常流程。
- 自动复用资源必须同时考虑名称、ID、账号、阶段证据和用户确认，不能只依赖一个字段。
- 部署工具应尊重平台项目配置，避免把本仓库的分支、域名或账号假设强加给 Fork 用户。

## 7. 知识提炼

- 可复用模式：单一锁定文件驱动上游仓库、release、提交和工具链版本，代码与文档只读取该来源。
- 可复用模式：Secret 通过标准输入写入，状态文件只保存恢复流程所需的非敏感标识。
- 可复用模式：资源复用采用“按已知 ID 核验 -> 按名称发现 -> 对归属变化确认 -> 创建”的顺序。
- 可复用模式：先用纯命令契约测试覆盖参数，再用只读真实 CLI 调用核对返回结构。
- 应避免：把单次 HTTP 失败视为部署失败、把资源名视为所有权、把 `main` 视为所有 Fork 的 Production 分支。

## 8. 测试与验证

- 安装器测试：46/46 通过。
- Admin 前端测试：85/85 通过。
- Webmail 前端测试：31/31 通过。
- 安装器所有 `.mjs` 文件通过 Node 语法检查。
- 公开脱敏、Cloudflare Pages 预检、Admin TypeScript、Webmail Functions 回归、双应用构建和双端浏览器 smoke 全部通过。
- `git diff --check` 通过；暂存内容不包含构建产物、安装状态、真实账号、资源 ID 或 Secret。

## 9. 参考资料

- 安装器入口：`scripts/installer/cli.mjs`
- 安装流程：`scripts/installer/installer.mjs`
- Cloudflare 命令适配：`scripts/installer/cloudflare.mjs`
- 上游锁定：`deployment/upstream-lock.json`
- 新手文档：`docs/INSTALLER.md`
- 发布门禁：`package.json` 中的 `check:release`

## 10. 指标

- 安装器专项测试：21 -> 46
- 支持模式：已有 Worker + 从零部署锁定官方 Worker
- 自动管理运行单元：1 个 Worker、1 个 D1、2 个 Pages、2 个 KV
- 用户必须手工完成的关键步骤：Email Routing/DNS/Catch-all 与真实邮件验收

---
**生成工具**: Codex
**技能**: commit-with-reflection v3.0
