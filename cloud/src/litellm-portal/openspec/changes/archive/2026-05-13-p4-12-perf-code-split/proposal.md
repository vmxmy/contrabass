## Why

性能现状：

- `app.generated.ts` 是单一大 bundle（含 admin 代码、所有 kumo 组件），用户端也会下载 admin chunk
- 静态资产（`portal.js`、`kumo.css`）通过 worker 内嵌 `embed.FS` 提供，每次请求都走 Worker 计算
- 无 source maps，线上错误不可读
- 缺 stale-while-revalidate / 服务端缓存的 HTTP 资产策略

## What Changes

- **路由级 code splitting**：admin 子路由用 `lazyRouteComponent`，admin chunk 只在切到 admin 时加载（与 P1-04 router 协同）
- **kumo 大组件按需 import**：`CommandPalette`、`Sidebar`、`DateRangePicker` 等大组件懒加载
- **静态资产分离到 R2**：`portal.js`、`kumo.css` 上传 R2，从 Worker 内嵌移除；Worker 只负责 HTML
- **CDN cache header**：JS/CSS 加 `Cache-Control: public, max-age=31536000, immutable`（含 hash 文件名）
- **HTML 缓存**：登录页面用 `Cache-Control: private, max-age=0, must-revalidate`，但 SSR 数据快速
- **Source maps**：production 构建生成 source maps，上传到 Sentry（或自托管），不公开
- **Bundle 分析**：CI 跑 `rollup-plugin-visualizer`，PR 显示 bundle size 差异

## Capabilities

### New Capabilities
- **route-code-splitting**：admin/user bundle 分离
- **r2-static-assets**：静态资产由 R2 + 边缘缓存提供
- **production-source-maps**：可解析的线上错误

### Modified Capabilities
- **资产分发**：从 Worker 嵌入 → R2 + CDN cache

## Impact

- **新增**：R2 bucket `litellm-portal-assets`
- **改造**：`scripts/build-litellm-portal-app.mjs` 输出 hash 文件名 + 上传 R2
- **改造**：Worker 不再 serve `/portal.js` 与 `/kumo.css`；HTML 引用 R2 URL 或 CNAME `assets.zhiyun.ziikoo.com`
- **新增**：bundle analyzer 报告
- **Breaking**：访问 `/portal.js` 旧路径返回 404；外部若有 hot-link 需迁移
- **测试**：bundle size 上限 gate（main bundle < 100KB gzip）
