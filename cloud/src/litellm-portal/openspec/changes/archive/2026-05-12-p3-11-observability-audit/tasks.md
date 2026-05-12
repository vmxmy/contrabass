## 1. Analytics Engine 数据集

- [ ] 1.1 `wrangler analytics-engine create portal-metrics`
- [ ] 1.2 `wrangler analytics-engine create portal-audit`
- [ ] 1.3 wrangler 配置加 `[[analytics_engine_datasets]]`

## 2. 服务端 metrics

- [ ] 2.1 新建 `observability/metrics.ts`：导出 `recordMetric(env, { route, status, latencyMs, upstreamMs, role, cacheHit })`
- [ ] 2.2 Hono middleware 包所有路由：start time、end time 写入
- [ ] 2.3 `litellmFetch` 包装层记录上游延迟

## 3. Audit log

- [ ] 3.1 新建 `observability/audit.ts`：导出 `recordAudit(env, { actor, action, target, ipAddr, ts })`
- [ ] 3.2 所有 `/api/admin/*` 路由内调用
- [ ] 3.3 写操作（P5-15）扩展 `before / after` JSON diff

## 4. 客户端错误上报

- [ ] 4.1 顶层 `<ErrorBoundary>` 捕获渲染错误
- [ ] 4.2 `window.onerror` / `unhandledrejection` 全局监听
- [ ] 4.3 攒批（5 错误或 10s）后 POST 到 `/api/_internal/client-error`
- [ ] 4.4 rate-limit 防止刷接口

## 5. RUM

- [ ] 5.1 Cloudflare dashboard 启用 Web Analytics（自动注入 beacon）
- [ ] 5.2 验证 portal 数据出现在 dashboard

## 6. 仪表盘

- [ ] 6.1 文档化：常用 SQL 查询（p95 latency / 5xx 率 / 各 admin 操作频次）
- [ ] 6.2 评估是否导出到 Grafana（用 CF 的 GraphQL API）

## 7. 测试

- [ ] 7.1 metrics middleware 单元测试：每次请求都写一行
- [ ] 7.2 客户端 ErrorBoundary 渲染 fallback
- [ ] 7.3 client-error 端点 rate limit 验证

## 8. 验证

- [ ] 8.1 部署后 24h 查看 metrics 数据非空
- [ ] 8.2 故意触发客户端错误，验证 server 收到记录
- [ ] 8.3 admin 操作产生 audit 行
