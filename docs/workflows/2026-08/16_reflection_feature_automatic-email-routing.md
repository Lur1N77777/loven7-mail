# 开发反思报告

**日期**: 2026-08-16
**提交类型**: feature
**修改文件数**: 31 个安装器、测试、发行配置、版本文件与文档文件

## 1. 概述

把 Loven7 Mail 的新手安装器从“部署基础设施后手工配置邮箱路由”升级为完整的自动化闭环，同时把邮件接管改成两阶段 Worker 部署：先准备并验收不接管邮件的核心 Worker，再启用 Email Routing、应用 Catch-all 并在线确认结果。Windows 用户仍然只需下载并双击一个文件。

## 2. 修改内容

- 修复 Windows 单文件启动器中的 PowerShell 变量转义与 npm 参数透传。
- 在系统缺少 Git 时统一准备官方 MinGit，保证运行中选择全新安装也能下载锁定 Worker。
- OAuth 后再读取并核验属于当前 Cloudflare 账号的 Active 邮箱域名，缺少 Email Routing scope 时重新授权。
- 使用 Wrangler `4.116.0` 的 `addresses` 能力自动声明多个 `*@域名` Catch-all。
- 第一次使用不含 `addresses` 的配置部署核心 Worker，写入 Secret、取得 `workers.dev` 地址并验收健康状态、域名配置和首个管理员。
- 核心验收成功后才启用 Email Routing/MX，第二次部署路由配置并在线读取规则确认目标 Worker。
- 对已有 Catch-all 或 destructive changes 增加中文确认，并保留 Wrangler 官方交互确认。
- 增加 `worker-core-ready`、`email-routing-ready` 和前端发布阶段的安全续装；旧断点先在线验收 Catch-all，错误目标不会被静默覆盖。
- 重写 README、小白教程、Cloudflare 域名与邮箱路由教程、Release 中文说明和 Issue 模板。
- 将版本提升到 `0.5.0`，补充兼容性、回滚边界和发布说明。

## 3. 遇到的错误

1. **PowerShell 解析错误（严重）**：Windows 启动器把 `$line` 错误写成转义文本，最终在 `if (-not $line)` 处出现“一元运算符 -not 后面缺少表达式”。
2. **部署顺序风险（严重）**：早期自动化先启用 Email Routing/MX，再部署和验收 Worker；核心 Worker 如果随后失败，域名已经失去原有收件路径。
3. **声明式配置阶段混淆（重要）**：`renderUpstreamWorkerConfig()` 默认始终输出 `addresses`，导致无法生成真正不接管邮件的核心配置。
4. **断点阶段误分类（重要）**：首次实现只把 `worker-ready/complete` 当作可复用后端；前端发布中断后状态变为 `secrets-ready`，重试会把 Worker 部署次数从 2 增加到 4。
5. **测试事件窗口错误（次要）**：冲突接管测试用最后三个事件判断三次 Worker 部署，遗漏了中间合法的 `routing-enable` 事件，测试表达与业务顺序不一致。
6. **授权与工具链差异（重要）**：旧 OAuth 会话可能缺少 Email Routing scope，旧 Wrangler 也不支持当前 `addresses` 配置，需要统一版本并提供一次重新授权路径。

## 4. 根本原因分析

- 启动器同时跨越 CMD、PowerShell 和 npm 三层参数解析，变量应在哪一层展开没有被明确区分。
- 最初把“用户已同意未来接管邮件”误当成“可以立即修改 MX”，没有把可逆的基础设施准备与高影响的邮件接管分开。
- Worker 配置渲染只有一种形态，无法表达“业务域名已配置但 Email Routing 尚未接管”的中间状态。
- 断点逻辑过度依赖单个 `phase` 字符串，没有同时使用已验证 Worker、Email Routing 域名和 Worker 名称作为完成证据。
- 测试关注调用次数但截取了不稳定的事件尾部，没有直接验证完整业务序列。
- Cloudflare OAuth scope、Wrangler 能力和 Dashboard 行为会随版本演进，安装器不能假定历史登录态与全局工具版本始终满足新能力。

## 5. 调试过程

1. 根据用户提供的 PowerShell ParserError 定位启动器生成的一行脚本，修复变量传递，并增加语法解析测试。
2. 先补测试要求核心配置不含 `addresses`、全新安装部署两次、冲突场景部署三次，确认 67/70 的预期红灯。
3. 给配置渲染增加 `includeEmailRouting`，将 Worker 发布拆分成核心阶段和路由阶段。
4. 把 Secret、公开 URL、Worker 健康、域名与首个管理员验收全部前移到 MX 变更之前。
5. 为 `worker-core-ready` 和 `email-routing-ready` 编写续装测试，避免重复执行已经完成的阶段。
6. 为旧版断点增加在线 Catch-all 校验；发现错误目标时停止，防止把用户后来修改的规则覆盖回去。
7. 模拟 Pages 发布中断，测试首次得到 `4 !== 2`，据此把带完整 Email Routing 证据的前端阶段也归为后端可复用状态。
8. 同步所有新手文档和 Release 页面文案，明确“填写域名不等于立即修改 DNS”。
9. 运行完整发布门禁和双端浏览器 smoke，确认构建产物、前端交互和安装器测试一致。

## 6. 经验总结

- 高影响外部变更应放在最后：先完成所有可验证、可重试的准备，再修改 MX、Catch-all 等用户流量入口。
- 同一声明式资源可以使用分阶段配置：核心配置建立服务，最终配置接管平台路由。
- 断点恢复不能只看阶段名，还要保存并重新验证足够的远端完成证据。
- 测试业务顺序时应断言完整事件序列或按事件类型过滤，避免依赖容易变化的数组切片。
- OAuth 与 CLI 能力都应版本化；需要新 scope 时应提供可理解、次数受限的重新授权流程。

## 7. 知识提炼

- **Prepare → Verify → Switch Traffic → Verify Traffic**：先准备服务、验收服务、切换流量、再验收流量，适用于邮件 MX、DNS、反向代理、蓝绿发布和数据库切换。
- **阶段证据而非阶段标签**：恢复条件应同时验证资源存在、Secret 名称、公开地址、业务配置和外部绑定，而不是相信本地状态字符串。
- **声明式配置分层**：同一渲染函数通过显式选项生成核心配置与流量配置，避免维护两套容易漂移的模板。
- 应避免先修改 DNS 再发现后端不可用，也应避免在前端修复时无条件重部署已经健康的 Worker。

类似任务检查清单：

- [x] 外部流量切换是否晚于核心服务验收
- [x] 冲突或 destructive changes 是否需要二次确认
- [x] 中间阶段是否可安全续装
- [x] 旧状态是否会在线迁移而非静默覆盖
- [x] Secret、Token 和私人 URL 是否不落盘、不进日志
- [x] CLI 版本与 OAuth scope 是否明确锁定
- [x] 正常、拒绝、冲突、中断和旧版本迁移是否都有测试

## 8. 测试与验证

- 安装器专项测试：74/74 通过。
- Admin 前端测试：85/85 通过。
- Webmail 前端测试：31/31 通过。
- `npm run check:public` 与 `npm run check:cloudflare` 通过。
- Admin TypeScript、Webmail Functions 回归、双应用生产构建通过。
- Admin 与 Webmail 本地浏览器 smoke 均返回 `ok: true`。
- `bootstrap.ps1` 通过 PowerShell AST 语法解析，`git diff --check` 无空白错误。
- 验证过程没有修改真实 Cloudflare 账号、MX、DNS、Worker、D1、Pages 或 KV。

## 9. 参考资料

- 安装器状态机：`scripts/installer/installer.mjs`
- Worker 配置渲染：`scripts/installer/domain.mjs`
- Cloudflare 命令适配：`scripts/installer/cloudflare.mjs`
- Windows 引导脚本：`scripts/installer/bootstrap.ps1`
- 完整小白教程：`docs/BEGINNER_GUIDE.md`
- Cloudflare 域名教程：`docs/CLOUDFLARE_DOMAIN_AND_EMAIL.md`
- 兼容 Worker 锁定：`deployment/upstream-lock.json`
- 发布门禁：`package.json` 中的 `check:release`

## 10. 指标

- 安装器测试：70 个初始用例扩展到 74 个最终用例。
- 核心 Worker 部署：正常全新安装 1 次改为分阶段 2 次。
- 自动管理邮箱域名：支持有序多域名列表，第一个域名为默认域名。
- 调试迭代：6 个主要红灯/边界场景。
- 调试结果：所有已知回归路径通过，测试通过率 100%。

---
**生成工具**: Codex
**技能**: commit-with-reflection v3.0
