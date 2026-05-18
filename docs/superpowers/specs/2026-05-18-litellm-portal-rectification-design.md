# LiteLLM Portal — 系统性整改设计 spec

> 来源:Phase-3 上线后生产 E2E(browser-harness, zhiyun.ziikoo.com, 账号 xu@gz-zhiyun.com)+ 全站路由/页面审计 + LiteLLM 权威角色核对 + 两轮对抗评审。用户指令:「彻底梳理 web 端所有页面和路由设计(含登录后默认路由),需要整改」「全部纳入一个整改计划后再动手」。

**Goal:** 一次性修复 Phase-3 上线后暴露的系统性缺陷:i18n 运行时全失效、LiteLLM→portal 角色映射错误、登录后落地路由(Owner)与陈旧文案、嵌入 bundle 与源码漂移的部署缺口、路由卫生问题。

**Status:** 设计待用户评审 → 通过后产出实施 plan(writing-plans)→ 门控流水线执行(subagent-driven + RETAINED 评审 + 整分支重审 + 重新部署 + 生产复验)。

---

## 1. 证据与现状(全部生产实测/源码/bundle 取证)

| # | 缺陷 | 严重度 | 证据 |
|---|---|---|---|
| F1 | **i18n 运行时系统性失效** | **P0** | 无 `lingui.config.*`(全仓确认)→ 宏生成内容**hash id**(`mO90dp`);catalog `i18n/messages/{en,zh-CN}.ts` 按**源文本**键(`"登录":"Sign in"`);`setupI18n` `loadAndActivate` 加载源文本键对象;运行时 `i18n._()` 按 hash id 查 → **100% miss**;`build-litellm-portal-app.mjs:95` `NODE_ENV="production"` → @lingui/core 不装 message compiler → fallback **逐字、不插值**返回。后果:**(a) 整个英文 locale 失效**(永远渲染中文源);**(b) 全站每个带占位符的消息渲染字面 `{…}`**(`{0} / {1}`、`下载 {period}`、`{realActor} 正在代表团队 {effectiveTeamId}` 等)。生产实测 `{0} / {1}` 现身每个已认证页 shell summary bar(明暗双模、含无权页)。 |
| F2 | **LiteLLM→portal 角色映射错误** | **P1** | LiteLLM 权威:xu@gz-zhiyun.com = `user_id:"laoxu"`, `user_role:"proxy_admin_viewer"`, 属 2 个 team(`ea0e8075…`,`1255c10b…`)。portal 却解析为裸 tenant **member**(`/billing`、`/members` 返回「无权访问 该页面仅对团队管理员开放」,且看到 Owner 专属 Phase-2 横幅)。`roles.ts:resolveIdentity`→`getRole(...)` 的 LiteLLM 角色映射未把 `proxy_admin_viewer`+team 归属映射到应有的平台/租户角色。 |
| F3 | **登录后落地路由 + 陈旧文案 + 受众错误** | **P1** | `handleMagicCallback` 硬编码 302→`/`(`login-routes.ts:502-508`)。`/` 对 pure-Owner 渲染 `OwnerPhase2Notice`「运营控制台将在 Phase 2 提供 / Operations Console arrives in Phase 2」(`shell.tsx:176-194`),而 `/ops`(8 路由)已上线(#140)。无 Owner→`/ops` 落地。**且 member 账号 xu 也看到该横幅**(受众错误)。`en.ts:232-234` 仍映射陈旧英文。 |
| F4 | **部署 bundle 与源码漂移** | **P1 流程** | 已合并 PR #141 + 3 处 `{0}/{1}` 源码修(commit `2ca6f687`)后,`HEAD:app.generated.ts` 仍含旧 buggy bundle(`mO90dp`)→ 即使源码已修,生产仍坏,直到重生 bundle + 重部署。无任何闸保证嵌入 bundle == 源码。 |
| F5 | 路由卫生 | P2/P3 | D4 客户端 `requireAdminRoute` 无 client role seed(`router.tsx:113-122`,`admin-guard.ts`);D5 legacy redirect 双层重复(`index.ts:37-53` vs `legacy/redirects.tsx`);D6 `/ops/usage` 空壳(`global-usage.tsx` 4 行,无 loading/empty/error);D7 `/login`/`/magic-callback` 仅服务端、未注册 TanStack(`UserView` 已用原生 `<a>` 规避,后续若用 Kumo Link 会破,latent);D9 tenant 路由级 `MemberForbidden` 死分支(`tenant-portal/routes.tsx:92-96`)。 |
| OK | §B/§C/§D 视觉改版、明暗、暗色 WCAG、unauth §D 欢迎页、perf≈3s | ✓ PASS | 生产实测 |

> 对抗评审 vs 路由审计在 i18n 范围上曾矛盾;已用配置级证据(无 lingui.config + 源文本键 catalog + prod 无 compiler)**终局裁定 = 系统性**(对抗评审正确;路由审计的「源文本键匹配→可用」无效,因运行时按 hash 查)。

## 2. 根因与修复策略(逐项)

### F1 i18n(P0,系统性)— 需用户决策修复路线
三选一(spec 推荐 **方案B**):

- **方案A — catalog 改为按 hash id 键(标准 Lingui 流水线)**:接入 `@lingui/cli` `extract`+`compile`,catalog 由编译产物提供(键=宏 id)。最「正统」,但引入新构建步骤、catalog 全量重生、改动面最大,对刚上线项目风险高。
- **方案B(推荐)— 配置 Lingui 用「源文本/显式 id」,与现有源文本键 catalog 对齐**:加 `lingui.config`(或 babel/swc macro 选项)令宏 id = 源文本(非 hash);catalog 现状即源文本键,天然匹配。一处配置即修复**全站所有消息**(含英文 locale + 所有占位符),改动面最小、与现有 catalog 零冲突。需补:验证占位符消息在 prod-mode bundle 真实插值(非依赖 compiler)。
- **方案C — 生产保留 message compiler**:仅修占位符插值,**不修**英文 locale miss(英文仍回落中文源)→ 不充分,排除(至多作为 B 的补充验证手段)。

附:F1 之外 `screens/billing.tsx:63` `t\`下载 ${period}\``、`screens/members.tsx:90` `t\`请输入「${email}」以确认撤销\`` 用 JS 模板 `${}`(被宏求值成具体串,二次 miss)→ 一并改为正规 Lingui ICU `{period}`/`{email}` + catalog 键对齐(`en.ts:271,299`/`zh-CN.ts:270,298`)。

**验收:** 中英双 locale 全站无字面 `{…}`/`${…}`;英文 locale 真正渲染英文;新增 prod-mode(NODE_ENV=production)渲染测试覆盖一个占位符消息断言已插值(非 vacuous,回归宏/配置即红);RETAINED 评审。

### F2 角色映射(P1)
在 `roles.ts`/`getRole` 明确 LiteLLM `user_role` + team 归属 → portal `{platformRole, tenantRole, tenantTeamId}` 的映射规则:`proxy_admin`/`proxy_admin_viewer` 应映射为平台 Owner(viewer=只读 Owner),有 team 归属者按 team 角色给 `tenantRole`(tenant_admin/member),`tenantTeamId` 取其 team。需对 fail-closed/缓存(5min)既有哲学不破坏。**验收:** 单测覆盖 proxy_admin/proxy_admin_viewer/普通+team/无 team 各档;生产以 xu(proxy_admin_viewer+2 team)复验能进应有面;RETAINED(安全/越权类)两阶段评审。

### F3 登录后落地 + 文案(P1)
- pure-Owner 登录后落地策略:`/` 对 Owner 重定向 `/ops`,或把 `OwnerPhase2Notice` 替换为「进入运营控制台」有效入口(指向 `/ops`)。
- 退役「Phase 2」陈旧文案(`shell.tsx:176-194` + `en.ts:232-234`/`zh-CN` 对应);确保该提示**只对其目标受众**渲染(不对 member/普通租户)。
- 与 F2 联动:角色修正后再定义各角色(member/tenant_admin/Owner)登录后默认路由的一致行为(文档化)。

### F4 部署 bundle 漂移(P1 流程)
- 整改完成后重生 `app.generated.ts`(`bun run build:litellm-portal`)并提交。
- 加 CI/预提交闸:校验 `app.generated.ts` == 由当前源码重新构建的产物(漂移即 fail),杜绝「源码已修、bundle 未更新→生产仍坏」复发。`deploy:litellm-portal` 已含构建步骤,但合并到 main 的提交可能携带陈旧 bundle —— 闸放在 CI(PR 必过)。

### F5 路由卫生(P2/P3,随同一计划)
D4 client 注入 role context(或移除 `requireAdminRoute` 的 client 依赖,明确 server 为唯一权威);D5 合并 legacy redirect 单一来源(worker 层为权威,删 TanStack 死副本或反之,二选一文档化);D6 补全或移除 `/ops/usage`;D7 注释/守卫固化「`/login` 必用原生 `<a>`」并加测试;D9 删死分支。

## 3. 范围边界(YAGNI)
- 不重写 i18n 框架,不换设计系统,不动 §B/§C/§D 已验收视觉。
- 不新增页面(路由图完整,nav 目标均已注册——审计 D8 确认)。
- F5 仅做卫生项,不做投机重构。
- 不改 magic-link 认证机制(用户既定)。

## 4. 执行与验证(门控流水线)
spec(本文件,待用户评审)→ writing-plans 出 TDD 实施 plan → 新分支 off main `fix/litellm-portal-rectification` → subagent-driven 逐任务实现 + 两阶段评审(F1/F2 RETAINED:安全/契约/越权;F3/F4/F5 机械项 implementer-only)→ 整分支对抗重审 → PR → 合并(merge commit,不 rebase/squash)→ `bun run deploy:litellm-portal`(自 `cloud/`,裸 wrangler 500)→ 生产复验(中英双 locale 无字面占位符 / 英文真英文 / xu 以正确角色进应有面 / Owner 落地正确 / bundle 闸生效)+ V2.0 复跑。本地 vitest 全绿(仅 2 个既存豁免)+ typecheck 仅基线 + build 绿 + e2e:perf CLS<0.1。

## 5. 用户决策(已拍板 2026-05-18)
1. **F1 修复路线 = 方案A**:接入标准 `@lingui/cli` `extract`+`compile` 流水线。catalog 由编译产物提供(键=宏 hash id),与运行时 `i18n._()` 的 hash id 查询对齐;编译产物为 token 数组 → prod 即使无 runtime compiler 也能插值;英文 locale 同时修复。须:加 `lingui.config`、迁移现有 zh-CN/en 源文本译文进新流水线(译文不丢)、接入 `build:litellm-portal`、补 prod-mode 非 vacuous 插值回归测试。
2. **F3 Owner 落地 = 先按角色修正再定落地**:先完成 F2(角色映射),再基于正确角色重新设计 member/tenant_admin/Owner 各自登录后默认路由(plan 内一个带子决策的任务);退役陈旧 Phase-2 文案、修正受众。
3. **范围 = F1–F5 全纳入一个计划一并执行**(门控流水线)。

执行序:F1(方案A,P0,RETAINED)→ F2(角色,P1,RETAINED 安全/越权)→ F3(落地+文案,依赖 F2)→ F4(bundle 重生 + CI 漂移闸,P1 流程)→ F5(路由卫生,P2/P3)→ 整分支重审 → PR → 合并 → 重部署 → 生产复验 + V2.0。

### 5.1 计划编制阶段的真码勘误(plan 已据实锚定,spec 同步更正)
- **F2 真实缺陷点更正**:不在 `roles.ts:getRole`,而在 `role-cache.ts:117-138 resolveRoleAndUserId` —— 它从 IndexDO 解析 role,**丢弃** `resolveLiteLLMUser` 已返回的 LiteLLM `user_role`/`teamIds`。这正是 xu(LiteLLM=proxy_admin_viewer+2 team)→ portal 裸 member 的精确根因。修复落在该丢弃点。
- **D4 降级**:client `requireAdminRoute` 实际**已**注入 role seed(`client.tsx:22,50`,`server-impl.tsx:115-120`)——原审计「无 client seed」过度断言。改为「server 为唯一权威」回归守卫,不再实现「缺失的 seed」。
- **D6 降级**:`ops-console/screens/global-usage.tsx` 实际委托 `<UsageDashboard initialScope="global"/>`,**非**空壳——原审计「4 行空壳」过度断言。改为保留 + 加冒烟回归测试,不做「补全/移除」。
- 佐证:`@lingui/cli` 当前**不在** package.json(Task 1 引入);prod 插值机制已对 `node_modules/@lingui/core` 源码核验(NODE_ENV=production 剥离 compiler;token 数组无需 runtime compiler 即可插值 → 方案A 成立);仓库无 litellm-portal CI job(F4 漂移闸落 vitest)。
- **F1 译文丢失补正(plan 新增 Task 3b)**:Task 2 的占位符重塑致 3 条 LIVE 消息的英文人工译文被 Task 3「逐字精确匹配」seed 漏掉(`billing.tsx:63 下载 {period}`、`members.tsx:90 请输入「{email}」以确认撤销`、`shell.tsx:204 {0} 正在代表团队 {1} …`)——legacy 键已变、msgid 不再字节相等。新增幂等 en-only 旧键→新消息 remap(扩展 seed 脚本,不重跑 extract、不动 zh-CN 源同一性、不改 legacy `.ts`),并加回归断言防复发。impersonation 经核验**非插值正确性 bug**(`<Trans>` 宏对 JSX 成员表达式提取为**位置参数** `{0}/{1}`,编译产物按位置绑定,运行时插值正确),仅译文丢失;Task 5 impersonation 回归断言同步改为位置 id+位置 values 以与该参数形态一致。
- **F1 Task 4 拆分(plan 新增 Task 4c)**:删除 legacy 源文本 `messages/{zh-CN,en}.ts` 会破坏 3 个 `src` i18n-completeness 测试(`ops-console`/`tenant-portal`/`phase3`,均直接 `import` 这些 map)——原 Task 4 未预见。Task 4 收敛为「仅运行时切换 + setup 测试」并保留 legacy map(独立绿);新增 Task 4c 将这 3 个完备性闸迁移到编译后 `.po`(msgid=源文本)为单一真值源——按文档化 `${x}`→`{x}`/花括号转义归一化断言源串已抽取、且双 locale `msgstr` 非空(扣除 en 端文档化的 ~52 net-new 空译白名单),保持非 vacuous,再 `git rm` 两个 legacy map。`scripts/seed-litellm-portal-catalogs.mjs` 删后导入失效属可接受的一次性死工具,不动。
- **F1 动态引用串可抽取化(plan 新增 Task 4d,位 Task 4 与 4c 之间)**:`errors/error-messages.ts` 的 36 条 §F.3 人性化错误串 + `tenant-portal/shell.tsx` 两个裸 SideNav 标题(`"我的"`/`"团队管理"`)是非宏包裹的 `Record<string,string>`/字面量,`lingui extract` 不可见 → Task 4c 完备性闸 BLOCKED(37 串缺失)。Task 4d 将 `MAP`/`GENERIC_FALLBACK` 改为 `@lingui/core/macro` `defineMessage`/`msg` 描述符(`errorMessage` 改返回 `descriptor.id` 这一 catalog hash,传输仍为 `string`、不改 `extract-error.ts`/任何 hook/`PanelError` 签名),两个标题改 `t\`\``,重跑 extract→seed(脚本加 `F3_EN` 忠实英文映射,人工撰写、Stage-1 RETAINED 逐串校真)→compile,RED→GREEN 测试锚定。**§F.3 严格收窄经构造保留并强化**:catalog id 必为已知键、裸技术串永非 hash id → `PanelError` 既有 `i18n.messages[raw]` 收窄不改即正确(且修复了裸 MAP 在 F1 后会静默退化为 generic 的潜在回归)。Task 4c 随之后置于 4d;`po-coverage.ts` 归一化新增「具名→位置」`{name}`→`{0},{1}`(首现序),与 `<Trans>` JSX 成员表达式抽取出的位置 msgid 对齐;空译白名单不再固定 52,后置 4d 后据实重导(应缩小趋空)。
