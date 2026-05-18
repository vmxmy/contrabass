# LiteLLM Portal 前端双维设计审计报告（汇总）

**日期**：2026-05-18
**审计方法**：4 个 opus 审计 Agent 并行，按 `frontend-review-standard`（认知体验 + 工程架构双维）逐界面走查
**覆盖范围**：Tenant Portal / Ops Console / 主 app（Key·Usage·图表）/ 共享外壳·导航·Kumo 系统层
**业务场景基准**：B 端多角色管理后台（租户自助 + 平台运维），专家高频、键盘流，信息密度应**偏紧凑、一屏看全**——C 端式大留白在此场景属反体验。

---

## 总体结论

> ⚠️ **修复 🔴 1 项 + 🟠 若干项后可上线**。
> Kumo **样式令牌层**纪律接近满分（零硬编码 hex，单一 CSS bundle）；但**导航/外壳结构层**利用不足且存在关键重造，叠加全站响应式缺失、密度开关对多数界面失效、卡片原语 43 处手写复制，使「页面整体简陋、组件/布局/卡片/响应混乱」的体感**有明确代码依据**——根因是系统层而非个别页面。

**Kumo 价值发挥度评分：68 / 100**
- 样式系统层 25/25，组件广度 20/25，顶层基建 15/15
- 扣分：手写 `side-nav` 重造 Kumo `sidebar` 且缺响应式（−12）；`breadcrumbs`/`menubar` 该用未用（−8）；图标策略不自洽（−2）

---

## 一、跨界面系统性问题（按杠杆排序）

这些问题在 2+ 界面重复出现，是「混乱体感」的真正根因，应优先于单页修复。

### S1 🔴 Blocker — 全站响应式完全缺失
- **证据**：全站仅 1 处断点（`tenant-portal/shell.tsx:142 sm:inline`）。`side-nav.tsx:37` 硬编码 `w-56`，无折叠/抽屉/汉堡；`ops-console/shell.tsx:146`、`tenant-portal/shell.tsx:306`、`routes/manage/route.lazy.tsx:30`、`routes/__root.tsx:188` 均零 `md:/lg:`。
- **影响**：窄分屏、平板、外接竖屏（B 端运维常见）直接破版。
- **根因**：手写 `side-nav.tsx` 重造了 Kumo 已提供的 `@cloudflare/kumo/components/sidebar`（自带折叠/响应式），重造版反而缺能力。
- **修复**：迁移到 Kumo `sidebar`，补折叠态（`w-14↔w-56`）+ 窄屏抽屉。折叠态存组件内 `useState`/路由 search，**不进全局 store**。一处迁移同时关闭 S1 + 缓解 S2。

### S2 🟠 Critical — 4 套布局外壳碎片化，无单一 AppShell
- **证据**：`__root.tsx:188`（居中窄栏+顶 header，无侧栏）／`tenant-portal/shell.tsx:294`（flex+侧栏）／`ops-console/shell.tsx:123`（flex+侧栏）／`routes/manage/route.lazy.tsx:30`（侧栏但**无品牌条**）四套根容器结构互不相同。
- **影响**：用户在 `/` → `/manage/keys` → 偏好页 间穿梭时导航骨架三种形态，定位锚点反复重建。
- **修复**：收敛为单一 `AppShell`（品牌/状态条 + SideNav + 内容区），差异仅由 `accent` + `density` + nav 数据驱动（SideNav 已是此模式，把外层对齐）。引入 Kumo `breadcrumbs` 补深层路由层级锚点。

### S3 🟠 Critical — 卡片原语手写重造 ×43，未用足 Kumo `LayerCard`
- **证据**：手写 `<article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">` + `border-b bg-kumo-elevated p-6` header —— Tenant 8 处、Ops 10 处、app/MemberOverlay 多处、全 Portal 共 43 处复制。而 `app.tsx:6` 已 import `LayerCard`，`StatTile`/overview 已正确使用，**同产品两套卡片实现并存**。
- **影响**：任一 token 改名需 43 处手改；圆角/描边/底色靠字符串约定，漂移即不一致——这是「卡片混乱」的直接来源。
- **修复**：抽 `<PanelCard title description>` 薄封装（内部用 Kumo `LayerCard`/`surface` + 走 density），43 处统一收敛。

### S4 🟠 Critical — 密度系统是死代码，「显示密度」偏好对多数界面失效
- **证据**：`DensityProvider` 已在各 shell 注入、`densityClasses` 已定义 compact/comfortable；但仅 3 个 ops 屏（tenant-overview/audit/tenant-detail）消费 `useDensity()`。Tenant 全部 screens、`admin-components.tsx` 表格（`p-5` 表头/`py-3` 单元格）、ops `provisioning` 全部硬编码间距，无视密度。`preferences-form.tsx:82` 的「显示密度」开关对它们**完全无效**。
- **修复**：`admin-components.tsx` 的 `Table.Head/Cell` padding 与 tenant screens 卡片间距改读 `densityClasses(useDensity())`；租户 shell 默认密度评估下调为 `compact`（同属 B 端专家）。否则删除该偏好以免承诺落空。

### S5 🟠 Critical — Error Boundary 范式已建但未铺满，关键区块崩溃拖垮整页
- **证据**：`BlockErrorBoundary` 已在 `usage-dashboard`/`usage-charts-lazy`/`ops audit` 落地（做得好），但**管理面三大表 users/teams/audit（`routes/manage/*/index.lazy.tsx`）零包裹**，`ApiKeysCard`/创建删除对话框/`MemberOverlay` 均无独立边界。`AdminUsersTable` 形状漂移即整个 `/manage` 白屏；MemberOverlay 图表抛错连「关闭」按钮都点不到。
- **修复**：在三个 `*.lazy.tsx` 的 `AdminCard` 内层、`ApiKeysCard`、`MemberOverlay` 各包 `BlockErrorBoundary`（组件已存在，只是没用全）。

### S6 🟠 Critical — 破坏性操作摩擦强度与风险不匹配
- **证据**：
  - 删除 API Key（不可逆、删后立即失效）确认框仅「取消/确认」两按钮，无约束式摩擦（`delete-key-button.tsx:50`）。
  - Ops 建租户、`tenant_admin` 提权、impersonation「进入租户」均「填表→点一次→立即提交」，无二次确认、无「将记入审计」提示（`provisioning.tsx:34/104/199`、`tenant-detail.tsx:18`）。
- **对比**：同仓 Tenant Portal `RevokeInviteDialog` 已有「输入完整邮箱才解禁确认」的成熟范式，未被复用。
- **修复**：高破坏操作统一接入 Kumo `Dialog` + typed-confirm（键入 Key 名/团队名/邮箱），与全站心智一致。

### S7 🟠 Critical — DTO 透传 + God Component（架构反模式 2/8）
- **证据**：
  - `admin-components.tsx` 576 行导出 12 符号（3 数据 hook 容器 + 展示原子 + 业务派生 + 时间格式化 + 分页 + 审计展开状态机）——文件级 God Component。
  - `MemberOverlay`（`member-overlay.tsx:6-84`）单组件发 2 个请求 + JSX 内 IIFE 算趋势 + 84 行手写布局，`useDashboard` 原始 DTO 直接解构透传给图表。
  - `shell.tsx`（tenant）混 nav 解析 + logo 安全校验 + SSR 策略 + 取数 + impersonation + 布局。
  - `dashboard.teams[0]` 原始 DTO 在 `tenant shell:132` 与 `overview:128` 重复解构，无 ViewModel。
- **修复**：拆 `admin-components.tsx` 为 `admin/cells`、`admin/tables`、`admin/derive.ts`、`lib/format`；`MemberOverlay` 抽 `useMemberUsage()` ViewModel + 哑组件；引入 `useTenantBudgetVM()` 集中 `teams[0]` 反规范化。

### S8 🟡 Major — 骨架几何不匹配终态 → CLS
- **证据**：tenant KPI tile loading 用通用 `PanelSkeleton lines=1` 文本条，终态是大号数字+Meter（`overview.tsx:69` 等）；仪表盘外层数据态/`MemberOverlay`/`UsageChart` 用居中纯文本「加载中…」（`usage-dashboard.tsx:166`、`chart.tsx:127`）；`TeamsAccessCard` 加载态是英文 `Loading…`（`app.tsx:219`，全站中文语境）。
- **对比**：`usage-charts-lazy.tsx` 已正确做几何匹配骨架，是范本。
- **修复**：为 KPI/图表做几何匹配专用骨架，文案统一中文。

### S9 🟡 Major — B 端场景套用 C 端大留白
- **证据**：主容器 `py-10 lg:py-16`、header `mb-12`、section `mb-14`、Key 表头 `p-5`、StatTile `p-6`、创建对话框 `p-8 space-y-6`（`app.tsx:344` 等）；tenant 主区 `py-10`。强迫纵向滚动，单屏信息量低。
- **修复**：按 B 端基准收紧（容器 `py-6~8`、表格单元 `p-3`、对话框 `p-6`），纵向留白预算转单屏密度，并接入 S4 的密度系统。

### S10 🟡 Major — 命令面板对非 admin 关闭 + 色彩为信息唯一媒介 + 语言不一致
- **命令面板**：`__root.tsx:205` 仅 `role==="admin"` 挂载，`admin_viewer`/`tenant_admin`/`member` 无法 ⌘K——恰是高频键盘流用户。应全身份挂载、按 role 过滤条目数据。
- **色彩唯一媒介**：状态色点 `aria-hidden`（`shell.tsx:155`）、模型徽章靠颜色分类、花费档位仅色（`keys-card.tsx:54`、`budget-badge.tsx:35`）——色盲/灰度不可辨。补 icon/文本冗余。
- **语言**：`SyncStatusBadge`/`relativeTime` 英文（`admin-components.tsx:548/535`）混入中文界面。走 Lingui + `Intl.RelativeTimeFormat`。

---

## 二、亮点（应保留的正向模式）

- **Design Token 纪律优秀**：业务 `.tsx` 零硬编码 hex，inline style 仅 6 处合法动态值，单一 `kumo-css.generated.ts` bundle，无平行 CSS 体系。
- **删除 Key 乐观更新四件套完整**（`use-delete-key.ts`）：onMutate 取消+快照+乐观移除 / onError 精确回滚 / onSettled 兜底——教科书级，应作为创建链路对齐范本（创建链路目前**无乐观对称**，是缺口）。
- **四态收敛规范**：`PanelSkeleton/Empty/Error/Loading`（`panel-state.tsx`）统一，`PanelError` §F.3 仅 catalog id 才回显的泄漏守卫是教科书级抽象泄漏防御。
- **SSR/#418 防线扎实**：`SsrSafeSkeleton` + `useHasHydrated` 门控，水合不匹配防御到位。
- **SideNav 已是正确数据驱动收敛模式**：三套外壳共用，差异仅 `accent`+`groups` 数据——这正是 S2 应推广到外层的范本。
- **图表懒加载边界设计成熟**（`usage-charts-lazy.tsx`）：lazy 分包 + boundary 置于 Suspense 外区分 chunk/render 错误 + 几何匹配骨架，CLS/分包/隔离三者兼顾。
- **错误文案人性化、不泄露技术栈**；**一次性密钥**用 SensitiveInput+Banner 强提示心智正确；**领域 vs 排版状态边界清晰**（未命中反模式 3）。

---

## 三、修复路线图（按杠杆/优先级）

| 优先级 | 动作 | 关闭项 | 杠杆 |
|---|---|---|---|
| 1 🔴 | 手写 `side-nav` 迁移到 Kumo `sidebar` + 折叠/窄屏抽屉 | S1 + 缓解 S2 | 一处迁移关 1 Blocker + 1 Critical |
| 2 🟠 | 抽 `<PanelCard>`（内含 Kumo `LayerCard`+density），收敛 43 处手写卡片 | S3 + S4 卡片侧 | 一处抽象消灭全站卡片混乱 + 接通密度 |
| 3 🟠 | 4 套外壳收敛为单一 `AppShell` + 引入 `breadcrumbs` | S2 | 消除导航骨架三形态认知税 |
| 4 🟠 | `admin-components.tsx` Table 接入 `densityClasses`；tenant screens 同源；评估 tenant shell 默认 compact | S4 | 让「显示密度」开关真正生效 |
| 5 🟠 | 管理面三大表 + ApiKeysCard + MemberOverlay 包 `BlockErrorBoundary` | S5 | 单卡片崩溃不再白屏整页 |
| 6 🟠 | 高破坏操作（删 Key/建租户/提权/impersonation）统一 Kumo `Dialog` typed-confirm | S6 | 防专家连点误操作 |
| 7 🟠 | 拆 `admin-components.tsx`/`MemberOverlay`；引入 `useTenantBudgetVM`/`useMemberUsage` ViewModel | S7 | 切断 DTO 透传，降崩溃半径 |
| 8 🟡 | 命令面板全身份挂载按 role 过滤；创建 Key 补 `setQueryData` 乐观对称 | S10/创建缺口 | 键盘流可达 + 交互对称 |
| 9 🟡 | KPI/图表几何匹配骨架；按 B 端基准收紧留白；语义色补 icon/文本；状态徽章中文化 | S8/S9/S10 | 消 CLS + 提密度 + 可达性 |
| 10 🟢 | 删死代码（`AdminSection`/`selectedModelsFromValue`/疑似 `chart.tsx::UsageChart` 双轨）；架构注释移入 docs/ADR；图标策略统一（手写 vs Phosphor）；`MemberForbidden` 迁出 routes | 各反模式苗头 | 降维护面 |

---

## 四、四问速筛汇总结论

1. **看代码（ViewModel 隔离）**：⚠️ 命中反模式 2+8 —— `admin-components.tsx`（576 行文件级 God Component）、`MemberOverlay` DTO 内联透传、`dashboard.teams[0]` 多处裸解构无 Adapter。（Ops Console 的 schema 层做得好，是正向反例。）
2. **看交互（响应阈值/骨架/乐观/Error Boundary）**：⚠️ 范式齐全但未铺满 —— 删除链路乐观完整但创建无对称；骨架几何不匹配致 CLS；Error Boundary 三大表/卡片缺位；破坏性操作摩擦不足。
3. **看设计（信息密度弹性）**：❌ 未通过 —— 响应式 0 断点（Blocker）、密度开关对多数界面假失效、B 端套 C 端留白、卡片/栅格双轨。
4. **看 AI（生成式 UI）**：➖ 不涉及（无生成式/流式 UI）。

---

*分界面完整明细见各审计 Agent 原始报告（Tenant / Ops / app / Shell+Kumo 四份），本汇总已合并同根因表象并按杠杆重排优先级。*

---

## 五、补充审计：Kumo 设计系统层（第二轮独立走查）

> 来源：`docs/frontend-audit-kumo-design-system.md`（独立于首轮 4-Agent 的第二次走查）。
> 结论方向与首轮一致——**问题不是 Kumo 组件用得少（Token 覆盖率很高），而是缺乏设计系统层规范，同一套视觉语言被重复发明了 4 遍**。本章只收录**首轮未捕获或更锐利的增量证据**，并交叉映射到 S1–S10。

### 增量证据 A：卡片不是 2 套而是 **4 套互斥实现**（深化 S3）

首轮 S3 判为「手写 `<article>` vs Kumo `LayerCard` 两套并存」。第二轮证实实际是 **4 套**：

| 实现 | 容器 | 圆角 | 边框 | 使用位置 |
|---|---|---|---|---|
| `LayerCard` | Kumo 组件 | 内置 | 内置 | overview tiles |
| `<article>` + 手写样式 | `<article>` | `rounded-xl` | `ring-1` | ops / tenant screens |
| `<div>` + 手写样式 | `<div>` | `rounded-xl` | `border` | dashboard Panel |
| `Surface` | Kumo 组件 | `rounded-lg` | 无 | `app.tsx` |

**对 S3 的修正**：圆角在 `rounded-xl` / `rounded-lg` 间分裂，边框在 `ring-1` / `border` / 内置 间分裂——`<PanelCard>` 收敛时必须**同时统一圆角与边框 token**，不能只替换容器标签。计数口径：首轮全量扫描计 43 处手写卡片，第二轮按 screen 级计 21 处重复——口径不同（含/不含原子级卡片），方向一致：**≥20 处、4 套实现并存**。

### 增量证据 B：3-Surface chrome 逐项不统一矩阵（深化 S2）

首轮 S2 指出「4 套外壳碎片化」，第二轮补上**逐项可量化对比**：

| Surface | Header | 内容区 Padding | 背景 | 宽度 |
|---|---|---|---|---|
| `PortalRootLayout` | `mb-12` 大标题 | `py-10 lg:py-16` | 默认 | `container mx-auto`（窄） |
| `TenantPortalShell` | 自建 header | `px-6 py-8` | `bg-kumo-canvas` | 全宽 |
| `OpsConsoleShell` | 紧凑 header + chips | `px-6 py-8` | `bg-kumo-canvas` | 全宽 |

**结论强化**：用户跨 Surface 切换时 header 高度、内边距、背景色**三者同时突变**。`PageShell` 收敛的验收标准 = 这张表三行除 nav 数据/accent 外应完全一致。

### 增量证据 C：`panel.tsx` API 极简是 S3「手写 header ×20」的机制根因（新）

`dashboard/components/panel.tsx` **只接受 `title: string` + `children`**——无 `icon` / `action` / `subtitle` / `loading` / `error` 槽位。这是首轮 S3「每个 screen 在卡片外手写 `border-b bg-kumo-elevated p-6` header ≥20 次」的**直接成因**：组件不给槽位 → 调用方只能在外面手搓。

**对路线图的影响**：S3 的 `<PanelCard>` 抽象**必须同时扩 API**（`icon`/`action`/`subtitle`/`loading`/`error` 槽位），否则即使统一容器，header 仍会继续手写。这把首轮路线图第 2 项从「抽薄封装」升级为「抽封装 + 补全 Panel API」。

### 计数口径调和（响应式断点）

首轮 S1 报「全站仅 1 处断点（指 shell/side-nav 关键布局层）」，第二轮报「全项目 26 处 `sm:/md:/lg:/xl:`」。二者不矛盾：**26 处零散分布在叶子组件，关键布局骨架层（shell/side-nav/表格容器/图表）几乎为 0**——这正是「破版」的精确定位:有断点的地方不影响布局,影响布局的地方没断点。S1 🔴 判定不变。

### 对修复路线图的并入

第二轮的 P0/P1/P2 已被首轮路线图覆盖，仅两处需**升级既有条目**：

| 受影响路线图项 | 升级动作 |
|---|---|
| 第 2 项「抽 `<PanelCard>`」 | 升级为「抽 `<PanelCard>` **+ 扩 Panel API**（icon/action/subtitle/loading/error）」——否则 header 仍手写（增量证据 C） |
| 第 3 项「4 套外壳收敛 AppShell」 | 验收标准量化为「增量证据 B 矩阵三行除 nav/accent 外完全一致」 |
| 第 2 项卡片收敛 | 验收标准追加「圆角统一 `rounded-xl`、边框统一、padding 统一 `p-6` 走 density」（增量证据 A 的 4 套分裂修正） |

其余（全宽布局、SideNav 折叠、God Component 拆分、Typography 走 Kumo `Text`）与首轮 S1/S2/S7/S9 完全重合，不另列。
