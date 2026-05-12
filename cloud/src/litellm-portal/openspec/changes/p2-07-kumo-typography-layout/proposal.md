## Why

排版与布局仍大量使用裸 Tailwind class（`text-3xl font-semibold text-kumo-strong`、`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4`）。kumo 提供了语义层组件：

- `Text`：`variant="heading1|heading2|heading3|body|secondary|success|error|mono|mono-secondary"`，token 级排版统一
- `Surface`：分层背景容器
- `Grid`：预设响应式列布局
- `Meter`：进度条（适合 budget 可视化）

长期：把字面 class 替换为语义组件，让 kumo 主题升级、暗黑模式、a11y 改进自动透传，不必逐处修补 Tailwind。

## What Changes

- **`Text` 替换**：所有 `<p className="text-... font-... text-kumo-...">` 替换为 `<Text variant="...">`
- **`Surface` 替换**：嵌套层背景（如 admin card 内子区块）用 `<Surface>` 而非手写 `bg-kumo-recessed`
- **`Grid` 评估**：能套预设的（4 列 stats、2 列 model+team）用 Grid；`md:grid-cols-[1fr_2fr]` 等定制保持 Tailwind
- **`Meter` 替换 BudgetBadge**：累计花费下方显示 `<Meter value={spend} max={maxBudget} customValue="$X / $Y" />`，Badge 仅作为 over-budget 状态标签
- **统一字体来源**：删除 `app.tsx` 内自写 `numberFormatter`、`fmt`、`fmtInt`，改用 kumo 提供的或 React `Intl` 包装

## Capabilities

### Modified Capabilities
- **portal 排版**：从 class-driven 升级为 token-driven 语义组件
- **预算可视化**：从单一 Badge 升级为 Meter + Badge 双层

## Impact

- **改造**：app.tsx 内 ~50+ 处 `<p className=...>` 替换
- **新增 import**：`Text`、`Surface`、`Grid`、`Meter`
- **Breaking**：无；视觉接近一致（kumo Text 与现有 Tailwind class 设计同源）
- **测试**：RTL 选择器若用 `getByText` 不受影响；用 `getByRole('heading')` 反而更稳
