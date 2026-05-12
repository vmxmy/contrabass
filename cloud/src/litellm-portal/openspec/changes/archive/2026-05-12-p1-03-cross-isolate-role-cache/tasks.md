## 1. KV 资源准备

- [ ] 1.1 `wrangler kv namespace create ROLE_CACHE_KV --config wrangler.litellm-portal.toml`
- [ ] 1.2 `wrangler kv namespace create ROLE_CACHE_KV --preview --config ...`
- [ ] 1.3 在 wrangler 配置加 `[[kv_namespaces]] binding = "ROLE_CACHE_KV"`
- [ ] 1.4 在 `LiteLLMPortalEnv` 类型加 `ROLE_CACHE_KV: KVNamespace`

## 2. 复合缓存层

- [ ] 2.1 新建 `role-cache.ts`，导出 `getRole(env, email) / setRole(env, email, role, userId) / invalidateRole(env, email)`
- [ ] 2.2 实现内存层（30s TTL）+ KV 层（5min TTL）+ LiteLLM fetch 三级
- [ ] 2.3 KV value 序列化为 `{ role, litellmUserId, savedAt }` JSON
- [ ] 2.4 KV 不可用时（绑定缺失或抛错）静默回退到纯内存

## 3. roles.ts 改造

- [ ] 3.1 `resolveIdentity` 把 LiteLLM `/user/list?user_email=` 调用包进 `getRole(env, email)`
- [ ] 3.2 删除 `roleCache: Map<...>` 与 `_clearRoleCacheForTests`（功能搬到 `role-cache.ts`）
- [ ] 3.3 测试导出 `_resetMemoryRoleCacheForTests`（KV 在 mock 环境用 `MemoryKV`）

## 4. 失效 API

- [ ] 4.1 新增 `POST /api/admin/roles/invalidate?email=xxx`，admin 鉴权后调 `invalidateRole`
- [ ] 4.2 新增 `POST /api/_internal/role-changed`，body `{ email, secret }`，校验 `ROLE_INVALIDATION_WEBHOOK_TOKEN` 后调 `invalidateRole`
- [ ] 4.3 `/api/_internal/*` 路由加 `x-real-ip` allowlist 与 token 双重防护

## 5. LiteLLM webhook 配置（运维步骤）

- [ ] 5.1 文档化：在 LiteLLM admin 配置 `POST https://zhiyun.ziikoo.com/api/_internal/role-changed` webhook
- [ ] 5.2 文档化：master key 与 webhook secret 在 Workers Secret Store 的轮换流程

## 6. 观测埋点

- [ ] 6.1 每次 `getRole` 调用记录 `cache_hit_layer` (mem/kv/origin) 与 latency
- [ ] 6.2 写入 Workers Analytics Engine（数据集 `role_cache_metrics`）

## 7. 测试

- [ ] 7.1 mock KVNamespace（in-memory Map 模拟）
- [ ] 7.2 覆盖：mem hit / kv hit / origin fetch / kv 写回 / invalidate / KV 不可用降级
- [ ] 7.3 webhook：合法 token 通过、非法 token 401、缺 token 401
- [ ] 7.4 并发：同一 email 100 次并发调用只触发 1 次 LiteLLM fetch（singleflight 模式）

## 8. 验证

- [ ] 8.1 `pnpm test src/litellm-portal` 全绿
- [ ] 8.2 部署后用两个 isolate（强制冷启动）验证：在 isolate A 解析后，isolate B 立即从 KV 命中
- [ ] 8.3 在 LiteLLM 改 user_role，5 分钟内不生效；调 invalidate API 后立即生效
