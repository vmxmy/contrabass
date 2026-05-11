## Why

Admin 视图当前是一张大长页（4 张 card 纵向叠），随着 admin 能力扩展（用户详情、团队详情、审计单条、写操作、设置）会变得难以浏览。kumo 提供了完整的导航组件家族：

- `Sidebar`：响应式侧栏，可折叠，含菜单组、子菜单、菜单徽章
- `Breadcrumbs`：路径导航，适合 admin 子页
- `CommandPalette`：⌘K 全局快速跳转 + 操作
- `MenuBar`：横向 icon toolbar，适合表格视图切换

## What Changes

- **admin layout 改为 Sidebar + Outlet**：左侧导航（用户/团队/审计/用量/设置），右侧 `<Outlet />` 渲染当前子页
- **Breadcrumbs**：admin 子页顶部显示 `管理员 / 用户 / Laoxu`
- **CommandPalette**：`⌘K` 触发，可搜索用户邮箱、跳转 audit 事件 id、跳转 team 别名
- **MenuBar（可选）**：admin tables 顶部加视图切换（列表/卡片/图表）

## Capabilities

### New Capabilities
- **admin-sidebar-navigation**：左侧菜单替代单页 4 card
- **command-palette**：全局快捷搜索 + 操作
- **breadcrumbs**：admin 子页面级导航

### Modified Capabilities
- **admin overview**：从单页堆叠 → 多页 + 侧栏

## Impact

- **改造**：`routes/admin/route.tsx` 加 Sidebar layout
- **新增**：`AdminSidebar`、`AdminBreadcrumbs`、`CommandPalette` 组件
- **新增 import**：`Sidebar`、`Breadcrumbs`、`CommandPalette`、`MenuBar`
- **键盘绑定**：全局 `⌘K` / `Ctrl+K` 监听
- **Breaking**：admin 视觉重构（用户重新学习）
- **测试**：Sidebar 折叠展开、CommandPalette 触发、Breadcrumbs 跟随路由
