# 开发反思报告

**日期**: 2026-07-27
**提交类型**: bugfix
**修改文件数**: 4 个功能、测试与文档文件

## 1. 概述

修复 Admin Production 已发布新版本，但受旧 Service Worker 控制的浏览器在普通刷新后仍持续运行旧前端 bundle，导致实时语言切换修复无法到达真实用户的问题。

## 2. 修改内容

- 网络直出的 `pwa-register-v2.js` 在发现已有 waiting Worker 时立即请求激活。
- 监听 `updatefound`，在新 Worker 安装完成且页面已有旧控制器时请求激活。
- 沿用激活后只重载一次及 4 秒兜底，避免重复刷新。
- 保留首次安装不强制重载，避免新用户进入循环。
- 增加 waiting 和 updatefound 两种时序的行为测试。

## 3. 遇到的错误

1. **验收入口错误（重要）**：最初使用本地 mock 验证语言切换，没有验证真实登录后的 Production 页面。
2. **部署版本与执行版本不一致（重要）**：Cloudflare Production 已指向新提交，但浏览器仍加载旧 `index-CGO6vM1G.js`；网络直取 HTML 已引用新 `index-BYJ9pOjV.js`。
3. **PWA 更新停留在 waiting（重要）**：注册器只调用 `registration.update()`，没有处理 waiting 或 updatefound；除非用户遇到错误提示并点击刷新，新 Worker 永远不会接管。

## 4. 根本原因分析

- React locale 修复已经存在于新 bundle，真正阻断交付的是 Service Worker 生命周期。
- `skipWaiting: false` 和 `clientsClaim: false` 是合理的安全默认值，但必须由网络直出的注册器显式协调激活和重载。
- 原注册器只拦截“检测到新版本”错误提示中的按钮，没有主动产生更新提示，也没有自动处理更新完成事件。

## 5. 调试过程

1. 在用户已登录的正式后台复现：`document.lang` 改变，仪表盘标题不变。
2. 对比 Cloudflare deployment source、网络 HTML 和浏览器实际 script hash。
3. 临时绕过 Service Worker 强制加载新 bundle，确认仪表盘立即显示英文，证明 React 修复有效。
4. 恢复正常网络并普通刷新，页面再次加载旧 hash，确认根因位于 PWA 更新链路。
5. 先编写两条失败测试，再实现 waiting 与 updatefound 激活逻辑。

## 6. 经验总结

- PWA 发布验收必须同时核对平台部署版本、网络 HTML 和浏览器实际执行的 bundle hash。
- 本地 Smoke 不能替代真实域名、真实登录状态和真实 Service Worker 控制下的验证。
- 选择 prompt 型 Worker 生命周期时，必须保证提示确实可达；否则 waiting 会成为永久旧版本。

## 7. 知识提炼

- 可复用模式：网络直出且禁止缓存的注册器负责更新协调，生成 Worker 保持保守生命周期设置。
- 可复用模式：覆盖“加载时已 waiting”和“更新后才 installed”两种异步时序。
- 应避免：只验证部署 ID，不验证用户浏览器实际加载的资源 hash。

## 8. 测试与验证

- 两条新增测试先红后绿。
- Admin 前端测试 59/59 通过。
- Admin 生产构建通过。
- Admin Chromium smoke 完整通过。
- `git diff --check` 通过。

## 9. 参考资料

- 注册器：`apps/admin/public/pwa-register-v2.js`
- 回归测试：`apps/admin/tests/frontend-release.test.ts`
- PWA 配置：`apps/admin/vite.config.ts`

## 10. 指标

- 总错误数: 3
- 严重错误数: 0
- 调试迭代次数: 3
- 新增行为测试: 2
- 最终验证成功率: 100%

---
**生成工具**: Codex
**技能**: commit-with-reflection v3.0
