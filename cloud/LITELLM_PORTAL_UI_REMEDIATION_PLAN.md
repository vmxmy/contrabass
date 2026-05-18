# LiteLLM Portal UI 结构整改 — 实施方案

**日期**：2026-05-18
**配套文档**：`LITELLM_PORTAL_UI_AUDIT.md`（审计依据，S1–S10 + 补充章）
**性质**：实施方案（plan-only，未开始改动）。批准某一 Phase 后方进入实现。

---

## 0. 设计立场（不可协商的约束）

整改是**建一层承重墙 + 一道防回归棘轮**，不是逐页调样式，也不是重写。

1. **薄、强制、组合优先**：Layer-2 缝只允许 ≤6 个组件。抽象资格已由 21–43 处复制证明（模式覆盖率 >80%），但不得越界成 config-driven 巨型件（审计反模式 6/7）。
2. **砍掉选择权**：一张卡片、一个页型只有**唯一答案**。`LayerCard` 与手写卡片并存比没有 `LayerCard` 更坏——整改的本质是消灭竞争性正确答案。
3. **棘轮是真交付物**：组件只是原料。没有 lint/CI 棘轮，成果在 2 个 Phase 内按复制机制重新腐烂（L1→L2→L3 已证明"靠纪律"在此项目不成立）。
4. **安全/SSR 平面零改动**：本整改是**纯表现层重新归位**。`auth/role/impersonation`、`#418` 水合纪律（`useHasHydrated`/`SsrSafeSkeleton`）、`panel-state` 四态、`PanelError §F.3` 泄漏守卫——**原样保留，只迁移不重写**。任何 PR 触及这些逻辑即判越界。

---

## 1. 目标三层结构

```
Layer 3  screens（只组合，零裸 chrome、零裸 grid/间距、零深 import Kumo 容器）
   │  只能 import 自 Layer 2
Layer 2  src/litellm-portal/ui/   ← 本项目设计系统缝（新建，唯一答案所在）
   │  PageShell · PanelCard · 布局槽位件 · 屏原型 · token 出口
Layer 1  @cloudflare/kumo        ← 供应商原语（screens 不再直接 import 容器类）
```

**Layer 2 清单（恰好 6 个 + 屏原型，不得再多）**

| 组件 | 职责 | 收敛/替换 | 关联审计项 |
|---|---|---|---|
| `PageShell` | 统一 chrome：品牌/状态条 + SideNav 槽 + 内容区 + density + accent | 替换 `__root`/`tenant shell`/`ops shell`/`manage` 4 套外层 | S2、补充证据 B |
| `SideNav`(迁移) | 改用 Kumo `sidebar`，自带折叠/窄屏抽屉，内嵌于 `PageShell` | 替换手写 `components/side-nav.tsx`（`w-56` 固定） | S1 🔴 |
| `PanelCard` | 唯一卡片：内含 Kumo `LayerCard` + 扩展 API（`title/subtitle/icon/actions/density` + `loading/empty/error` 走既有 `panel-state`） | 收敛 4 套卡片实现 + 复用 `dashboard/components/panel.tsx` 调用方 | S3、补充证据 A/C |
| `PageHeader` | 标题 + Kumo `breadcrumbs` + 操作槽（`actions`） | 替换各 screen 手写 `border-b bg-kumo-elevated p-6` header（≥20 处） | S3-C、S2 |
| `KpiBand` | 指标行，内部走 Kumo `<Grid>`（房规 `app.tsx:159`） | 替换手写 `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` | S3-A、S8 |
| `ContentColumns` | 主/次内容槽（`primary` + `aside`），density 感知 | 替换各 screen 手摆双栏 div | 排布随意根因 |

**屏原型（thin templates，4 个，screen 填具名槽位）**

| 原型 | 槽位语法 | 适配现状 |
|---|---|---|
| `ListScreen` | `header / filters / table(主) / pagination` | manage users/teams/audit、ops audit |
| `DetailScreen` | `header / summary / sections[]` | tenant/user/tenant-detail |
| `OverviewScreen` | `header / KpiBand / ContentColumns` | tenant overview、usage-dashboard |
| `FormScreen` | `header / fields / actions(带 typed-confirm 钩子)` | ops provisioning 三表单 |

> screen 只声明"填哪些槽"，**不准手摆 div / 写裸 grid / 写裸纵向间距**。排布随意 → 结构上不可能（无语法可表达"放别处"）。

---

## 2. 防回归棘轮（与缝同期落地，真交付物）

落在 `cloud` 的 lint + CI。**新文件即刻 `error`；存量文件 Phase 0–2 期间 `warn`，Phase 3 全量翻 `error`**（否则棘轮会阻断迁移 PR 自身）。

| 规则 | 拦截 | 豁免 |
|---|---|---|
| R1 禁裸卡片 chrome | screen 内 `className` 含 `rounded-(xl\|lg)` 且含 `ring-1\|border` 的 `article/section/div` | `src/litellm-portal/ui/**` |
| R2 禁裸栅格/纵向节奏 | screen 内 `grid-cols-*` / `space-y-*` / `py-1[0-6]` / `mb-1[0-6]` | `ui/**` |
| R3 禁深 import Kumo 容器 | screen 直接 import `kumo/components/{layer-card,surface,grid}` | `ui/**`（缝内允许） |
| R4 禁裸 hex | `#[0-9a-fA-F]{3,6}`（现状已 0，设为保活闸防新增） | 注释、`*-theme.ts`、`*.stories.tsx` |
| R5 结构测试 | 快照断言：3 个 Surface 的 header 高度/内容 padding/背景/宽度 computed class **token 级一致**（补充证据 B 矩阵验收） | — |
| R6 import 边界 | screen 目录只能 import 自 `ui/**` 与 hooks/schema，不得反向 import `routes/**` 取 UI（修 S 中 `MemberForbidden` 类） | — |

棘轮验证基线沿用项目既有门：`bunx tsc --noEmit` clean + `vitest run`（含新增 R5 快照测试）。

---

## 3. 分批迁移与验收

每批一个 PR，独立可上线，验收以**可执行证据**为准（grep 计数 / 快照 / tsc）。

### Phase 0 — 建缝 + 棘轮(warn)
- 新建 `src/litellm-portal/ui/`：6 组件 + 4 原型，内部封装 Kumo（`LayerCard`/`sidebar`/`Grid`/`breadcrumbs`）。
- `PanelCard` 扩 API 并复用 `panel-state` 四态；`SideNav` 迁 Kumo `sidebar`（仅组件，未接入页面）。
- 落地 R1–R6（存量 warn、新文件 error）+ R5 快照测试骨架。
- **验收**：`ui/` 单测 + stories 覆盖；`tsc` clean；`vitest` 绿；棘轮在脏代码上产出预期 warn 数（作为整改进度基线）。

### Phase 1 — Ops Console 作参考迁移（最规整、B 端最纯）
- `OpsConsoleShell` → `PageShell`；7 屏套 `ListScreen/DetailScreen/FormScreen`；10 处手写卡片 → `PanelCard`；provisioning/tenant-detail 接 `densityClasses`。
- 高破坏操作（建租户/提权/impersonation）经 `FormScreen` 的 typed-confirm 钩子接 Kumo `Dialog`（S6）。
- **验收**：ops 目录 R1/R2/R3 命中归零；R5 快照中 ops 行达标；审计 S4/S6/S7(ops 侧) 关闭；功能回归（impersonation/审计/provisioning）无行为变更。

### Phase 2 — Tenant + 主 app + manage
- `TenantPortalShell`/`__root`/`manage route.lazy` → `PageShell`（chrome 矩阵三行收敛一致）。
- tenant 4 屏 + overview/usage-dashboard 套 `OverviewScreen`；app keys/MemberOverlay 卡片 → `PanelCard`；KPI → `KpiBand`。
- 三大管理表 + `ApiKeysCard` + `MemberOverlay` 包 `BlockErrorBoundary`（S5）；创建 Key 补 `setQueryData` 乐观对称（审计缺口）；命令面板全身份挂载按 role 过滤数据（S10）。
- God Component 拆分：`admin-components.tsx`→`admin/{cells,tables,derive,format}`；`MemberOverlay`→`useMemberUsage` VM + 哑组件（S7）。
- **验收**：全 screen R1–R3/R6 命中归零；R5 三行 token 级一致；S1/S2/S3/S5/S7/S8/S9/S10 关闭；CLS 用 lighthouse/手测确认 KPI/图表骨架几何匹配。

### Phase 3 — 翻 error + 清死代码
- 棘轮存量翻 `error`；删 `components/side-nav.tsx` 旧实现、`AdminSection`、`selectedModelsFromValue`、确认并清理 `chart.tsx::UsageChart` 双轨；架构注释移入 `docs/ADR`。
- **验收**：仓库零 R1–R6 违规；死代码引用 grep 归零；`docs/frontend-audit` 全部 🔴🟠 标记 closed；按既有流程 `bun run deploy:litellm-portal` 灰度（裸 `wrangler deploy` 禁用，见项目记忆）。

---

## 4. 风险与边界

| 风险 | 缓解 |
|---|---|
| 过度抽象成巨型配置件 | Layer-2 硬上限 6 组件 + 4 原型；组合优先；评审专设"是否越界"一票否决 |
| 迁移误伤安全/SSR | §0.4 红线；Phase 1/2 验收强制"功能行为零变更"；`#418`/`useHasHydrated`/`panel-state` 列入禁改清单，PR diff 触及即打回 |
| 棘轮阻断迁移 PR 自身 | 存量 warn / 新文件 error 的双档；Phase 3 才全量翻 error |
| 多主体（含 AI agent）迁移漂移 | 每屏迁移须套原型，PR 模板挂 R1–R6 自检；缝由单一 owner 把关一致性 |
| chrome 矩阵"看起来一致但 class 不同" | R5 用 computed-class 快照断言，非肉眼 review |

**不在本方案内**：后端 API 设计、`role` 单一真源逻辑、计费/usage 归属算法——仅整改前端如何隔离/呈现它们。

---

## 5. 优先级与杠杆（一句话）

Phase 0+1 是最高杠杆：建缝 + 一个参考 Surface 跑通 + 棘轮起效后，**S1🔴 与 S2/S3/S6 部分**即关闭，且后续 Phase 变成机械套原型——风险与认知负担在 Phase 1 末尾一次性塌缩。Phase 2 收割剩余 21–43 处复制，Phase 3 上锁。
