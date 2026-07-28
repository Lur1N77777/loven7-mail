# 开发反思报告

**日期**: 2026-07-28
**提交类型**: bugfix
**修改文件数**: 10 个功能、资源与测试文件

## 1. 概述

修复 Admin 与 Webmail 的 HTML 邮件兼容性问题：固定宽度表格被阅读器全局样式拉伸、不同发件方的顶层邮件画布未统一居中，以及 Claude 静态 Logo 因源站 Cloudflare 挑战导致图片代理返回破图。

## 2. 修改内容

- 停止对邮件内所有元素和表格强制 `max-width`、`width:auto`、`box-sizing:border-box`。
- 保留发件方显式图片高度，仅为没有 `height` 属性的图片自动计算高度。
- 将邮件根节点的直接子画布水平居中，不修改邮件内部文字、列和段落对齐。
- 为两个已失效的 Claude/Anthropic 静态 Logo 地址提供同源资源回退。
- Admin 与 Webmail 同步增加固定表格、顶层居中和品牌资源回退测试。

## 3. 遇到的错误

1. **执行版本不一致（重要）**：第一轮修复只保留在本地工作树，正式站仍运行旧版本，因此用户复测时破图和错位完全没有变化。
2. **邮件布局被全局 CSS 改写（重要）**：Stripe 邮件原有 `align="center" width="600"` 表格被强制扩展到阅读器宽度；PayPal 顶层约 640px 画布左右 margin 为 0。
3. **图片源站拒绝服务器抓取（重要）**：Claude Logo 的 PNG 地址对代理返回 Cloudflare 403 challenge，代理正确拒绝 HTML 错误页并返回 415。
4. **公共发布检查失败（次要）**：测试夹具直接包含真实品牌域名，不符合仓库只允许 example 部署 URL 的发布规范。

## 4. 根本原因分析

- HTML 邮件依赖旧式 table 属性和固定尺寸，阅读器不能把普通网页的响应式全局规则无差别施加到邮件 DOM。
- 不同邮件的顶层结构不同：有的自带居中属性，有的只有固定最大宽度；阅读器需要统一居中顶层画布，同时尊重内部布局。
- 图片代理的 MIME 安全校验没有问题，真正失败点是源站反爬；放宽校验会把挑战 HTML 当图片，必须采用受控同源回退。
- 发布状态与本地状态没有在首次交付时一起说明和执行，造成“代码已修复”与“用户实际可见版本”脱节。

## 5. 调试过程

1. 在正式站逐封测量 PayPal、Stripe、Claude iframe 的顶层节点、表格宽度、margin 和图片自然尺寸。
2. 确认 PayPal 画布约 640px 但贴左；Stripe 的 600px 居中表格被旧 CSS 拉到约 887px；Claude 图片加载完成但 `naturalWidth=0`。
3. 直连 Claude 图片与同源代理，分别得到 403 challenge 和 415，确认代理没有错误接受非图片响应。
4. 先添加失败测试，再移除破坏邮件几何的全局规则、增加顶层画布居中和同源 Logo 回退。
5. 修正测试夹具的公共发布 URL 规范后，从头执行完整 release 检查。

## 6. 经验总结

- 邮件 HTML 渲染应采用“最小干预”：安全清洗可以严格，视觉 CSS 应尽量保留发送方 table、width、height 和 align 语义。
- 代理错误必须区分“资源不是图片”和“源站拒绝抓取”，不能通过关闭 MIME 校验掩盖问题。
- 交付邮件/PWA 修复时必须同时完成代码、构建、部署和正式域名真实样本验收。

## 7. 知识提炼

- 可复用模式：只统一 iframe 根节点直接子画布的外部对齐，内部邮件布局保持隔离。
- 可复用模式：对确定失效且稳定的品牌静态资源使用窄范围同源映射，其余 URL 继续走安全代理。
- 应避免：对所有 `table/td/img/*` 使用 `!important` 响应式覆盖。
- 应避免：只以本地测试通过或 Cloudflare deployment success 作为用户可见修复的证据。

## 8. 测试与验证

- 新增居中测试完成红绿验证。
- Admin 60/60、Webmail 31/31 前端测试通过。
- Cloudflare Pages 预检、图片代理、CORS、分享删除与 Functions 回归检查通过。
- Admin 与 Webmail 生产构建及 Chromium smoke 通过。
- 发布后继续在正式域名核对真实邮件左右留白与 Logo `naturalWidth`。

## 9. 参考资料

- Admin 邮件解析器：`apps/admin/src/lib/mailParser.ts`
- Webmail 邮件解析器：`apps/webmail/src/mailParser.ts`
- 图片地址映射：`apps/admin/src/lib/mailImageProxy.ts`、`apps/webmail/src/mailImageProxy.ts`
- 回归测试：`apps/admin/tests/frontend-release.test.ts`、`apps/webmail/tests/frontend-release.test.ts`

## 10. 指标

- 总错误数: 4
- 严重错误数: 0
- 调试迭代次数: 4
- 新增/扩展回归测试: 2
- 发布前验证成功率: 100%

---
**生成工具**: Codex
**技能**: commit-with-reflection v3.0
