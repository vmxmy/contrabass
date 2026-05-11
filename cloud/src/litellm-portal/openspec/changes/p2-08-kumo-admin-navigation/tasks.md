## 1. Sidebar 接入

- [ ] 1.1 `routes/admin/route.tsx` 改为 `<Sidebar.Provider><Sidebar>...</Sidebar><Sidebar.Inset><Outlet /></Sidebar.Inset></Sidebar.Provider>`
- [ ] 1.2 菜单项：用户、团队、审计、用量、设置（5 项），每项含 phosphor icon
- [ ] 1.3 当前路由高亮（`useMatchRoute`）
- [ ] 1.4 折叠/展开按钮 `Sidebar.Trigger`，localStorage 持久化状态

## 2. Breadcrumbs

- [ ] 2.1 子页面顶部加 `<Breadcrumbs>` 含 admin / [类别] / [资源名]
- [ ] 2.2 资源名从 query 数据派生（user.email、team.alias、event 摘要）

## 3. CommandPalette

- [ ] 3.1 新建 `CommandPalette` 组件，挂在 `__root.tsx` 顶层
- [ ] 3.2 `⌘K` / `Ctrl+K` 监听切换 open
- [ ] 3.3 项分组：
  - **跳转**：所有用户、团队、最近 50 条 audit
  - **操作**：新建 Key、切换深色、退出登录
- [ ] 3.4 输入实时过滤（HighlightedText 高亮匹配）

## 4. MenuBar（可选，admin tables）

- [ ] 4.1 AdminUsersTable 顶部加 MenuBar：列表（默认）/ 卡片 / 表
- [ ] 4.2 评估是否真正需要，若仅 1 个视图则不上

## 5. Sidebar Menu Badge

- [ ] 5.1 审计菜单项右侧显示"今日新增条数"badge
- [ ] 5.2 用 `useAdminAudit({ window: '24h' })` 派生

## 6. 测试

- [ ] 6.1 Sidebar 折叠状态持久化
- [ ] 6.2 CommandPalette 键盘触发与搜索过滤
- [ ] 6.3 Breadcrumbs 跟随路由变化

## 7. 验证

- [ ] 7.1 浏览器：admin 视图 sidebar + breadcrumbs + ⌘K 全流程
- [ ] 7.2 视觉对比：所有 admin 子页面紧凑度合理，无信息过载
