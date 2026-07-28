# 开发反思报告

**日期**: 2026-07-28
**提交类型**: bugfix
**修改文件数**: 4 个配置、资源与测试文件

## 1. 概述

修复 Admin 正式站中 HTML 邮件的 Claude/Anthropic 本地 Logo 仍显示破图的问题。前一轮已将会被 Claude 源站拦截的图片映射到同源资源，但邮件 iframe 的沙箱安全模型仍会阻止该资源嵌入。

## 2. 修改内容

- 为 Admin 的 `/mail-assets/*` 设置 `Cross-Origin-Resource-Policy: cross-origin`，仅放开受控的邮件回退资源。
- 保持全站默认 `same-site` 资源隔离，其他静态资源不受影响。
- 更新两张回退 SVG 的版本内容，使 PWA 预缓存清单更新，旧客户端不会继续使用带旧响应头的缓存副本。
- 增加回归断言，要求邮件回退资源始终兼容无来源的沙箱 iframe。

## 3. 遇到的错误

1. **HTML 邮件仍显示破图（重要）**：正式站中图片地址已是同源、HTTP 也返回 `200 image/svg+xml`，但浏览器仍显示备用文本。
2. **安全上下文误判（重要）**：将“同源地址”视为一定可被邮件 iframe 使用，忽略了 iframe 的 `sandbox` 未授予 `allow-same-origin`，因此其实际来源是 opaque origin。
3. **PWA 缓存风险（次要）**：只修改 `_headers` 不会改变预缓存资源版本；旧 Service Worker 可能继续提供带旧响应头的 Logo。

## 4. 根本原因分析

- Admin 的全局 `_headers` 默认发送 `Cross-Origin-Resource-Policy: same-site`。
- 邮件正文运行在不带 `allow-same-origin` 的 `srcdoc` iframe 中，浏览器将其视为无来源页面；从其中请求 Admin 的静态 SVG 时，不满足 `same-site` 嵌入策略。
- 图片代理已正确发送 `cross-origin`，这也解释了为什么代理图片可显示而本地回退 SVG 不可显示。

## 5. 调试过程

1. 在正式 Admin 中重新打开 Claude 邮件，确认破图仍可稳定复现。
2. 核对图片元素：`src` 已映射为 `/mail-assets/claude-logo-full.svg`，且静态请求返回正确 MIME 类型。
3. 检查邮件 iframe 属性，确认其 `sandbox` 不含 `allow-same-origin`。
4. 对比图片代理响应头与静态资源的默认响应头，定位到 `Cross-Origin-Resource-Policy` 差异。
5. 先添加会失败的响应头回归断言，再按最小范围添加静态资源豁免并更新预缓存版本。

## 6. 经验总结

- 沙箱 iframe 中的“同源 URL”不等于同源嵌入；必须同时考虑请求发起者的实际安全来源。
- 安全头例外应按目录精确限定，不能为了显示图片移除全站 CORP。
- PWA 中受响应头影响的静态资源更新时，需要确保预缓存清单发生版本变化。

## 7. 知识提炼

- 可复用模式：为邮件沙箱专用的受控资源放置独立目录，并用 `Cross-Origin-Resource-Policy: cross-origin` 显式标注。
- 可复用模式：代理图片和本地回退资源应具有相同的嵌入安全语义。
- 应避免：仅用 HTTP 200、URL 正确或服务器端 fetch 成功来判断沙箱图片已修复。

## 8. 测试与验证

- 新回归测试先红后绿：Admin 60/60 通过。
- Admin 生产构建通过，生成的 `sw-v2.js` 包含更新后的两个 Logo revision。
- 发布后在正式 Admin 中重新检查 Claude 邮件的渲染状态与资源响应头。

## 9. 参考资料

- 静态响应头：`apps/admin/public/_headers`
- Logo 回退映射：`apps/admin/src/lib/mailImageProxy.ts`
- 邮件 iframe 生成：`apps/admin/src/lib/mailParser.ts`
- 回归测试：`apps/admin/tests/frontend-release.test.ts`

## 10. 指标

- 总错误数: 3
- 严重错误数: 0
- 调试迭代次数: 2
- 新增/扩展回归测试: 1

---
**生成工具**: Codex
**技能**: commit-with-reflection v3.0
