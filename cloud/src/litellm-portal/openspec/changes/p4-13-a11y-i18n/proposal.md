## Why

A11y：kumo 组件本身可访问，但 portal 拼装层未审计 — 焦点管理、屏幕阅读器宣告、键盘流可能有断点。

I18n：~80+ 中文字符串散在组件里硬编码（`"用户面板"`、`"暂无 API Key"`、`"近 30 天"`…），未来要支持 EN 或其他语言需大改。

## What Changes

- **axe-core 集成进 vitest**：所有组件渲染后跑 axe，CI gate
- **焦点管理**：tab 切换后焦点落到 `<main>`，dialog 关闭后焦点回触发器
- **`aria-live` 区域**：loading 完成、错误出现、toast 出现宣告
- **i18n 库**：选 `formatjs` 或 `lingui`，抽出所有字符串到 `messages/zh-CN.ts`
- **Locale 检测**：根据 `Accept-Language` SSR 选择 locale
- **数字/日期/货币本地化**：`Intl.NumberFormat({ style: 'currency', currency: 'USD' })`、`Intl.DateTimeFormat({ timeZone: 'Asia/Shanghai' })`
- **EN 翻译占位**：建立 `messages/en.ts` 骨架（自动翻译 + 人工校对）

## Capabilities

### New Capabilities
- **a11y-ci-gate**：自动化无障碍回归
- **i18n-translation**：多语言支持基础设施
- **locale-detection**：根据请求头自动选语言

### Modified Capabilities
- **所有字符串渲染**：从字面值改为 `t('key')` 调用

## Impact

- **新增**：`messages/zh-CN.ts`、`messages/en.ts`、`hooks/use-i18n.ts`
- **改造**：所有 React 组件字符串替换为 `t()`
- **新增依赖**：`@formatjs/intl` 或 `@lingui/core` + `@lingui/react`
- **新增 CI gate**：vitest + axe runner
- **Breaking**：无对外（UI 文本不变），但内部 string 提取改动面广
