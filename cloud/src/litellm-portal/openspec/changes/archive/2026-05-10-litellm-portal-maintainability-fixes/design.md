## Context

`litellm-portal` 是一个部署在 Cloudflare Workers 上的 LiteLLM 只读管理门户。当前 `index.ts` 已膨胀至 1807 行，同时承载了：
- Worker fetch 路由与入口
- Cloudflare Access JWT 验证（含 JWKS 缓存）
- LiteLLM API 客户端（用户、Key、团队、用量查询）
- 多粒度用量统计与 Bucket 聚合
- 服务端 HTML 模板渲染（含 350+ 行内联 JS 与内联 HTML）

这种大单体文件导致：定位代码困难、多人协作冲突率高、代码 review 成本高。此外，review 还发现 XSS 注入风险、前后端常量重复维护、API 请求竞态等可修复的安全和体验问题。

## Goals / Non-Goals

**Goals:**
- 将 `index.ts` 按职责拆分为 5 个模块文件，使单文件行数控制在 300 行以内。
- 修复 `renderPortalHtml` 中的 XSS 漏洞（环境变量直插 HTML）。
- 消除前后端 `USAGE_WINDOWS` 等常量的重复定义。
- 前端用量切换增加 `AbortController` 去重保护。
- `readUserTeams` 由串行改为并行请求。
- Dev Auth 开启时输出安全警告日志。
- 为 `app.tsx` 补充单元测试。

**Non-Goals:**
- 不新增任何用户可见功能或 API 端点。
- 不改变现有 API 响应结构或行为。
- 不修改 UI 视觉设计或交互流程。
- 不升级 React、Kumo 或其他依赖版本。

## Decisions

### 1. 按职责拆分 `index.ts`
- **方案 A**：保持单文件，用 region comment 分隔（改动最小，治标不治本）
- **方案 B**：按职责拆分为多个模块文件（推荐）
- **选择 B**：Cloudflare Workers 打包支持多文件 import，拆分后每个模块职责单一，便于测试和 review。
- **拆分计划**：
  - `types.ts`：所有共享类型定义（`LiteLLMPortalEnv`、`AuthResult`、`LiteLLMKey` 等）
  - `auth.ts`：`authenticateRequest`、`validateAccessJwt`、`getAccessJwks`、`principalFromEmail` 等
  - `litellm.ts`：`litellmFetch`、`resolveLiteLLMUser`、`listUserKeys`、`readUserTeams`、`readAvailableModels`、`normalizeKey`、`normalizeTeam` 等
  - `usage.ts`：`readUserDailyActivity`、`readUsageTimeseries`、`createBucketMap`、`alignBucketStart` 等所有用量聚合逻辑
  - `html.ts`：`renderPortalHtml`、响应构造辅助函数（`htmlResponse`、`cssResponse`、`javascriptResponse`）、`securityHeaders`、HTML escape 工具
  - `index.ts`：仅保留 Worker `fetch` 入口、`handleLiteLLMPortalRequest`、路由分发 `routeApiRequest`

### 2. HTML Escape 实现
- **方案 A**：引入外部依赖（如 `html-escaper`）
- **方案 B**：内联轻量 `escapeHtml` 函数（约 6 行）
- **选择 B**：门户追求零运行时依赖（Worker bundle 体积敏感），且转义需求简单，内联即可。

### 3. 常量统一策略
- **现状**：`index.ts` 中有 `USAGE_WINDOWS`（TS 常量），`renderPortalHtml` 内联 JS 中又有一份同构常量。
- **方案 A**：通过构建脚本将 JSON 注入 HTML（需要改构建流程）
- **方案 B**：`html.ts` 从 `usage.ts` 导入常量，在渲染时以内联 JSON 形式写入 `<script>` 标签供前端读取
- **选择 B**：最小侵入，无需改构建脚本。`renderPortalHtml` 输出 `<script>window.__PORTAL_CONFIG = ...</script>`，前端内联 JS 读取该全局变量，不再硬编码常量。

### 4. 请求竞态保护
- **方案 A**：防抖（debounce）
- **方案 B**：AbortController 取消旧请求
- **选择 B**：debounce 会延迟响应，AbortController 能立即取消旧请求，用户体验更即时。实现简单，无需引入 lodash 等库。

### 5. 并行化团队请求
- `readUserTeams` 当前是 `for...of` 串行 `await litellmFetch`。LiteLLM 团队数量通常 <=5，但改为 `Promise.all(ids.map(...))` 无额外复杂度，收益明确。

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| 拆分文件时遗漏导出或破坏 import 路径 | 拆分后完整运行现有测试 `index.test.ts`，确保全部通过后再提交 |
| 常量统一后前端内联 JS 依赖运行时注入的全局变量，若注入失败则 JS 报错 | 在前端增加兜底：如果 `window.__PORTAL_CONFIG` 不存在，回退到旧硬编码常量（渐进迁移） |
| `AbortController` 在部分旧版浏览器不支持 | 门户受众是企业内部用户，浏览器版本较新；且 `AbortController` 已是现代浏览器标准 API |
| 文件拆分引入大量 import/export 可能略微增加打包体积 | 拆分为 6 个模块后，打包器（esbuild/rollup）tree-shaking 效果反而可能更好，体积影响可忽略 |
