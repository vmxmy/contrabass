## Why

portal 当前可观测性几乎为零：

- `wrangler.toml` 只开了 `[observability] enabled = true`（基础 logs）
- 无业务级 metrics（用户访问、admin 操作、LiteLLM 上游延迟）
- 无 audit log（admin 谁查询了什么、何时操作了哪个对象）
- 客户端 unhandled error 直接丢失
- 缓存命中率（P1-03 的 role cache）没暴露

## What Changes

- **Workers Analytics Engine** 写入业务 metrics：每次 `/api/*` 调用记录 `latency / upstream_latency / cache_hit_layer / role / status`
- **客户端错误上报**：unhandled exception / unhandled promise rejection → `POST /api/_internal/client-error`，含 session id、user agent、stack
- **Admin 行为审计**：所有 `/api/admin/*` 请求记录 `who / what / when / from-ip`，写入独立 Analytics Engine 数据集
- **业务级 dashboard**：在 Cloudflare dashboard 配 Workers Analytics 自定义查询，或导出到 Grafana
- **RUM**：接入 Cloudflare Web Analytics（轻量、零客户端 JS 配置）

## Capabilities

### New Capabilities
- **server-metrics**：业务级请求/缓存/上游指标
- **client-error-reporting**：客户端异常 → 服务端聚合
- **admin-audit-log**：所有 admin 访问可回溯
- **real-user-monitoring**：性能、Web Vitals

### Modified Capabilities
- **错误处理**：客户端 ErrorBoundary 不再静默吞错误

## Impact

- **新增**：`observability/metrics.ts`、`observability/audit.ts`、`observability/client-error.ts`
- **新增 binding**：`METRICS_AE`、`AUDIT_AE`（Analytics Engine 数据集）
- **新增**：客户端 `ErrorBoundary` 顶层 + `window.onerror` / `unhandledrejection` 监听
- **新增端点**：`POST /api/_internal/client-error`（rate-limited）
- **新增 CSP 报告 URI**：与 P3-10 协同
- **Breaking**：无；纯增量
