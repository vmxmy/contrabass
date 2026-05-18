# Litellm Portal 前端审计 — 专业建议报告

> 输出方：基于完整代码审计与架构分析的前端架构师视角
> 输入材料：评审报告 + 架构速查 + 组件规范 + 技术债清单 + 源代码
> 日期：2026-05-18

---

## A. 优先级重排：Top 5 必做项

以「用户可感知风险」×「修复成本」为二维矩阵，重新排序后：

### 1. 🥇 拆分 app.tsx God Component（原 🔴 Blocker）
- **用户可感知风险**：中 — 当前 app.tsx 一处崩溃会导致整个 dashboard 区域不可用
- **修复成本**：中 — 纯代码移动，无逻辑变更
- **推荐理由**：解锁团队并行开发、降低回归风险、为后续重构扫清障碍。这是所有其他修复的前置条件。

### 2. 🥈 接入 Toasty 全局错误层 + 统一 admin fetch（原 🟠 Critical ×2）
- **用户可感知风险**：高 — 用户当前遭遇网络错误时可能看到空白或技术错误泄漏
- **修复成本**：低 — TanStack Query 的 `onError` 全局配置 + hooks 已存在
- **推荐理由**：投入产出比最高。`useUpdatePreferences` 已展示完整乐观更新模式，只需把该模式复制到 `use-dashboard`/`use-admin-*` hooks。

### 3. 🥉 替换 AdminLoadingSkeleton 为 SsrSafeSkeleton（原 🟠 Critical）
- **用户可感知风险**：低 — 仅影响 admin 页面 hydration 稳定性
- **修复成本**：极低 — 替换 import，5 分钟完成
- **推荐理由**：零风险、高确定性、立即消除已知的 #418 隐患点。

### 4. 统一 /manage 与 Tenant Portal 导航 Chrome（原 🟠 Critical）
- **用户可感知风险**：高 — 高频操作路径（/ → /manage/keys）的界面突变
- **修复成本**：中 — 需要调整 PortalRootLayout 或提取共享 Layout
- **推荐理由**：心智模型一致性是 B 端产品的核心体验指标。

### 5. 接入 CSP + 安全头 + RateLimitDO（原 OpenSpec p3-10）
- **用户可感知风险**：高 — 生产环境缺少基础安全防护
- **修复成本**：中 — 大部分为配置和中间件层工作
- **推荐理由**：安全 debt 会随时间指数级恶化，越早修复成本越低。

---

## B. 架构改进方案

### B.1 app.tsx 拆分方案

**目标**：将 1176 行的 God Component 拆分为职责单一的文件，保持零行为变更。

```
src/litellm-portal/
├── app.tsx                              # 仅保留入口组装 + 导出聚合
├── app/
│   ├── index.ts                         # re-export 所有公开 API
│   ├── hero-stats.tsx                   # HeroStats + StatTile + statsFromDashboard
│   ├── stats-tiles.tsx                  # TeamIdentityTile / PersonalSpendTile / TeamBudgetTile / RecentActivityTile
│   ├── teams-access-card.tsx            # TeamsAccessCard
│   ├── model-access-card.tsx            # ModelAccessCard + ModelBadges
│   ├── api-keys-card.tsx                # ApiKeysCard + ModelsCell
│   ├── create-key-button.tsx            # CreateKeyButton + CreateKeyResult + 表单逻辑
│   ├── delete-key-button.tsx            # DeleteKeyButton + deleteKeyErrorMessage
│   ├── portal-error-banner.tsx          # PortalErrorBanner
│   └── header-actions.tsx               # HeaderActions + resolvedTheme + initialResolvedTheme
```

**迁移步骤**：
1. 逐个组件复制到新文件（保持 Git history：用 `git mv` + 分步 commit）
2. 每个组件单独验证：单元测试 + Storybook（如有）
3. 最后删除 app.tsx 中的内联定义，改为 `export { HeaderActions } from './app/header-actions'` 等 re-export
4. **关键**：`normalize*` 工具函数和 `modelBadgeColor` 移到 `lib/` 或 `app/utils.ts`

### B.2 admin-components 统一数据层

**现状**：三个组件各自维护 `useState + useEffect + fetch`：

```tsx
// 反模式：每份复制粘贴
const [data, setData] = useState<AdminUsersResponse | null>(null);
const [error, setError] = useState<string | null>(null);
const [loading, setLoading] = useState(true);
const [page, setPage] = useState(1);
const requestIdRef = useRef(0);
useEffect(() => { /* 相同模式 */ }, [page]);
```

**方案 A（推荐）：迁移至已有 TanStack Query hooks**

项目中已存在 `hooks/use-admin-users.ts`、`hooks/use-admin-teams.ts`、`hooks/use-admin-audit.ts`，但 `admin-components.tsx` 没有使用它们。

```tsx
// AdminUsersTable 改造后
import { useAdminUsers } from "../../hooks/use-admin-users";

export function AdminUsersTable() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error } = useAdminUsers(page, ADMIN_PAGE_SIZE);

  if (isLoading) return <PanelSkeleton lines={4} />;  // ← 用 PanelSkeleton 替换 AdminLoadingSkeleton
  if (isError) return <PanelError title={t`加载失败`} error={error} />;
  // ... 渲染逻辑不变
}
```

**方案 B（备选）：抽象通用 hook**

如果已有 hooks 的接口不完全匹配（如分页方式不同），抽象一个：

```ts
// hooks/use-admin-fetch.ts
export function useAdminFetch<T>(url: string, page: number, size: number) {
  return useQuery({
    queryKey: [url, page, size],
    queryFn: async () => {
      const res = await fetch(`${url}?page=${page}&size=${size}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<T>;
    },
    staleTime: 30_000,
  });
}
```

**迁移步骤**：
1. 逐个替换：AdminUsersTable → useAdminUsers
2. AdminTeamsTable → useAdminTeams
3. AdminAuditFeed → useAdminAudit
4. 删除 `AdminLoadingSkeleton` 和 `AdminErrorBanner`（被 PanelSkeleton / PanelError 替代）
5. 删除 `requestIdRef` 等手工竞态处理（TanStack Query 内建）

---

## C. SSR 安全加固：#418 隐患排查与自动化

### C.1 已知隐患点清单

| # | 位置 | 隐患 | 风险等级 |
|---|---|---|---|
| 1 | `admin-components.tsx:249-257` | `AdminLoadingSkeleton` 直接使用 `SkeletonLine` | 🔴 高 |
| 2 | `dashboard/charts/*.tsx` | ECharts 动态导入可能在 SSR 边界抛出 | 🟡 中 |
| 3 | `ops-console/shell.tsx:67` | `useOpsTenants()` 在 Shell 中调用，SSR 时可能触发请求 | 🟡 中 |
| 4 | `app.tsx:623` | `ModelAccessCard` 的 `useState(modelAccess.models.length > 0 && ...)` | 🟢 低 |
| 5 | 任何新增组件 | 开发者误用 `Math.random()` / `Date.now()` / `window` 在 render 阶段 | 🔴 高 |

### C.2 自动化检查方案

#### ESLint 规则配置

```js
// .eslintrc.cjs — 新增规则
module.exports = {
  rules: {
    // 禁止在组件 render 阶段访问 browser-only API
    "no-restricted-globals": ["error", "window", "document", "navigator", "localStorage"],
    
    // 禁止直接使用 Math.random()（必须用 ssr-safe 包装）
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
        message: "Math.random() causes hydration mismatch. Use useHasHydrated() gate or SsrSafeSkeleton.",
      },
    ],
    
    // 禁止导入 SkeletonLine 直接从 @cloudflare/kumo/components/loader
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@cloudflare/kumo/components/loader",
            importNames: ["SkeletonLine"],
            message: "Use SsrSafeSkeleton or PanelSkeleton instead to prevent #418.",
          },
        ],
      },
    ],
  },
};
```

#### CI Gate：Hydration Smoke Test

```ts
// tests/hydration-smoke.test.ts
import { renderToString } from "react-dom/server";
import { renderToReadableStream } from "react-dom/server";

test("SSR output is byte-identical on second render", async () => {
  const stream1 = await renderToReadableStream(<AppShell />);
  await stream1.allReady;
  const markup1 = await readableStreamToText(stream1);
  
  const stream2 = await renderToReadableStream(<AppShell />);
  await stream2.allReady;
  const markup2 = await readableStreamToText(stream2);
  
  expect(markup1).toBe(markup2);
});
```

#### 代码审查清单（PR Template）

```markdown
## SSR 安全检查
- [ ] 新增 loading 态使用 PanelSkeleton（非 SkeletonLine）
- [ ] 无 Math.random() / Date.now() / window / document 在 render 阶段
- [ ] 新增异步数据区块包 BlockErrorBoundary
- [ ] 无 suppressHydrationWarning 滥用（仅在 <html> 属性）
```

---

## D. 性能预算与优化建议

### D.1 当前基线评估

| 指标 | 当前估计 | 目标 | 差距 |
|---|---|---|---|
| **LCP** | ~1.5s（SSR HTML + Kumo CSS + portal.js） | < 1.2s | 🟡 |
| **INP** | ~150ms（Tabs 切换、Dialog 打开有延迟感） | < 100ms | 🟡 |
| **CLS** | ~0.05（SsrSafeSkeleton 占位稳定） | < 0.1 | ✅ |
| **TTFB** | ~200ms（Worker cold start） | < 200ms | ✅ |

### D.2 具体优化方案

#### LCP 优化

1. **Kumo CSS 内联关键样式**
   - 当前 `<link rel="stylesheet" href="/kumo.css" />` 阻塞渲染
   - 方案：将首屏关键 Kumo token（colors、spacing、typography）内联到 `<style>`，剩余样式异步加载
   - **目标**：LCP 从 ~1.5s → ~1.0s

2. **portal.js 预加载**
   - 在 `<head>` 添加 `<link rel="preload" href="/portal.js" as="script">`
   - **目标**：减少 JS 加载阻塞时间 100~200ms

#### INP 优化

1. **CommandPalette 懒加载优化**
   - 当前 `React.lazy(() => import('./portal-command-palette'))` 首次 ⌘K 有 200~300ms 延迟
   - 方案：在 `client.tsx` `hydrateRoot` 完成后 3 秒，后台 `import('./routes/portal-command-palette')` 预热 chunk
   - **目标**：INP 从 ~150ms → ~80ms

2. **UsageDashboard 图表延迟渲染**
   - `TrendChartLazy` 在数据就绪后才加载，造成主线程阻塞
   - 方案：数据请求和图表 chunk 加载并行（`Promise.all([fetchDashboard(), import('./charts/trend-chart')])`）
   - **目标**：减少用户感知延迟 50ms

#### CLS 优化（已较好，可维持）

- 当前 `SsrSafeSkeleton` + `useHasHydrated` 体系已确保占位稳定
- 唯一风险：`AdminStatusHeader` 的 `Badge` 数量变化可能导致高度微跳
- 方案：固定 `AdminStatusHeader` 高度 `min-h-[56px]`

---

## E. 长期治理机制

### E.1 CI 检查 Gate

```yaml
# .github/workflows/frontend-quality.yml
jobs:
  quality-gate:
    steps:
      - name: ESLint (SSR safety)
        run: pnpm lint --rule 'no-restricted-imports:error'
      
      - name: Hydration smoke test
        run: pnpm test -- tests/hydration-smoke.test.ts
      
      - name: Bundle size budget
        run: |
          pnpm build
          npx bundlesize --config .bundlesize.json
        # 限制：portal.js < 200KB gzipped，admin chunk < 100KB gzipped
      
      - name: i18n completeness
        run: pnpm test -- tests/i18n-completeness.test.ts
      
      - name: Tech debt threshold
        run: |
          TODO_COUNT=$(grep -r "TODO\|FIXME\|HACK" src/litellm-portal --include="*.ts" --include="*.tsx" | wc -l)
          if [ "$TODO_COUNT" -gt 10 ]; then
            echo "Tech debt threshold exceeded: $TODO_COUNT TODOs found (max 10)"
            exit 1
          fi
```

### E.2 代码审查 Checklist（PR 模板）

```markdown
## 前端质量检查
- [ ] 新增组件有独立文件（非 God Component 增量）
- [ ] 状态走 TanStack Query（非手写 useEffect + fetch）
- [ ] Loading 态使用 PanelSkeleton / SsrSafeSkeleton
- [ ] 关键区块包 BlockErrorBoundary
- [ ] i18n 字符串已抽取（无硬编码中文）
- [ ] Design Token 覆盖率 100%（无硬编码颜色/间距）
- [ ] 密度不硬编码（读取 DensityContext）
- [ ] 单元测试覆盖新增逻辑
```

### E.3 指标监控 Dashboard

在 Ops Console 或独立页面添加「前端健康度」面板：

| 指标 | 数据源 | 告警阈值 |
|---|---|---|
| Hydration mismatch 次数 | `console.error` 中 `#418` 匹配 | > 0 / day |
| JS Error 率 | `window.onerror` 上报 | > 0.1% |
| LCP P75 | Cloudflare Web Analytics / RUM | > 1.2s |
| INP P75 | Cloudflare Web Analytics / RUM | > 200ms |
| CLS P75 | Cloudflare Web Analytics / RUM | > 0.1 |
| 首屏 API 延迟 | `server-impl.tsx` 打点 | > 500ms |

### E.4 技术债治理节奏

| 周期 | 动作 | 负责人 |
|---|---|---|
| 每周 | Sprint 计划时审查 Tech Debt 清单 | Tech Lead |
| 每月 | 生成「债务热力图」变化 diff | CI Bot |
| 每季度 |  dedicated Tech Debt Sprint（2~3 天） | 全团队 |
| 实时 | 新增 TODO 必须关联 Issue / OpenSpec 变更 | PR Reviewer |

---

## 附录：与 OpenSpec 任务的映射

| 本报告建议 | 对应 OpenSpec 变更 | 状态 |
|---|---|---|
| 拆分 app.tsx | 无（新增建议） | 待创建 |
| 统一 admin fetch | `p0-02-typed-rpc-data-layer` 遗留项 | 部分完成 |
| Toasty 全局错误层 | `p2-06-kumo-feedback-overlays` | ❌ 未完成 |
| CSP + 安全头 | `p3-10-security-hardening` | ❌ 未完成 |
| R2 接入 + 缓存 | `p4-12-perf-code-split` §3~5 | ❌ 延期 |
| axe-core + 焦点 | `p4-13-a11y-i18n` | ⚠️ 部分完成 |
| Text Kumo 化 | `p2-07-kumo-typography-layout` | ❌ 未完成 |

**建议**：将本报告的 A~E 维度结论转化为新的 OpenSpec 变更，编号建议 `p2-08-frontend-architecture-cleanup`，包含上述 Top 5 必做项。
