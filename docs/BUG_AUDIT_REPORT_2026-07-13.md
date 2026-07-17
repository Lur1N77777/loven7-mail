# Loven7 Mail 全项目 Bug 审查报告

审查日期：2026-07-13

审查性质：只读代码审查、构建验证、静态检查与依赖审计

发布结论：**当前版本不建议在修复 P0 与核心 P1 前继续扩大生产流量。**

## 1. 执行摘要

本次审查覆盖新版管理端、用户邮箱站、Cloudflare Pages Functions、上游 Hono Worker、D1/KV 数据链路、邮件接收与发送、分享功能、Rust 邮件解析模块、Python SMTP/IMAP 代理、CI/CD 和多端性能。

在当前源码、配置和本机可执行测试范围内，共确认：

- **P0（阻断级）2 项**：地址 JWT 在地址转移后仍可越权操作新持有人邮箱；用户密码以可直接重放的等价密码存入 D1。
- **P1（高优先级）30 项**：包括未验签 JWT 污染邮件状态、角色令牌跨账号借权、发件额度并发超发、删除地址残留旧邮件、分享撤销竞态、Turnstile 流程断裂、401 管理令牌选错、SMTP 阻塞、IMAP 日志泄密、依赖安全 advisory 及部署不受 CI 门禁等。
- **P2（中优先级）30 项**：包括 KV 并发丢更新、分享索引半成功、创建与绑定非原子、IMAP 大邮箱退化、邮件列表传输完整原文、Offset 分页漂移、远程图片隐私泄露、PWA 热更新和多端交互状态等。

现有 `check:release` 全部通过，说明常规构建、当前 smoke 场景和已覆盖的多端布局没有回归；但最危险的问题集中在**令牌生命周期、跨用户隔离、原子并发和最终一致性**，这些不在现有 smoke 测试的覆盖范围内。因此，“测试通过”不能作为当前版本可安全扩流的依据。

> 边界说明：任何有限审查都不能证明“所有 Bug 已被找完”。本报告列出的是当前工作树、配置及可执行环境中已确认的高价值缺陷和高可信风险，并明确记录未覆盖项。

## 2. 审查范围与仓库标识

为便于定位，下文使用两个仓库标识：

- **Suite**：`D:/files/Aitest4/mail/loven7-mail-pwa-1`
  - `apps/admin`：React/Vite 管理端与 Pages Functions 管理代理
  - `apps/webmail`：React/Vite 用户邮箱、公开分享页与 Pages Functions
  - `.github/workflows`：新版前端的构建与部署
- **Upstream**：`D:/files/Aitest4/mail/cloudflare_temp_email`
  - `worker`：Cloudflare Worker、Hono、D1、KV、邮件收发 API
  - `mail-parser-wasm`：Rust/WASM 邮件解析
  - `smtp_proxy_server`：Python SMTP/IMAP 代理
  - `e2e`：Docker 集成测试

两个仓库审查时均存在用户未提交修改。本次结果基于**当前工作树**，没有覆盖、回滚或提交这些修改。

## 3. 严重度定义

| 级别 | 含义 | 处理要求 |
| --- | --- | --- |
| P0 | 可造成跨用户数据泄露/破坏、核心凭证失陷，或必须阻断发布的问题 | 立即止血，修复后才能扩流 |
| P1 | 高概率影响认证、数据正确性、可用性、费用或关键业务流程 | 0–7 天内完成 |
| P2 | 在特定规模、并发、浏览器或故障条件下出现的明确缺陷 | 1–2 周内完成 |
| P3 | 工程债、体验和长期维护风险 | 纳入一个月治理计划 |

## 4. 已执行验证

| 范围 | 命令/检查 | 结果 |
| --- | --- | --- |
| Suite 全发布链 | `npm run check:release` | 通过 |
| Admin | TypeScript、Vite build、local smoke | 通过 |
| Webmail | TypeScript/build、Functions headers/CORS/image/share-delete、local smoke | 通过 |
| 响应式 | 390px、844px 横屏、1365px 桌面、无横向溢出 | 通过 |
| 前端竞态脚本 | 登录/退出、分享邮箱切换 | 通过 |
| 前端依赖 | Admin 与 Webmail `npm audit` | 均为 0 |
| Worker | `pnpm lint`、`wrangler deploy --dry-run` | 通过 |
| Worker 依赖 | `pnpm audit` | 1 critical、8 high、21 moderate、5 low |
| Rust | `cargo check`（独立临时 target） | 通过 |
| Python | 所有 `.py` 内存语法编译 | 通过 |
| Docker E2E | 上游完整集成测试 | **未执行：Docker daemon 不可用** |

## 5. P0：阻断级问题

### P0-01 地址 JWT 永久有效，地址转移后旧持有人仍可操作新持有人邮箱

**证据**

- `Upstream/worker/src/common.ts:424-427` 与 `worker/src/user_api/bind_address.ts:160-167` 签发地址 JWT 时仅写入 `address`、`address_id`，没有 `exp`、令牌类型或版本号。
- `worker/src/user_api/bind_address.ts:208-243` 转移地址时删除旧地址行，再以同名邮箱重建新 ID 并绑定目标用户。
- `worker/src/mails_api/mails_crud.ts:9-20, 84-102` 的读取、清空和删除逻辑主要信任 JWT 内的邮箱字符串。
- `worker/src/common.ts:555-605` 删除地址时没有校验 JWT 中的 `address_id` 与 `address` 当前仍属于同一行，最终按邮箱名删除。

**可复现场景**

1. 用户 A 获取某地址的 JWT 并保存。
2. A 将该地址转移给用户 B；系统删除旧行并重建同名地址。
3. A 继续携带旧 JWT 请求 `/api/mails`、`/api/clear_inbox`、发件或 `/api/delete_address`。
4. 旧 JWT 签名仍有效，且邮件按邮箱名查询，因此 A 仍可读取或破坏 B 的邮箱。

**影响**

- 跨租户邮件读取、清空、发件和地址删除。
- 地址改密、解绑或转移无法撤销已经泄露的令牌。
- 这是数据隔离边界失效，应视为发布阻断项。

**修复要求**

- 地址 JWT 增加短 `exp`、`typ=address`、不可变 `sub=address_id`、`token_version`。
- 每个敏感请求按 `sub` 查询 D1，并校验地址名、版本、当前状态和用户归属。
- 转移、删除、改密和强制退出时递增版本；地址转移应保留不可变 ID 或显式作废旧版本。
- 紧急止血可先暂停地址转移/删除，或轮换 JWT secret 强制全部地址会话下线；后者影响所有用户，需提前公告。

### P0-02 用户密码以可直接重放的值存入 D1

**证据**

- `Upstream/worker/src/user_api/user.ts:150-158` 将请求中的 `password` 原样写入 `users.password`。
- `worker/src/user_api/user.ts:212-220` 登录时直接读取并用普通字符串比较。
- `worker/src/admin_api/admin_user_api.ts:71-85, 116-123` 管理员创建用户和重置密码也直接写入。
- `worker/src/utils.ts:355-367` 最低密码长度实际为 1；现有 SHA-256 仅发生在部分前端/辅助路径，且无服务端随机盐。

**影响**

即使浏览器先提交 SHA-256 值，该值本身仍是“等价密码”：D1、备份或管理权限泄露后，攻击者无需还原明文即可直接登录。无盐快速哈希还可被离线字典和彩虹表攻击。

**修复要求**

- 服务端使用 Argon2id、scrypt，或至少 PBKDF2 + 每用户随机盐和足够迭代次数。
- 使用恒定时间比较；提高最低密码长度并拒绝常见弱密码。
- 增加 `password_algo/password_version`，用户下次成功登录时渐进迁移旧记录。
- 迁移完成前，数据库泄露应按凭证泄露处理，不能把前端 SHA-256 当作安全密码哈希。

## 6. P1：高优先级问题

### P1-01 邮件状态接口信任未验签 JWT

- **证据**：`Suite/apps/webmail/functions/api/mail-state.ts:75-85, 120-164`。上游 `/api/settings` 验证失败后，仍使用 `decodeJwtAddress()` 得到的未验签 payload 地址作为 KV key。
- **触发/影响**：攻击者伪造 payload 中的受害邮箱，无需有效签名即可读取或覆盖其已读状态；当前 PATCH 主要改已读状态，类型中虽有星标但未在此 PATCH 写入。
- **修复**：上游验签失败立即 401；只使用 Worker 返回的稳定 address ID，禁止任何“验签失败后继续”的身份 fallback。

### P1-02 角色令牌未绑定当前用户或地址，可跨账号借权

- **证据**：`Upstream/worker/src/worker.ts:127-142` 只提取 `user_role` 字符串；`worker/src/mails_api/send_balance.ts:47` 与 `worker/src/user_api/bind_address.ts:43` 直接据此决定免余额和地址额度。
- **触发/影响**：普通用户 B 可在自己的地址请求中附带高权限用户 A 的角色令牌，借用 A 的免余额或更高地址上限。
- **修复**：角色令牌必须包含并校验 `user_id`，与用户 token 及地址归属一致；更稳妥的是从 D1 按当前用户实时派生角色。

### P1-03 发件余额和全局日/月限额存在并发超发

- **证据**：`Upstream/worker/src/mails_api/send_mail_api.ts:178-246` 与 `send_mail_limit_utils.ts:128-170` 都是“先读额度→外部发送→再扣/加计数”。
- **触发/影响**：余额只剩 1 时两个并发请求都可发送成功，余额最终为负；全局额度同样可突破，造成费用和统计失控。
- **修复**：发送前执行 D1 条件更新原子预占，或用 Durable Object 串行化；外部发送失败补偿归还；所有发送请求增加幂等键。

### P1-04 管理员删除地址的 SQL 顺序错误，旧邮件会泄露给同名新地址

- **证据**：`Upstream/worker/src/admin_api/address_api.ts:70-95` 先删除 `address`，随后再通过已删除行的子查询删除 `raw_mails/address_sender`，子查询已为空；同时遗漏 `sendbox` 和 `auto_reply_mails`。
- **影响**：历史邮件和状态成为孤儿数据；之后创建同名地址时，新持有人可能看到旧邮件并继承旧发件状态。
- **修复**：先取得并锁定地址名，批量删除所有关联表，最后删地址；整个过程放入 D1 batch/事务并覆盖完整关联表。

### P1-05 地址转移是破坏性的多步操作，失败会丢失绑定

- **证据**：`Upstream/worker/src/user_api/bind_address.ts:208-253` 依次解绑 Telegram、删 `users_address`、删地址、重建地址、查新 ID、绑定目标用户，没有事务或补偿。
- **触发/影响**：任何中间 D1 错误、唯一约束冲突或并发额度变化，都会留下无主/半转移地址；原用户已经失去绑定，重试也未必可恢复。
- **修复**：优先保留同一 address ID，只原子更新 `users_address.user_id`；额度校验和更新放在同一事务/DO 中，外部 Telegram 解绑通过 outbox 异步处理。

### P1-06 验证码发送存在竞态且随机源不适合安全码

- **证据**：`Upstream/worker/src/user_api/user.ts:59-82` 先查 KV、发送邮件、最后写 KV，并用 `Math.random()` 生成验证码。
- **触发/影响**：同邮箱并发请求会发出多封码，后写 KV 覆盖先发验证码，用户输入先收到的码会失败；KV 跨 POP 最终一致进一步放大问题。
- **修复**：先用 Durable Object/D1 唯一键原子占位，再发送；失败释放占位；统一邮箱规范化；使用 `crypto.getRandomValues()` 并记录尝试次数。

### P1-07 注册、验证码消费和默认角色不是原子业务操作

- **证据**：`Upstream/worker/src/user_api/user.ts:148-198` 先创建用户；关闭邮件验证时在 172–174 行提前返回，跳过默认角色；开启验证时先删 KV 验证码，再验证/写角色。
- **触发/影响**：默认角色配置错误或写入失败时，接口报错但用户已存在且验证码已删除，用户无法重试恢复；关闭验证时所有新用户都漏默认角色。
- **修复**：插入前验证角色；用户和角色用一个 D1 batch/事务提交；成功提交后再消费验证码；两种注册模式共用同一角色分配路径。

### P1-08 登录无代码级限流并可枚举账号

- **证据**：`Upstream/worker/src/worker.ts:63` 的限流列表不含 `/user_api/login` 和 `/api/address_login`；`worker/src/user_api/user.ts:200-220` 区分“用户不存在”和“密码错误”。
- **触发/影响**：Turnstile 未启用、配置失效或被绕过时，可暴力破解、枚举账号并压垮 D1。
- **修复**：增加 IP、规范化账号、设备三维滑动窗口和指数退避；统一外部错误；Turnstile 只作为附加层。

### P1-09 分享记录无 CAS，已撤销链接可被并发写“复活”

- **证据**：`Suite/apps/webmail/functions/_lib/share.ts:472-486` 对整条 KV 记录执行读改写；公开隐藏接口 `functions/api/share/[token]/mail/[id].ts:19-34` 也走同一路径。
- **触发/影响**：管理员撤销与访客隐藏/管理员更新并发时，后写的旧 payload 可把 `revokedAt` 覆盖回 `null`；跨 POP 读取还会延迟看到撤销。
- **修复**：迁移到 Durable Object 或 D1 强一致事务；至少增加不可逆独立 revoke tombstone，并在所有读写路径优先检查。

### P1-10 修改分享权限会意外把期限重置为未来 7 天

- **证据**：`Suite/apps/webmail/functions/api/share/admin/[token].ts:41-56`、`user/[token].ts:53-67` 与 `_lib/share.ts:290`。
- **触发/影响**：PATCH 只改权限或可见范围、未传期限时，默认 TTL 仍被计算并覆盖原 `expiresAt`，扩大访问窗口。
- **修复**：只有请求显式包含 `expiresAt/expiresIn` 时才更新期限；非法值返回 400，不得静默采用默认值。

### P1-11 Admin Pages 代理选错 Token，合法管理员出现 401/403

- **证据**：`Suite/apps/admin/functions/_lib/admin-proxy.ts:91-97` 优先取 `Authorization`；`apps/admin/src/lib/api.ts:176-182` 在已选择邮箱时把 address JWT 放入 Authorization，而账号 token 位于 `x-user-token`。
- **触发/影响**：管理员账号登录后选择邮箱，再访问 `/admin/*`，代理拿地址 JWT 调 `/user_api/settings`，把合法管理员判成非管理员；过期 access token 也会遮蔽有效账号 token。
- **修复**：按 `x-user-token → x-user-access-token → Bearer` 逐一验签/验角色，不能用第一个存在的 token 直接决定身份。

### P1-12 品牌图标解析可被公开请求拖慢并耗尽内存

- **证据**：`Suite/apps/admin/functions/api/brand-icon.ts:98-225` 与 Webmail 同名实现 `:100-227`。代码先完整 `text()/arrayBuffer()` 后才检查大小，且 BIMI、主页和最多 11 个候选串行请求，理论最坏接近 100 秒。
- **触发/影响**：无 Content-Length 的超大或慢响应会在 128MB 级函数内先被完整读入；随机 query 可绕过完整 URL 缓存键，多用户时造成内存、连接和出站请求放大。
- **修复**：流式限长、统一总 deadline、有界并发、规范化缓存键与负缓存；合并 Admin/Webmail 两份实现。

### P1-13 品牌图标私网校验可被重定向和 IPv6 绕过

- **证据**：Admin `brand-icon.ts:47, 106, 166` 与 Webmail `:49, 108, 168` 使用自动跟随重定向，跳转后不重新校验；IPv6 hostname 的括号形式与阻止集合不匹配。
- **影响**：攻击者控制 BIMI、主页或 favicon 时，可诱导 Cloudflare 节点尝试访问 loopback、ULA、link-local 或 IPv4-mapped IPv6 地址，形成 SSRF 边界缺口。
- **修复**：手动逐跳重定向并校验；规范化 IPv6；必要时 DNS 解析后校验实际目标 IP；限制端口和跳转次数。

### P1-14 “仅新增邮件”分享超过一页后无法继续加载

- **证据**：`Suite/apps/webmail/functions/_lib/share.ts:723-739` 在上游分页后再过滤，并把 `count` 设为当前页过滤后长度；前端 `apps/webmail/src/App.tsx:984` 用它判断是否还有历史。
- **触发/影响**：分享创建后新增超过 50 封邮件，第一页返回 50 且 count=50，剩余新邮件永久不可见；隐藏邮件也使 offset 与 count 漂移。
- **修复**：在服务端按 cutoff 查询，或返回稳定 cursor、`hasMore/nextCursor`；不得用当前页长度冒充总数。

### P1-15 分享管理列表分页会永久跳过记录

- **证据**：`Suite/apps/webmail/functions/_lib/share.ts:560-615` 一次 `kv.list(limit:100)`，收满客户端 limit 后在页内 break，却返回整个 KV 页的 cursor。
- **触发/影响**：50 条记录请求 limit=20 时，同一 KV 页剩余 30 条不会出现在后续页；管理员可能找不到并撤销仍有效的分享。
- **修复**：建立按反向创建时间编码的索引键并把索引键作为游标；不能丢弃尚未消费的页内 key。

### P1-16 开启全局 Turnstile 后，多条登录/注册链路断裂

- **证据**：`Suite/apps/webmail/functions/api/session.ts:13` 不接收/转发 `cf_token`；`user/register.ts:25-33` 注册后复用一次性 token 自动登录；`user/login.ts:23` 的兼容重试也复用同一 token。
- **影响**：地址凭证/密码登录失败；注册可能“账号已创建但最终响应失败”；hash/raw 第二次登录尝试必然因 token 已消费失败。
- **修复**：每次受保护尝试使用新 token；注册成功直接由 Worker 返回会话；Session API 明确接收 token，并为兼容重试重新获取挑战。

### P1-17 SMTP 异步处理器内执行同步 HTTP，阻塞所有会话

- **证据**：`Upstream/smtp_proxy_server/smtp_server.py:38, 116-121` 的 `async handle_DATA()` 直接调用同步 `httpx.post()`。
- **触发/影响**：Worker 慢或超时时，aiosmtpd event loop 被阻塞；所有同时连接的用户一起卡顿。
- **修复**：复用 `httpx.AsyncClient`，配置连接池、总超时和并发上限；对后端错误返回稳定 SMTP 状态码。

### P1-18 IMAP DEBUG 日志泄露明文密码和 JWT

- **证据**：`Upstream/smtp_proxy_server/imap_server.py:16-18, 31-49` 全局 DEBUG，并记录客户端原始 LOGIN 命令、服务器原始响应和 RAW 数据。
- **影响**：日志平台、容器 stdout 或运维人员可直接获得用户密码/JWT。
- **修复**：生产强制 INFO/WARN；对 LOGIN、AUTH、Authorization、JWT 和响应 literal 全量脱敏；增加日志敏感字段测试。

### P1-19 D1 保存邮件抛错后仍正常结束，发件人认为投递成功但邮件永久丢失

- **证据**：`Upstream/worker/src/email/index.ts:68-119` 仅在 `success=false` 时 `setReject`，但 catch 只打印错误，不 reject/throw；之后仍执行转发等任务。
- **触发/影响**：D1 超时、迁移不一致或配额故障时，邮件未落库但 Email Worker 正常返回，发送方不会重试。
- **修复**：持久化是主事务，异常必须临时失败/拒收并停止后续副作用；记录可重放的 delivery ID 和告警。

### P1-20 Worker 依赖树命中 critical/high 安全 advisory

- **证据**：`pnpm audit` 为 1 critical、8 high、21 moderate、5 low。锁文件包含 `@aws-sdk/client-s3 3.888.0 → fast-xml-parser 5.2.5`；`hono 4.12.15` 也命中高危 CORS advisory。
- **影响**：依赖树命中 XML 实体注入/DoS 与 Hono CORS 等已披露 advisory；本次未完成所有调用路径的可达性和实际可利用性验证。`fast-xml-parser` 位于运行时 AWS SDK 依赖链，应优先处置；`undici/ws` 中部分高危来自 Wrangler/Miniflare，主要影响开发链路。
- **修复**：优先把 Hono 升至已修复版本（至少 4.12.25）并升级 AWS SDK/fast-xml-parser；升级后重跑 lint、dry-run、真实 S3 和 CORS 回归。

### P1-21 生产部署与 CI 并行触发，CI 失败也可能先上线

- **证据**：`Suite/.github/workflows/ci.yml:3-7` 与 `deploy-cloudflare-pages.yml:3-6` 都监听 main push，互不依赖；部署内 Admin 只运行 Vite build，未执行 TypeScript 和 Admin smoke。
- **影响**：CI 已发现类型或 smoke 回归时，生产部署仍可能先完成。
- **修复**：部署改为只接受成功的 `workflow_run`，或让部署 job 依赖同 workflow 的完整 `npm run check:release`；生产环境启用 required checks 与人工审批。

### P1-22 管理端持久缓存未完整按 API/账号隔离

- **证据**：`Suite/apps/admin/src/lib/constants.ts:21-34` 定义全局缓存前缀；`UsersView.tsx:68, 133-148`、`MailWorkspace.tsx:378, 641-657`、`AddressView.tsx:687, 1187-1203` 的用户、邮件、全局地址索引和分享缓存 key 未包含 API scope/管理员账号。凭证本身已按 API scope 隔离，但这些业务缓存没有完全同步。
- **触发/影响**：同一浏览器切换 API、管理员账号或多标签页登录不同账号时，会短暂或在网络失败时持续显示另一个上下文的用户、邮件、地址或分享数据。
- **修复**：所有敏感缓存 key 使用 `apiOrigin + stableUserId + role + resource`；账号变化广播清理；缓存值写入 scope 并在读取时二次核对。

### P1-23 Webmail 只缓存 300 封，却保留更大的 nextOffset

- **证据**：`Suite/apps/webmail/src/cache.ts:5, 50-56` 截断 mails 到 300，但原样保存 `nextOffset`；`App.tsx:1061-1088` 重开后从该 offset 继续。
- **触发/影响**：用户曾加载超过 300 封后刷新页面，缓存只剩前 300 封，但 nextOffset 可能为 500；随后“加载更多”从 500 开始，301–500 永久跳过。
- **修复**：截断时同步把 cursor/offset 重置到缓存尾部；更推荐稳定的 `beforeId` cursor。

### P1-24 增量刷新只加不删，跨标签/管理员删除的邮件长期残留

- **证据**：`Suite/apps/webmail/src/App.tsx:998-1049` 与 Admin `MailWorkspace.tsx:676-727` 以 merge 为主；本地删除 tombstone 只覆盖当前客户端操作，未与服务端列表做删除对账。
- **触发/影响**：另一标签页、管理员或保留策略删除邮件后，当前页面增量刷新仍保留旧邮件；点击详情可能 404 或显示缓存原文。
- **修复**：定期做第一页权威 reconciliation；服务端提供 change feed/deleted IDs；跨标签使用 BroadcastChannel 同步删除事件。

### P1-25 账号控制台的发件箱/未知邮件和手机详情实际不可用

- **证据**：`Suite/apps/admin/src/views/AccountConsole.tsx:341-347` 对任何非 inbox 模式直接清空；`:451-453` 详情 pane 在小于 `lg` 时永久 hidden，且没有移动端详情替代层。
- **影响**：账号入口中的 Sent/Unknown 永远显示空；手机点击 inbox 邮件只改变选中状态，用户看不到正文。
- **修复**：为三种模式调用对应 API；复用主 MailWorkspace 的移动详情路由/抽屉；增加 390px 点击邮件后正文可见的行为测试。

### P1-26 临时网络错误或 Worker 5xx 会清除合法登录

- **证据**：`Suite/apps/admin/src/App.tsx:570-588` 在加载 profile 的通用失败路径清理认证，而不是只对已确认的 401/403 执行退出。
- **触发/影响**：离线 PWA、Cloudflare 短暂抖动或上游 5xx 会把用户强制登出；用户可能在未保存操作中丢失上下文，并误以为凭证失效。
- **修复**：只有明确的认证错误才清凭证；网络/5xx 保留会话并显示可重试离线态，使用退避重试和最后一次已验证 profile。

### P1-27 地址 JWT 被放进 URL query，可能在页面代码清理前泄露

- **证据**：`Suite/apps/admin/src/lib/clipboard.ts:31-35` 生成含凭证 query 的登录链接；`apps/webmail/src/auth.ts:6-18` 只能在页面 JavaScript 启动后读取并清理 URL。
- **影响**：首次 HTTP 请求、CDN/反代访问日志、浏览器历史、崩溃报告及部分安全产品可能已经记录完整 JWT；之后 `replaceState` 或 `no-referrer` 无法撤回。
- **修复**：改用不会发送到服务器的 URL fragment；更推荐一次性、短 TTL 的兑换码，服务端兑换后立即作废。

### P1-28 图片代理公开且无业务级限流，可被当作带宽/内存放大器

- **证据**：`Suite/apps/webmail/functions/api/image.ts:4-16, 107-188` 对每个唯一 URL 代理并返回最高约 8 MB，公开接口没有 token bucket；虽逐跳检查 hostname，但未校验 DNS 最终 IP。
- **影响**：攻击者可制造大量唯一 URL 消耗 Pages 出站请求、CPU、内存和流量；动态 DNS/解析层 SSRF 边界还需外网测试。
- **修复**：WAF + Durable Object 令牌桶、显著降低单图上限、稳定缓存键与负缓存；解析并固定公网 IP，逐跳重新验证。

### P1-29 UI 中的“永久分享”实际最多保存 30 天

- **证据**：管理端 `Suite/apps/admin/src/views/AddressView.tsx:98-103, 627-632` 会提交 `forever`；`apps/webmail/functions/_lib/share.ts:290-294` 将该值落入 30 天上限。
- **影响**：用户明确选择永久，但链接 30 天后失效，属于对外承诺与实际访问控制不一致。
- **修复**：产品若支持永久，`expiresAt` 应为 `null` 且另设审计/撤销策略；若不支持，移除 UI 选项并明确最大期限。

### P1-30 大 MIME/CID 附件在主线程批量解析，缓存只限条数不限字节

- **证据**：`Suite/apps/webmail/src/mailParser.ts:75-129, 219-275` 可把 CID 附件转成 base64，并对一页邮件批量解析；`cache.ts:5, 50-56` 只限制 300 条而无总字节上限，写缓存失败会中断同步链。Admin `lib/mailParser.ts:549-624` 也在打开邮件时解析附件/Blob。
- **影响**：大邮件或恶意附件可造成长任务、内存峰值、IndexedDB quota error、界面卡顿甚至标签页崩溃；未采用的 Blob URL 还可能延迟释放。
- **修复**：列表不解析完整 MIME；详情按需在 Web Worker 中解析；限制单邮件/附件/缓存总字节，采用 LRU，并确保 Blob URL 生命周期可回收。

## 7. P2：中优先级问题

| ID | 问题与证据 | 影响 | 建议 |
| --- | --- | --- | --- |
| P2-01 | Admin `functions/api/mail-state.ts:296` 与 Webmail `mail-state.ts:145-164` 都是 KV 读改写 | 两标签同时标记时后写覆盖先写 | DO/D1 原子操作，或增量事件键 |
| P2-02 | `Suite/apps/webmail/functions/_lib/share.ts:447-453` 主记录成功后吞掉摘要/索引错误 | 链接可访问但可能不出现在索引化管理列表；只有处于 legacy fallback 扫描范围时才可能被找回 | 事务存储；至少可靠重试和告警 |
| P2-03 | `_lib/share.ts:456-463` 每次读取都异步重写摘要，未使用 `waitUntil`/catch | 同 key 写限流、费用和未处理 Promise | 仅迁移或变化时写，并交给 `waitUntil` |
| P2-04 | `functions/api/share/[token]/mail/[id].ts:25-33` 重复隐藏同一 ID 仍递减 `mailCount` | 重试/并发使计数持续下降 | 仅首次加入 Set 时递减，增加幂等测试 |
| P2-05 | `functions/api/share/index.ts:145` 只解码 JWT payload 即允许创建分享 | 产生表面成功但打开后 401 的坏链接 | 创建前必须调用上游 settings 验签 |
| P2-06 | `_lib/shareUser.ts:38-43` 要求当前仍拥有分享中的全部地址，payload 无 creator ID | 解绑/转移一个地址后，原创建用户失去该多地址分享的管理/撤销权限，只能由管理员介入 | 保存 `creatorUserId`，解绑/转移时处理关联分享 |
| P2-07 | `functions/api/user/addresses/index.ts:70-80` 先创建邮箱、再独立绑定 | 第二步失败产生孤儿邮箱，重试产生混乱 | Worker 提供“创建并绑定”事务 API |
| P2-08 | `share/admin/batch.ts:13`、`_lib/share.ts:570-615` 可触发数百到上千次 KV/Worker 操作且大量串行等待 | 大批量管理易超时或耗尽子请求 | 降低同步上限、有界并发、队列化和索引化 |
| P2-09 | `deploy-cloudflare-pages.yml:118-124` 在无 `WEBMAIL_RUNTIME_URL` 时跳过探针 | 缺 Worker URL、KV 或 secret 仍显示部署成功 | 生产强制 runtime URL，并验证实际绑定 |
| P2-10 | `smtp_server.py:28-36` 对任意 LOGIN/PLAIN 先成功；`imap_server.py:140-155` 只按 JWT 外形判断成功 | 客户端先显示登录成功，真正收发时才报错 | AUTH 阶段调用后端验签并统一失败语义 |
| P2-11 | `smtp_server.py:90-110` 对缺 From/To/Subject 直接 `decode_header(None)` | 合法 Bcc-only 或无主题邮件触发 TypeError | 所有头字段使用空值 fallback，按 envelope 收件人发送 |
| P2-12 | `imap_mailbox.py:117-149, 200-241` SELECT/FETCH 扫描全邮箱；`:62, 78-79, 257-259` flags 仅内存、UNSEEN 恒 0、首次 fetch 即 Seen | 大邮箱 O(n) 慢，重连后状态丢失且未读数错误 | 后端支持按 ID/cursor 查询；持久化 flags；修正 IMAP 语义 |
| P2-13 | `worker/src/email/index.ts:121-162` 的 forward/auto-reply/extract 未统一隔离；`db/schema.sql` 的 message_id 仅普通索引 | 存储后副作用抛错可能触发重投并重复入库/回复 | 主存储、outbox、幂等 delivery key，副作用独立重试 |
| P2-14 | `worker/src/user_api/user.ts:11-14, 60, 82, 139, 184, 212-214` 对邮箱大小写/空白处理不一致 | 注册、验证码、登录和 OAuth 可表现不同，大小写变化登录失败 | 入口统一 `trim().toLowerCase()`，数据库使用规范化唯一列 |
| P2-15 | `Suite/apps/admin/src/views/MailWorkspace.tsx:46-47, 742-776` 搜索最多加载 240×240=57,600 封，并在每页 merge/sort | 大邮箱造成数百 API 请求、解压/解析和 React 重渲染 | Worker 提供服务端搜索与 cursor；前端取消全量建索引 |
| P2-16 | `apps/webmail/src/App.tsx:1536-1557, 538-587` 首帧先渲染原始远程图片，再异步替换代理 data URL；`mailParser.ts:142-204` 保留 `<style>` 并注入开放 ShadowRoot，且 picture/source/svg 等 URL 未完整代理 | 跟踪像素先泄露 IP/打开时间并双下载；恶意 `:host` CSS 可遮盖阅读界面 | 默认阻断远程 URL；使用 sandbox iframe 和严格元素/CSS allowlist；代理完成后一次性显示 |
| P2-17 | Worker 邮件列表 `mails_crud.ts:16-19`、`admin_mail_api.ts:12-21` 使用 `SELECT *`；`common.ts:660-682` 每页解压完整 raw | 列表/搜索传输和解析大量完整 MIME，放大 CPU、D1 和流量 | 列表只返回摘要；详情接口按 ID 返回 raw/附件 |
| P2-18 | `common.ts:630-637, 673-681` 使用 `ORDER BY ... LIMIT ... OFFSET`；前端依赖 nextOffset | 分页间有新邮件或删除时会重复/跳过记录 | 改用 `(created_at,id)` 或 `id` 的稳定 cursor |
| P2-19 | Admin `MailWorkspace.tsx:531-573, 621-628, 1376-1384` 以并集合并星标且快速 PATCH 可乱序 | 另一端取消的星标被本地旧状态复活，最后点击不一定最后生效 | 操作序列号、服务端 revision 与显式 add/remove 语义 |
| P2-20 | Admin `MailWorkspace.tsx:302-305, 1397-1405` 在地址筛选下仍写 mode 级 `readAllBefore` | “全部已读”会误标同一模式下其他地址邮件 | read-state key 加 address scope，或逐地址保存阈值 |
| P2-21 | Admin 移动详情 `MailWorkspace.tsx:955-965` pushState；`:788-798, 1706-1712` 的滑动/顶部关闭采用不同清理方式 | 快速开关后浏览器返回键穿越“幽灵详情”，历史栈持续增长 | 单一状态机和统一 close 路径；replace/push 规则写 E2E |
| P2-22 | Admin `vite.config.ts:18, 34-37` 启用 skipWaiting、clientsClaim 和旧缓存清理；应用有 lazy chunks 且无 ErrorBoundary | 部署更新时旧页面请求已删除 chunk，可能 ChunkLoadError 白屏 | 保留一代资源、提示刷新、chunk 错误恢复与顶层 ErrorBoundary |
| P2-23 | Webmail `App.tsx:165-168` 对分享 URL 直接 `decodeURIComponent`，没有捕获 URIError | 畸形 `%` 编码链接可让应用启动白屏 | 安全解码 helper，非法 token 显示 400 页面 |
| P2-24 | Admin `public/_headers:9` 的 CSP 不允许 `index.html:15-28` 内联主题脚本，也阻止 `index.html:8-10` Google Fonts；两端品牌字体使用 `font-display:block` | 生产暗色首屏白闪、外部字体加载失败或 Logo 慢网短时不可见 | 内联脚本加 hash/nonce或移到外部；字体自托管，改 `swap/optional` |
| P2-25 | 分享 KV TTL 在 `_lib/share.ts:326-329, 369-375, 447-453` 直接物理删除过期记录；按地址列表 `:618-660` 最多从头扫描 8 页 | “已过期”审计/恢复记录消失；单地址超过约 800 条索引后，较旧分享可能不再出现在按地址管理列表中 | 业务过期与物理清理分离；有序 D1 索引和稳定 cursor |
| P2-26 | `_lib/share.ts:168-176` 只要求 `SHARE_ENCRYPTION_SECRET` 非空，没有长度、熵和 key id | 弱 secret 可离线猜解 KV 中封装的地址 JWT；轮换会让历史分享全部失效 | 至少 32 随机字节、版本化 key ring 和轮换演练 |
| P2-27 | Admin `MailWorkspace.tsx:1525-1543` 处理 iframe postMessage 时不核对 `event.source` | 能持有窗口引用的其他 frame 可伪造滑动消息，干扰 UI | 保存 iframe ref，同时校验 source、类型和严格 payload |
| P2-28 | Admin mail-state `functions/api/mail-state.ts:32-35, 175-198` 的身份缓存无上限；Admin/Webmail state key 未包含 Worker/租户维度 | 大量 token 推高 isolate 内存；共享 KV 绑定下同 email/id 可跨环境污染 | 有界 LRU/TTL；key 加 tenant/worker ID 和稳定 subject |
| P2-29 | Address `AddressView.tsx:700-737, 807-834` 可在挂载后全量拉地址并缓存；`:217-229` 用户筛选硬上限 1000；批量分享 `:1393-1400` 无并发上限 | 大租户背景请求、内存和子请求飙升，1000 后结果不完整 | 服务端搜索/cursor、AbortController、有界并发和明确截断提示 |
| P2-30 | Admin `admin-proxy.ts:136-148, 191-210` 几乎每个请求额外请求一次 profile；通用上游 fetch 多数无应用级总 deadline | 页面并发请求被放大，慢上游时 Pages 函数堆积 | 短 TTL 的验签后角色缓存、请求取消传播和统一 deadline |

## 8. 性能、动画和前端工程观察

以下属于已测量的工程风险，不单独计入 P0–P2 数量：

- `apps/admin/src/index.css` 为 **19,547 个物理行 / 616,523 bytes**，存在多代“FINAL Vxx”覆盖层；样式优先级和重计算成本高，动画回归难以定位。
- Admin 构建 CSS 约 **539,870 bytes**，主业务 JS 约 **307,099 bytes**；Admin `dist` 总量约 **36.1 MB**。
- Admin `public` 约 **34.9 MB**，多张 PNG 单图 1.7–2.7 MB；Webmail `public` 约 **3.74 MB**。
- Admin 搜索与全量地址索引均有“逐页拉全量再前端过滤”的路径，规模增大后会造成持续网络请求、解压、排序和 React 更新。
- 品牌图标解析在 Admin/Webmail 复制了两份实现，安全修复容易漂移。
- 当前多端 smoke 验证了常用尺寸和无横向溢出，但没有覆盖低端手机长列表、快速连续手势、后台/前台切换、`prefers-reduced-motion` 和 4× CPU slowdown。

## 9. 测试覆盖缺口

本次没有执行或无法可靠模拟的范围：

1. Docker daemon 不可用，上游完整 Docker E2E 未运行。
2. 未连接真实生产 D1/KV，因此没有执行真实的并发扣费、地址转移、注册原子性和 KV 跨 POP 一致性测试。
3. 未对真实 Cloudflare Email Routing、SMTP 提供商、S3、Telegram、Webhook 和 AI 提取故障做混沌测试。
4. 未进行外网渗透、WAF 配置验证和生产 secret/权限审计。
5. 未进行长时间 soak、数百并发用户、万封级邮箱和低端移动设备性能测试。
6. 现有 `share-delete` 等 Functions 检查含较多源码正则/定制 smoke，无法证明运行时原子语义。

## 10. 建议的发布门禁

在恢复正常扩流前，至少满足：

- P0-01、P0-02 有迁移方案并完成安全回归。
- 删除未验签 mail-state fallback，修复 admin token 选择。
- 地址删除/转移、注册/角色、发件额度有原子并发测试。
- 分享 revoke/hide、期限 PATCH、50+ 邮件分页和列表游标测试通过。
- IMAP 生产日志确认不含凭证，SMTP 不再阻塞 event loop。
- Worker 运行时 critical/high 依赖得到处置或有书面、可验证的例外。
- Deploy 只在完整 CI 成功后执行，并强制生产 runtime probe。
- 上游 Docker E2E、Suite `npm run check:release` 和新增安全/并发测试全部通过。

详细整改顺序、验收标准与负责人建议见 `docs/OPTIMIZATION_REPORT_2026-07-13.md`。
