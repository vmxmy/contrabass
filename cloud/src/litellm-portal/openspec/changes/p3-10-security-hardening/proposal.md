## Why

当前安全姿态对一个 admin 门户偏弱：

- 无 `Content-Security-Policy`，内联脚本宽松
- `LITELLM_MASTER_KEY` 走 wrangler env var，没用 Workers Secret Store（不支持自动轮换、无访问审计）
- `/api/admin/*` 无速率限制（admin 凭证一旦泄露可大规模扫描）
- 现有 `index.test.ts` 验证过响应不含 master key 字符串，但没有 fuzz 层防护
- Cloudflare Access 已在前面，但 portal 自身没有第二层（IP allowlist、mTLS 之类）做纵深防御

## What Changes

- **CSP 头**：`script-src 'self' 'nonce-XXX'`、`style-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'self'`、`form-action 'self'`
- **内联脚本 nonce**：FOUC 脚本与 `__INITIAL_DATA__` 注入脚本都带 nonce
- **Workers Secret Store 迁移**：`LITELLM_MASTER_KEY`、`ROLE_INVALIDATION_WEBHOOK_TOKEN` 改用 Secret Store binding（自动轮换 + 访问审计）
- **`/api/admin/*` 速率限制**：基于 Durable Object 的滑动窗口计数器，admin 邮箱 + IP 维度
- **响应 sanitize 双保险**：响应在 Hono 中间件层用 `JSON.stringify` 后正则检测 `sk-` 前缀，匹配则 5xx + 告警
- **路径穿越/SSRF 防护**：`/v2/user/info?user_email=` 等查询参数 Zod 严格校验，禁止注入 `&` `?` 字符
- **安全头补齐**：`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy` 锁死
- **Audit 写入流量**：所有 admin 写操作（P5-15 上线后）写 audit DO

## Capabilities

### New Capabilities
- **csp-with-nonce**：内联脚本严格 CSP
- **secret-store-rotation**：Worker Secret Store 集成
- **admin-rate-limit**：DO-based 速率限制
- **response-leak-detection**：响应 sanitize 中间件

### Modified Capabilities
- **HTTP 响应头**：补全安全头矩阵

## Impact

- **新增**：`security/headers.ts`、`security/rate-limit-do.ts`、`security/leak-detector.ts`
- **新增 binding**：`RATE_LIMIT_DO`（Durable Object）
- **改造**：所有响应经过 `withSecurityHeaders` middleware
- **运维**：Workers Secret Store 迁移流程文档
- **Breaking**：CSP 严格化可能拦截开发期热重载脚本（dev/prod 分开配置）
- **测试**：响应头矩阵、rate limit 触发、sanitize fuzzer
