## 1. Router 接入

- [ ] 1.1 `pnpm add @tanstack/react-router`
- [ ] 1.2 配置 `vite-plugin-tanstack-router` 自动生成 routeTree（或手写）
- [ ] 1.3 新建 `router.ts`，导出 `router` 实例

## 2. 路由树定义

- [ ] 2.1 `routes/__root.tsx`：layout 组件（header、tab 栏、`<Outlet />`）
- [ ] 2.2 `routes/index.tsx`：用户面板（HeroStats / TeamsAccessCard / ModelAccessCard / ApiKeysCard / UsagePanel 组合）
- [ ] 2.3 `routes/admin/route.tsx`：admin layout，`beforeLoad` 检查 role
- [ ] 2.4 `routes/admin/index.tsx`：admin overview（沿用现 AdminSection 4 卡）
- [ ] 2.5 `routes/admin/users/route.tsx` + `routes/admin/users/$userId.tsx`：可选拆细
- [ ] 2.6 `routes/admin/teams/route.tsx` + `routes/admin/teams/$teamId.tsx`
- [ ] 2.7 `routes/admin/audit/route.tsx` + `routes/admin/audit/$eventId.tsx`
- [ ] 2.8 `routes/admin/usage/route.tsx`

## 3. Tab 栏适配

- [ ] 3.1 `PortalTabs` 改用 `useRouterState` 获取当前 path
- [ ] 3.2 tab 改为 `<Link to="/" />` 与 `<Link to="/admin" />`，渲染时复用 kumo `<Tabs>` 视觉

## 4. 删除旧切换逻辑

- [ ] 4.1 删除 `applyTabToDom / readTabFromHash`
- [ ] 4.2 删除 `#user-panel` 和 `#admin-root` 上的 `hidden` 控制
- [ ] 4.3 删除 `PortalTabsLoader` 中的手工 DOM 操作

## 5. Hash 兼容期

- [ ] 5.1 `__root.tsx` 内一次性 effect：检测 `window.location.hash === '#admin'` → `router.navigate({ to: '/admin', replace: true })`
- [ ] 5.2 计划在 4 周后删除该 redirect

## 6. SSR 兼容

- [ ] 6.1 Worker 端用 `createServerHistory`，把请求 URL 注入 router
- [ ] 6.2 `renderPortalSSR` 走 `<RouterProvider router={router} />`
- [ ] 6.3 验证直接访问 `/admin/users` 能 SSR 出对应页面

## 7. 测试

- [ ] 7.1 单元测试：role guard 在非 admin 时重定向到 `/`
- [ ] 7.2 单元测试：tab 高亮跟随路由变化
- [ ] 7.3 SSR 测试：直接请求 `/admin/audit/abc123` 返回 200 + 含审计单条事件 markup
- [ ] 7.4 E2E（与 P3-09 协同）：浏览器后退/前进按钮正常工作

## 8. 验证

- [ ] 8.1 typecheck 全过
- [ ] 8.2 build 全过
- [ ] 8.3 浏览器：所有 tab 切换、子页深链、role guard 验证
