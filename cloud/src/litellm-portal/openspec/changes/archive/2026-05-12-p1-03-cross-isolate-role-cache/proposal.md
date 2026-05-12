## Why

`roles.ts` 的角色缓存是 per-isolate `Map`，TTL 5 分钟。已知问题（注释里也写了）：

1. 多 Worker isolate 不共享 → 同一用户在不同 isolate 各被解析一次，浪费 LiteLLM 调用配额
2. 角色变更（admin → user 降级）最长滞后 5 分钟才生效
3. 紧急吊销只能旋转 master key 或重启 Worker

长期：角色缓存必须跨 isolate 一致 + 支持显式失效 + 可审计。

## What Changes

- **接入 Workers KV** 作为跨 isolate role cache 的二级缓存（一级仍是内存，避免每次都走 KV）
- **失效协议**：新增 `POST /api/admin/roles/invalidate?email=xxx` 端点，admin 可手动清缓存；同时在 LiteLLM 那侧配置 webhook 推到 `POST /api/_internal/role-changed`，自动失效
- **TTL 调整**：内存缓存 30s（极短，主要去抖），KV 缓存 5min（保持对 LiteLLM 的保护），webhook/手动失效立即清两层
- **缓存命中观测**：role 解析的 cache hit/miss/stale 计入 Workers Analytics Engine（依赖 P3-11）
- **降级保险**：KV 不可用时回退到当前的纯内存策略，不阻塞请求

## Capabilities

### New Capabilities
- **role-cache-cross-isolate**：跨 isolate 一致的角色判定
- **role-cache-invalidation-api**：admin 可手动失效；webhook 可自动失效
- **role-cache-observability**：缓存命中率可见

### Modified Capabilities
- **角色解析**：内存 → KV → LiteLLM 三级查找
- **`/api/admin/*` 鉴权时延**：稍降（KV ~10ms vs LiteLLM ~50ms）

## Impact

- **新增**：`role-cache.ts`（KV + 内存复合 cache）、`/api/admin/roles/invalidate`、`/api/_internal/role-changed`
- **新增 binding**：`ROLE_CACHE_KV`（Workers KV namespace）
- **改造**：`roles.ts` `resolveIdentity` 改为调 `roleCache.get / set / invalidate`
- **新增 secret**：`ROLE_INVALIDATION_WEBHOOK_TOKEN`（webhook 鉴权）
- **wrangler 配置**：`wrangler.litellm-portal.toml` 加 `[[kv_namespaces]]`
- **Breaking**：无；缓存升级对调用方透明
- **测试**：mock KV 环境，覆盖 hit/miss/stale/invalidate 路径
