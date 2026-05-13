## Why

用户偏好目前只有"深色/浅色"，存在 `localStorage`：

- 多设备不同步（手机切深色，桌面仍浅色）
- 清缓存即丢失
- 未来要扩展：默认 tab、默认时间窗口、通知偏好、语言偏好、密度（compact/comfortable）
- 通知（预算 80%、key 即将过期）也需要存储用户级开关

## What Changes

- **服务端存储**：`/api/me/preferences` GET/PATCH 端点，存到 Workers KV（key = email hash）
- **前端 store**：`usePreferences()` hook，读取 + 写入服务端，本地优先 localStorage 作为缓存层
- **可配项**：
  - `theme`: `auto | dark | light`
  - `defaultTab`: `user | admin`
  - `defaultUsageWindow`: `30d | 7d | 24h | ...`
  - `language`: `auto | zh-CN | en`
  - `density`: `comfortable | compact`
  - `notifications`: `{ budgetThreshold: 0.8, keyExpirySoon: true }`
- **通知投递**：邮件 / Slack 等渠道（先用邮件，sendgrid / mailchannels）
- **预算提醒后端**：定时任务（Cron Trigger）扫所有用户，触达阈值时发邮件
- **设置页**：`/preferences`（用户）+ `/admin/settings`（admin 全局默认）

## Capabilities

### New Capabilities
- **server-stored-preferences**：多设备同步偏好
- **budget-alert-emails**：超预算自动通知
- **language-switching**：用户级语言覆盖（与 P4-13 协同）

### Modified Capabilities
- **theme persistence**：从 localStorage → 服务端

## Impact

- **新增**：`/api/me/preferences` GET/PATCH 端点
- **新增 binding**：`USER_PREFS_KV`
- **新增**：`PreferencesPage` 组件 + `usePreferences` hook
- **新增 cron trigger**：每日扫预算阈值，触发邮件
- **新增依赖**：邮件投递服务（MailChannels / SendGrid 二选一）
- **Breaking**：localStorage 中的 `litellm-portal-mode` 迁移到服务端（一次性 migration）
- **测试**：preferences 读写 + cron 触发邮件 + 多设备同步
