## 1. 路由级 splitting

- [ ] 1.1 admin 路由全部改为 `createLazyRoute`（TanStack Router）
- [ ] 1.2 验证 user bundle 不含 `AdminUsersTable` / `AdminAuditFeed` 等代码（用 source-map-explorer 验证）

## 2. 组件级懒加载

- [ ] 2.1 `React.lazy(() => import('@cloudflare/kumo/components/command-palette'))` 等大组件
- [ ] 2.2 Suspense 边界 + 加载态用 `<Loader />`

## 3. R2 接入

- [ ] 3.1 `wrangler r2 bucket create litellm-portal-assets`
- [ ] 3.2 build 脚本：生成 hash 文件名（`portal.[hash].js` / `kumo.[hash].css`），写入 R2
- [ ] 3.3 自定义域 `assets.zhiyun.ziikoo.com` 指 R2
- [ ] 3.4 旧路径 `/portal.js` `/kumo.css` 改为 302 重定向（兼容期）

## 4. Cache 头

- [ ] 4.1 R2 端 / Worker assets 路由设置 `Cache-Control: public, max-age=31536000, immutable`
- [ ] 4.2 HTML 设置 `private, max-age=0, must-revalidate`
- [ ] 4.3 配合 ETag / Last-Modified

## 5. Source maps

- [ ] 5.1 esbuild 配 `sourcemap: 'external'` 生成 `.map` 文件
- [ ] 5.2 `.map` 上传 R2 但 robots disallow（或上传到 Sentry）
- [ ] 5.3 HTML 不引用 `.map`（不暴露）

## 6. Bundle analyzer

- [ ] 6.1 集成 `rollup-plugin-visualizer` 或 `esbuild-visualizer`
- [ ] 6.2 CI step：构建后生成 report，PR 评论 bundle size 差异
- [ ] 6.3 size budget：user main < 100KB gzip、admin chunk < 80KB gzip，超限 CI 失败

## 7. 测试

- [ ] 7.1 单元：路由 lazy load 触发后加载对应模块
- [ ] 7.2 E2E：admin 切换时 Network 面板看到 admin chunk 请求

## 8. 验证

- [ ] 8.1 Lighthouse 跑分：Performance 95+
- [ ] 8.2 WebPageTest LCP < 1s
- [ ] 8.3 R2 缓存命中率 95%+
