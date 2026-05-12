## Why

Tab 状态目前用 URL hash (`#admin` / `#user`) 加 `applyTabToDom` 手工切 DOM `hidden`。已知约束：

- 不能表达子路由（admin 视图未来要点进具体用户/团队/审计事件）
- 浏览器后退/前进按钮交互不天然
- 共享链接只到 tab 粒度
- 与 React 组件树解耦，导致每个 tab 切换都做 DOM 突变

## What Changes

- **接入 TanStack Router**（file-based + type-safe），路径模型：
  - `/`：用户面板
  - `/admin`：admin overview
  - `/admin/users`、`/admin/users/:userId`
  - `/admin/teams`、`/admin/teams/:teamId`
  - `/admin/audit`、`/admin/audit/:eventId`
  - `/admin/usage`
- **路由级 role guard**：admin 路由用 `beforeLoad` 校验 `useMe().role === 'admin'`，否则重定向到 `/`
- **删除手工 DOM 切换**：`applyTabToDom`、`#user-panel hidden` 全部退役；改为 React 路由 `<Outlet />` 渲染
- **保留分段 Tabs 视觉**：tab 栏改为 `<Link to="/" />` + `<Link to="/admin" />`，外观不变
- **预加载与代码分割**：admin 子树用 `lazyRouteComponent` 拆 chunk（与 P4-12 协同）

## Capabilities

### New Capabilities
- **deep-linking**：admin 子页面（用户详情、审计单条事件）可分享 URL
- **route-level-role-guard**：admin 路由在导航前就拒绝非 admin

### Modified Capabilities
- **tab 切换**：从 URL hash 升级为完整路径
- **portal 顶层结构**：单 page → 路由树

### Removed Capabilities
- `applyTabToDom`、`#user-panel`/`#admin-root` 手动 hidden 切换

## Impact

- **新增**：`routes/__root.tsx`、`routes/index.tsx`、`routes/admin.tsx`、`routes/admin/users.tsx` 等
- **改造**：`PortalTabs` 改为基于 `useMatchRoute` 高亮当前路由
- **改造**：admin 子组件解耦为可独立路由的页面，而非一张大表的 4 个 card
- **新增依赖**：`@tanstack/react-router`
- **Breaking**：URL `#admin` 不再生效（提供一次性 redirect 兼容期）
- **测试**：路由测试用 `createMemoryHistory` 模拟导航
