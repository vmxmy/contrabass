# Litellm Portal 前端审计 — 深度调研与专业建议

> 基于审计执行摘要，以「用户可感知风险 × 修复成本」为框架，输出五个维度的可执行方案

---

## A. 优先级重排 — Top 5 必做项

以 **用户可感知风险（右 → 高）** 和 **修复成本（下 → 低）** 为双轴排列：

```
高风险 / 低成本 ← 立即做          高风险 / 高成本 ← 分阶段做
─────────────────────────────────────────────────────
  ① C2 SsrSafeSkeleton              ③ B1 app.tsx 拆分
  ② C1 admin fetch → TQ hooks       ④ C3 导航 Chrome 统一
                                    ⑤ C4 DTO 类型解耦
低风险 / 低成本 ← 排期做          低风险 / 高成本 ← 待定
```

### ① C2 — AdminLoadingSkeleton 消除 hydration 隐患
| 项目 | 说明 |
|---|---|
| **感知风险** | 🔴 **最高** — 页面白屏 / React 控制台报错 / 降级到 client-only 渲染 |
| **修复成本** | 🟢 **极低** — 改 1 个 import，约 5 分钟 |
| **具体动作** | 将 `AdminLoadingSkeleton` 中 `SkeletonLine` → `SsrSafeSkeleton`，并在 CI 添加 ESLint 规则（见 C 节） |
| **理由** | `Math.random()` 在 Worker 线程和浏览器产生不同值，是 #418 hydration mismatch 的**确定触发器**。admin 页面每次加载都会命中，这不是概率问题而是必然问题 |

### ② C1 — Admin Components 手写 fetch → TanStack Query hooks
| 项目 | 说明 |
|---|---|
| **感知风险** | 🟠 **高** — 3 个 admin 表格共享同一段有 bug 的代码，一处不修则三处泄漏 |
| **修复成本** | 🟢 **低** — 已有 hooks，纯迁移工作，约 0.5 天 |
| **具体动作** | `AdminUsersTable` → `useAdminUsers()`，`AdminTeamsTable` → `useAdminTeams()`，`AdminAuditFeed` → `useAdminAudit()`，删除 200+ 行重复代码 |
| **理由** | 这不是优化，是**还债**。TanStack Query 已在项目中成熟使用（L1/L3 状态层），admin 组件绕过它直接 fetch 等于绕过了缓存、重试、stale-while-revalidate 等全部基础设施 |

### ③ B1 — app.tsx God Component 拆分
| 项目 | 说明 |
|---|---|
| **感知风险** | 🟠 **高** — 1176 行混合体，任何改动都可能产生回归 bug，协作冲突几乎必然 |
| **修复成本** | 🟡 **中** — 约 1–2 天纯拆分，需验证所有交互无回归 |
| **具体动作** | 见 B 节完整拆分方案 |
| **理由** | 这是**协作瓶颈**。在 B 端 SaaS 中，dashboard 是最频繁变更的页面，God Component 会让团队并行开发变得不可能 |

### ④ C3 — /manage 与 Tenant Portal 导航 Chrome 统一
| 项目 | 说明 |
|---|---|
| **感知风险** | 🟡 **中** — 用户心智模型断裂，"我是不是换了产品？" |
| **修复成本** | 🟡 **中** — 需设计确认 + 布局重构，约 2–3 天 |
| **具体动作** | 将 /manage 纳入统一 Shell 布局系统，通过 Context 控制 SideNav 折叠态和 Tab 类型 |
| **理由** | B 端用户的操作频率高但耐心低，导航一致性直接影响**任务完成率**和**误操作率** |

### ⑤ C4 — DTO 镜像类型解耦
| 项目 | 说明 |
|---|---|
| **感知风险** | 🟡 **中** — 不立即影响用户，但一旦后端改字段，前端直接 runtime crash |
| **修复成本** | 🟡 **中** — 引入 adapter 层 + branded type，约 1 天 |
| **具体动作** | 见 B 节 DTO 解耦方案 |
| **理由** | 这是**隐性炸弹**。前后端类型强耦合意味着后端做任何 breaking change 都无法做 graceful degradation |

---

## B. 架构改进方案

### B1. app.tsx 拆分方案

**原则：按「关注点分离」+「单一职责」拆到 8–12 个文件，每个文件 ≤ 200 行**

```
src/
├── pages/
│   └── dashboard/
│       ├── index.tsx                    # 页面入口，仅组合布局 (<100 行)
│       ├── hero-stats.tsx               # HeroStats 组件
│       ├── teams-access-card.tsx        # TeamsAccessCard
│       ├── model-access-card.tsx        # ModelAccessCard
│       ├── api-keys-card.tsx            # ApiKeysCard（含 Create/Delete）
│       └── error-banner.tsx             # PortalErrorBanner
├── features/
│   ├── dashboard/
│   │   ├── types.ts                     # 所有 dashboard 相关类型定义
│   │   ├── selectors.ts                 # normalizeModelAccess / statsFromDashboard
│   │   ├── derive-health.ts             # deriveHealthSummary 等派生逻辑
│   │   └── adapters.ts                  # DTO → 领域模型适配器（见 C4 解耦）
│   └── header/
│       └── header-actions.tsx           # HeaderActions 组件
└── hooks/
    └── use-dashboard-data.ts            # 聚合 useDashboard + selectors 的自定义 hook
```

**拆分步骤（可逐步执行，不要求一次性完成）：**

**Step 1 — 类型与工具函数外提（非破坏性）**

```typescript
// src/features/dashboard/types.ts
export interface PortalKey {
  id: string;
  name: string;
  createdAt: string;
  // ...
}

export interface PortalTeam {
  id: string;
  name: string;
  memberCount: number;
  // ...
}

export interface DashboardViewModel {
  heroStats: HeroStats;
  teams: PortalTeam[];
  models: ModelAccess[];
  keys: PortalKey[];
}
```

**Step 2 — Selector 纯函数外提（非破坏性，100% 可测试）**

```typescript
// src/features/dashboard/selectors.ts
import type { InitialDashboardData } from './types';

export function selectHeroStats(data: InitialDashboardData): HeroStats {
  // 纯函数，输入原始 DTO，输出视图模型
}

export function selectModelAccess(data: InitialDashboardData): ModelAccess[] {
  return normalizeModelAccess(data.models);
}
```

**Step 3 — 组件逐步切出（逐个验证）**

```typescript
// src/pages/dashboard/hero-stats.tsx
import { useHasHydrated } from '@cloudflare/kumo';
import { SsrSafeSkeleton } from '@/components/ssr-safe-skeleton';
import { selectHeroStats } from '@/features/dashboard/selectors';

export function HeroStats({ data }: { data: InitialDashboardData }) {
  const hydrated = useHasHydrated();
  if (!hydrated) return <SsrSafeSkeleton lines={3} />;

  const stats = selectHeroStats(data);
  return (
    <div className="grid grid-cols-3 gap-4">
      {stats.map(s => <StatCard key={s.label} {...s} />)}
    </div>
  );
}
```

**Step 4 — 页面入口瘦身**

```typescript
// src/pages/dashboard/index.tsx — 拆分后目标
import { HeroStats } from './hero-stats';
import { TeamsAccessCard } from './teams-access-card';
import { ModelAccessCard } from './model-access-card';
import { ApiKeysCard } from './api-keys-card';
import { PortalErrorBanner } from './error-banner';
import { useDashboardData } from '@/hooks/use-dashboard-data';

export function DashboardPage() {
  const { data, error, isLoading } = useDashboardData();

  if (error) return <PortalErrorBanner error={error} />;
  if (isLoading) return <DashboardSkeleton />;

  return (
    <div className="dashboard-layout">
      <HeroStats data={data} />
      <div className="grid grid-cols-2 gap-6 mt-6">
        <TeamsAccessCard teams={data.teams} />
        <ModelAccessCard models={data.models} />
      </div>
      <ApiKeysCard keys={data.keys} />
    </div>
  );
}
```

### B2. Admin Components 手写 fetch → TanStack Query 迁移

**现状问题示意：**

```typescript
// ❌ 当前 — 每个组件重复此模式
function AdminUsersTable() {
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const id = ++requestIdRef.current;
    const controller = new AbortController();
    fetch('/api/admin/users', { signal: controller.signal })
      .then(r => r.json())
      .then(json => { if (id === requestIdRef.current) setData(json); })
      .catch(e => { if (id === requestIdRef.current) setError(e); });
    return () => controller.abort();
  }, []);
  // ...render
}
```

**目标方案 — 统一 RPC Hook 层：**

```typescript
// src/hooks/rpc/use-admin-users.ts
import { useQuery } from '@tanstack/react-query';
import { adminRpcClient } from '@/lib/rpc-client';

export function useAdminUsers(params?: { page?: number; search?: string }) {
  return useQuery({
    queryKey: ['admin', 'users', params],
    queryFn: () => adminRpcClient.getUsers(params),
    staleTime: 30_000,       // admin 数据 30s 缓存足够
    placeholderData: (prev) => prev, // keepPreviousData
  });
}

// src/hooks/rpc/use-admin-teams.ts
export function useAdminTeams(params?: { page?: number }) {
  return useQuery({
    queryKey: ['admin', 'teams', params],
    queryFn: () => adminRpcClient.getTeams(params),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// src/hooks/rpc/use-admin-audit.ts
export function useAdminAudit(params?: { cursor?: string }) {
  return useQuery({
    queryKey: ['admin', 'audit', params],
    queryFn: () => adminRpcClient.getAuditLog(params),
    staleTime: 10_000,
  });
}
```

**统一 RPC Client（消除 fetch 重复）：**

```typescript
// src/lib/rpc-client.ts
import type { ApiResponse } from '@/types/api';

class AdminRpcClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new RpcError(res.status, await res.text());
    }
    return res.json() as Promise<ApiResponse<T>>;
  }

  getUsers = (params?: Record<string, unknown>) =>
    this.request('/api/admin/users', { /* ... */ });

  getTeams = (params?: Record<string, unknown>) =>
    this.request('/api/admin/teams', { /* ... */ });

  getAuditLog = (params?: Record<string, unknown>) =>
    this.request('/api/admin/audit', { /* ... */ });
}

export const adminRpcClient = new AdminRpcClient('');
```

**组件迁移后：**

```typescript
// ✅ 迁移后 — AdminUsersTable
function AdminUsersTable() {
  const { data, error, isLoading } = useAdminUsers({ page: 1 });

  if (isLoading) return <AdminLoadingSkeleton />;
  if (error) return <BlockErrorBoundary fallback={<p>Failed to load users</p>}>{/*...*/}</BlockErrorBoundary>;

  return <Table data={data.users} columns={userColumns} />;
}
```

### B3. DTO 镜像类型解耦方案

```typescript
// src/features/dashboard/adapters.ts
// 领域模型 — 前端自己的视图类型，不依赖后端 JSON 结构
export interface DashboardViewModel {
  heroStats: HeroStats;
  teams: TeamViewModel[];
  models: ModelViewModel[];
  keys: KeyViewModel[];
}

// Adapter — 后端 DTO → 前端领域模型
export function adaptDashboardResponse(raw: InitialDashboardData): DashboardViewModel {
  return {
    heroStats: {
      totalRequests: raw.total_requests ?? 0,
      activeKeys: raw.active_keys ?? 0,
      // 显式映射，后端字段变化只改 adapter
    },
    teams: raw.teams?.map(adaptTeam) ?? [],
    models: raw.models?.map(adaptModel) ?? [],
    keys: raw.keys?.map(adaptKey) ?? [],
  };
}

// Branded type — 让编译器帮你区分「原始 DTO」和「领域模型」
export type Branded<T, B> = T & { __brand: B };
export type SafeDashboard = Branded<DashboardViewModel, 'SafeDashboard'>;
```

**核心收益：** 后端改字段 → 只改 `adapters.ts` 一个文件 → 前端所有组件无需感知变化。

---

## C. SSR 安全加固 — 消除 #418 Hydration Mismatch

### C1. 已知隐患清单

| # | 隐患点 | 触发条件 | 当前状态 |
|---|---|---|---|
| 1 | `AdminLoadingSkeleton` 用 `SkeletonLine` | 每次 admin 页面加载 | 🔴 **确定触发** |
| 2 | `Math.random()` / `Date.now()` 在组件渲染路径中 | SSR ≠ client 时间戳/随机数 | 🔴 **潜在触发** |
| 3 | `typeof window !== 'undefined'` 三元表达式 | SSR 返回 server 分支，client 返回 client 分支 | 🟠 **视使用位置** |
| 4 | CSS-in-JS 动态 class（Tailwind 的 `dark:` 依赖系统偏好） | SSR 无 `prefers-color-scheme` | 🟡 **已有防御** |
| 5 | 第三方库未经 `useHasHydrated` gate | 如 charts、date formatters | 🟠 **需逐个排查** |
| 6 | `suppressHydrationWarning` 被滥用 | 超出 `<html>` 标签范围使用 | 🟡 **需 lint 检查** |

### C2. 自动化检测方案

**ESLint 自定义规则 — 禁止 SSR 路径使用非安全组件：**

```javascript
// eslint-rules/no-unsafe-skeleton.js
module.exports = {
  meta: {
    type: 'error',
    docs: {
      description: 'Disallow SkeletonLine outside SsrSafeSkeleton wrapper',
    },
    messages: {
      unsafeSkeleton:
        'Direct SkeletonLine usage causes hydration mismatch. Use SsrSafeSkeleton or PanelSkeleton instead.',
    },
  },
  create(context) {
    return {
      JSXIdentifier(node) {
        if (node.name === 'SkeletonLine') {
          // 检查是否在 SsrSafeSkeleton 或 PanelSkeleton 内部
          let parent = node.parent;
          let isSafe = false;
          while (parent) {
            if (
              parent.type === 'JSXElement' &&
              parent.openingElement?.name?.name &&
              ['SsrSafeSkeleton', 'PanelSkeleton'].includes(
                parent.openingElement.name.name
              )
            ) {
              isSafe = true;
              break;
            }
            parent = parent.parent;
          }
          if (!isSafe) {
            context.report({ node, messageId: 'unsafeSkeleton' });
          }
        }
      },
    };
  },
};
```

**ESLint 规则 — 检测 SSR 不安全的 API 调用：**

```javascript
// eslint-rules/no-unsafe-ssr-api.js
module.exports = {
  meta: { type: 'error' },
  create(context) {
    const UNSAFE_APIS = ['Math.random', 'Date.now', 'new Date'];
    return {
      CallExpression(node) {
        const callee = context.getSourceCode().getText(node.callee);
        if (UNSAFE_APIS.some(api => callee.startsWith(api))) {
          // 检查是否在 useHasHydrated guard 内
          const ancestors = context.getAncestors();
          const hasHydrationGuard = ancestors.some(ancestor => {
            // 检查是否被 useHasHydrated() 条件保护
            if (ancestor.type === 'IfStatement') {
              const source = context.getSourceCode().getText(ancestor.test);
              return source.includes('useHasHydrated') || source.includes('hydrated');
            }
            return false;
          });
          if (!hasHydrationGuard) {
            context.report({
              node,
              message: `${callee} in render path causes SSR/CSR mismatch. Wrap with useHasHydrated() guard.`,
            });
          }
        }
      },
    };
  },
};
```

### C3. 代码审查清单（PR Review Checklist）

```markdown
## SSR Hydration 安全检查清单

- [ ] 新组件的 loading 态是否使用 `PanelSkeleton` / `SsrSafeSkeleton`？
- [ ] 组件渲染路径中是否包含 `Math.random()` / `Date.now()` / `new Date()`？
- [ ] 是否有 `typeof window` 条件渲染？（应用 `useHasHydrated` 替代）
- [ ] `suppressHydrationWarning` 是否仅出现在 `<html>` 标签？
- [ ] 新引入的第三方库是否在 SSR 环境中产生确定性输出？
- [ ] 异步数据区块是否包裹 `BlockErrorBoundary`？
```

### C4. 构建时检测 — Hydration Diff 测试

```typescript
// tests/hydration-safety.test.ts
// 在 CI 中运行，确保关键页面的 SSR 输出与 client 首帧一致

import { renderToReadableStream } from 'react-dom/server';
import { createSSRRouter } from '@/router/ssr-router';

const CRITICAL_ROUTES = ['/', '/manage', '/keys', '/members'];

for (const route of CRITICAL_ROUTES) {
  describe(`Hydration safety: ${route}`, () => {
    it('SSR output should not contain Math.random artifacts', async () => {
      const stream = await renderToReadableStream(
        createSSRRouter(route, mockData)
      );
      const html = await collectStream(stream);

      // 检查是否有常见的随机性迹象
      expect(html).not.toContain('style="');
      // 检查 skeleton 数量确定性（同样数据应产生同样数量的骨架屏）
      const skeletonCount = (html.match(/data-slot="skeleton"/g) || []).length;
      expect(skeletonCount).toBeGreaterThan(0); // 确保有骨架屏
    });
  });
}
```

---

## D. 性能预算

### D1. 核心指标目标

基于 B 端 SaaS 管理后台的合理预期（参考 Google 的 INP Good 阈值 ≤200ms，LCP ≤2.5s，CLS ≤0.1）：

| 指标 | 当前预估风险 | 目标值 | 测量方式 |
|---|---|---|---|
| **INP** (Interaction to Next Paint) | 🟠 受 1176 行组件影响，交互延迟高 | **≤150ms** (P75) | `web-vitals` 库 + RUM 上报 |
| **LCP** (Largest Contentful Paint) | 🟡 SSR-first 有优势，但 HeroStats 渲染链路需优化 | **≤2.0s** | CWV real-user + Lighthouse CI |
| **CLS** (Cumulative Layout Shift) | 🟠 Skeleton → 真实内容切换可能导致布局抖动 | **≤0.05** | `web-vitals` + Layout Shift Observer |
| **TTFB** (Time to First Byte) | 🟢 Cloudflare Worker 边缘执行 | **≤100ms** | Worker 自带 metrics |
| **FID** / **TBT** | 🟠 JS bundle 体积需控制 | **TBT ≤150ms** | Lighthouse CI |

### D2. 具体优化建议

**LCP 优化 — Hero 渲染链路缩短**

```
当前: Worker 启动 → 数据查询 → renderToReadableStream → 完整 HTML → hydration → HeroStats 可见
目标: Worker 启动 → 数据查询 → 流式 HTML（HeroStats 优先 flush）→ hydration
```

```typescript
// src/entry/ssr.tsx — 流式优先 flush HeroStats
export default {
  async fetch(request, env) {
    const shellStream = await renderToReadableStream(
      <AppShell>
        <DashboardPage data={seedData} />
      </AppShell>,
      {
        // 关键：让 HeroStats 所在区块先 flush
        bootstrapModules: ['/src/entry/client.tsx'],
      }
    );

    return new Response(shellStream, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // 流式传输，不等全部渲染完
        'Transfer-Encoding': 'chunked',
      },
    });
  }
};
```

**INP 优化 — 长任务拆分**

```typescript
// ❌ 当前 — 1176 行组件的任何点击都触发整棵大树 reconcile
// ✅ 拆分后 — 各子组件独立更新，不会互相拖累

// 额外优化：对非紧急交互使用 startTransition
import { startTransition } from 'react';

function ApiKeysCard({ keys }: { keys: PortalKey[] }) {
  const [filter, setFilter] = useState('');

  const handleFilterChange = (value: string) => {
    // 输入响应保持即时（高优先级）
    setFilter(value);
    // 列表过滤延迟到空闲帧（低优先级）
    startTransition(() => {
      // 触发 selector 重新计算，不影响输入响应
    });
  };
}
```

**CLS 优化 — 骨架屏尺寸匹配**

```typescript
// src/components/dashboard-skeleton.tsx
// 关键：Skeleton 的宽高必须与真实内容一致，避免布局偏移

export function DashboardSkeleton() {
  return (
    <div className="dashboard-layout">
      {/* HeroStats 骨架 — 精确匹配真实布局的 grid */}
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <SsrSafeSkeleton key={i} width="100%" height={96} />
        ))}
      </div>
      {/* Teams + Models — 精确匹配 2-col grid */}
      <div className="grid grid-cols-2 gap-6 mt-6">
        <SsrSafeSkeleton width="100%" height={320} />
        <SsrSafeSkeleton width="100%" height={320} />
      </div>
      {/* Keys 表格 */}
      <SsrSafeSkeleton width="100%" height={240} className="mt-6" />
    </div>
  );
}
```

**Bundle Size 预算**

```typescript
// vite.config.ts — 添加 bundle 大小警告
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-tanstack': ['@tanstack/react-query', '@tanstack/react-router'],
          'vendor-i18n': ['@lingui/core', '@lingui/react'],
          'vendor-cf': ['@cloudflare/kumo'],
        },
      },
    },
  },
  plugins: [
    // 添加 bundle 大小限制
    visualizer({
      emitFile: true,
      template: 'treemap',
    }),
  ],
});

// package.json
{
  "scripts": {
    "size-limit": "size-limit",
    "size-check": "npm run build && npm run size-limit"
  }
}
```

```json
// .size-limit.json
[
  { "name": "Dashboard page", "path": "dist/assets/dashboard-*.js", "limit": "15 KB" },
  { "name": "Admin pages (lazy)", "path": "dist/assets/admin-*.js", "limit": "20 KB" },
  { "name": "Vendor chunk", "path": "dist/assets/vendor-*.js", "limit": "80 KB" },
  { "name": "Total JS", "path": "dist/assets/**/*.js", "limit": "150 KB" }
]
```

---

## E. 长期治理

### E1. CI 检查矩阵

在 CI pipeline 中建立以下 **硬门禁（Hard Gates）**：

```yaml
# .github/workflows/frontend-quality.yml
name: Frontend Quality Gates

on: [pull_request]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      # Gate 1: 类型安全
      - name: TypeScript Strict Check
        run: npx tsc --noEmit --strict

      # Gate 2: ESLint（含自定义 SSR 规则）
      - name: Lint with Custom SSR Rules
        run: npx eslint 'src/**/*.{ts,tsx}' --max-warnings 0

      # Gate 3: 单文件行数限制
      - name: File Size Guard
        run: |
          npx eslint 'src/**/*.{ts,tsx}' --rule '
            "max-lines": ["error", { "max": 300, "skipBlankLines": true }]
          '

      # Gate 4: Bundle Size Budget
      - name: Bundle Size Check
        run: npm run size-check

      # Gate 5: 无直接 fetch（必须走 TanStack Query）
      - name: No Raw Fetch Check
        run: |
          # 在非 hook 文件中搜索直接 fetch 调用
          grep -rn "fetch(" src/pages/ src/components/ --include="*.tsx" && exit 1 || exit 0

      # Gate 6: Hydration 安全测试
      - name: Hydration Safety Tests
        run: npx vitest run tests/hydration-safety.test.ts
```

### E2. 代码审查 Gate（PR Review Rules）

建立 **CODEOWNERS + PR Template** 强制机制：

```
# .github/CODEOWNERS
# 架构关键路径需要两人审查
/src/pages/dashboard/          @frontend-architects
/src/entry/                    @frontend-architects
/src/hooks/rpc/                @frontend-architects

# SSR 相关变更需要 hydration 专家审查
/src/components/*skeleton*     @ssr-experts
/src/entry/ssr*                @ssr-experts
```

```markdown
# .github/pull_request_template.md

## 变更类型
- [ ] 🏗️ 架构变更（需 2 人 approve）
- [ ] 🔒 SSR 相关（需 hydration checklist）
- [ ] 🎨 UI/布局变更（需截图/录屏）

## 检查项
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过（0 warnings）
- [ ] 无文件超过 300 行
- [ ] 新组件 loading 态使用 `PanelSkeleton`
- [ ] 新 hook 走 TanStack Query（非手写 fetch）
- [ ] 无 `suppressHydrationWarning`（除非在 `<html>` 上）

## 性能影响
- [ ] 此 PR 不增加主 bundle 超过 2KB
- [ ] 此 PR 不引入新的 hydration mismatch 风险
```

### E3. 技术债看板（Tech Debt Board）

建立 **技术债积分卡** 机制，每个 PR 带上债务标签：

```typescript
// src/lib/tech-debt.ts — 运行时追踪技术债使用
// 在开发模式下标记技术债使用
if (import.meta.env.DEV) {
  const DEBT_ITEMS = {
    'raw-fetch-in-admin': 'C1: Admin 组件仍使用手写 fetch，应迁移到 TQ hooks',
    'dto-mirror-type': 'C4: DTO 类型与后端强耦合，需 adapter 解耦',
    'god-component-app': 'B1: app.tsx 仍为 God Component，需拆分',
  } as const;

  // 在控制台暴露技术债状态
  window.__TECH_DEBT = DEBT_ITEMS;
}
```

### E4. 指标监控仪表盘

建立 **四级监控体系**：

| 层级 | 指标 | 告警阈值 | 工具 |
|---|---|---|---|
| **RUM (Real User)** | INP P75 / LCP P75 / CLS | INP >200ms, LCP >2.5s | `web-vitals` → CF Analytics Engine |
| **构建时** | Bundle size per route | 超预算 10% | `size-limit` CI gate |
| **代码质量** | 单文件行数 / ESLint warnings | >300 行 / >0 warnings | CI + SonarQube |
| **架构健康** | TanStack Query 覆盖率 / 直接 fetch 数量 | 直接 fetch >0 | 自定义 grep + CI |

```typescript
// src/lib/rum.ts — RUM 上报
import { onINP, onLCP, onCLS } from 'web-vitals';

function reportToAnalytics(metric: Metric) {
  // 上报到 Cloudflare Analytics Engine
  navigator.sendBeacon('/api/v1/analytics', JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    path: location.pathname,
    timestamp: Date.now(),
  }));
}

onINP(reportToAnalytics);
onLCP(reportToAnalytics);
onCLS(reportToAnalytics);
```

### E5. 季度技术债回顾

建立 **每季度一次** 的技术债回顾会议，议程固定：

1. **盘点**：运行 `grep -rn "TODO|FIXME|HACK|DEBT" src/` 输出清单
2. **打分**：每个债务项按「用户影响 × 修复成本」打分
3. **排期**：将 Top 3 债务项编入下一迭代
4. **防回退**：检查 CI gates 是否有效阻止同类债务新增
5. **更新本文档**：刷新审计摘要中的技术债清单

---

## 执行时间线总结

| 阶段 | 时间 | 内容 | 涉及维度 |
|---|---|---|---|
| **P0 热修** | Week 1 | C2: SsrSafeSkeleton 修复 + CI gate 部署 | A①, C |
| **P1 偿债** | Week 1–2 | C1: Admin fetch → TQ hooks 迁移 | A②, B2 |
| **P2 架构** | Week 2–3 | B1: app.tsx 拆分 + C4: DTO adapter 层 | A③⑤, B1, B3 |
| **P3 体验** | Week 3–4 | C3: 导航 Chrome 统一 | A④ |
| **P4 治理** | 持续 | CI gates + RUM + 技术债看板上线 | D, E |

> **核心原则：每一步都是非破坏性的渐进式改进。** 拆分文件时保持 export 兼容，迁移 hook 时保持 API 不变，每一步都能独立部署和验证。不追求「大重构」，追求「每一步都比上一步更安全」。
