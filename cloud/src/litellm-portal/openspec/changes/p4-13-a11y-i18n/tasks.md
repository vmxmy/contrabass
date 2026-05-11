## 1. axe-core 集成

- [ ] 1.1 `pnpm add -D vitest-axe @axe-core/react`
- [ ] 1.2 在 `app.test.tsx` 中每个 render 后 `expect(await axe(container)).toHaveNoViolations()`
- [ ] 1.3 Storybook 集成 `@storybook/addon-a11y`
- [ ] 1.4 修复 axe 报出的所有问题（label、role、color contrast）

## 2. 焦点管理

- [ ] 2.1 tab 切换后 `<main>` 加 `tabIndex={-1}` 并 `focus()`
- [ ] 2.2 Dialog 关闭后焦点回到 trigger（kumo Dialog 已内置）
- [ ] 2.3 Pagination 翻页后焦点保持在按钮

## 3. aria-live

- [ ] 3.1 Toast viewport `role="status" aria-live="polite"`（kumo Toasty 已内置）
- [ ] 3.2 加载完成宣告：`useEffect` 配 visually hidden `<span aria-live="polite">数据已加载</span>`
- [ ] 3.3 错误宣告：`aria-live="assertive"`

## 4. i18n 接入

- [ ] 4.1 选定 `@lingui` 或 `formatjs`（建议 lingui，bundle size 小）
- [ ] 4.2 `<I18nProvider locale={locale}>` 包根
- [ ] 4.3 `lingui extract` 扫描所有 `t\`...\`` 标签，输出 `messages/zh-CN.po`
- [ ] 4.4 `lingui compile` 生成运行期 messages

## 5. 字符串抽取

- [ ] 5.1 sweep 所有组件，把字面中文换成 `t\`用户面板\`` 等模板字符串
- [ ] 5.2 admin / user / hero 各部分独立 catalog
- [ ] 5.3 `messages/en.ts` 自动翻译占位（机翻 + TODO 标记）

## 6. Locale 检测

- [ ] 6.1 SSR 端：解析 `Accept-Language`，选 `zh-CN`（默认）或 `en`
- [ ] 6.2 注入 `<html lang={locale}>`
- [ ] 6.3 用户偏好（P5-16）覆盖自动检测

## 7. 本地化格式

- [ ] 7.1 数字 / 货币 / 日期统一走 `lib/format.ts` 的 locale-aware 函数
- [ ] 7.2 EN 货币用 `$X.XX`，ZH 同
- [ ] 7.3 日期 EN 用 `M/d/yyyy`，ZH 用 `yyyy-MM-dd`

## 8. 验证

- [ ] 8.1 axe CI gate 全绿
- [ ] 8.2 手动用 VoiceOver / NVDA 走一遍关键流程
- [ ] 8.3 切到 EN locale，所有可见文本翻译完整
- [ ] 8.4 键盘 only 走完所有交互
