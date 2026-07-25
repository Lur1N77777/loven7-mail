# 开发反思报告

**日期**: 2026-07-25
**提交类型**: bugfix
**会话时长**: 约 90 分钟
**修改文件数**: 20 个功能与测试文件

## 1. 概述

修复发件人域名头像长期退化为首字母，以及 HTML 邮件中的远程图片无法显示的问题。修复同时覆盖 Admin 与 Webmail，并保留邮件 iframe 的隔离、无 Referrer 和图片代理 SSRF 防护。

## 2. 修改内容

### 修改的文件

- `apps/admin/functions/api/brand-icon.ts`、`apps/webmail/functions/api/brand-icon.ts`：优化品牌图标发现顺序和重定向后相对 URL 解析。
- `apps/admin/functions/api/image.ts`、`apps/webmail/functions/api/image.ts`：提供双端同源图片代理，并允许 sandbox iframe 显示代理响应。
- `apps/admin/src/lib/mailParser.ts`、`apps/webmail/src/mailParser.ts`：自动改写邮件图片、`srcset`、背景图和 CSS 图片 URL。
- `apps/admin/src/lib/mailImageProxy.ts`、`apps/webmail/src/mailImageProxy.ts`：集中实现邮件图片 URL 改写。
- `apps/admin/src/lib/brandIdentity.tsx`、`apps/webmail/src/brandIdentity.tsx`：更新失败缓存版本并缩短负缓存时间。
- Webmail 展示状态、样式、Functions 检查、单元测试和双端浏览器 smoke：删除旧的手动加载链路并补充回归覆盖。

### 主要变更

- 优先读取网站 HTML 声明的 favicon，再尝试约定路径，避免 `/favicon.ico` 超时或 404 阻塞正确图标。
- 使用最终页面响应 URL 解析相对图标地址，并升级服务端、浏览器端缓存版本。
- 邮件图片默认经当前站点 `/api/image` 加载，不再让 iframe 直接连接任意第三方域名。
- 图片代理限制协议、域名、DNS 结果、重定向、MIME、大小、请求频率和总超时。
- `srcset` 按候选语法解析，避免破坏带逗号的 `data:image` URL。

## 3. 遇到的错误

1. **品牌图标发现顺序错误（重要）**：约定 favicon 路径先于 HTML 声明图标，Notion 的正确图标来不及尝试。
2. **远程图片策略与产品需求冲突（重要）**：Webmail 默认阻止远程图片，Admin 又没有可用的手动放行路径，导致功能表现为失效。
3. **`srcset` 边界解析错误（次要）**：初版改写直接按逗号分割，会截断 `data:image/...;base64,...`。

## 4. 根本原因分析

### 为什么会出现这个错误?

- 图标解析器假设主流站点会提供约定路径，低估了 HTML 声明图标的优先级。
- 隐私加固只考虑了“阻止第三方请求”，没有同时提供安全、自动、同源的替代加载路径。
- `srcset` 被当作普通逗号列表处理，没有考虑 URL 本身可以包含逗号。

### 是什么导致编写时出现这个错误?

- 缺少 Notion 这类非标准 favicon 路径的回归 fixture。
- Admin 与 Webmail 的图片展示链路不完全对称。
- 初版测试只覆盖单一 `src`，没有覆盖响应式图片和内嵌数据图片组合。

## 5. 调试过程

### 调查步骤

1. 跟踪 `BrandAvatar` 到 `/api/brand-icon`，确认字母是代理失败后的回退表现。
2. 检查 Notion 首页与图标路径，定位约定路径 404、HTML 声明路径有效。
3. 追溯邮件 iframe 的 sanitizer、CSP 和旧图片内存缓存，确认远程图片是被策略主动清除。
4. 设计同源代理方案，并复用现有图片代理的 SSRF、大小、MIME、缓存和限流边界。
5. 人工审查时发现 `srcset` 数据 URL 逗号边界，补测试并修复。

### 迭代过程

- 尝试 1：只调整 favicon 候选顺序；补充相对 URL 按最终响应地址解析和缓存版本升级后才完整。
- 尝试 2：恢复图片显示但保留任意 `https:` CSP；改为同源代理后避免 iframe 直连第三方。
- 尝试 3：简单逗号分割 `srcset`；严格审查发现数据 URL 截断并改为扫描式候选解析。

### 耗时统计

- 调查: 约 25 分钟
- 实现: 约 35 分钟
- 测试与审查: 约 30 分钟

## 6. 经验总结

### 核心洞察

- 品牌图标发现应优先尊重站点显式元数据，约定路径只能作为回退。
- 安全策略不应只“关闭功能”，应提供满足相同安全目标的代理替代路径。
- 邮件 HTML 包含大量边缘格式，URL 列表不能用通用字符串分割代替语法解析。

### 预防策略

- 为非标准 favicon、页面重定向和失败缓存加入固定回归测试。
- Admin/Webmail 的邮件资源策略保持功能和安全测试对称。
- 图片 URL 测试覆盖 `src`、`srcset`、CSS `url()`、背景属性、重定向和内嵌数据图片。

### 识别的最佳实践

- iframe CSP 仅开放当前站点图片代理，并设置 `referrerPolicy="no-referrer"`。
- 代理对每个重定向重新校验 DNS 和目标地址，并设置总请求截止时间。
- 修复缓存相关缺陷时同时升级服务端缓存键和浏览器负缓存键。

## 7. 知识提炼

### 可复用模式

- “第三方资源 → 同源受控代理 → sandbox iframe”的安全邮件资源加载模式。
- “显式元数据优先、约定位置回退”的品牌资产发现模式。

### 应避免的反模式

- 把长期负缓存用于网络和站点结构这类易变化失败。
- 在 CSP 中直接允许任意 `http:`/`https:` 来解决资源显示问题。
- 用 `split(',')` 解析 `srcset`、CSS 或其他带嵌套语法的字段。

### 类似任务检查清单

- [x] 验证原始用户症状。
- [x] 双端实现保持一致。
- [x] 检查 SSRF、重定向、DNS、MIME、大小、限流和超时。
- [x] 检查 iframe CSP、CORP 和 Referrer 策略。
- [x] 覆盖响应式图片与内嵌图片边界。
- [x] 运行单元、构建和浏览器回归。

## 8. 测试与验证

### 测试用例

- Admin 前端测试 25/25 通过；Webmail 前端测试 10/10 通过。
- 品牌图标代理回归覆盖 Notion 风格 HTML 图标优先级、DNS、重定向、限流和缓存。
- 图片代理回归覆盖 Admin/Webmail、私网 IPv4/IPv6、DNS、重定向、MIME、大小、缓存、限流、超时和 CORP。
- 双端浏览器 smoke 验证邮件 HTML 自动出现 `/api/image?url=...`。

### 验证步骤

1. 执行 `npm run check:release`，退出码为 0。
2. 执行真实网络 Notion 图标请求，返回 HTTP 200、`image/svg+xml`、1872 字节。
3. 执行 `git diff --check`，无空白错误。

## 9. 参考资料

- 项目内 Functions 安全检查：`apps/webmail/scripts/check-image-proxy.mjs`、`apps/webmail/scripts/check-brand-icon-proxy.mjs`。
- 项目内发布门禁：根目录 `npm run check:release`。

## 10. 指标

- 总错误数: 3
- 严重错误数: 0
- 调试迭代次数: 3
- 成功率: 100%
- 代码变动: 以最终 Git diff 为准

---
**生成工具**: Codex
**技能**: commit-with-reflection v3.0
