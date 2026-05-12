## Why

Portal 当前是双轨制：`html.ts` 用字符串模板做 SSR HTML（含 100+ 行内联 JS bridge），`app.tsx` 通过 5 个独立 React island 在 9 个 mount 点上水合。数据流靠 `litellm-portal:keys/teams/stats/models/error/refresh` 等 6 个 CustomEvent 在内联 JS 与 React 组件之间分发。这套架构是过渡期妥协，长期问题：

- **职责耦合**：每加一个数据展示卡片，需要同时改 html.ts 占位、内联 JS dispatcher、React 组件三处。
- **类型断裂**：内联 JS 是无类型 JavaScript，`window.__litellmPortal*` globals 在两侧手工保持一致。
- **测试盲区**：内联 JS 和 React 之间的事件契约没有任何编译期或运行期校验。
- **kumo 组件无法跨边界**：任何"hero stats / theme toggle 想用 LayerCard / Switch"都被迫做成 island，引入第 N 个 mount 点。
- **FOUC 与 SEO**：当前 SSR 只渲染骨架，所有数据由客户端二次拉取，首屏空白时间长。

## What Changes

- **删除 `html.ts` 字符串模板**，改用 `react-dom/server` 的 `renderToString` 在 Worker 内渲染整页 HTML。
- **单一 React 根**：客户端只有一个 `hydrateRoot(document, <App />)`，不再有 9 个 island。
- **杀掉内联 JS bridge**：`byId / dispatch* / refresh / renderDashboard / list / api` 等 100+ 行内联脚本全部删除。
- **杀掉 6 个 CustomEvent**：`litellm-portal:keys/teams/stats/models/error/refresh` 全部移除，状态走 React context 或下一阶段的 query 客户端。
- **保留唯一内联 `<script>`**：FOUC-prevention（`data-mode` 早设置）改为最小内联脚本，nonce 注入。
- **SSR 数据预填**：在 Worker 内首次渲染时已经拥有 `/api/dashboard` 数据（同进程内调用），首屏直接是数据态而非骨架。
- **kumo 组件可自由使用**：所有 LayerCard / Switch / Button / Tooltip 等不再被 SSR 字符串边界限制。

## Capabilities

### New Capabilities
- **SSR-with-data**：Worker 端渲染时直接吐出含数据的 HTML，客户端 hydrate 即可，免一次 round-trip。

### Modified Capabilities
- **portal 渲染**：从"SSR 骨架 + 客户端拉数据 + 6 事件分发"改为"SSR 全量渲染 + hydrate"。

### Removed Capabilities
- 所有 `litellm-portal:*` CustomEvent 协议
- `window.__litellmPortal*` globals
- `html.ts` 文件本身

## Impact

- **删除**：`html.ts`（~200 行）、内联 JS bridge、6 个 CustomEvent 监听器
- **新增**：`server.tsx`（React SSR 入口）、`shell.tsx`（页面壳组件，含 `<head>` 和 hydrate marker）
- **改造**：`index.ts` 路由 `/` 改为调用 `renderToString(<App initialData={...} />)`
- **改造**：`app.tsx` 加 `<App>` 顶层组件，接受 SSR 注入的 `initialData`
- **依赖**：`react-dom/server`（已通过 React 19 自带）
- **Breaking**：无对外 API 变更；旧 CustomEvent 全删，任何外部脚本若监听需迁移
- **测试**：`index.test.ts` 中所有"HTML 含 X 字符串"断言需要重写；新增 SSR 输出快照
