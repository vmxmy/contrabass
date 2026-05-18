# Litellm Portal 前端审计执行摘要

> 提交给 Onyx 深度调研 | 2026-05-18

---

## 1. 项目概况

- **技术栈**：React 19 + TypeScript + TanStack Router + TanStack Query + Cloudflare Kumo + Tailwind CSS + Lingui i18n
- **运行环境**：Cloudflare Worker（SSR），浏览器 hydration
- **用户类型**：租户成员/管理员（Tenant Portal）+ 平台 Owner（Ops Console）
- **关键特征**：SSR-first，#418 hydration mismatch 已有成熟防御体系

---

## 2. 评审核心问题（🔴 Blocker / 🟠 Critical）

### 🔴 B1 — God Component: app.tsx (1176 行)
- 单个文件混合 15+ 组件定义：HeaderActions、HeroStats、TeamsAccessCard、ModelAccessCard、ApiKeysCard、CreateKeyButton、DeleteKeyButton、PortalErrorBanner
- 同时包含工具函数、类型定义、状态逻辑、DOM 渲染
- **影响**：无法独立测试、改一处牵全身、协作冲突高、崩一处可能拖垮 dashboard 区域

### 🟠 C1 — admin-components 手写 fetch 代码重复
- AdminUsersTable、AdminTeamsTable、AdminAuditFeed 各自手写几乎相同的 useEffect + fetch + AbortController + requestIdRef
- 复制粘贴重复代码约 200+ 行
- **影响**：维护成本高、bug 修复需改三处、已有 TanStack Query hooks 未使用

### 🟠 C2 — AdminLoadingSkeleton 直接使用 SkeletonLine（非 SsrSafeSkeleton）
- Kumo SkeletonLine 依赖 Math.random() → SSR ≠ client first render → React #418
- **影响**：admin 页面存在 hydration mismatch 风险

### 🟠 C3 — /manage 页面与 Tenant Portal 导航 Chrome 不一致
- Tenant Portal：左侧 SideNav + BrandSummaryBar
- /manage：顶部 Tabs（underline variant）+ 平台名大标题
- **影响**：用户切换 surface 时整页 Chrome 突变，失去空间掌控感

### 🟠 C4 — DTO 镜像类型
- app.tsx 中 InitialDashboardData / PortalKey / PortalTeam 与后端 JSON 结构完全一致
- **影响**：前后端数据结构死锁，后端改字段前端类型即崩

---

## 3. 技术债清单（Top 10）

| # | 来源 | 内容 | 严重度 |
|---|---|---|---|
| 1 | 代码 TODO | AdminUsersTable 迁移到 useAdminUsers() RPC hook | 🟠 |
| 2 | 代码 TODO | AdminTeamsTable 迁移到 useAdminTeams() RPC hook | 🟠 |
| 3 | 代码 TODO | AdminAuditFeed 迁移到 useAdminAudit() RPC hook | 🟠 |
| 4 | OpenSpec p2-06 | Toasty 全局错误层未接入（query/mutation 失败未走 toast） | 🟠 |
| 5 | OpenSpec p2-07 | Text/Surface/Grid/Meter 未全面 Kumo 化 | 🟡 |
| 6 | OpenSpec p3-10 | CSP + 安全头 + RateLimitDO + 泄漏检测 全部未实现 | 🟠 |
| 7 | OpenSpec p3-11 | Analytics Engine + metrics + audit log + 客户端上报 全部未实现 | 🟠 |
| 8 | OpenSpec p4-12 | R2 接入 + 缓存头 + Source maps（deferred） | 🟡 |
| 9 | OpenSpec p4-13 | axe-core 集成 + 焦点管理未完成 | 🟡 |
| 10 | OpenSpec p5-15 | High 危险级操作（PendingApprovalDO + SSE）deferred | 🟡 |

---

## 4. 架构关键信息

### 状态分层
- L1: SSR 服务端预填（QueryClient seed + dehydrate）
- L2: 派生 Selector（normalizeModelAccess / statsFromDashboard / deriveHealthSummary）
- L3: 全局 TanStack Query（useMe / useDashboard / usePreferences 等）

### SSR #418 防御体系
1. renderToReadableStream（非 renderToString）
2. SsrSafeSkeleton + useHasHydrated gate
3. Shell 包含在 client tree（useId 深度一致）
4. suppressHydrationWarning 仅在 <html> 标签属性

### 路由结构
- TanStack Router code-based（无文件系统 codegen）
- /manage/*、/usage、/keys、/members、/alerts、/billing、/ops/*
- admin 路由全部 lazyRouteComponent（代码分割）

---

## 5. 组件规范关键约束

- Loading 态必须走 PanelSkeleton（内部使用 SsrSafeSkeleton）
- 禁止 SSR 路径直接使用 SkeletonLine
- 关键异步区块必须包 BlockErrorBoundary
- 密度由 Shell 通过 Context 推送，屏幕只读取不硬编码
- 全局状态不存 UI 排版字段（如 isLeftPanelOpen）

---

## 6. 请求 Onyx 输出的专业建议

请基于以上材料，从以下五个维度给出深度调研和专业建议：

A. 优先级重排 — 以「用户可感知风险」和「修复成本」两个维度，重新排列所有问题，给出 Top 5 必做项（附理由）
B. 架构改进方案 — 针对 God Component（app.tsx）和 admin-components 手写 fetch，给出具体拆分/重构方案（含文件结构建议）
C. SSR 安全加固 — 列出所有仍可能导致 React #418 的隐患点，给出检查和修复的自动化方案（如 ESLint 规则、代码审查清单）
D. 性能预算 — 基于当前代码结构，给出 INP / LCP / CLS 的具体优化建议和可量化的目标
E. 长期治理 — 建立技术债防止回退的机制（如 CI 检查、代码审查 gate、指标监控）
