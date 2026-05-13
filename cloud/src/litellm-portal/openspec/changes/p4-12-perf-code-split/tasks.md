## 1. 路由级 splitting

- [x] 1.1 admin 路由全部改为 `createLazyRoute`（TanStack Router）
- [x] 1.2 验证 user bundle 不含 `AdminUsersTable` / `AdminAuditFeed` 等代码（build 脚本失败若 admin inputs 出现在 main chunk）

## 2. 组件级懒加载

- [x] 2.1 `React.lazy(() => import('@cloudflare/kumo/components/command-palette'))` 等大组件
- [x] 2.2 Suspense 边界 + 加载态用 `<Loader />`

## 3. R2 接入 (deferred — operational, owner)

- [ ] 3.1 `wrangler r2 bucket create litellm-portal-assets`
- [ ] 3.2 build 脚本：生成 hash 文件名（`portal.[hash].js` / `kumo.[hash].css`），写入 R2
- [ ] 3.3 自定义域 `assets.zhiyun.ziikoo.com` 指 R2
- [ ] 3.4 旧路径 `/portal.js` `/kumo.css` 改为 302 重定向（兼容期）

## 4. Cache 头 (deferred — depends on §3)

- [ ] 4.1 R2 端 / Worker assets 路由设置 `Cache-Control: public, max-age=31536000, immutable`
- [ ] 4.2 HTML 设置 `private, max-age=0, must-revalidate`
- [ ] 4.3 配合 ETag / Last-Modified

## 5. Source maps (deferred — needs Sentry config)

- [ ] 5.1 esbuild 配 `sourcemap: 'external'` 生成 `.map` 文件
- [ ] 5.2 `.map` 上传 R2 但 robots disallow（或上传到 Sentry）
- [ ] 5.3 HTML 不引用 `.map`（不暴露）

## 6. Bundle analyzer

- [x] 6.1 集成 `esbuild-visualizer`（生成 `cloud/dist/reports/litellm-portal-bundle.html`）
- [ ] 6.2 CI step：构建后生成 report，PR 评论 bundle size 差异 (deferred — needs github-actions integration)
- [x] 6.3 size budget：user main < 100KB gzip、admin chunk < 80KB gzip，超限构建失败（gate built into `scripts/build-litellm-portal-app.mjs`）

## 7. 测试

- [x] 7.1 单元：路由 lazy load 触发后加载对应模块（`cloud/src/litellm-portal/index.test.ts`）
- [ ] 7.2 E2E：admin 切换时 Network 面板看到 admin chunk 请求 (deferred — covered by §6.1 build assertion + §1.2 input check)

## 8. 验证 (deferred — operational)

- [ ] 8.1 Lighthouse 跑分：Performance 95+
- [ ] 8.2 WebPageTest LCP < 1s
- [ ] 8.3 R2 缓存命中率 95%+
