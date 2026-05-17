# LiteLLM Portal — Web UI/UX 全站重设计 · 设计文档

- 日期：2026-05-17
- 状态：已通过 brainstorm 评审，待用户审阅 → writing-plans
- 范围层级：本文档为 **总纲 spec**；P0–P3 每期各自再走 spec→plan→实现

## Context（为什么做这件事）

LiteLLM Portal 当前是面向内部团队的自助台。近期演进：

- #134：SSR #418 修复 + 用量数据平台改为直连 LiteLLM + 缓存（退役 firehose/UsageDO）。
- #135：layout-unification —— `/` 统一 UsageDashboard（个人/全局 scope 切换），管理操作迁到 `/manage/*` 顶部 tab，identity-bar，旧路径 301。
- #136（待审阅）：F1 管理员邀请制接入、F2 每团队预算告警 webhook、F3 月度账单→R2、F4 AI Gateway 运维文档、F5 预算 pill 回归守卫。**F1/F2/F3 均为后端，零界面。**

由此产生三类问题，共同驱动一次全站重设计：

1. **功能不可用**：建团队、邀请管理、告警 webhook 配置、月度账单下载等后端已就绪却无 UI；`/manage/users/$userId`、`/manage/teams/$teamId` 仍是「待实现」占位。
2. **信息架构与心智**：个人 vs 全局 scope、`/` 与 `/manage` 分工、管理员双重身份、tab 层级，认知负担偏高。
3. **定位升级**：需从「内部团队台」转向真正对外的多租户客户自助门户（机构级可信观感）。

## 已锁定决策（brainstorm 产出）

| 维度 | 决策 |
|---|---|
| 范围 | **全站重设计**（登录 → `/` → `/manage/*` 统一重做：信息架构 + 视觉 + 交互），建立在 #135 之上 |
| 设计系统 | **在 Kumo 上演进**：保留 `@cloudflare/kumo` + `DESIGN.md` token 体系，**扩展不替换** |
| 首要目标 | 四者皆要：功能完整性 + 信息架构 + 专业质感 + 对外多租户重定位（重定位为统摄框架） |
| 角色模型 | **三层角色分视角**：平台 Owner / 租户管理员 / 普通成员 |
| 租户管理员识别 | **选项 2 —— 新增门户级 tenantRole**（与 LiteLLM 解耦，IndexDO 侧显式存，需迁移 + 写入路径） |
| 总体方向 | **方向 C —— 双界面分裂**：对外 Tenant Portal ｜ 对内 Operations Console |

隐含硬约束（保持）：SSR + React 岛、zh-CN/en 双语、暗色（`data-mode`）、Kumo 组件、bundle 敏感、无装饰阴影、数字等宽、语义色仅文本、#135 作基线。

## 第 1 节 · 界面分裂 + 路由/鉴权模型

同一个 Worker、同一套 magic-link session：

- 登录 → session cookie → `resolveIdentity`（沿用现有 role-cache）解析角色。
- 解析结果决定 SSR 选壳：
  - `/` → **Tenant Portal**（对外，作用域恒为「我所属的 team」，可品牌化）
  - `/ops` → **Operations Console**（对内，仅平台 Owner；非 Owner 403/重定向）
- **跨面桥接**：Owner 在 Console 点某租户 →「进入该租户视角」深链到 Tenant Portal，带 tenant 上下文（受控），顶部常驻 impersonation 横幅 + 一键退出，**该越权访问写审计**。
- 旧路径 `/admin/*`、`/manage/*`、`/preferences` → 301 重定向到新结构（扩充 `routes/legacy/redirects`）。

## 第 2 节 · Tenant Portal（`/`）信息架构与关键屏

左侧主导航，按门户级 `tenantRole` 收放；顶部租户品牌条（Logo · 团队名 · 本周期花费/预算 · 告警状态）。

| 屏 | 角色可见性 | 内容 / 后端对接 |
|---|---|---|
| 概览 / Home | 全部（member 为个人维度变体） | 团队身份 + 本预算周期花费/预算环（F2 周期）+ 告警状态 + Top 模型 + 近期活动 |
| 用量 | 全部 | 沿用 UsageDashboard，作用域恒为本 team（无全局开关）；tenant_admin 可下钻成员（复用 member-overlay） |
| API Key | 全部 | 演进 ApiKeysCard + 预算 pill（F5）；member：自有 Key；tenant_admin：团队 Key 只读 + 创建/禁用/删除 |
| 成员 & 邀请 | 仅 tenant_admin | 成员列表/角色/人均花费；发/撤/查邀请（F1 invites） |
| 预算 & 告警 | 仅 tenant_admin | 团队预算视图 + F2 告警 webhook 配置（SSRF 安全输入、状态、周期去重说明、清除） |
| 账单 | 仅 tenant_admin | F3 月度账单：可用月份列表 + 下载本团队 CSV |

## 第 3 节 · Operations Console（`/ops`）信息架构

仅平台 Owner；全租户视角；与 Tenant Portal 视觉同源（Kumo）但 chrome 更「运营驾驶舱」化。

| 屏 | 内容 |
|---|---|
| 租户总览（Home） | 全租户列表：成员数 · 本周期花费/预算 · 告警&webhook 状态 · 账单状态；行→进入该租户 |
| 发放 & 邀请 | 建团队（F1 `POST /api/admin/teams`）· 跨租户发/查/撤邀请（F1）· **指派门户级 tenantRole（写入权威在此）** |
| 全局用量 | 沿用全局 UsageDashboard：跨租户聚合 · 排行 · 多线趋势 · 成员下钻 |
| 审计 | AdminAuditFeed 全平台 + **事件详情页（把 stub 的 `audit/$eventId` 做实）** |
| 平台设置 | 偏好默认值 · write-ops 开关可见性 · 角色/tenantRole 管理 · 平台级 webhook/账单配置 |
| 租户详情 | **做实 `/manage/teams/$teamId`**：成员 · 预算/配额 · webhook 状态 · 账单历史 · tenantRole 指派 ·「进入租户」 |
| 用户详情 | **做实 `/manage/users/$userId`**：身份 · 所属团队 · role/tenantRole · 用量历史 · Key |

## 第 4 节 · 设计语言演进（Kumo 上）

`DESIGN.md` 仍为载体规范，**扩展不替换**。机构级底子不变：canvas/ink/层级、单一品牌电压、数字等宽、pill/xl 圆角、无装饰阴影、语义色仅文本。

- **两面同源异质（共享 Kumo token）**：
  - Tenant Portal —— 平静、品牌化、编辑式留白；单一电压 = 租户品牌色；左导航 + 品牌条。
  - Ops Console —— 致密、状态前置、运营驾驶舱；固定中性钢色 accent（标识「内部/特权」）；左导航 + 运营 chip。
- **租户品牌层（不分叉设计系统）**：每租户 Logo + 主色 + 显示名 → 以 CSS 自定义属性覆盖 `--kumo-brand*`（仅品牌电压位）；语义色/层级/版式不动；缺省回落 Kumo 默认；强制对比度校验（双模式）；主色受约束调色板。Ops 面忽略租户品牌。
- **组件演进（最小新增）**：复用 KPI 卡 / data-panel / metric-tile / 状态 pill / 模型徽章 / 预算 pill(F5) / TimeseriesChart / Table·Dialog·Banner·Empty·SkeletonLine；按需新增左导航壳（替代 top-tabs）、身份/租户切换 Dropdown、impersonation 横幅、邀请/webhook/账单表单屏。
- 约束保持：暗色、双语、无阴影、等宽数字、语义色仅文本、统一空/载入/错误态。

## 第 5 节 · 必需后端改动 · 横切 · 分期

### 必需后端改动（本重设计非纯前端）

- **门户级 tenantRole（选项 2）**：IndexDO 新增映射（仿 `cb_index_invites` 自迁移 `CREATE TABLE IF NOT EXISTS`）：userId↔teamId↔tenantRole。权威 = Ops Console 指派；F1 邀请消费时按 `invite.teamRole` 写初值。`resolveIdentity` 扩展为 `{platformRole, tenantRole, teamId}`。
- **租户作用域 API**：F1/F2/F3 现为 `/api/admin/*` + `requireAdmin`（平台级）。新增 `requireTenantAdmin`（tenantRole=admin 且仅本 team）+ 租户作用域端点（自助）。Owner 保留 `/api/admin/*` 超集；impersonation 带租户上下文 + 审计。
- **SSR 选壳路由**：按解析角色在请求期选壳；旧路径 301。

### 横切（沿用现有约束）

i18n（新文案先入 `i18n/messages/*` zh-CN/en）· 暗色 `data-mode`（品牌色双模式对比度校验）· SSR+岛（两壳=两入口，角色服务端解析）· bundle 按面拆分 + 懒加载重面板（沿用 #135 TanStack lazy 路由）· Kumo 自带键盘/focus/ARIA + 图表 `ariaDescription` + impersonation 横幅为 alert 区 · Storybook/路由守卫/作用域中间件/选壳测试扩展。

### 分期（增量、低风险、早交付价值；每期独立 spec→plan→实现）

- **Phase 0 · 后端地基**：tenantRole 存储+迁移 · `resolveIdentity` 扩展 · `requireTenantAdmin` · 租户作用域端点（无 UI，独立可测）。
- **Phase 1 · Tenant Portal**：壳 + IA + 缺失四屏（概览/邀请/webhook/账单）+ 复用演进 Usage/Keys + 旧路径重定向。兑现「后端可用 + 成员/租户管理员价值」。
- **Phase 2 · Operations Console**：壳 + 租户总览 + 发放 + 把租户/用户/审计详情做实 + impersonation 桥接。
- **Phase 3 · 设计打磨**：设计语言打磨 + 租户品牌层 + 密度/状态统一 + bundle 拆分 + a11y 审计。

## 复用而非新建（关键既有资产）

`resolveIdentity` / role-cache · `requireAdmin`/`applyAdminRateLimit`/`auditWrite` · UsageDashboard / member-overlay / KPI 带 · ApiKeysCard + BudgetBadge(F5) · F1 invites（`teamRole` 已为 tenantRole 种子）· F2 alert-webhook + SSRF 守卫 · F3 billing-archive · TanStack lazy 路由 · `routes/legacy/redirects` · Kumo 组件全集 · `portal.stories.tsx`。

## 风险 / 开放项

- 选项 2 引入新后端表/迁移与写入权威；与 F1 邀请消费写路径需对齐（P0 落实）。
- C 是最大重构（两壳/路由树）；分期与 #135 基线衔接需在 P1 spec 细化。
- impersonation 的安全边界（受控只读 vs 受控写、时限、审计字段）需 P0/P2 明确。
- 租户品牌色对比度在暗色模式的强制回退策略需 P3 明确。
- 与 PR #136 的关系：本设计依赖 F1/F2/F3 合入 main；P0 起点应在 #136 合并后。

## 非目标（Out of scope）

- 不更换设计系统（不弃用 Kumo）。
- 不引入计费/支付实现（账单仅为 F3 CSV 归档下载）。
- 不重建 firehose/UsageDO（#134 已退役，沿用直连+缓存）。
- 本文档不含像素级视觉稿；视觉细化在 P3 spec。

## 后续

本文档为总纲。下一步进入 writing-plans，先为 **Phase 0（后端地基）** 产出实施计划（P0 完成后依次 P1/P2/P3，各自 spec→plan→实现）。
