## 1. Text 全替换

- [ ] 1.1 sweep app.tsx 找所有 `<p className="text-..."`、`<span className="text-..."`
- [ ] 1.2 按映射表替换：
  - `text-2xl font-semibold text-kumo-strong` → `Text variant="heading2"`
  - `text-3xl font-semibold text-kumo-strong` → `Text variant="heading1"`
  - `text-lg font-semibold text-kumo-strong` → `Text variant="heading3"`
  - `text-sm text-kumo-subtle` → `Text variant="secondary"`
  - `font-mono ... text-kumo-default` → `Text variant="mono"`
  - `text-kumo-success` 数字 → `Text variant="success"`
- [ ] 1.3 验证字符级 diff：渲染输出与替换前像素级一致

## 2. Surface 替换

- [ ] 2.1 admin card 内的 audit 详情 `bg-kumo-recessed p-3` → `<Surface>`
- [ ] 2.2 ModelAccessCard 展开后的 `bg-kumo-recessed p-5` → `<Surface>`

## 3. Grid 评估

- [ ] 3.1 列出当前所有 `grid grid-cols-*`：
  - HeroStats 4 列 → 评估 kumo `<Grid columns={{base:1, md:2, xl:4}}>`
  - 用量 metric 3 列 → 评估
  - `md:grid-cols-[2fr_1fr]` 定制比例 → 保留 Tailwind
- [ ] 3.2 替换适合预设的；其余加注释说明为何不替换

## 4. Meter 替换

- [ ] 4.1 HeroStats 累计花费卡片下方加 `<Meter value={totalSpend} max={maxBudget ?? totalSpend} customValue="$X / $Y" />`
- [ ] 4.2 BudgetBadge 缩为状态徽章（"超预算"/"即将超支"），不再含数值
- [ ] 4.3 admin teams 表格的 budget 列同样加 mini Meter

## 5. 数字格式化统一

- [ ] 5.1 删除 `fmt / fmtInt / numberFormatter`，统一封装到 `lib/format.ts`
- [ ] 5.2 优先用 kumo 自带 number formatter（如有），否则用 `Intl` 包装

## 6. 测试

- [ ] 6.1 RTL 选择器迁移到 `getByRole('heading', { name: ... })`
- [ ] 6.2 visual regression（与 P3-09 协同）

## 7. 验证

- [ ] 7.1 测试全过
- [ ] 7.2 浏览器对比：截图替换前后视觉一致
