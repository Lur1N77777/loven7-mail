# Loven7 Mail 优化与整改路线图

日期：2026-07-13

输入：`BUG_AUDIT_REPORT_2026-07-13.md`

目标：在不破坏现有产品风格和业务能力的前提下，先恢复安全边界和数据正确性，再处理规模性能、体验与工程效率。

## 1. 总体判断

项目的常规构建和现有 smoke 基线是健康的，但生产风险主要不在“能否编译”，而在以下四条系统边界：

1. **身份边界**：地址 JWT 无撤销版本，角色 token 未绑定主体，部分 Pages 逻辑验签失败后继续。
2. **一致性边界**：KV 被用于需要原子读改写的分享撤销和邮件状态；D1 多步业务操作缺少事务/补偿。
3. **资源边界**：邮件列表传完整 MIME，前端全量搜索；图片/品牌代理和批量分享缺少明确预算。
4. **发布边界**：部署不等待 CI；当前 smoke 没有覆盖跨账号、跨标签、并发和真实故障。

推荐顺序是：**止血 → 身份与原子性 → 邮件链路可靠性 → 性能与多端体验 → 可观测和长期治理**。在前两阶段完成前，不建议继续添加大功能。

## 2. 目标架构

### 2.1 统一身份模型

所有令牌必须有明确类型、主体、期限和撤销版本：

| Token | 必需字段 | 服务端校验 |
| --- | --- | --- |
| 用户会话 | `typ=user`、`sub=user_id`、`exp`、`iat`、`ver`、可选 `aud/iss` | 用户存在、未禁用、版本一致 |
| 地址会话 | `typ=address`、`sub=address_id`、`address`、`exp`、`ver` | ID/地址名/版本/状态一致；需要时校验 owner |
| 角色/权限 | 不建议独立成为任意请求的提权凭证 | 按当前 user ID 从 D1 派生，或与 user ID、audience 强绑定 |
| 一次性登录链接 | 随机兑换码、短 TTL、单次消费 | 服务端存 hash，兑换后立即删除 |

密码只在服务端做 KDF。建议 Argon2id；若 Worker 运行环境或依赖限制不适合，可先采用 Web Crypto PBKDF2 作为过渡，但必须有每用户随机盐、足够迭代和版本字段。

### 2.2 强一致数据放置原则

- **D1 事务/批处理**：用户注册+角色、创建+绑定地址、地址转移/删除、额度预占和幂等账本。
- **Durable Object 或 D1**：分享生命周期、撤销、隐藏邮件集合、邮件状态等需要读改写和并发顺序的状态。
- **KV**：只保存可重建缓存、不可变快照或独立 tombstone；不能把 KV 当作 CAS 数据库。
- **Queue/outbox**：Telegram、Webhook、转发、自动回复、AI 提取等非主事务副作用。

### 2.3 稳定分页和轻量列表

- 邮件列表只返回 `id/from/to/subject/preview/created_at/size/flags`，不返回 raw MIME 和完整附件。
- 详情按 ID 单独获取 raw/解析结果。
- 所有列表改为基于 `(created_at,id)` 或单调 ID 的 cursor，避免 OFFSET 在并发插入/删除下漂移。
- 搜索在 Worker/D1 完成；前端不得再拉 57,600 封建立临时索引。

## 3. 分阶段计划

### 阶段 A：0–24 小时，生产止血

| 动作 | 对应问题 | 验收标准 |
| --- | --- | --- |
| 暂停地址转移/删除的高风险入口，或限制为管理员维护窗口 | P0-01 | 旧 JWT 无法继续触发破坏性操作 |
| 删除 Webmail mail-state 的未验签 fallback | P1-01 | 伪造 JWT 的 GET/PATCH 均返回 401，KV 不产生受害 key 写入 |
| 修复 Admin 代理 token 选择顺序 | P1-11 | 账号管理员选择邮箱后仍可访问 `/admin/*`；过期 token 不遮蔽有效 token |
| 生产关闭 IMAP DEBUG 并清理历史敏感日志访问权限 | P1-18 | LOGIN、JWT、Authorization 不出现在新日志中 |
| 暂时限制 brand-icon/image 公共接口的请求率和响应大小 | P1-12、P1-13、P1-28 | WAF/边缘限流生效；超限返回 429/413 |
| 将生产部署切为人工审批，停止 main push 自动直发 | P1-21 | CI 未完成或失败时无法部署 |
| 升级/隔离 Worker critical/high 运行时依赖 | P1-20 | 审计无未处置的运行时 advisory；例外项有可达性分析、截止日期和补偿控制 |

如果已怀疑地址 JWT 泄露，应安排 JWT secret 轮换并强制所有地址重新登录。该操作会使全部旧会话失效，必须配合公告、回滚 secret 保管和运行时监控。

### 阶段 B：第 1–7 天，修复安全和数据正确性

#### B1. 身份与密码

- 引入 token type、`sub`、`exp` 和 `token_version`；所有敏感地址 API 查 D1 当前记录。
- 角色从当前用户派生，禁止把他人的 `x-user-access-token` 用在自己的地址请求。
- 实施密码 KDF schema 和渐进迁移；统一邮箱 `trim().toLowerCase()`。
- 登录错误统一，对用户、地址、IP 和设备增加限流/退避。
- 地址登录链接从 query 改为一次性兑换码或 fragment。

**验收**

- 地址转移、改密、删除后，所有旧地址 token 立即失效。
- 借用另一账号的角色 token 无法提升额度。
- 数据库中不再写入可直接用于登录的新密码值。
- 邮箱大小写变化不会导致注册、验证码、OAuth 与登录行为不一致。

#### B2. 原子业务操作

- 注册前验证默认角色；用户+角色一次提交，成功后消费验证码。
- 地址创建+绑定、地址转移、地址删除全部改成事务/单写者流程。
- 删除地址覆盖 `raw_mails/sendbox/address_sender/auto_reply_mails/users_address/address`。
- 发件前原子预占余额和日/月额度；外部发送失败补偿；请求使用幂等键。
- 验证码先原子占位再发送，使用 CSPRNG。

**验收**

- 对每条操作注入任意一步失败，不会出现“接口失败但资源已半创建/半删除”。
- 余额为 1 的 20 个并发发送请求最多成功 1 个，余额不为负。
- 同邮箱 20 个并发验证码请求最多发送 1 封，收到的验证码必然可用。

#### B3. 分享访问控制

- 把分享状态迁移到 Durable Object 或 D1：`status/revoked_at/expires_at/version/creator_user_id` 独立字段。
- 撤销成为不可逆状态迁移；公开隐藏操作不能写生命周期字段。
- PATCH 未传期限时保持原期限；“永久”与产品语义一致。
- 隐藏表采用 `(share_id, mailbox_id, mail_id)` 唯一键；重复 DELETE 幂等并验证邮件属于分享邮箱。
- 建立按创建时间排序的管理索引和 cursor；修复 50+ 新邮件分页。

**验收**

- revoke 与 100 次并发 hide/update 竞争，最终状态始终 revoked。
- 只改权限不会改变 `expiresAt`。
- 50、51、500 封新增邮件都可完整分页且无重复/遗漏。
- 管理列表 20/50/500 条逐页遍历结果集合完全一致。

### 阶段 C：第 1–2 周，邮件链路与多用户稳定性

#### C1. 入站邮件可靠性

推荐流程：

1. 校验地址和邮件大小。
2. 使用 delivery key 幂等写入 D1；保存失败立即临时失败，停止副作用。
3. 事务提交 outbox 事件。
4. Queue 消费者分别执行转发、Telegram、Webhook、自动回复和 AI 提取。
5. 每个消费者独立重试、死信和告警。

**验收**

- D1 故障时发送方收到可重试失败，不出现“成功但邮箱没有信”。
- 同一 delivery 重试 10 次只存一封，不重复自动回复。
- 任一外部集成故障不阻止其他集成，且可在后台重放。

#### C2. SMTP/IMAP

- SMTP 使用共享 `httpx.AsyncClient`，AUTH 阶段真实验证，头字段完整容错。
- IMAP AUTH 对 JWT 做后端验签；日志脱敏。
- Worker 增加按 ID/cursor 批量获取接口，避免 SELECT/FETCH 从头扫描全邮箱。
- IMAP flags 持久化，修正 UNSEEN/RECENT/Seen 语义；限制线程池和邮箱缓存字节。

**验收**

- 后端延迟 5 秒时，其他 SMTP 会话仍可并行响应。
- 无 Subject、Bcc-only、UTF-8/8bit 邮件均可发送。
- 10,000 封邮箱 SELECT/FETCH 不产生 O(n) 全量 HTTP 扫描。
- 重连后 Seen/Flagged 状态保持一致，日志扫描为零凭证。

#### C3. 前端账号和缓存隔离

- 所有缓存 key 包含 `apiOrigin + stableUserId/addressId + resource + schemaVersion`。
- 登录主体/Worker 改变时清理内存请求缓存；持久值读取时核对 scope。
- 使用 BroadcastChannel 同步登录变化、删除、已读和星标；仍定期向服务端权威对账。
- 修复 300 封截断 cursor、幽灵邮件、地址筛选“全部已读”和星标乱序。
- AccountConsole 的 inbox/sent/unknown 使用统一数据层，加入移动详情和分页。

**验收**

- 两个标签分别连接两个 Worker/账号，任何时刻都不显示对方缓存。
- 已加载 1000 封后重开，301–1000 不会被跳过。
- 标签 A 删除、标签 B 在一个同步周期内移除；快速星标最后操作获胜。
- 390px 下 inbox/sent/unknown 均可打开正文并返回列表。

### 阶段 D：第 3–4 周，性能、体验与工程治理

#### D1. 前端性能预算

| 指标 | 当前观察 | 建议预算 |
| --- | --- | --- |
| Admin 构建 CSS | 约 540 KB 原始 | 首阶段低于 300 KB，最终低于 180 KB；按页面拆分 |
| Admin dist | 约 36.1 MB | 未引用资源不进产物；首屏资源低于 1.5 MB |
| Admin public | 约 34.9 MB | 图片 AVIF/WebP、多尺寸；删除未引用历史图 |
| PWA precache | 约 3.63 MiB | 只缓存 shell 与关键小资源，非关键图 runtime cache |
| Webmail 登录图 | 约 1.75 MB 且高优先预载 | 只在无会话登录路由加载，提供移动小图 |
| 邮件解析 | 一页可并行解析完整 MIME | 列表零完整 MIME；详情 Web Worker 按需解析 |
| 图片代理 | 单唯一 URL 可返回大对象 | 单图建议 1–2 MB、总 deadline 3–5 秒、有界并发 |

具体动作：

- 清理 `index.css` 多代 FINAL 覆盖层，按 tokens/base/layout/components/pages/utilities 分层。
- 只有 transform/opacity 动画进入合成层；移除长列表行永久 `will-change/translateZ`。
- 每秒倒计时拆成局部组件，避免整页邮件行重渲染；稳定 memo props 和回调。
- 尊重 `prefers-reduced-motion`，对 4× CPU slowdown 和低端 Android 做手势测试。
- 远程邮件 HTML 使用 sandbox iframe、严格 sanitizer/CSP；默认阻断图片，用户明确允许后再代理加载。
- Webmail/Admin 品牌字体自托管并改 `font-display:swap/optional`；修复 CSP inline script。

#### D2. PWA 与错误恢复

- 不再让 `skipWaiting + cleanupOutdatedCaches` 在没有版本协调时强制替换旧客户端。
- 发布保留至少一代哈希资源；捕获 ChunkLoadError，提示刷新并保留编辑草稿。
- 顶层与路由级 ErrorBoundary；错误 UI 支持重试、复制 request ID。
- 临时网络/5xx 不清登录，离线只读使用最后已验证缓存并明确标识。

#### D3. 无障碍与交互

- 邮件行使用真实 button/link 或补齐 role、tabIndex、Enter/Space 行为。
- 避免 button 嵌套 button；阻止验证码按钮键盘事件冒泡。
- Modal 增加初始焦点、focus trap、Escape、焦点恢复和可访问名称。
- 恢复移动端缩放；触控目标至少 44×44 CSS px。
- 移动详情由一个路由状态机管理，统一顶部关闭、滑动返回和浏览器 Back。

## 4. 测试体系重建

### 4.1 必需测试金字塔

- **单元测试**：token claim/版本、邮箱规范化、TTL PATCH、分页 cursor、额度条件更新、sanitizer URL/CSS。
- **D1/KV 集成测试**：注册/角色、转移/删除、分享状态机、验证码占位、幂等账本。
- **并发属性测试**：20–100 并发下余额不负、撤销不复活、验证码单发、重复 DELETE 幂等。
- **浏览器 E2E**：两账号/两 API/两标签、1000+ 邮件、离线/5xx、PWA 跨版本、移动详情、键盘与 reduced motion。
- **外部故障测试**：D1、KV、SMTP provider、S3、Telegram、Webhook 慢/错/超时。
- **安全回归**：伪 JWT、旧地址 JWT、角色 token 借权、SSRF 重定向/IPv6、恶意邮件 HTML、日志 secret 扫描。

### 4.2 首批必须新增的自动化用例

1. 伪造 mail-state JWT 返回 401。
2. 地址转移后旧 JWT 的 mails/clear/send/delete 全部 401/403。
3. revoke 与 hide 并发 100 次，链接不恢复。
4. PATCH permissions 不改变期限；forever 语义与 UI 一致。
5. 分享 50/51/500 邮件完整分页；列表 limit 20 遍历 50 条不丢。
6. 余额 1 并发 20 次仅一封成功。
7. 验证码并发 20 次只发送一封且可注册一次。
8. 删除地址后重建同名地址看不到历史数据。
9. 两标签不同账号/API 缓存无串租户。
10. 1000 封缓存重开与删除对账。
11. 390px AccountConsole 三个邮箱菜单均可读正文。
12. 生产 CSP、PWA chunk 更新、ErrorBoundary 和离线保会话。

## 5. 发布与运维门禁

推荐单一流水线：

1. checkout + 固定 Node/pnpm/Wrangler 版本；禁止 `wrangler@latest`。
2. install with lockfile。
3. TypeScript/lint/unit/security tests。
4. D1/KV 集成和并发测试。
5. Admin/Webmail build + smoke + Docker E2E。
6. 依赖审计、secret scan、bundle budget。
7. 部署 staging。
8. 强制 runtime probe：Worker URL、KV、D1、加密 secret、实际 API 行为。
9. 人工批准后生产 canary。
10. 观察错误率/延迟/邮件落库率后逐步扩流；失败自动回滚。

生产应至少有：

- request/delivery/share operation ID 全链路透传。
- 结构化日志，字段白名单，默认不记录 body/token/password/raw mail。
- 指标：认证失败率、验证码发送/成功、D1 写失败、邮件落库延迟、重复 delivery、发件预占/补偿、分享冲突、KV/DO 延迟、SMTP/IMAP 活跃与超时。
- 告警：邮件保存失败立即告警；额度负值、分享 revoked→active、认证异常突增属于安全告警。

## 6. 建议负责人和交付拆分

| 工作流 | 主责 | 首个交付 |
| --- | --- | --- |
| 身份、密码、额度 | Worker/安全 | token v2、密码迁移、原子预占 |
| 分享和邮件状态 | Pages/数据 | D1/DO 状态机、cursor 与迁移脚本 |
| 入站/出站邮件 | Worker/平台 | 幂等存储、outbox、SMTP async |
| IMAP | 协议/后端 | 真 AUTH、按 ID API、flags 持久化 |
| Admin/Webmail | 前端 | cache scope、reconciliation、移动详情、HTML 隔离 |
| CI/CD/SRE | 平台 | 单一 gated pipeline、runtime probe、指标告警 |
| QA | 测试 | 并发矩阵、两标签/两账号、恶意邮件与 PWA 测试 |

每个 PR 建议只解决一个可验证的不变量，避免把安全迁移、视觉重构和大规模重命名混在同一提交。

## 7. 迁移与回滚原则

- Token v2 与旧 token 可短期双读，但敏感操作只接受 v2；迁移窗口结束后彻底拒绝 v1。
- 密码登录成功时升级 hash；保留算法版本但不保留明文或等价密码日志。
- 分享从 KV 迁移到 D1/DO 时采用双读、单写新存储、后台校验数量，再切读；撤销 tombstone 必须优先于旧记录。
- 数据清理先做只读报告和备份，再修正孤儿数据；不能直接批量删除生产历史邮件。
- 前端缓存 schema 版本提升时按 scope 清理旧敏感缓存，界面偏好可保留。
- PWA 发布保留前一版本资源，直到活跃旧客户端比例降到可接受范围。

## 8. 完成定义

本轮整改只有在以下条件同时满足时才算完成：

- P0 全部关闭，核心 P1 有代码、测试和生产验证证据。
- 上游 Docker E2E 与 Suite `npm run check:release` 全通过。
- 新增并发/安全/两标签 E2E 全通过，且在 CI 中强制执行。
- Worker 无未处置的运行时 critical/high advisory；或已证明不可达并有可验证的补偿控制。
- 生产部署只能在 CI 成功、runtime probe 成功和审批后发生。
- canary 期间无邮件丢失、跨租户缓存、额度负数、撤销复活或异常 401。
- 运维手册包含 token/secret 轮换、D1/KV 故障、邮件重放、PWA 回滚和日志泄露响应。

完成上述阶段后，再进入新功能开发，项目会从“可运行的产品”提升为“可以稳定扩流、可定位故障、可安全接手的生产系统”。
