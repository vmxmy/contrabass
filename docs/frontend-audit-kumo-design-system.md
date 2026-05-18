# 前端双维评审报告 — Kumo Design System 深度审计

**评审对象**：`src/litellm-portal/` 全局前端代码（组件、布局、卡片、响应式）
**模式判定**：评审模式（依据：用户明确要求对已有代码做设计系统级走查）
**总体结论**：⚠️ 修复 🔴🟠 后可上线
**业务场景与心智**：B 端后台管理（Ops Console + Tenant Portal + Admin Manage）—— 核心心智是「一屏看全、快速操作、信息密度高」

> 评审前提：本项目使用 Cloudflare Kumo 设计系统。Kumo 是一套成熟的 B 端组件库，提供了 LayerCard、Surface、Panel、Table、SideNav 等组件，以及完整的 `kumo-*` Design Token。本次审计的核心发现是：**项目没有充分发挥 Kumo 的价值，大量使用了低级的 HTML 标签 + 手写的 Tailwind 类，导致视觉语言混乱、维护成本高、响应式缺失。**

---

## 一、认知体验维度

### 问题清单

| # | 严重度 | 位置 | 违反标准 | 现象 | 修复建议 |
|---|---|---|---|---|---|
| 1 | 🔴 Blocker | 全局 | 卡片系统混乱 | **存在 4 种互斥的卡片实现**：① `LayerCard`（overview tiles）② `article` + `ring-1 ring-kumo-line`（ops/tenant screens）③ `div` + `border border-kumo-line`（dashboard Panel/kpi-band）④ `Surface`（app.tsx, create-key-button）。圆角、边框、padding、header 样式全部不统一。用户无法建立「卡片」的空间记忆。 | 收敛到 **1 种**卡片组件。Kumo 提供了 `LayerCard` 和 `Surface`，应基于它们封装一个 `AppCard`（统一圆角 `rounded-xl`、统一边框 `ring-1`、统一 header 结构），所有 screen 强制使用。 |
| 2 | 🔴 Blocker | 全局 | 布局系统分裂 | **三个 Surface 的 chrome 完全不统一**：① PortalRootLayout（`routes/__root.tsx`）用 `container mx-auto px-4 py-10 lg:px-10 lg:py-16` + 大标题描述 ② TenantPortalShell 自建 header + SideNav ③ OpsConsoleShell 用 `px-6 py-8` + 紧凑 header + SummaryChips。同一用户在不同页面切换时，header 高度、内边距、背景色全部突变。 | 提取一个共享的 `PageShell` 布局组件，统一：① 顶部 header 区域高度 ② 内容区 padding ③ 背景色（`bg-kumo-canvas`）。三个 surface（tenant/ops/manage）都基于此扩展，只注入差异内容。 |
| 3 | 🟠 Critical | `routes/__root.tsx:188` | 信息密度弹性 | B 端后台使用了 **C 端大留白**布局：`container mx-auto px-4 py-10 lg:px-10 lg:py-16`（最大宽度 1280px 居中 + 巨大垂直内边距）。后台管理员需要「一屏看全」仪表盘，居中窄容器迫使用户频繁滚动，降低效率。 | B 端后台应使用 **全宽布局**（`w-full` 或 `max-w-none`），内容贴边或仅保留最小呼吸边距（`px-4` / `px-6`）。参考 Kumo 的 Dashboard 布局模式。 |
| 4 | 🟠 Critical | 全局 | 响应式设计缺位 | 整个项目只有 **26 处** `sm:/md:/lg:/xl:` 断点使用。对于一个有 SideNav + Table + Chart 的 B 端应用，这个数量极低。SideNav 固定 `w-56`（224px）没有 collapse；表格没有横向滚动容器；图表没有移动端适配。 | ① SideNav 在 `< md` 断点下应自动折叠为 icon-only 或汉堡菜单 ② 所有 Table 应包裹在 `overflow-x-auto` 容器中 ③ 图表容器应设置最小宽度并在窄屏下允许横向滚动。 |
| 5 | 🟠 Critical | `dashboard/components/panel.tsx` | 组件 API 一致性 | `Panel` 组件过于简陋：只接受 `title: string` + `children`，没有 icon、action button、subtitle、loading/error 状态扩展点。导致每个 screen 都在卡片外部手写 header（`border-b bg-kumo-elevated p-6`），重复 20+ 次。 | 扩展 `Panel` 组件 API：`icon?: ReactNode`、`action?: ReactNode`、`subtitle?: string`、`loading?: boolean`、`error?: Error`。所有卡片统一走此组件，消灭手写 header 模式。 |
| 6 | 🟠 Critical | `ops-console/shell.tsx:84` | 布局与 Shell 不一致 | OpsConsoleShell 的 `OpsSummaryChips` 使用了 **自定义的 badge 样式**（`rounded-full bg-kumo-canvas px-2 py-0.5`），而不是 Kumo 的 `Badge` 组件。颜色、圆角、字号与系统中其他 Badge 不统一。 | 统一使用 Kumo `Badge` 组件，通过 `variant` 和 `className` 定制。 |
| 7 | 🟡 Major | 全局 | 圆角不一致 | `rounded-xl`（大部分屏幕）、`rounded-lg`（Surface in app.tsx）、`rounded-md`（stories）。同一个设计系统中出现 3 种卡片圆角。 | 统一为 `rounded-xl`（Kumo LayerCard 的默认圆角），stories 中的 `rounded-md` 也应升级。 |
| 8 | 🟡 Major | 全局 | Padding 不一致 | 卡片 body padding：`p-5`（dashboard Panel, kpi-band）、`p-6`（ops/tenant screens）。差距虽然只有 4px，但在高密度页面中会累积成视觉节奏断裂。 | 统一为 `p-6`（24px），与 Kumo LayerCard 的默认 padding 对齐。 |
| 9 | 🟡 Major | `tenant-portal/screens/overview.tsx` | 间距系统混乱 | Overview 页面使用了 `space-y-8`（32px）作为 section 间距，同时卡片内部又有 `space-y-4`、`space-y-5`、`gap-4` 等多种间距。没有清晰的「section / group / item」三级间距规范。 | 建立三级间距规范：Section 间距 `gap-8`（32px）、Group 间距 `gap-4`（16px）、Item 间距 `gap-2`（8px）。所有 screen 按此规范执行。 |
| 10 | 🟡 Major | `routes/__root.tsx:192` | 字号系统越级 | `text-3xl lg:text-4xl` 用于平台名称。B 端后台不需要如此大的标题，且没有使用 Kumo 的 `Text variant="heading*"` 组件，而是手写 Tailwind 类。 | 统一使用 Kumo `Text` 组件的 `variant` 系统（`heading1`~`heading4`），不手写 `text-*` 类。 |
| 11 | 🟡 Major | `ops-console/screens/tenant-overview.tsx:67` | 视觉层次破坏 | 该卡片 header 使用了 **独特的左边框品牌色**（`border-l-2 border-l-kumo-brand`），这是整个项目中唯一一处。打破了「所有卡片 header 长得一样」的空间稳定性。 | 移除特殊的左边框，统一为标准的 `border-b` header 样式。如果必须强调，使用 header 内的 icon 或 badge，而非边框变化。 |
| 12 | 🟢 Minor | `dashboard/components/panel.tsx:27-35` | 组件 API 正交性 | `WindowSelector` 是手写的一组 button，不是 Kumo 组件。虽然功能正确，但没有 disabled 状态、没有 loading 状态、没有 keyboard navigation。 | 如果 Kumo 提供 SegmentedControl / ToggleGroup 组件，优先使用；否则封装一个共享的 `WindowSelector` 组件并补齐 a11y。 |
| 13 | 🟢 Minor | `tenant-portal/tenant-portal.stories.tsx:216` | Design Token 覆盖率 | 硬编码颜色 `primaryColor: "#1d4ed8"` 在 stories 中。虽然不直接影响生产代码，但说明团队对 Token 的理解不一致。 | stories 中也应走 Kumo token 或设计系统变量。 |

---

## 二、工程架构维度

### 问题清单

| # | 严重度 | 位置 | 命中反模式 | 现象 | 修复建议 |
|---|---|---|---|---|---|
| 1 | 🟠 Critical | 全局 | **反模式 8：上帝组件**（God Component） | `tenant-portal/screens/overview.tsx` 包含 387 行、15+ 个独立 tile 组件。`ops-console/screens/*.tsx` 多个屏幕混合了数据获取、业务权限、复杂条件渲染。虽然之前拆分了 `app.tsx`，但 screen 级别的 God Component 仍然大量存在。 | 每个 screen 拆分为：① `ScreenContainer`（数据获取 + Error Boundary）② `ScreenLayout`（布局编排）③ `*Tile` / `*Panel` / `*Table`（纯展现组件）。单文件不超过 150 行。 |
| 2 | 🟠 Critical | 全局 | **反模式 4：过度抽象与过早泛化** + **反模式 2：DTO 透传** | 卡片 header 模式在 **20+ 个文件**中重复手写（`border-b border-kumo-line bg-kumo-elevated p-6`）。这是典型的「该抽象时不抽象」——模式已经稳定（覆盖率 > 80%），却没有提取共享组件。 | 提取 `CardHeader`、`CardBody`、`CardFooter` 三个哑组件，或扩展 `Panel` 组件。一旦提取，所有 screen 强制迁移，禁止手写。 |
| 3 | 🟠 Critical | 全局 | **反模式 3：UI 驱动的状态结构** | `DensityProvider` 的 `density` 状态（`comfortable` / `compact`）是 UI 排版字段，但存储在全局偏好中。如果未来改版，这个状态会与新 UI 冲突。 | 密度应作为**纯展示层的计算属性**，不持久化到用户偏好。或至少将密度与「布局系统版本」绑定，避免历史 density 值与新布局不兼容。 |
| 4 | 🟡 Major | 全局 | **反模式 6：抽象泄漏** | 多个 screen 需要手写 `isLoading ? <PanelSkeleton /> : ...` 分支。用户被迫理解「数据还在加载」这个技术概念。 | 使用 Kumo 的 `Skeleton` 包装模式，或封装 `DataPanel` 组件，自动处理 loading / empty / error / success 四种状态，screen 只提供数据。 |
| 5 | 🟡 Major | `app.tsx:344` | **反模式 1：CRUD 镜像** | `app.tsx` 的渲染逻辑按「数据库实体」（keys、models、teams）组织卡片，而非按「用户任务」（创建 key、查看预算、管理权限）组织。 | 改为任务导向的卡片分组：「我的 API Keys」（创建 + 列表）、「预算与消费」（Meter + 告警）、「团队设置」（成员 + 权限）。 |
| 6 | 🟡 Major | `ops-console/shell.tsx` | **反模式 5：穿越镜子的紧耦合** | OpsConsoleShell 直接判断 `identity.role === "admin" || identity.role === "admin_viewer"`，与后端权限模型硬耦合。后端新增一个 owner 角色，前端会错误地拒绝访问。 | 前端只判断一个布尔值 `canAccessOpsConsole`，由后端在 `/api/me` 中返回。前端不硬编码角色名。 |
| 7 | 🟡 Major | 全局 | 组件组合模式缺失 | `LayerCard`、`Surface`、`article` 三种卡片容器并行存在，但没有统一的组合规范。有的卡片有 header，有的没有；有的用 `ring`，有的用 `border`。 | 定义一张「卡片类型决策表」：什么时候用 `LayerCard`、什么时候用 `Surface`、什么时候用 `Panel`。禁止第四种实现。 |
| 8 | 🟢 Minor | `routes/__root.tsx:165-167` | 条件分支暴露实现细节 | `isOpsSurface = pathname === "/ops" || pathname.startsWith("/ops/")` 这种路径判断应该在路由配置中完成，而不是在 layout 组件中硬编码。 | 使用 TanStack Router 的 `beforeLoad` 或路由 meta 字段来标识 surface 类型，layout 只读取 meta。 |

---

## 三、亮点

1. **SideNav 组件设计优秀**（`components/side-nav.tsx`）：API 清晰（`groups`、`currentPath`、`accent`、`ariaLabel`），视觉统一（active bar + hover state + focus ring），且被三个 shell 共享。这是 Kumo 价值发挥最好的地方。
2. **Design Token 覆盖率较高**：除 echarts 配置和 stories 中的少量硬编码外，大部分颜色、间距、背景都走了 `kumo-*` token。说明团队有 Token 意识，只是卡片级别的组合缺乏规范。
3. **#418 SSR 安全防线完善**：`SsrSafeSkeleton` + `useHasHydrated` + `suppressHydrationWarning` 三层防御，且 `renderToReadableStream` 用于 SSR。骨架屏的几何形状是确定的，减少了 CLS 风险。

---

## 四、四问速筛结论

1. **看代码（ViewModel 隔离）**：🟠 命中反模式 2（DTO 透传）和反模式 8（God Component）。screen 级别组件直接消费 API 数据，未经过 ViewModel 映射；部分 screen 文件超过 300 行。
2. **看交互（响应阈值/骨架屏/乐观更新/Error Boundary）**：🟡 骨架屏使用正确（SsrSafeSkeleton），但 Error Boundary 只在 `BlockErrorBoundary` 一处看到，screen 级别的独立边界不足。
3. **看设计（信息密度弹性）**：🟠 命中。B 端后台错误使用了 C 端大留白（`container mx-auto py-10 lg:py-16`），信息密度远低于 B 端专家用户的期望。
4. **看 AI（Fallback 降级与 CLS 防御）**：✅ 不涉及。本项目没有生成式 UI 组件，传统表单和图表为主。

---

## 五、修复优先级

### P0（🔴 Blocker — 本次迭代必须修复）

1. **统一卡片系统**：提取 `AppCard` 组件（基于 `LayerCard` 或 `Surface`），统一圆角、边框、padding、header 样式。强制所有 screen 迁移，消灭手写 `article` + `ring-1` 模式。
2. **统一布局系统**：提取 `PageShell` 组件，统一 header 高度、内容区 padding、背景色。三个 surface（tenant/ops/manage）都基于此扩展。

### P1（🟠 Critical — 强烈建议本次修复）

3. **B 端全宽布局**：将 `container mx-auto` 改为全宽或最小宽度限制（`max-w-none` 或 `max-w-[1600px]`），减少垂直留白，提升信息密度。
4. **扩展 Panel 组件 API**：补齐 icon、action、subtitle、loading、error 扩展点，消灭 20+ 处手写 header。
5. **响应式基础**：SideNav 在移动端折叠、Table 添加横向滚动、图表容器设置最小宽度。
6. **Screen 级别 God Component 拆分**：每个 screen 拆分为 Container + Layout + Tile/Panel/Table 三层。

### P2（🟡 Major — 下个迭代修复）

7. 统一圆角为 `rounded-xl`，统一 padding 为 `p-6`。
8. 建立三级间距规范（Section / Group / Item）。
9. 统一使用 Kumo `Text` 组件，不手写 `text-*` 类。
10. 移除 `ops-tenant-overview.tsx` 的特殊左边框。
11. 封装 `DataPanel` 自动处理 loading/empty/error/success 四种状态。
12. OpsConsoleShell 权限判断改为后端返回的布尔值。

### P3（🟢 Minor — 有空时优化）

13. `WindowSelector` 补齐 a11y（keyboard navigation、disabled 状态）。
14. stories 中的硬编码颜色改为 Token。
15. `routes/__root.tsx` 的 surface 判断迁移到路由 meta。

---

## 附录：卡片系统现状对比表

| 位置 | 容器 | 圆角 | 边框 | 背景 | Header | Body Padding |
|---|---|---|---|---|---|---|
| `dashboard/components/panel.tsx` | `div` | `rounded-xl` | `border` | `bg-kumo-base` | `border-b px-5 py-3` | `p-5` |
| `dashboard/panels/kpi-band.tsx` | `div` | `rounded-xl` | `border` | `bg-kumo-base` | 无 | `p-5` |
| `ops-console/screens/*.tsx` | `article` | `rounded-xl` | `ring-1` | `bg-kumo-base` | `border-b p-6` | `p-6` / `space-y-5` |
| `tenant-portal/screens/*.tsx` | `article` | `rounded-xl` | `ring-1` | `bg-kumo-base` | `border-b p-6` | `p-6` / `flex-wrap gap-2` |
| `tenant-portal/screens/overview.tsx` | `LayerCard` | Kumo 默认 | Kumo 默认 | Kumo 默认 | 无（纯卡片） | `p-6` |
| `app/keys-card.tsx` | `article` | `rounded-xl` | `ring-1` | `bg-kumo-base` | `border-b p-6` | `space-y-3 p-6` |
| `app/create-key-button.tsx` | `Surface` | `rounded-xl` | `ring-1` | Surface 默认 | 无 | `p-5` |
| `app.tsx` | `Surface` | `rounded-lg` | 无 | Surface 默认 | 无 | `p-5` |
| `ops-console/screens/tenant-overview.tsx` | `article` | `rounded-xl` | `ring-1` | `bg-kumo-base` | `border-b + border-l-2 brand` | `p-6`（TenantsTable） |

**结论**：同一项目中出现了 **9 种**卡片变体，且 `ops-console` 和 `tenant-portal` 虽然视觉相似，但实现方式完全不同（`article` vs `LayerCard` vs `Surface` vs `div`）。这是典型的「没有设计系统规范」导致的视觉语言分裂。
