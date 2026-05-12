## Why

数据流当前是裸 `fetch('/api/...')` + 客户端 jQuery 风格手动 `useState` + `useEffect`，缺失：

- **类型双声明**：`PortalKey/PortalTeam/PortalStats` 在 `app.tsx` 写一遍，`LiteLLMKey/LiteLLMTeam` 在 `litellm.ts` 写一遍，`/api/me` 等响应字段拼写靠注释维护。
- **缓存与失效**：每个组件自己 `useEffect` 拉数据，无 dedupe、无 stale-while-revalidate、无 background refetch。
- **乐观更新与回滚**：CreateKey / DeleteKey 后只能强刷整页，没有乐观 UI。
- **错误处理散落**：每个组件自己 try/catch，错误 toast 体验不统一。
- **运行期校验缺失**：LiteLLM 返回的 JSON 字段变形时没有任何防线，直接让 UI 崩。

## What Changes

- **接入 Hono RPC**：Worker 路由用 Hono `app.get('/api/dashboard', ...).get('/api/me', ...)`，导出 `AppType`，客户端 `hc<AppType>()` 拿到全 typed client。
- **接入 TanStack Query**：所有数据读取走 `useDashboard()`、`useMe()`、`useAdminUsers()`、`useAdminAudit()` 等 hook；写操作走 `useMutation`。
- **Zod schema 单源**：`schemas.ts` 定义 `DashboardSchema / KeySchema / TeamSchema / StatsSchema / MeSchema`，从 schema 推导 TS 类型。Worker 在响应前 `schema.parse(data)`，客户端在反序列化时再 `schema.parse(json)`。
- **统一错误层**：`onError` 全局 toast（依赖 `kumo Toasty`，见 P2-06）。
- **删除手写 Window globals**：`__litellmPortalKeys/Teams/Stats/Models/Error` 全部退役（P0-01 已开头）。
- **删除每组件的 fetch + useState/useEffect 模板**：替换为 `const { data, isLoading, error } = useXxx()`。

## Capabilities

### New Capabilities
- **typed-rpc-client**：客户端到服务端端到端类型安全
- **runtime-schema-validation**：所有 API 边界 Zod 校验
- **query-cache-layer**：自动 dedupe / refetch / stale-while-revalidate

### Modified Capabilities
- **API 响应**：从 plain JSON 变为 schema-validated JSON（运行期不变，类型与契约更强）
- **客户端数据获取**：从 `fetch + useState` 变为 `useQuery / useMutation`

## Impact

- **新增**：`schemas.ts`（Zod schema 集中地）、`hooks/use-dashboard.ts` 等 query hooks、`rpc.ts`（hc client + AppType 导出）
- **改造**：`index.ts` 改用 Hono；`litellm.ts` 内部不变但导出类型与 schema 对齐
- **改造**：所有 React 组件 `useEffect(...)` 改为 `useXxx()` hook
- **新增依赖**：`hono`、`@tanstack/react-query`、`zod`
- **Breaking**：`/api/*` 响应 schema 严格化（多余字段被剥离）；外部消费者若依赖未文档化字段需对齐
- **测试**：mock layer 改为 Hono test client；React 组件测试包 QueryClientProvider
