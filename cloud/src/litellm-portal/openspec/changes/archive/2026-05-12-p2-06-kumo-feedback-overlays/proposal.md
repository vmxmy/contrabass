## Why

反馈与悬停层组件目前缺失：

- 错误只能通过顶部 `PortalErrorBanner` 一种渠道展示，没有 toast，无法表达"删 key 成功 / 创建 key 成功 / undo"等瞬态反馈
- 邮箱截断、key 截断仅靠 HTML `title=` 属性提示，UX 粗糙
- admin 表格的行操作（未来要有"删用户/删 key/查看详情"）没有原生 dropdown 容器
- 数据点 hover、help 图标 hover 没有 popover/tooltip

## What Changes

- **接入 `Toasty`**：在 `<App>` 根包 `<Toasty.Provider>`，新增全局 `useToast()` hook
- **替换错误层**：mutation onError、query onError 走 toast，保留 PortalErrorBanner 仅用于阻塞性错误
- **接入 `Tooltip`**：根包 `<TooltipProvider delay={300}>`，所有 `title=` 属性升级为 `<Tooltip>`
- **接入 `DropdownMenu`**：admin 表格行末新增 `⋯` 触发器，含查看/编辑/删除（写操作上线后）
- **接入 `Popover`**：用量图表数据点 hover 显示详细数字；help 图标点击显示长说明

## Capabilities

### New Capabilities
- **toast-notifications**：成功/失败/警告 toast，自动消失 + swipe 关闭
- **tooltip-on-hover**：可访问的悬停提示
- **dropdown-row-actions**：表格行操作菜单
- **popover-detail**：紧凑详情浮层

### Modified Capabilities
- **错误展示**：banner（持久阻塞）+ toast（瞬态）双轨

## Impact

- **新增 import**：`Toasty`、`Tooltip`、`TooltipProvider`、`DropdownMenu`、`Popover`
- **新增**：`hooks/use-toast.ts` 包装 `Toasty` API
- **改造**：`<App>` 根加 Provider；`HeroStats` 邮箱、`ApiKeysCard` 截断 key 改 Tooltip
- **改造**：admin 表格新增行操作列（与 P5-15 写操作协同）
- **测试**：RTL 中 toast 用 `screen.getByRole('status')` 验证
