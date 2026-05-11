## 1. Schema 与存储

- [ ] 1.1 Zod `UserPreferencesSchema`：theme / defaultTab / defaultUsageWindow / language / density / notifications
- [ ] 1.2 KV namespace `USER_PREFS_KV`，key = `sha256(email)`，value = preferences JSON
- [ ] 1.3 端点 `GET /api/me/preferences` 返回 prefs（默认值兜底）、`PATCH` 部分更新

## 2. 客户端 hook

- [ ] 2.1 `usePreferences()`：`useQuery` 加 localStorage 作为本地缓存
- [ ] 2.2 `useUpdatePreferences()`：`useMutation`，乐观更新 + onError 回滚

## 3. 设置页 UI

- [ ] 3.1 路由 `/preferences`，组件 `PreferencesPage`
- [ ] 3.2 各字段用 kumo `Switch / Select / Radio / Field`
- [ ] 3.3 改动后立即生效（不需要"保存"按钮）

## 4. theme 迁移

- [ ] 4.1 客户端启动时检测 `localStorage['litellm-portal-mode']`
- [ ] 4.2 如有，上传到服务端 prefs，清掉本地
- [ ] 4.3 之后只读服务端

## 5. 通知系统

- [ ] 5.1 选邮件投递：MailChannels（Cloudflare 集成、免费）
- [ ] 5.2 `sendEmail(to, template, data)` 包装
- [ ] 5.3 邮件模板：预算 80% 警告、key 即将过期、key 创建确认
- [ ] 5.4 模板用 mjml 或 react-email 渲染

## 6. Cron 扫描

- [ ] 6.1 `wrangler.toml` 配 `[triggers] crons = ["0 9 * * *"]`（每天 9 点 UTC）
- [ ] 6.2 scheduled handler：`scanBudgetThresholds(env)`，遍历用户调 LiteLLM 拿当前 spend
- [ ] 6.3 命中阈值 + 用户 notifications 开启 → `sendEmail`

## 7. admin 全局默认

- [ ] 7.1 `/admin/settings` 设全局默认（新用户继承）
- [ ] 7.2 KV key `__global_defaults__`

## 8. 测试

- [ ] 8.1 prefs 读写 + 默认值兜底
- [ ] 8.2 theme localStorage → server migration 一次性
- [ ] 8.3 mock MailChannels 调用，验证模板渲染正确
- [ ] 8.4 cron handler：mock 时间触发，验证阈值用户被邮件投递

## 9. 验证

- [ ] 9.1 两个浏览器登同一邮箱：A 切深色，B 刷新后变深色
- [ ] 9.2 手动触发 cron 测试：超阈值用户收到测试邮件
- [ ] 9.3 设置页所有字段持久化
