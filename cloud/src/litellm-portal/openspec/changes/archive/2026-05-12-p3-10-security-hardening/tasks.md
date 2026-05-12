## 1. CSP

- [ ] 1.1 新建 `security/csp.ts`，导出 `buildCSP({ nonce, env })`
- [ ] 1.2 SSR 生成 nonce（`crypto.randomUUID()` 后 base64），渲染时挂在 `<script nonce={nonce}>`
- [ ] 1.3 响应头注入 CSP
- [ ] 1.4 dev/preview 环境放宽 `'unsafe-inline'`（条件分支）

## 2. 安全头补全

- [ ] 2.1 `withSecurityHeaders` middleware：注入 X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy
- [ ] 2.2 校验在 securityheaders.com 得分 A+

## 3. Secret Store 迁移

- [ ] 3.1 `wrangler secrets-store` 创建 store
- [ ] 3.2 把 LITELLM_MASTER_KEY / ROLE_INVALIDATION_WEBHOOK_TOKEN 写入
- [ ] 3.3 wrangler 配置改 `[[secrets_store_secrets]]`
- [ ] 3.4 文档化轮换流程

## 4. Rate Limit DO

- [ ] 4.1 新建 `RateLimitDO`（Durable Object），滑动窗口计数（60 req / 60s 每邮箱+IP）
- [ ] 4.2 `/api/admin/*` 所有路由前置 `rateLimit({ key: email + ip })`
- [ ] 4.3 超限 429 + `Retry-After` 头

## 5. 响应泄漏检测

- [ ] 5.1 `leakDetector` middleware：响应 JSON 字符串 `/\bsk-[A-Za-z0-9_-]{8,}/` 匹配则 500 + 触发告警
- [ ] 5.2 添加单元 fuzz：构造含 `sk-xxx` 响应，验证被拦
- [ ] 5.3 告警通道：写入 Analytics Engine + 触发 webhook（待 P3-11）

## 6. 输入校验

- [ ] 6.1 所有 query/path/body 经 Zod schema 校验
- [ ] 6.2 email schema：禁止 `&`、`?`、URL 解码后的注入字符
- [ ] 6.3 数字 schema：`int().min().max()` 严格

## 7. 测试

- [ ] 7.1 响应头矩阵测试（所有路由）
- [ ] 7.2 Rate limit：连续请求验证 429
- [ ] 7.3 Fuzz：故意构造泄漏响应验证拦截
- [ ] 7.4 CSP：渲染 HTML 含 nonce 且 nonce 唯一

## 8. 验证

- [ ] 8.1 securityheaders.com 扫描得分 A+
- [ ] 8.2 Mozilla Observatory 扫描通过
- [ ] 8.3 部署后 CSP report-uri 收集 24h 无误报
