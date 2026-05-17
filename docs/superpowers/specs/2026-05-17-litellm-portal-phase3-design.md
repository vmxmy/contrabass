# LiteLLM Portal — Phase 3 设计语言演进 · 设计文档

- 日期：2026-05-17
- 状态：**APPROVED by user 2026-05-17（§E 全部 resolved）；V2.0 6 项全折入 2026-05-17（见 §F，用户「全部折入」决策）；plan 已编写并加固至 #418 round-5 ✅**
- 范围层级：本文档为 **Phase 3 spec**，扩展总纲 spec 第 4 节，建立在已上线的 Phase 1/2 之上
- 父文档：`docs/superpowers/specs/2026-05-17-litellm-portal-uiux-redesign-design.md`（已通过的总纲）
- 载体规范：`cloud/src/litellm-portal/DESIGN.md`（**扩展不替换**）

---

## Context（为什么是 Phase 3）

总纲 spec 把全站重设计拆为 P0–P3。当前状态：

- **Phase 0（后端地基）** 已落地：门户级 `tenantRole`、`resolveIdentity` 扩展、`requireTenantAdmin`、租户作用域端点。
- **Phase 1（Tenant Portal）** 已上线（zhiyun.ziikoo.com）：`tenant-portal/shell.tsx` 左导航壳 + 品牌条 + `branding.ts` 单电压品牌层 + 六屏（overview/usage/keys/members/alerts/billing）+ impersonation 横幅 + 旧路径 301。
- **Phase 2（Operations Console）** 已上线：`ops-console/shell.tsx` Owner-gated 壳 + 固定钢色 `ops-theme.ts` + 七屏（tenant-overview/provisioning/global-usage/audit/platform-settings/tenant-detail/user-detail）+ 跨面 impersonation 桥接。

Phase 3 是总纲第 4 节里「设计语言演进 + 租户品牌层 + 密度/状态统一 + bundle 拆分 + a11y 审计」那一期。它不新增屏、不动后端、不改 IA；它在**已清理过的基线**上把视觉语言从「能用的 Phase-1/2 脚手架」推进到「明显重塑的对外多租户门户 + 对内运营驾驶舱」。

**现状盘点（决定本期工作量的真实事实，已读源码确认）：**

1. 两壳的导航是裸 `<a className="block rounded-md px-3 py-2 ... hover:bg-kumo-canvas">`，**没有 active/current 态、没有图标、没有分组**，Tenant 与 Ops 的 chrome 几乎逐字相同（只差品牌条文案与钢色变量）。「同源异质」目前只体现在一个 `--kumo-brand` 值的差异上，视觉上两面分不开。
2. 空/载入/错误/骨架态**每屏各写一份**：`overview.tsx` 的 `TopModelsTile` 自绘 article+header+SkeletonLine；`tenant-overview.tsx` 的 `TenantsTable` 自绘 `SkeletonLine`×2 / `Banner variant="error"` / `Empty size="sm"`；`routes.tsx` 的 `MemberForbidden` 又是另一种 `Empty`。同一语义在不同屏呈现不一致，密度也不统一（`p-6` / `p-6 space-y-3` / `py-12` 混用）。
3. 品牌面只覆盖 `--kumo-brand` / `--kumo-brand-hover` 两个 token（`applyBrandVars`），左导航、卡片头、active 态全是 Kumo 默认中性灰——租户「认领感」很弱。
4. 动效语言为零：壳、卡片、导航无任何 `transition-*`，无 `prefers-reduced-motion` 处理。
5. a11y 已有底子但不完整：impersonation 横幅是 `role="alert" aria-live="assertive"`，图表有 1 处 `ariaDescription`；但导航缺 `aria-current`，键盘焦点态依赖浏览器默认，未做系统化审计。
6. bundle：总纲记录 portal app bundle ≈ 1.09MB minified / gzip ≈ 385KB（Kumo Chart/ECharts 占增量约 235KB/96KB）；路由是 code-based 全量 import（`router.tsx` 顶部静态 import 全部 route 模块），**没有任何 `React.lazy` / lazy-route 拆分实际生效**——总纲所说的「沿用 #135 TanStack lazy」在 portal 侧目前是名义上的，chart island 也未懒加载。

由此，Phase 3 必须先做卫生收敛（让基线一致、可访问、可拆），再在干净基线上做明显重塑——否则重塑会把不一致与体积问题一起放大。

---

## 已锁定决策（用户 2026-05-17，逐条编码，不再讨论）

| # | 维度 | 锁定决策 | 本 spec 如何编码 |
|---|---|---|---|
| 1 | 视觉强度 | **明显重塑**（visibly new look，非仅间距打磨）：新 chrome/卡片/导航处理、更强品牌表达、motion + 状态前置的「运营驾驶舱」观感。**严格在 Kumo 内**：不分叉设计系统；语义/层级/版式 token 不覆盖；暗色 `data-mode` + 双语 + WCAG-AA 对比度不变量保持；`DESIGN.md` 扩展不替换。 | §B 用 Kumo token/utility 决策 + DESIGN.md 新增小节表达重塑语言；§B 末「不变清单」显式列出不动的 token 类。 |
| 2 | 租户品牌深度 | **扩展可品牌面**：超出 Phase-1 单 `--kumo-brand*` accent，更多 chrome 面（左导航、卡片边/头、强调/active 态）可取租户主色；仍强制对比度（双模式）、仍 Kumo 默认回落、仍注入安全（严格 `#rrggbb`，`branding.ts` 守卫模型扩展）。**Ops Console `/ops` 保持固定中性钢色、忽略租户品牌**（Phase-2 不变量）。 | §C 给出确切可品牌面清单 + `branding.ts` 扩展规则 + Ops 忽略不变量重述。 |
| 3 | 范围/优先级 | **全做，卫生优先**：Phase 3 顺序 (A) a11y 审计 → (B) 密度/状态 token 统一 → (C) bundle 拆分（低风险收敛先做）→ (D) 明显视觉重塑（叠加在已清理基线上）。一个 Phase-3 spec→plan→impl 周期内完成。 | §A 三条卫生工作流（含验收）先行；§B 重塑后置；§D 明确 §A→§B 排序与计划分解。 |

隐含硬约束（继承总纲第 5 节横切，全程保持）：SSR + React 岛（两壳 = 两入口，角色服务端解析，#418 hydration 不回归）、zh-CN/en 双语（新文案先入 `i18n/messages/*`）、暗色 `data-mode`、Kumo 组件、bundle 敏感、无装饰阴影、数字等宽、语义色仅文本。

---

## §A 卫生优先（先做：A → B → C）

§A 的产物是「一致、可访问、可拆」的基线。三条工作流互相独立、低风险、可单独验证、可单独交付。**§B 不得在 §A 三条全部达验收前开工**（决策 3）。

**§A 先行结构/缺陷修复（执行期发现，用户决策规则授权折入 Phase-3）：** (1) Tenant 需一个对称于 Ops `OpsLayout` 的无路径 pathless layout 包裹 `/usage|/keys|/members|/alerts|/billing`（见 §B.1 结构前提；plan Task 0）。(2) **修复一个已上线生产 #418**：Tenant shell 的加载态经 `TenantOverviewScreen` 渲染 Kumo `SkeletonLine`，而 Kumo `SkeletonLine` 用**未 seed 的 `Math.random()`** 计算 `--skeleton-width`/shimmer，SSR 与客户端首帧不一致 → 真实 hydration mismatch（`hydration.test.tsx` "tenant_admin full-nav shell at /" 在已上线 main 即红）。Phase-3 必须修（plan Task 0B：确定性 SSR 占位 + hydration 后再挂真实 SkeletonLine，禁用 `suppressHydrationWarning`），因为 **没有任何 CI workflow 跑 `cd cloud && bun run test`**（`ci.yml`=`make test-quick`，仅 go+dashboard+landing），§A-GATE 本地 sweep 是这些测试的唯一门禁，而 #418 是本分支的命名不变量——不可借「CI 会兜底」放过。

### §A.1 — a11y 审计与达标（工作流 A，最先）

**审计范围（逐项，针对已上线两壳 + 全部 13 屏 + 共享组件）：**

- **键盘可达性**：左导航每个 `<a>`、impersonation「退出代操作」按钮、provisioning/alerts 表单控件、表格行内链接（`/ops/tenants/...`）必须 Tab 可达且顺序符合视觉顺序；无键盘陷阱。
- **焦点态**：当前裸 `<a>` 依赖浏览器默认 outline。统一为 Kumo 焦点环约定 `focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-offset-2`（DESIGN.md 既有 select 焦点约定的推广），保证暗色与品牌色覆盖下焦点环对比 ≥ 3:1。
- **ARIA 语义**：左导航包一层 `<nav aria-label>`（已有）+ 每个链接在当前路由命中时加 `aria-current="page"`（**当前完全缺失**）；`OpsForbiddenCard` / `MemberForbidden` 的 `Empty` 确认有可读标题（已有 `title`）；impersonation 横幅 `role="alert" aria-live="assertive"`（已有，纳入回归守卫不得丢失）。
- **图表 `ariaDescription`**：`chart.tsx` 已有 1 处中文 `ariaDescription`；审计为 (a) 文案随 i18n 切换（当前是硬编码中文模板字符串，en locale 下仍输出中文——**缺陷**），(b) global-usage 多线图若复用同一 chart island 须同样具备。
- **对比度**：正文/标签在 canvas/elevated/recessed 三层背景、亮/暗双模式下文本对比 ≥ 4.5:1（语义色文本 ≥ 4.5:1）；非文本 UI（焦点环、active 指示、品牌强调边）≥ 3:1。复用 `branding.ts` 既有 WCAG 数学（`relativeLuminance`/`contrastRatio`），不引入新依赖。

**达标 pass bar（验收）：**

- 全部 13 屏 + 两壳：键盘可单独完成「进入屏 → 操作主 CTA → 离开」without mouse。
- 每个导航链接在其路由命中时输出 `aria-current="page"`；有自动化测试断言（扩展现有 `shell.test.tsx` / `ops-console/shell.test.tsx`）。
- `chart.tsx` 的 `ariaDescription` 走 `t`-宏化（zh-CN/en 各一份消息），`i18n-completeness.test.ts` 覆盖。
- 焦点环可见 token 化（一个共享 utility 类串，§A.2 沉淀），不再依赖浏览器默认 outline；暗色 + 任一合法品牌色下焦点环对比 ≥ 3:1（用 `branding.ts` 数学写一条单测样例）。
- 不回归项：impersonation `role="alert"`、`OpsForbiddenCard` Owner 门、`MemberForbidden` 仍在；现有 `shell-impersonation.test.tsx` 全绿。

### §A.2 — 密度与状态 token 统一（工作流 B，第二）

**问题**：empty/loading/error/skeleton 每屏各写一份，密度（padding/间距）三套混用。Phase 3 必须给出**唯一规范的四态 + 一套密度刻度**，命名化，应用于两壳全部屏。

**统一模型（在 DESIGN.md 新增「State Treatments」与「Density Scale」两小节，作为契约）：**

- **四态规范组件（最小新增，封装 Kumo 原语，不新建设计系统）：**
  - `PanelSkeleton` — 统一骨架：复用 Kumo `SkeletonLine`，固定为「标题行 12px + 内容行 16px」的密度，参数仅 `lines`。取代各屏手写的 `SkeletonLine` 堆叠。
  - `PanelEmpty` — 统一空态：封装 Kumo `Empty`，默认 `size="sm"`，标题必填、描述可选、可选 action；居中 `py-10`。取代 `Empty size="sm"` / `py-12 Empty` / `MemberForbidden` 各写一份。
  - `PanelError` — 统一错误态：封装 Kumo `Banner variant="error"`，标题 + `error instanceof Error ? error.message : t\`网络请求失败\``（沿用 `tenant-overview.tsx` 已有模式，提为唯一实现）。
  - `PanelLoading` — 行内/小范围加载：封装 Kumo `Loader`，用于按钮/局部；与 `PanelSkeleton`（首屏占位）分工明确。
  - 这四者是「面板内容区」的契约：任何 data-panel/LayerCard 的 query 状态分支只允许走这四个，不允许屏内再手写骨架/空/错。
- **密度刻度（命名化，沿用 DESIGN.md 既有 spacing token，不新增数值）：**
  - `density="comfortable"` → 卡片 `p-6`、组间 `space-y-6`、KPI 网格 `gap-4`（= Tenant Portal 默认，对外、编辑式留白）。
  - `density="compact"` → 卡片 `p-4`、组间 `space-y-4`、表格行紧凑（= Ops Console 默认，对内、运营驾驶舱致密）。
  - 密度是壳级决策（Tenant=comfortable / Ops=compact），由壳通过 context 下发，屏不各自硬编码 padding。**这是「同源异质」在密度维度的第一处真实差异化**（目前两面密度无差别）。

**验收：**

- 仓库内对 `SkeletonLine` / `Empty` / `Banner variant="error"` 的**直接**调用收敛到这 4 个封装内部；屏组件不再直接 import 这三个 Kumo 原语做状态分支（lint/grep 守卫 + 测试）。
- 13 屏的空/载入/错误三态在快照测试中视觉一致（同标题层级、同居中、同 padding）。
- Tenant 屏渲染 comfortable 密度、Ops 屏渲染 compact 密度，由壳 context 决定；`tenant-portal.stories.tsx` / `ops-console.stories.tsx` 各加一个「四态画廊」story 供肉眼回归。
- 暗色 + 双语下四态文案/对比不回归。

### §A.3 — bundle 拆分（工作流 C，第三，仍属卫生）

**现状**：`router.tsx` code-based 全量静态 import；总纲所述「TanStack lazy」在 portal 实际未生效；chart island 未懒加载；app bundle ≈ 1.09MB min / 385KB gzip，ECharts 占大头。

**目标（保守、低风险、可测量）：**

- **Chart island 懒加载**：`chart.tsx`（Kumo `TimeseriesChart` + `echarts/core` 注册）改为 `React.lazy` + `Suspense`，fallback = §A.2 的 `PanelSkeleton`。仅 usage/global-usage 屏进入时才加载 ECharts chunk。
- **两壳按面分包**：Tenant Portal 屏子树与 Ops Console 屏子树拆为两个 lazy 边界（route 级 `React.lazy`），使 member 用户首屏不下载 Ops 屏代码，反之亦然。route 拓扑不变（仍 `rootRoute.addChildren`），只在 component 处引入 lazy 包装。
- **不做**：不拆 Kumo 核心组件（共享、tree-shaking 已处理）、不引入新构建插件（保持 code-based、无 Vite FS 插件，符合 `router.tsx` 既定约束）。

**验收（§E-1 已锁，2026-05-17）：**

- **HARD GATE（CI 可验证）**：构建产物中 ECharts 进入独立 chunk，且**不在初始 portal app chunk 内**。`analyze:litellm-portal-bundle` 在 CI 中断言此条；before/after 数字追加进 DESIGN.md 的 Chart/Bundle 决策小节作为观测记录，但不设 KB 阈值门槛。
- **观测指标（非门槛）**：member 首屏初始 gzip 体积较当前下降，具体数字由 plan 阶段实测后记录；不作为 CI 门槛，仅作参考。
- SSR + 岛 hydration 不回归（#418 守卫）：lazy 边界在 SSR 下有正确 fallback，hydration 不 mismatch；`hydration.test.tsx` 扩展覆盖 lazy 边界。

---

## §B 明显视觉重塑（在 §A 三条达验收后）

§B 把视觉语言从 Phase-1/2 脚手架推进到「明显重塑」。表达为 Kumo token/utility 决策 + `DESIGN.md` 新增小节；**不出像素稿**；需要描述布局处用文字/ASCII 精确描述。

### §B.0 不变清单（决策 1 硬边界，先声明再扩展）

以下**绝不改动**——重塑只在其上做编排，不动地基：

- 语义色仍仅文本（success/warning/danger/info），`-tint` 仅用于 pill/badge 背景。
- 层级 token（canvas/base/elevated/recessed/tint/fill）映射与角色不变。
- 版式 token：标题权重 ≤ 600、数字等宽、metric label 12px uppercase tracking-wider、page title `tracking-tight`——不覆盖。
- 圆角体系（xs/sm/md/lg/xl/pill）与「pill 用于交互、xl 用于容器」不变。
- 无装饰阴影：仍以 surface 层变化造深度，**不**引入 `shadow-*`。
- 不分叉 Kumo、不覆盖语义/层级/版式 token、不改 Ops 钢色/忽略品牌不变量。

### §B.1 Chrome 系统（壳/页头/导航处理）——重塑核心

当前两壳 chrome 逐字雷同。重塑后两壳**结构同源、语气异质**：

- **页头条（顶部 brand/identity bar）**：
  - Tenant：品牌条升级——左侧 logo + 租户名（已有），**新增**右侧常驻「本周期花费/预算」紧凑 meter（复用 `Meter`）+ 告警状态点（success/warning 语义文本+点），形成「门户身份摘要条」。背景 `bg-kumo-elevated`，底 `border-b border-kumo-line`（统一 hairline，当前误用 `border-kumo-default`，重塑时归正）。语气：平静、品牌化、编辑式留白（comfortable 密度）。
  - Ops：页头保留「运营控制台 + 内部·特权」chip（已有），**强化**为运营驾驶舱语气——chip 升级为固定钢色描边 pill（`ring-1` 钢色，非品牌色，强化「特权」标识），页头右侧加全局态摘要 chip 组（租户数 / 告警租户数，等宽数字，compact 密度）。
- **左导航重塑**（两壳共用一个 `SideNav` 封装，语气由壳的密度 + 品牌 context 决定）：
  - 当前：裸 `<a>`，无 active、无图标、无分组。
  - 重塑：
    - **active/current 态**：命中路由的项 = 左侧 2px 强调条（Tenant 取租户品牌色 `--kumo-brand`，Ops 取固定钢色）+ `bg-kumo-tint` 底 + `text-kumo-strong` + `aria-current="page"`（与 §A.1 合流）。
    - **hover 态**：`bg-kumo-tint`（统一，当前 `hover:bg-kumo-canvas` 在 elevated 底上几乎不可见——归正）。
    - **图标**：每项前置 16px 图标（`text-kumo-subtle`，active 时随强调色）。**主策略（§E-2 已锁，2026-05-17）：使用 `@cloudflare/kumo` 内置图标集**（Kumo icon 组件/set）。**备选（仅当 plan/impl 阶段确认 Kumo 未提供覆盖所需导航图标的 icon 组件时才启用）**：零依赖内联 SVG（绝不引入新 icon 依赖——这与 §A.3 的 bundle 约束直接矛盾，禁止）。ASCII 示意：
      ```
      ┌─ Tenant SideNav (comfortable) ──┐   ┌─ Ops SideNav (compact) ─────┐
      │ ▎● 概览        (active: 品牌条) │   │ ▎▣ 租户总览  (active: 钢条) │
      │   ◔ 用量                        │   │   ▤ 发放与邀请               │
      │   ⚿ API Key                     │   │   ◔ 全局用量                 │
      │   ⋯ 成员                        │   │   ✓ 审计                     │
      └─────────────────────────────────┘   └──────────────────────────────┘
      ```
    - **分组**：Tenant 在 `member` 主项与 `tenant_admin` 管理项之间插一条 `text-kumo-subtle` 12px uppercase 分组小标题（「我的」/「团队管理」）；Ops 同理（「租户」/「平台」）。
- **结构前提（执行期发现，2026-05-17，lead 锁定 Option A）**：重塑后的 `SideNav`/页头摘要条要在 Tenant 的全部子路由（`/usage|/keys|/members|/alerts|/billing`）可见，前提是 Tenant 必须有一个**无路径 pathless layout**包裹这些子路由（对称于 Ops 已有的 `OpsLayout`/`opsLayoutRoute`）。现状缺陷：`createTenantPortalRoutes(rootRoute,{includeIndex:false})` 把这些子路由建成 `rootRoute` 的扁平兄弟、无 `TenantPortalShell` 包裹（shell 仅 `/` 经 `indexRoute`→`PortalIndex` 挂载）。故 Phase-3 计划新增一个先行结构任务（Task 0），照 `createOpsConsoleRoutes`/`opsLayoutRoute` 范式镜像出 `tenantLayoutRoute`（`id:"tenant-layout"`，`component` 渲染 `TenantPortalShell`+`<Outlet/>`），`/` 仍归 `indexRoute`、无 route-id 冲突。**这是本节重塑的实现前提，非新设计方向**（不分叉 Kumo、不动 Ops 钢色/忽略品牌、不重开任何 §E/锁定决策；`PortalIndex` 不变）。
- **DESIGN.md 新增**：`## Shell / SideNav` 小节，规定 active 强调条规则（2px、取壳强调色）、hover=`tint`、图标尺寸/色、分组标题排版、Tenant=comfortable / Ops=compact 的 chrome 差异表。

### §B.2 卡片/面板系统

- 保留 DESIGN.md 既有 `data-panel`（base + xl + ring-line + elevated header）与 `metric-card`/`metric-tile`，**不重定义**；重塑在其上加：
  - **强调头**：data-panel header 可选「强调态」——左侧 3px 竖条取壳强调色（Tenant=品牌 / Ops=钢色），用于标识「主面板/当前焦点面板」，其余面板保持中性。这是品牌色进入卡片头的受控入口（与 §C 对齐）。
  - **active/选中卡片**：可点卡片（如 tenant-overview 行卡、KPI 可下钻卡）hover=`bg-kumo-tint`（已有约定推广），选中/聚焦加 `ring-2` 壳强调色（非阴影，符合无阴影约束）。
  - 统一：所有面板用 `ring-1 ring-kumo-line`（当前部分屏 `border-kumo-default`，重塑归正为 `ring-kumo-line`，与 DESIGN.md 一致）。

### §B.3 强调/active/hover 状态语言（统一表，写入 DESIGN.md）

| 元素 | rest | hover | active/current | focus-visible |
|---|---|---|---|---|
| 导航项 | `text-kumo-default` | `bg-kumo-tint text-kumo-strong` | 2px 强调条 + `bg-kumo-tint` + `text-kumo-strong` + `aria-current` | `ring-2 ring-kumo-brand ring-offset-2` |
| 可点卡片/行 | `bg-kumo-base` | `bg-kumo-tint` | `ring-2` 壳强调色 | 同上 |
| 主面板头 | 中性 elevated | — | 3px 竖条壳强调色 | — |
| 主 CTA（Button primary） | Kumo 默认（`--kumo-brand`） | `--kumo-brand-hover` | — | Kumo 默认 |

强调色 = 壳级变量：Tenant = `--kumo-brand`（= 租户品牌色，§C）；Ops = 固定钢色（`ops-theme.ts`，不变）。

### §B.4 Motion 语言（subtle，reduced-motion-safe）

当前零动效。重塑引入**克制**的动效，仅高影响时刻，全部 reduced-motion 安全：

- **允许的动效（穷举，超出即违规）：**
  - 路由进入：主内容区 `opacity 0→1` + `translateY(4px→0)`，`150ms ease-out`。一次性，不循环。
  - 导航 active 强调条：宽度/位置 `transition` `120ms ease-out`（项间切换时强调条平滑移动）。
  - hover 态背景色：`transition-colors 100ms`。
  - 骨架→内容：交叉淡入 `120ms`（替代生硬替换）。
- **禁止**：视差、自动轮播、入场 stagger 链、装饰性 loop 动画、弹性/overshoot 缓动、任何 > 200ms 的过渡。
- **reduced-motion**：全部包裹在 `motion-safe:` 变体下，或等价 `@media (prefers-reduced-motion: reduce)` 关闭位移与淡入（保留即时状态变化）。`prefers-reduced-motion: reduce` 时动效降级为「无过渡、直接到终态」。
- **DESIGN.md 新增** `## Motion` 小节：上述允许清单 + 时长上限 200ms + 全程 motion-safe 约束 + 「无阴影同理：动效是点睛非氛围」原则。

### §B.5 两面语气差异（同源异质，最终成型）

| 维度 | Tenant Portal（对外、品牌化、平静） | Ops Console（对内、特权、运营驾驶舱） |
|---|---|---|
| 密度 | comfortable（`p-6`/`space-y-6`，编辑式留白） | compact（`p-4`/`space-y-4`，信息致密） |
| 强调色 | 租户品牌色（§C，受约束、可回落） | 固定钢色（`#475569`，不变，标识特权） |
| 可品牌面 | 扩展（导航强调条/卡片头/active，§C） | 全部忽略租户品牌（钢色恒定） |
| 页头 | 品牌身份摘要条（logo+名+预算 meter+告警点） | 运营态摘要 chip 组（租户数/告警数，钢色描边特权 pill） |
| 状态前置度 | 适度（概览以身份+预算为先） | 强（表格/状态点/告警优先，驾驶舱式） |
| Motion | 同一套（§B.4），无差异——动效语言全站统一，仅强调色随壳 |

---

## §C 扩展租户品牌模型

在 Phase-1 `branding.ts`（`applyBrandVars`/`isAccessibleBrand`，严格 `#rrggbb`，WCAG-AA 双模式）之上扩展可品牌面，**守卫模型不变、只扩展应用面**。

### §C.1 可品牌面（确切清单）

Tenant Portal 中以下 chrome 面取租户主色（全部经 §C.2 守卫，不达标整体回落 Kumo 默认）：

1. 主 CTA / Button primary（Phase-1 已有，`--kumo-brand`）。
2. 图表主描边（Phase-1 已有）。
3. **新增**：左导航 active 强调条（§B.1 的 2px 条）。
4. **新增**：主面板头强调竖条（§B.2 的 3px 条）。
5. **新增**：可点卡片/行 active 的 `ring-2` 强调环。
6. **新增**：品牌身份摘要条的预算 meter 进度色（仅进度填充，轨道仍中性）。

**不品牌化（保持 Kumo 中性，决策 1 边界）**：正文/标题/标签文本色、层级背景（canvas/base/elevated/recessed）、语义色（success/warning/danger/info）、hairline、焦点环底色逻辑（焦点环仍用 `--kumo-brand` 但其对比由 §C.2 保证）。

### §C.2 守卫规则（扩展 `branding.ts`，数学与契约不变）

- 仍**只接受严格 `#rrggbb`**（`HEX6_RE`），其余形态（3 位、命名色、`rgb()`、`var()`、`url()`、空白、注入载荷）→ 整体回落 `{}`（Kumo 默认）。注入安全契约不变。
- 仍**只emit 真实 Kumo 品牌 token**：`--kumo-brand` / `--kumo-brand-hover`。扩展的 5 个新面**全部消费 `--kumo-brand`（或其 `-hover`）**，**不新增任何自定义 CSS 变量、不emit 语义/层级/版式 token**——这样「扩展可品牌面」在实现上是「同一个 `--kumo-brand` 被更多 utility 引用」，而非新变量面，天然继承既有注入与对比度守卫。
- **WCAG-AA 守卫扩展（§E-3 已锁，2026-05-17）**：当前 `isAccessibleBrand` 校验品牌色对 **canvas**（亮 `#fafafa` / 暗 `#1a1a1a`）非文本对比 ≥ 3:1。新面里 active 强调条/卡片头竖条出现在 `bg-kumo-tint` / `bg-kumo-elevated` 之上，故守卫扩展为：品牌色须对 **canvas + elevated + tint 三个表面**（亮/暗各取其 Kumo 值，共 6 次校验）均达 ≥ 3:1；任一表面任一模式不达标 → **整体回落 Kumo 默认**（`{}`）。复用既有 `relativeLuminance`/`contrastRatio` 数学，**不引新依赖**。
- **接受的权衡（用户已确认）**：此扩展比 Phase-1 canvas-only 校验更严，部分原本通过 Phase-1 的租户色会因 elevated/tint 表面失败而整体回落（品牌面感弱于 Phase-1），但始终保持 WCAG-AA 可读。被明确否决的替代方案——分面部分降级（per-surface partial degradation）——契约复杂、难以单测，不采纳。**全有或全无** = 简单、可测、可断言。回落仍是 `{}`，契约与 Phase-1 完全一致。

### §C.3 Ops 不变量（重述，决策 2 末句）

Operations Console（`/ops`）**继续忽略所有租户品牌**：`ops-console/shell.tsx` 仍套 `OPS_STEEL_ACCENT`（`#475569`/`#334155`），§C 的 6 个可品牌面在 Ops 壳内**全部解析为钢色**（因为 Ops 壳注入的 `--kumo-brand` 即钢色）。无任何代码路径让租户色进入 `/ops`。这是 Phase-2 不变量，本期不动。**（§F.6：这两个钢色 hex 是经批准的唯一 raw-hex 豁免；Phase-3 将其提为具名 const + 豁免注释，值零变更，并加 no-other-raw-hex 守卫——见 §F.6。）**

---

## §D 横切与分期

### §D.1 不变量保持（全程回归守卫）

- **SSR + React 岛 / #418**：两壳两入口、角色服务端解析不变；§A.3 的 lazy 边界必须 SSR-safe（正确 fallback、hydration 不 mismatch），`hydration.test.tsx` / `router.test.tsx` 扩展覆盖。
- **双语**：所有新文案（分组标题、摘要条、四态、`ariaDescription` i18n 化）先入 `i18n/messages/{en,zh-CN}`，`i18n-completeness.test.ts`（两壳各有）守卫。
- **暗色 `data-mode`**：四态、active 态、品牌新面、焦点环全部在亮/暗双模式过对比；chart 暗色同步不回归。
- **Kumo 边界**：只用 Kumo 组件/原语 + token + utility 类；零 Kumo fork；零语义/层级/版式 token 覆盖。
- **Ops 钢色/忽略品牌**：不动。

### §D.2 排序（决策 3 编码）

```
§A.1 a11y 审计达标
        │  (independent, may parallel A.2)
§A.2 状态/密度 token 统一  ──┐
        │                     ├─ 三条全部达 §A 验收  ──►  §B 明显重塑  ──►  §C 扩展品牌面叠加
§A.3 bundle 拆分           ──┘                                 (§C 依赖 §B.1/§B.2 的新面存在)
```

§A 三条彼此独立可并行实现，但 §B 不得在 §A 全部达验收前开工；§C 的新可品牌面依赖 §B.1/§B.2 的强调条/卡片头先存在（§C 是给这些新面接上品牌色 + 扩展守卫）。

### §D.3 计划分解（高层工作流清单，**非计划本身**——计划在用户批准本 spec 后才产出）

1. **WS-1 a11y 审计与达标**（§A.1）：键盘/焦点/`aria-current`/`ariaDescription` i18n 化/对比度；扩展 shell 测试。
2. **WS-2 状态与密度统一**（§A.2）：4 个 Panel* 封装 + 密度 context；屏迁移；DESIGN.md State/Density 小节；stories 四态画廊。
3. **WS-3 bundle 拆分**（§A.3）：chart island lazy + 两壳分包；bundle 前后实测；hydration 守卫。
4. **WS-4 chrome/导航重塑**（§B.1）：共用 `SideNav` + 页头摘要条 + 分组 + active 强调条；DESIGN.md Shell/SideNav 小节。
5. **WS-5 卡片/状态/motion 语言**（§B.2–§B.4）：强调头/选中卡片/状态表/Motion 小节 + reduced-motion。
6. **WS-6 扩展品牌面**（§C）：`branding.ts` elevated/tint 对比度扩展 + 6 面接 `--kumo-brand`；Ops 忽略不变量测试。
7. **WS-7 DESIGN.md 整合 + 回归**（横切）：DESIGN.md 新增小节合并、双语补全、暗色/双语/#418 全回归、stories/快照更新。

WS-1/2/3 属 §A（先做、低风险、可独立交付）；WS-4/5/6 属 §B/§C（后做）；WS-7 收口。每条 WS 在 plan 阶段再细化任务与测试矩阵。

---

## §E 已解决决策（用户 spec-review，2026-05-17）

以下三条在用户 spec-review 时拍板，已分别回写进 §A.3 / §B.1 / §C.2，此处作为完整记录存档。

1. **RESOLVED — §E-1 → §A.3（bundle 阈值）**：ECharts chart island **必须**懒加载且不在初始 portal app chunk 内 = **CI 可验证的 HARD GATE**。初始 bundle gzip 体积下降量为**观测指标，不设 KB 阈值门槛**（不成为 CI 门槛）。具体数字由 plan 阶段 `analyze:litellm-portal-bundle` 实测后记录进 DESIGN.md，仅供参考。
2. **RESOLVED — §E-2 → §B.1（导航图标来源）**：**主策略**：使用 `@cloudflare/kumo` 内置图标集。**备选（仅当 Kumo 经 plan/impl 阶段确认不提供所需 nav icon 时）**：零依赖内联 SVG。绝不引入新 icon 依赖（违反 §A.3 bundle 约束）。
3. **RESOLVED — §E-3 → §C.2（品牌色对比度守卫扩展与回落）**：接受 **canvas + elevated + tint 三表面 × 亮/暗双模式（6 次校验）全部 ≥ 3:1** 的扩展守卫，任一失败整体回落 Kumo 默认（全有或全无）。接受部分 Phase-1 通过色在此守卫下回落（品牌感弱于 Phase-1 但始终 WCAG-AA）。per-surface 部分降级方案被明确否决（契约复杂、难测）。

---

## §F V2.0 双维评审标准折入（用户 2026-05-17「全部折入」，6 项全锁）

依据 `.omc/wiki/ui-ux-v2-0.md`（V2.0 标准）与 `.omc/wiki/litellm-portal-phase-3-v2-0.md`（审计与全折入决策）。litellm-portal 是 **B 端 ops 工具**，却整套套用 Kumo「平静大留白」C 端心智——该缺口 + 5 项其余债务是本次折入对象。**这 6 项不是新设计方向，而是把既有 §A/§B/§C 的验收提到 V2.0 工业落地标准**；卫生优先排序与 §A GATE 不变。

### §F.1 → 扩展 §B.5 / §A.2：B 端运营驾驶舱密度纵深（V2.0 §1.2，最高价值发现）

Ops Console（`/ops`：tenant-overview 全租户表、audit 审计表、billing）必须达**真 B 端专家密度**，非「略收紧的间距刻度」：

- **紧凑表格变体**：Ops 的 `Table`（tenant-overview/audit/tenant-detail/user-detail 行）采用 compact 行高与 padding——具体数：行高 ≤ 36px、单元格 `px-3 py-1.5`（对比 Tenant comfortable 的 `px-4 py-3`）；表头 sticky；`tabular-nums` 数字列右对齐。沿用 §A.2 既有 spacing token（不新增数值），compact 在表格语境下落到 `py-1.5`/`px-3` 这一档。
- **密度切换**：壳级 `comfortable↔compact` 可切，**复用 Task 2/§A.2 的 density context**，用户选择持久化（走既有 `usePreferences`/preferences 持久化通道，新增 `density?: "comfortable" | "compact"` 偏好；缺省 = 壳默认：Tenant comfortable / Ops compact）。切换即时（无整页刷新），SSR/#418 安全（偏好走 hydrated 通道，服务端客户端首帧一致）。
- **键盘流**：Ops 表格行可 `Tab`/方向键不可用时至少行内主链接 `Tab` 顺序符合视觉顺序（§A.1 已覆盖键盘可达）；额外要求 Ops 列表屏 `/` 或既有 command-palette 可达（已存，纳入回归不丢）。**不**新建复杂 roving-tabindex 框架（承认前端脆弱性，组合优于过度抽象——V2.0 §4#4）。
- **一屏看全/拒绝滚动**：Ops 全租户总览在 1280px 视口下，首屏（无纵向滚动）应可见租户列表前 N 行 + 摘要 chip 组；以 compact 密度 + sticky 表头实现，非强制（「where feasible」——数据多时表格自身滚动，外层壳不滚动）。
- **Tenant Portal 不变**：保持 calm/comfortable（对外品牌化）。这是「同源异质」在密度维度的**第二层**深化（第一层 = §A.2 的 p-6/p-4 壳级差异；本项 = 表格语境 compact + 可切换 + 持久化）。
- **验收**：Ops 表格行高/padding 数值达上述；密度切换持久化且切回刷新保持；切换 SSR/#418 不回归（`hydration.test.tsx` 覆盖含密度偏好的两壳首帧一致）；Tenant 屏密度不被 Ops 切换影响。**编码位置**：§B.5 表格密度列 + §A.2 density context 扩展（持久化 + compact 表格档）。

### §F.2 → 扩展 §A.3 / §D：性能预算硬门禁（V2.0 §2.1）

ECharts-lazy 是体积代理，不是 Web-Vitals 预算。新增：

- **CLS < 0.1 = HARD GATE**（CI 可验证，与 §A.3 ECharts gate 同band）。机制：Playwright（仓库已有 `@playwright/test` + `playwright.config.ts` + `test:e2e`）E2E 用例在 `/`、`/usage`、`/ops` 加载后用 `PerformanceObserver({type:"layout-shift"})` 累计 CLS，断言 `< 0.1`；失败 `process.exit≠0`（CI 红）。**无 KB 阈值类比**——CLS 是确定可断言的数，作硬门禁。
- **INP < 100ms / LCP < 1.2s = 观测断言**（非硬门禁，与 §A.3 「观测指标」同性质）：同一 Playwright run 采集 LCP（`PerformanceObserver type:"largest-contentful-paint"`）与一次代表性交互的 INP 近似（`event`/`first-input`），数值记入 DESIGN.md 观测记录；偏离记 follow-up，不阻断（B 端工具优先功能正确性，性能持续观测）。
- **不引 Lighthouse 新依赖**（与「不引新依赖」一致）：复用既有 Playwright。若 Playwright 无法稳定取某指标 → 该指标降为人工 staging 检查项（记录于 E2E checklist），CLS 硬门禁不可降级。
- **验收**：三路径 CLS < 0.1 的 Playwright 断言进 CI；LCP/INP 观测值入 DESIGN.md；骨架屏几何高度匹配（§A.2 `PanelSkeleton` 固定高度，减少 reflow——本项强化其 CLS 价值）。**编码位置**：§A.3 验收新增 Web-Vitals 段 + §D E2E 项。

### §F.3 → 新增「错误 UX 契约」（V2.0 §2.4 + §4#6 抽象泄漏，**安全/契约敏感**）

服务端错误码（`impersonation_required` / `index_do_unavailable` / `billing_archive_not_found` / `confirm_email_mismatch` ... ~40 个，`routes.ts`）当前**裸泄露**进 Banner，违反 V2.0「错误提示禁暴露技术栈、人类可读三要素」。同时这是 §4#6 抽象泄漏（用户被迫理解后端实现模型）的根。

- **错误 UX 契约（单一真相源）**：建立本地化 `errorMessage(code, locale)` 映射，每条 = **三要素**：(1) 发生了什么（人话，非 code）、(2) 你的输入已保留（适用时明示未丢失）、(3) 清晰的下一步恢复动作。zh/en 双语。
- **唯一边界**：映射应用在 `tenant-portal/hooks.ts` + `ops-console/hooks.ts` **共享的 `extractError` 边界**（两文件各有一份 `extractError`，本项将其统一/共用一个实现，所有 `throw new Error(...)` 与 `PanelError`/`Banner` 渲染经此层把 code 翻成三要素文案；未知 code → 通用安全兜底「操作未完成，请重试或联系管理员」，**绝不**回落显示原始 code）。
- **安全契约**：错误文案**不得**泄露内部实现细节（DO 名、内部路径、栈）；`impersonation_required` 类权限码翻成「需以租户身份操作才能执行此写操作 → 请从运营台『进入租户』后重试」式恢复指引，不泄露鉴权内部。注入安全不变（错误文案是静态本地化字符串，不回显用户输入原文到 HTML 之外的 Banner 文本里——遵循既有 Kumo Banner 文本渲染，不 `dangerouslySetInnerHTML`）。
- **验收**：每个已知服务端 code（枚举自 `routes.ts`）→ 断言映射出非-code 的人类三要素文案 + 有恢复指引；未知 code → 通用兜底（断言不含原始 code 字面量）；zh/en 各一份，`i18n-completeness` 覆盖；no-tech-leak 断言（文案不含 `_`-snake-case code、不含 `DO`/`undefined`/HTTP 数字码）。**本项标记为保留安全/设计评审 pass**（与 §C 同级敏感）。**编码位置**：新增「§F.3 错误 UX 契约」为 spec 子节（本段即是）；plan 新增独立 task。

### §F.4 → 扩展 §A.3 / §2.4：分块 ErrorBoundary（与 round-3 critic MAJOR-1 合流，**叠加非重复**）

MAJOR-1 的 `client.tsx` `try { await warmUsageCharts() } catch {}` 是**白屏地板**（chunk-fetch 失败不阻断 hydrate）——**保留不动**。本项在其**之上叠加**真正的 React ErrorBoundary：

- **分层契约**：(1) `try/catch warmUsageCharts` = chunk **加载**失败地板（保留，§A.3/MAJOR-1）；(2) ErrorBoundary = chart/审计/dashboard 核心块的**渲染/运行时**异常隔离——块内 throw 时降级为内联错误面板（复用 §F.3 错误文案 + §A.2 `PanelError` 风格），页面其余部分完好，非区块崩或白屏。二者正交：前者管「拿不到代码」，后者管「代码跑炸」。
- **范围**：包住 lazy chart island（`usage-charts-lazy` 边界外再套 ErrorBoundary）、audit 核心块、dashboard 核心块（V2.0 §2.4「关键业务区块独立 Error Boundary」）。不全站包一个上帝 boundary（V2.0 §4#8）。
- **验收**：chart 块内人为 throw → ErrorBoundary fallback 渲染、页面其余区块仍可交互；fallback 文案走 §F.3 契约（人类三要素 + 重试/恢复）；不与 MAJOR-1 try/catch 重复或互相吞掉（明确分层注释）；不回归 §E-1 #418 loading-parity（ErrorBoundary 在正常 loading 路径透明，不改变 SSR/hydrate 首帧）。**编码位置**：§A.3 / §F.4（本段）；plan 新增 additive task。

### §F.5 → 扩展 §A.1 / §B + §D：type-scale 审计 + 5s/模糊验收（V2.0 §1.1）

- **type-scale 审计**：V2.0 要求 token 化字号 **≤7 层**、标题为正文 **1.5~2 倍**。**审计真实源**（`DESIGN.md` Typography Hierarchy + Kumo `Text` variant 实际值）：当前 DESIGN.md 列 **8 个 tier**（Page title 30→36 / Section title 18 / Metric value 28 / Metric label 12 / Body 14→16 / Caption 13 / Table header 12 / Mono data 14→18）——**超 7 层**；标题/正文比 desktop 36/16 = 2.25×、mobile 30/14 = 2.14×——**略超 2× 上限**。本项要求 plan 阶段：(a) 以真实 token 源核实层数与比例并文档化真实数；(b) 收敛到 ≤7 tier（合并语义等价档，如 Metric label 与 Table header 同为 12px/600/uppercase——并为一档；Caption 13px 与 Body 14px 评估合并）且标题:正文 ≤ 2×（Page title 收到 ≤ 2× body，如 desktop 32px/16px = 2.0× 或文档化为可接受例外并说明理由）——**严格在 Kumo 内、不覆盖版式 token 的前提下**通过「使用更少的 Text variant 档位 + DESIGN.md 收敛表」达成，不改 Kumo 本身。若某档无法合并，**文档化真实比例 + 明确豁免理由**（不静默放过）。
- **5 秒测试 + 模糊测试**（V2.0 §1.1 验证法，人判项）：纳入 §A / E2E 人工验收 checklist——程序：截屏（亮/暗各一，Tenant `/` + Ops `/ops`）→ 移除 5s → reviewer 须能复述核心 CTA + 主标题（pass bar：两者皆能，否则视觉层次不达标）；高斯模糊截屏 → 视觉质心/能量应落在主信息区（KPI/主面板），非装饰/导航（pass bar：质心在内容区）。
- **验收**：type-scale 层数 ≤7 且断言（测试读真实 DESIGN.md/token 源断言 tier 数与标题:正文比，或文档化豁免）；5s/模糊为 staging 人工项含明确 pass bar。**编码位置**：§A.1 子步（type-scale 审计）+ §D/E2E checklist（5s/模糊）。

### §F.6 → 扩展 §C.3 / §1.3：ops-theme 硬编码 hex → 具名豁免 token（V2.0 §1.3）

`ops-console/ops-theme.ts` 硬编码 `{"--kumo-brand":"#475569","--kumo-brand-hover":"#334155"}`。V2.0 §1.3 禁硬编码颜色（全量走 token）。但 Ops 固定钢色是 **Phase-2 不变量**（Ops 忽略租户品牌、固定中性钢——§C.3）——这是**唯一被批准的 hardcode 例外**（固定钢色品牌电压覆盖）。

- **要求**：把两个 hex 提为**具名 const**（如 `OPS_STEEL_BRAND` / `OPS_STEEL_BRAND_HOVER`）并加 doc 注释明确标注「这是经批准的唯一 raw-hex 豁免：Ops 固定钢色品牌电压，Ops 忽略租户品牌的 Phase-2 不变量；不得新增任何其它 raw hex」。`OPS_STEEL_ACCENT` 继续由这两个具名 const 组装（行为零变更）。同时在 DESIGN.md token 表记一行「Ops fixed steel（sanctioned exception）」。
- **守卫**：新增/扩展一个测试或 grep 守卫断言 restyle 后**除 `ops-theme.ts` 这两个具名 const 外，源码无其它 raw `#rrggbb` 字面量**（branding.ts 的 canvas/elevated/tint surface 常量是 WCAG 数学输入、已有注释——纳入 allowlist；测试夹具/快照排除）。
- **验收**：`ops-theme.ts` 为具名 const + 豁免注释；DESIGN.md 记该例外；no-other-raw-hex 守卫通过。**编码位置**：§C.3 末补一句「钢色具名豁免」+ §F.6（本段）；plan 新增小 task。

### §F 排序与不变量

- **卫生优先不变**：§F.5 type-scale → 并入 §A.1；§F.2 perf-budget → §A.3 gate band；§F.1 密度纵深 → §A.2 扩展 + §B 重塑带；§F.3 错误契约 + §F.4 ErrorBoundary + §F.6 ops-theme token → 归各自 §A/§B task。**§A GATE 不变**（§B 不得在 §A 验收前开工；perf-budget CLS 门禁入 §A band）。
- **不重开锁定决策**：不分叉 Kumo、不覆盖语义/版式 token、Ops 固定钢色/忽略品牌（§F.6 是把既有 hardcode 具名化而非改值）、ECharts-lazy-no-KB、内联-SVG-only、双模式 all-or-nothing 对比——全不动。§F.4 仅在 MAJOR-1 try/catch **之上叠加**，不弱化/不重复已闭合的 #418 §A.3 工作流（§E-1 loading-parity 测试、`not.toContain` §A-gate pin、warm-up、OQ-(b) 推理一律不动）。

---

## 非目标（Out of scope）

- 不新增屏、不改 IA、不动后端、不改路由鉴权模型（沿用 Phase 0–2）。
- 不分叉 Kumo、不覆盖语义/层级/版式 token、不引入 `shadow-*`。
- 不动 Ops 固定钢色 / 忽略租户品牌不变量。
- 不出像素稿（本文档为文字设计 spec）。
- 不引入新 icon 依赖（主策略用 Kumo 内置图标集；备选内联 SVG；永不添加新 icon 包，见 §E）。
- 本文档不产出实施计划——计划在用户批准本 spec 后另起 writing-plans（spec 已批准，由 lead 触发）。

---

## Self-Review

- **占位符扫描**：无 TBD / 待定 / 「适当打磨」类模糊措辞。§A 三条均有逐项验收且已固化（§A.3 的 HARD GATE 为「ECharts 不在初始 chunk」，KB 阈值明确为观测指标而非门槛——已锁，不再是 OPEN）。§B 表达为 token/utility 决策 + DESIGN.md 新增小节。§C 守卫规则完整（6 次校验、全有或全无、已锁）。§E 三条全部 RESOLVED，无残留 OPEN 项。
- **内部一致性**：决策 1/2/3 → §B/§C/§(A→D) 一一编码。§A.3 验收更新为 HARD GATE 语言，与 §E-1 resolution 一致。§B.1 图标指令更新为「Kumo 内置优先 / 内联 SVG 备选 / 禁止新依赖」，与 §E-2 resolution 及非目标一致（非目标已同步修正，旧「倾向内联 SVG」措辞已清除）。§C.2 守卫扩展为 canvas + elevated + tint 三表面 × 双模式，与 §E-3 resolution 一致；接受的权衡与被否决的替代方案均已明文记录。不变清单（§B.0）与决策 1 边界一致。§C「只 emit `--kumo-brand`」与 Phase-1 `branding.ts` 注入契约一致。Ops 钢色/忽略品牌在 §B.5/§C.3 重述且与 Phase-2 一致。排序 §D.2 严格编码决策 3 的 A→B→C→D。
- **范围 = 一个可计划周期**：7 条 WS，无新屏/无后端/无 IA 变更，全部建立在已上线 Phase 1/2 文件（`tenant-portal/{shell,branding,routes}.tsx`、`ops-console/{shell,ops-theme}.ts`、各 `screens/*`、`DESIGN.md`、`router.tsx`、i18n、stories、既有测试）之上，扩展不替换 —— 一个 Phase-3 spec→plan→impl 周期可容纳。
- **越界检查**：未写代码、未跑构建/测试、未提交、未改源码；仅修订本一个 spec md；未触发 writing-plans 或任何实现技能。
- **§F V2.0 折入诚实自检（2026-05-17 amendment）**：6 项均以「提既有 §A/§B/§C 验收到 V2.0 工业标准」方式编码，非新设计方向，卫生优先 + §A GATE 不变。逐项落点已显式标注（§F.1→§B.5/§A.2、§F.2→§A.3/§D、§F.3→新增错误 UX 契约子节、§F.4→§A.3 叠加 MAJOR-1、§F.5→§A.1/§D、§F.6→§C.3/§1.3）。**未声称未编码的覆盖**：§F.5 明确承认当前 type-scale = 8 tier 超 7、标题:正文 2.14~2.25× 超 2×（真实 DESIGN.md 数已核），收敛方案给出但具体合并由 plan 阶段读真实 token 源定案（不静默放过、不假装已收敛）；§F.2 CLS 为硬门禁、INP/LCP 诚实降为观测（非假装全门禁）；§F.4 明确与 MAJOR-1 分层正交（不假装替代）；§F.6 是具名化既有 hardcode（不假装消除——它是被批准的唯一例外）。§F.3 标记保留安全/设计评审 pass。#418 §A.3 已闭合工作流未被 §F 触碰（仅 §F.4 在 try/catch 之上叠加 ErrorBoundary）。
- **不重开锁定**：§E-1/§E-2/§E-3 及决策 1/2/3、Ops 固定钢色/忽略品牌、Kumo-no-fork、版式 token 不覆盖——§F 全部尊重；§F.6 改的是「hardcode 如何命名」非「钢色是否存在」。
