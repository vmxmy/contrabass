## 1. Toasty 接入

- [ ] 1.1 在 `<App>` 根包 `<Toasty.Provider position="bottom-right">`
- [ ] 1.2 新建 `hooks/use-toast.ts`：导出 `useToast()` 含 `success/error/warning/info` 方法
- [ ] 1.3 整合到 P0-02 的 QueryClient `defaultOptions.queries.onError` 与 `mutations.onError`

## 2. 错误层迁移

- [ ] 2.1 query 失败 → toast.error（保留 retry button）
- [ ] 2.2 mutation 失败 → toast.error 含具体字段错误
- [ ] 2.3 PortalErrorBanner 改为只在"无法初始化（auth 失败、ssr 数据缺失）"等致命错误显示
- [ ] 2.4 mutation 成功 → toast.success（"Key 已创建" / "Key 已删除"）

## 3. Tooltip

- [ ] 3.1 根包 `<TooltipProvider delay={300}>`
- [ ] 3.2 `HeroStats` 邮箱截断 → Tooltip 显示完整邮箱
- [ ] 3.3 `ApiKeysCard` displayKey 截断 → Tooltip 显示 key 别名 + 创建时间
- [ ] 3.4 admin 表格中所有 truncate 字段加 Tooltip
- [ ] 3.5 字段说明 info 图标 → Tooltip（如"什么是 RPM/TPM"）

## 4. DropdownMenu

- [ ] 4.1 `AdminUsersTable` 行末加 `⋯` 列，含 `<DropdownMenu>` 触发器
- [ ] 4.2 P5-15 上线前菜单项只放"查看详情（跳转 `/admin/users/$userId`）"
- [ ] 4.3 同样改造 `AdminTeamsTable`、`AdminAuditFeed`

## 5. Popover

- [ ] 5.1 `UsagePanel` 图表数据点 hover → Popover 含日期、tokens、spend 详细数字
- [ ] 5.2 `BudgetBadge` 旁加 info 图标 → Popover 解释 "正常/即将超支/超预算" 阈值

## 6. 测试

- [ ] 6.1 mutation 成功后 toast 出现（`screen.getByRole('status')`）
- [ ] 6.2 Tooltip 在 focus / hover 时出现
- [ ] 6.3 DropdownMenu 键盘导航（Tab / Enter / Esc）

## 7. 验证

- [ ] 7.1 测试全过、typecheck 干净
- [ ] 7.2 浏览器：删 key 后 toast、邮箱 hover tooltip、点击 ⋯ 弹菜单、图表数据点 hover popover
