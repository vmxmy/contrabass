# LiteLLM Portal — Phase 3 §D 公共入口重塑（UserView + /login）· 设计文档

- 日期：2026-05-18
- 状态：**APPROVED by user 2026-05-18（AskUserQuestion：「扩范围：重塑 UserView+/login」，locked）**
- 范围层级：**Phase-3 §D 扩展工作流**，与既有 Phase-3 spec（`docs/superpowers/specs/2026-05-17-litellm-portal-phase3-design.md` §A/§B/§C/§E/§F + Task-0/0B）同一分支 `feat/litellm-portal-phase3-design-restyle`、同一 whole-branch re-review、同一 PR #141
- 载体规范：`cloud/src/litellm-portal/DESIGN.md`（沿用，不新增小节——这是「把已建立的设计系统应用到 2 个表面」，非新设计）
- 关联：[[ui-ux-v2-0]]（V2.0 标准）、Phase-3 plan `docs/superpowers/plans/2026-05-17-litellm-portal-uiux-redesign-phase3.md`（Task-0B `SsrSafeSkeleton`/`useHasHydrated`、Task-2 `Panel*`、§B 设计语言、#418 不变量）

---

## Context（为什么是 §D — 本地视觉预览的真实发现）

Phase-3 §B 的重塑**只覆盖了已认证的两壳**（`TenantPortalShell` / `OpsConsoleShell`）。`routes/index.tsx` `PortalIndex` 的分支（已读源码确认 2026-05-18）：

```
function PortalIndex() {
  const { data: me } = useMe();
  if (me === undefined) return <UserView />;          // ← 未重塑的旧页
  return <TenantPortalShell …><TenantOverviewScreen/></TenantPortalShell>;  // ← §B 已重塑
}
```

后果（本地预览证实）：

1. **每个未认证访客（所有人的第一印象）在 `/` 看到的是 legacy `UserView`**（`routes/index.tsx`@~69，代码注释自称 "the legacy `UserView` body (unchanged prior)"）：`UserView` = `<IdentityBar/>` + `<section id="usage-panel-root"><UsageDashboard/></section>`。`IdentityBar`（`identity-bar.tsx`）渲染 `当前身份 — / 总消费 $0.00 / …`，`UsageDashboard` 渲染 `30D 用量 / 模型数 0 / 24h–30d / 加载中…` 形状的骨架。**对一个登出用户这是过时且语义错误的内容**（假的 $0.00 数据看板）。
2. **`me === undefined` 同时覆盖已认证用户 `me` 解析前的短暂 LOADING 窗口** → 已认证用户进入时会先 FLASH 这个 legacy 页，再出现 §B 重塑壳。
3. **`/login`（magic-link 页，`auth/login-routes.ts` `loginPage()`@~117）SSR 渲染一个近乎空的 legacy body**（≈1579 bytes，纯内联 `<style>`、无 Kumo、无 JS）——同样未重塑。

用户决策（locked 2026-05-18）：把这两个公共入口纳入 Phase-3 重塑，让任何人看到的第一眼就是新设计，而不是旧页。

**关键技术事实（已读源码确认）：**

- `useMe()`（`hooks/use-me.ts`）是单一 `useQuery`；**无法区分「无 session（未认证）」与「session 解析中（认证-loading）」**——两者都 `data === undefined`（query 未 resolve 或 401 抛错）。`PortalIndex` 只能看到 `me === undefined`，没有第二个信号。
- `server-impl.tsx`@54-74 **仅在 `dataWithIdentity !== null`（已认证）时 seed `ME_QUERY_KEY`**；未认证 SSR 不 seed → `useMe()` 在 SSR 与客户端首帧**都**是 `undefined` → `UserView` 在两端都渲染（这是 #418-safe 的根据：SSR == client-first-render，确定性）。
- 故重塑后的 `UserView` 必须呈现**单一、对登出访客安全、确定性**的状态——一个品牌化欢迎 + 登录 CTA（链接 `/login`），**绝不**是数据看板。认证-loading 的短暂窗口由同一重塑顺带修复（flash 变成品牌欢迎而非旧看板；`me` resolve 后即切到 §B 壳——可接受，且 #418-safe，因为未认证 SSR == 未认证 client == 欢迎页）。

---

## 已锁定决策（用户 2026-05-18，逐条编码，不再讨论）

| # | 维度 | 锁定决策 | 本 spec 如何编码 |
|---|---|---|---|
| D1 | 范围 | **重塑 `UserView` + `/login`**，应用既有 Phase-3 设计系统（§B 词汇 + Kumo token + DESIGN.md type-scale/state/motion），**非新设计** | §D.1 / §D.2 给出确切呈现内容 + 复用清单 |
| D2 | `UserView` 内容 | 不再是假 `$0.00` 看板：**品牌化欢迎 + 「登录」CTA（→ `/login`）**；不区分 unauth/auth-loading（代码无信号），单一对登出访客安全的状态 | §D.1 |
| D3 | `/login` | 重塑为同一 Kumo 设计语言（品牌、可访问、双语、暗色安全）；**SSR/无-JS 仍可用**；magic-link POST/CSRF/限流/allowlist 逻辑**逐字不变**（presentation-only） | §D.2 |
| D4 | #418 | `UserView` 是 `/` 在 `me===undefined` 时的 SSR-emitted 状态——改它即改 `renderPortalSSR("/")` 输出；`hydration.test.tsx` 相关 case 必须更新到新 `UserView` 且保持 SSR==client（10/10）；复用 Task-0B `useHasHydrated`/`SsrSafeSkeleton` + Task-2 `Panel*` 纪律 | §D.3 |

隐含硬约束（继承 Phase-3 §B.0 / §D.1 横切）：不分叉 Kumo、不覆盖语义/层级/版式/圆角 token、不引 `shadow-*`；双语 zh-CN/en（新文案先入 i18n 目录，completeness 守卫——Phase-3 已有 `i18n/__fixtures__/phase3-keys.ts` + `i18n-completeness-phase3.test.ts`，新 key 入此）；暗色 `data-mode`；WCAG-AA；SSR + #418 不变量。

---

## §D.1 — `UserView` 重塑（`routes/index.tsx`）

**现状（`routes/index.tsx`@69-78，re-anchor by symbol）：**

```tsx
function UserView() {
  return (
    <>
      <IdentityBar />
      <section id="usage-panel-root" className="mb-14">
        <UsageDashboard />
      </section>
    </>
  );
}
```

**目标呈现（确定性、对登出访客安全、品牌化）：** 一个干净的「品牌欢迎屏」——

- 复用 Phase-3 §B 的**品牌身份摘要条视觉语汇**（Kumo `bg-kumo-elevated` / `border-b border-kumo-line` / `text-kumo-strong` 标题、§F.5 收敛后的 type-scale），但**不**渲染 `IdentityBar`（它读 `useDashboard()`，对登出用户无意义）也**不**渲染 `UsageDashboard`（数据看板，对登出用户语义错误且引入 `useDashboard` query 噪声）。
- 内容：平台名（来自 SSR 注入的 company/title——`PortalIndex` 当前不接 props；用 DESIGN.md 既有 page-title 排版的静态文案 + 平台名，平台名经既有 `portalDisplayName`/`me` 不可用时回落到中性 i18n 文案，**不**读任何受保护数据）、一句副标题（产品自助台简述，复用既有 `__root.tsx` 已有的中性平台副标题文案模式，i18n 化）、一个**主 CTA「登录」**作为 Kumo `Button`/`LinkButton`（`variant` primary，pill，`href="/login"`，`FOCUS_RING`）。
- **不出数据**：无 `$0.00`、无 KPI、无模型数、无 `加载中…` 看板。这是欢迎/落地，不是 dashboard。
- 容器密度沿用 §A.2 comfortable（对外、编辑式留白）；motion 沿用 §B.4（路由进入 `motion-safe:` ≤150ms，可选，单次）。
- **任何动态/随机/浏览器位**（若需要——本设计本身不需要任何动态内容；若实现中出现，例如装饰性骨架）必须经 Task-0B `useHasHydrated` 门控或 Task-0B `SsrSafeSkeleton`，确保 SSR == client-first-render（§D.3）。本欢迎屏的设计目标就是**零动态内容**——纯静态确定性 markup（最简单的 #418-safe）。

**验收：**

- `routes/index.tsx` `UserView` 不再 import/render `IdentityBar`/`UsageDashboard`（除非别处仍用——grep 确认；`UserView` 内不用）。
- 渲染的是品牌欢迎 + 可达「登录」链接（`href="/login"`），无任何 `$`/KPI/模型数/`加载中…` 看板文案。
- 新文案全部 i18n（zh-CN/en），入 Phase-3 completeness 守卫。
- 暗色 + 双语下视觉/对比不回归；§B.0 不变清单不破（无 Kumo fork、无 token 覆盖、无 `shadow-*`）。
- #418：见 §D.3（这是本工作流的 LOCKED-INVARIANT-ADJACENT 核心）。

---

## §D.2 — `/login` 重塑（`auth/login-routes.ts` `loginPage()`）

**现状（`auth/login-routes.ts` `loginPage(errorMsg?, successEmail?)`@~117，re-anchor by symbol）：** 纯字符串 SSR HTML：`<!DOCTYPE html>` + 内联 `<style>`（system-ui、`#f5f5f5` 卡片、`#0f62fe` 按钮等硬编码十六进制）+ `<form method="POST" action="/login">`（email input + 「Send magic link」按钮）/ success / error 三态。无 React、无 Kumo、无 JS。

**目标：** 同一 Kumo 设计语言的品牌登录卡——

- **保留 SSR/无-JS 可用**：仍是 `loginPage()` 返回的字符串 HTML（不引 React island，不引 client JS），只重写内联 `<style>` 与 markup class，使其视觉对齐 Phase-3：品牌卡（圆角沿用 DESIGN.md `lg/xl`、`border` hairline、无 `shadow-*`——用 surface 层次造深度，与 §B.0 一致；`shadow` 现状违反 §B.0「无装饰阴影」，重塑时移除改用 hairline + elevated surface）、品牌主色按钮、可读对比（WCAG-AA）、**暗色安全**（`prefers-color-scheme: dark` 媒体查询或与门户 `data-mode` 一致的中性深色——因为是独立 SSR 页无 Kumo 运行时，用与 Kumo canvas/elevated 近似的确定性十六进制 + `@media (prefers-color-scheme: dark)`；这些十六进制是**该独立无-Kumo 登录页的局部确定性样式**，类比 §F.6 `ops-theme` 的「受批准例外」——在 spec 中显式登记为可接受局部硬编码：登录页是 Kumo 运行时之外的独立 SSR 文档，无法用 Kumo utility class，其内联样式十六进制是该页自包含的、与 Kumo 视觉对齐的确定性常量，非门户 token 体系内的硬编码违规）。
- **双语**：错误/成功/标签/按钮文案随请求语言（沿用 `auth/login-routes.ts` 现有语言来源——若现状是英文硬编码，重塑时不扩范围强加 i18n 框架到一个无-React 的字符串页；**最小**：保留现有文案语言行为不变，仅重排版/品牌化——除非现有代码已传入 locale，则文案随之。**不为登录页引入新的 i18n 运行时**，避免触碰安全流。spec 在此明确：登录页 i18n 范围 = 「不回归现有语言行为」，视觉重塑优先；若 plan 阶段确认 `login-routes.ts` 已有 locale 入参则文案随之双语，否则保持现状文案、只重塑外观）。
- **安全逻辑逐字不变**：`<form method="POST" action="/login">`、magic-link 签发/校验、CSRF、rate-limit、`BOOTSTRAP_ADMIN_EMAILS` allowlist、`maskEmail`、success/error 分支——**presentation-only**，仅改 `loginPage()` 返回的 HTML 字符串外观，不动任何路由 handler / token / cookie / 校验代码。

**验收：**

- `/login` SSR 字节体积合理增长（新样式），但仍是无-JS 可提交的 `<form>`；POST flow 行为与重塑前逐字一致（现有 login route 测试若有须全绿；新增一个断言：`loginPage()` 输出仍含 `<form method="POST" action="/login">` 且 email input + submit 仍在，error/success 两态 markup 仍生成）。
- 视觉对齐 Phase-3（品牌卡、无 `shadow-*`、hairline 深度、暗色安全、WCAG-AA 按钮对比）。
- 安全 handler 代码 0 改动（diff 仅 `loginPage()` 字符串体 + 可能的纯样式 helper）。

---

## §D.3 — #418 / hydration 不变量（LOCKED-INVARIANT-ADJACENT，本工作流核心）

`UserView` 是 `/` 在 `me===undefined`（未认证 + 认证-loading）时的 **SSR-emitted React 状态**。改 `UserView` = 改 `renderPortalSSR("/")` 的 SSR 输出。

**契约（已读 `hydration.test.tsx` + `server-impl.tsx` 确认）：**

- 未认证 SSR **不 seed** `ME_QUERY_KEY` → `useMe()` 在 SSR 与客户端首帧都 `undefined` → 两端都渲染 `UserView`。新 `UserView` 必须**确定性**（无 `Math.random`/`Date.now`/`window`/`document`/effect 控制首帧；本设计为纯静态欢迎屏——天然满足）。
- `hydration.test.tsx` 现有 2 个相关 case 必须更新：
  - **"unauthenticated → legacy UserView at /"**（`TASK_1W_CASES` 内，`identity` 空 + `initialData: null`）：断言里以 `#usage-panel-root`（旧 `UserView` 的 `<section id="usage-panel-root">` 标记）识别 UserView。重塑后该标记消失 → 该 case 必须改名为 "unauthenticated → restyled welcome at /"，并以新 `UserView` 的稳定标记（如 `#portal-welcome-root`，由 §D.1 实现给出）识别；hydrate 仍**无 mismatch**（SSR welcome == client welcome）。
  - 另一相关项：`TASK_1W_CASES` 的 `tenant_admin full-nav shell at /` 等是**已认证壳**路径（不经 `UserView`，Task-0B/§B 已覆盖），**不**因本工作流改变——但本 spec 要求 plan 显式确认这些非-UserView case 不回归（它们走 `TenantPortalShell`，与 `UserView` 重塑无耦合）。
- Task-3 的 NEW-C-A `/usage`/`/ops/usage` 平价 case、Task-0B 的 shell-skeleton case：**不**被本工作流触碰（不同路径）。本工作流只动 `UserView`（`/` 未认证态）。
- **验收硬指标：** `bun run test src/litellm-portal/hydration.test.tsx` → **全绿（更新后的全部 case，含新 welcome case + Task-0B 7/7 + Task-3 NEW-C-A）**。spec 把这记为「hydration 10/10」语义 = 「该文件全部 case 绿、`UserView` case 已迁到新 welcome 标记且 SSR==client」。plan 必须含一步证明此点（实跑该测试文件）。
- `/login` **不经 React/hydration**（独立 SSR 字符串页，不在 `renderPortalSSR` React 树内）→ 无 #418 面；其验收是「POST flow 不回归 + 视觉对齐」，不进 `hydration.test.tsx`。

**RETAINED-REVIEW 标记：** 本工作流 = public-entry（所有人第一印象）+ #418-LOCKED-INVARIANT-ADJACENT（改 SSR-emitted `/` 状态）+ login（security-adjacent，虽 presentation-only）。两个 impl 任务都标 **RETAINED-REVIEW**（先 spec + #418/security 评审，后 code-quality），与 Phase-3 Task-2C / Task-0B 同级。

---

## §D.4 — 时序与依赖

- 本 §D 工作流在 Phase-3 的**两个在飞 blocker 修复之后**落地：(B1) 过期 §F.3 测试修复；(B2) perf-spec 真实-auth 修复。本工作流依赖 **B2 的 session-cookie helper**——它使得能以「已认证」预览/验证（认证-loading flash 修复的人眼验收、以及确认 `me` resolve 后切到 §B 壳）。plan 在 Prerequisites 注明此依赖（不复制 B2 内容，只声明顺序）。
- 折入 **同一分支** `feat/litellm-portal-phase3-design-restyle`、**同一 whole-branch re-review**（PR #141 前的单次 critic）。不单独开 PR。
- §D 不属 §A hygiene-gate（§A GATE 是 §B 的前置）；§D 是 §B 的同族重塑扩展，排在 §B 之后（它消费 §B 的设计语汇 + Task-0B 的 `SsrSafeSkeleton`/`useHasHydrated` + Task-2 的 `Panel*`），但其 `hydration.test.tsx` 更新与 Task-0B 同处一文件 → **plan 必须声明：§D 的 hydration.test.tsx 编辑串行在 Task-0B 之后**（同文件序列化，禁并发）。

---

## 非目标（Out of scope）

- 不改 auth/magic-link/CSRF/rate-limit/allowlist 任何**逻辑**（`/login` 纯外观）。
- 不为 `/login`（无-React 字符串页）引入新 i18n 运行时/React island；不扩 IA、不新增路由。
- 不动 Phase-3 §A/§B/§C/§E/§F、Task-0/0B、Task-3 #418 工作流的任何既有代码/测试（仅**更新** `hydration.test.tsx` 的 `UserView` 那 1 个 case 到新标记——Task-0B 的 7/7、Task-3 NEW-C-A case 不动）。
- 不区分 unauth vs auth-loading（代码无信号——D2 已锁单一状态）。
- 不出像素稿（应用既有设计系统）。

---

## Self-Review

- **占位符扫描**：无 TBD/待定。§D.1 内容确切（品牌欢迎 + `/login` CTA，零动态内容→天然 #418-safe）。§D.2 边界确切（presentation-only，安全逻辑逐字不变，登录页内联十六进制显式登记为「无-Kumo 独立 SSR 页的可接受局部确定性样式」类比 §F.6 例外）。§D.3 #418 契约基于已读 `hydration.test.tsx`/`server-impl.tsx`/`use-me.ts` 真实事实（unauth 不 seed me、两端都渲 UserView、`#usage-panel-root` 旧标记需换、login 不经 hydration）。
- **内部一致性**：D1–D4 → §D.1/§D.2/§D.3/§D.4 一一编码。`useMe` 无 unauth/auth-loading 信号 → D2 单一状态决策与 §D.1 一致。#418 契约与 Phase-3 OQ-(b)/Task-0B 纪律一致（SSR 确定性、动态位 post-hydration——本设计零动态故最简）。i18n 复用 Phase-3 既有 `phase3-keys` 守卫。RETAINED-REVIEW 与 Task-2C/0B 同级。时序 B1/B2→§D、串行于 Task-0B 同文件、折入单一 re-review/PR #141。
- **范围 = 紧（应用既有系统到 2 表面）**：无新设计小节、无新 IA、无后端逻辑变更；建立在 Phase-3 已落 §B 语汇 + Task-0B + Task-2 之上。
- **越界检查**：未写代码、未跑构建/测试、未提交；仅本一个 spec md（plan 另文件）。
