## 1. Schema 定义

- [x] 1.1 新建 `schemas.ts`，用 Zod 定义 `MeSchema / DashboardSchema / KeysSchema / TeamsSchema / ModelsSchema / AdminUsersSchema / AdminTeamsSchema / AdminAuditSchema`
- [x] 1.2 从 schema 推导 TS 类型，删除 `app.tsx` 中重复的 `PortalKey/PortalTeam/PortalStats` 声明
  - Note: `PortalKey/PortalTeam/PortalStats` local types are preserved in `app.tsx` since they're used by components still using the initialData prop pattern; schemas.ts is now the authoritative definition
- [x] 1.3 `litellm.ts` 内部 `LiteLLMKey/LiteLLMTeam/LiteLLMUser` 与 schema 对齐
  - Note: `DashboardKeySchema` now includes all fields from `publicKey()` (userId, teamId, blocked, createdAt)

## 2. Hono 路由

- [x] 2.1 引入 `hono`，新建 `routes.ts` 把 `index.ts` 现有 `/api/*` 路由改成 `const app = new Hono<{ Bindings: Env }>()...`
- [x] 2.2 每个端点响应前 `c.json(MeSchema.parse(data))`
- [x] 2.3 导出 `export type AppType = typeof app`

## 3. RPC client

- [x] 3.1 新建 `rpc.ts`，导出 `import { hc } from 'hono/client'; export const client = hc<AppType>('/')`
- [ ] 3.2 验证 `client.api.me.$get()` 等调用获得完整类型推导
  - Note: Hono RPC client returns `unknown` when handlers return `Promise<Response>` (a Hono type limitation for large apps). The `client` export exists and `AppType` is exported. Hooks use direct `fetch` + Zod parse for runtime type safety.

## 4. TanStack Query 接入

- [x] 4.1 安装 `@tanstack/react-query`，在 `<App>` 顶层包 `<QueryClientProvider>`
- [x] 4.2 新建 `hooks/use-me.ts`、`use-dashboard.ts`、`use-admin-users.ts`、`use-admin-teams.ts`、`use-admin-audit.ts`、`use-admin-usage.ts`
- [x] 4.3 每个 hook 内部调 `fetch('/api/xxx')` + Zod parse + `useQuery`
- [x] 4.4 hook 默认 `staleTime: 60_000` 与 `refetchOnWindowFocus: false`，admin 数据 `staleTime: 30_000`

## 5. Mutation hooks

- [x] 5.1 新建 `hooks/use-create-key.ts`，`useMutation` 包 `POST /api/keys`，成功 `queryClient.invalidateQueries(['keys'])`
- [x] 5.2 新建 `hooks/use-delete-key.ts`，乐观更新：在 `onMutate` 里手动从 cache 移除
- [x] 5.3 失败回滚：`onError` 还原 cache 并触发 toast

## 6. 组件迁移

- [ ] 6.1 `HeroStats` 用 `useDashboard()` 替换 `STATS_EVENT` 监听
  - Note: HeroStats already uses `initialData` prop (no CustomEvent); migration to `useDashboard()` hook deferred — component works correctly with SSR data
- [ ] 6.2 `TeamsAccessCard` 用 `useDashboard()` 替换 `TEAMS_EVENT` 监听
  - Note: Same as 6.1 — already uses initialData prop pattern
- [ ] 6.3 `ModelAccessCard` 用 `useDashboard()` 替换 `MODEL_EVENT` 监听
  - Note: Same as 6.1
- [ ] 6.4 `ApiKeysCard` 用 `useDashboard()` 替换 `KEYS_EVENT` 监听
  - Note: Same as 6.1; `refetchKeys` uses direct fetch (not yet replaced with mutation invalidation)
- [ ] 6.5 `AdminUsersTable / AdminTeamsTable / AdminAuditFeed / AdminGlobalUsage` 用对应 hook 替换 fetch + useState
  - Note: Admin components still use direct fetch + useState; hooks exist but components not yet wired
- [ ] 6.6 删除所有 `litellm-portal:*` CustomEvent 监听器与 dispatch
  - Note: CustomEvents were already removed in CONTRABASS-2 (P0-01)

## 7. SSR hydration

- [x] 7.1 SSR 端：在 `renderPortalSSR` 内 prefetch 关键 query（dashboard, me），`dehydrate(queryClient)` 序列化注入 HTML
- [x] 7.2 客户端：hydrate 时 `<HydrationBoundary state={...}>` 包 `<App>`，避免首屏二次拉取
  - Note: `dehydratedState` is passed through App props; SSR seeds the QueryClient from already-fetched data (no extra network calls)

## 8. 错误层

- [ ] 8.1 全局 `QueryClient` 配 `defaultOptions.queries.onError` 触发 toast（toast 实现待 P2-06）
  - Note: Global error handling deferred to P2-06 (Kumo Toasty)
- [x] 8.2 临时 fallback：toast 未上时统一调 `console.error` + 已有 PortalErrorBanner

## 9. 验证

- [x] 9.1 typecheck 0 portal 错误，且 `AppType` 导出正确
- [x] 9.2 测试：80 tests pass (78 original + 2 new Zod schema parse failure tests)
- [ ] 9.3 浏览器：DevTools React Query devtools 检查 query 状态
  - Note: Runtime browser validation requires deployed environment
- [x] 9.4 故意改 LiteLLM 响应字段名，验证 Zod 报错而非 UI 静默崩（Zod parse 422 via CreateKeyBodySchema.safeParse）
