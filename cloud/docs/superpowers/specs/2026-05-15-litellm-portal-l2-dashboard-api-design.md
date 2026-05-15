# LiteLLM Portal — L2 Dashboard API 设计

- 日期: 2026-05-15(经 Codex review 修订)
- 状态: 已批准设计(修订版),待用户复核 → writing-plans
- 分支: `feat/litellm-do-sql-storage`
- 子项目: 三层拆解中的 **L2**(L1 数据平台 → **L2 API** → L3 Kumo 前端)
- 依赖: L1 — spec `docs/superpowers/specs/2026-05-15-litellm-portal-usage-data-platform-design.md`,
  plan `docs/superpowers/plans/2026-05-15-litellm-portal-usage-data-platform.md`
- Plane: project `LPD`,本子项目对应 epic `LPD-2`

## 背景与动机

L1 把用量数据备进 `UsageDO`(SQLite)并提供只读查询方法。L2 在请求路径上
把它们暴露为聚合 API,**彻底移除请求路径对 LiteLLM 的直接读取**。L3 前端
消费 L2 还原 reference dashboard。

## 范围

- **本 spec(L2)**:新增聚合 dashboard 端点;删除旧 timeseries 端点及其
  LiteLLM 读取路径;DO-backed 全局 summary;路由/鉴权接线;纯函数装配层 + 测试。
- **不在本 spec**:L1(已完成设计)、L3(前端 UI)。**不引入写操作**。
- **明确不做(L1 as-built 限制)**:`90d` / `12mo` 长窗口、`month` 粒度。
  L1 查询方法仅读 `cb_usage_events`(30d 保留)、grain 仅 `hour|day`。
  长期趋势作为后续 L1/L2 增量,不在本期。

## 已锁定决策

| 决策点 | 选择 |
|---|---|
| 接口形态 | 聚合端点(每 scope+window 一次请求返回整页面板) |
| 旧端点 | 直接废弃并删除其 LiteLLM 读取路径 |
| 成员下钻 | `?member=<userId>` 复用全局端点,只读,同 self 响应形状 |
| 窗口目录 | 仅 `24h / 48h / 7d / 30d`(均 events-backed) |
| 全局 summary | 从 **IndexDO + UsageDO** 重算,**绝不调 LiteLLM / adminSummary** |

## § 1. 端点与契约

| 端点 | 守卫 | scope |
|---|---|---|
| `GET /api/usage/overview?window=&grain=` | 登录身份 | self(`identity.litellmUserId`) |
| `GET /api/admin/usage/overview?window=&grain=` | `requireAdmin` | global |
| `GET /api/admin/usage/overview?window=&grain=&member=<userId>` | `requireAdmin` | member(该 userId,只读) |

> 命名说明:/api/dashboard 已被既有 SSR portal 数据端点占用,故聚合用量端点采用 /api/usage/overview 与 /api/admin/usage/overview(替代被删除的 /api/usage/timeseries、/api/admin/usage/timeseries)。

- 删除路由 `/api/usage/timeseries`、`/api/admin/usage/timeseries`。
- handler 经 `env.USAGE_DO.get(env.USAGE_DO.idFromName("usage"))` 取 stub
  调 L1 查询方法(沿用 `IndexDO` / `spend-snapshot-cron` 的 DO stub 模式)。

## § 2. window / grain 目录与 L1 调用契约

固定受控枚举,非法值 → HTTP 400。**全部 events-backed**:

| window | auto grain | 兼容 grain | 上一周期可比? |
|---|---|---|---|
| `24h` | hour | hour | 是(prev 在 30d 保留内) |
| `48h` | hour | hour | 是 |
| `7d` | day | day | 是 |
| `30d` | day | day | **否**(prev 30d 落在 events 30d 保留期外) |

- L2 **自己**把 `window` 解析成 `{ fromMs, toMs }`(以 `Date.now()` 为
  `toMs`,按窗口长度回退得 `fromMs`),以及上一周期
  `{ previousFromMs = fromMs - len, previousToMs = fromMs }`,时区
  `Asia/Shanghai`。解析逻辑放 `dashboard.ts:parseDashboardRequest(url)`,
  替代 `timeseries.ts:parseUsageTimeseriesRequest`。
- 显式 `grain` 仅允许与该 window 兼容的粒度;不兼容时回落 auto grain 并在
  响应置 `grainFallback:true`(非阻断)。
- **按 L1 plan 实际签名调用**(L2 不改 L1):
  - `queryTimeseries({ scope, grain, fromMs, toMs })`
  - `queryModelBreakdown({ scope, fromMs, toMs })`
  - `queryHourOfDay({ scope, fromMs, toMs })`
  - `queryPerUserSeries({ grain, fromMs, toMs, topN })`(仅 global)
  - `queryRecentEvents({ userId, limit })`(仅 self/member;**与窗口无关**)
  - `queryKpiWithDelta({ scope, currentFromMs, currentToMs, previousFromMs, previousToMs })`
- `member=` 允许窗口与 self 相同(`24h/48h/7d/30d`)。

### scope 适配

L1 查询方法只接受 `{kind:"global"} | {kind:"user",userId}`。L2 内部
`toUsageScope(scope)`:`self` 与 `member` → `{kind:"user",userId}`;
`global` → `{kind:"global"}`。响应里的 `scope` 标签
(`"self"|"global"|"member:<id>"`)仅用于响应整形,不传给 L1。

## § 3. 聚合响应形状(discriminated union)

裁剪规则:**省略键本身,不返回 null**。`self`/`member` 同形状。

```jsonc
// 公共字段
{
  "available": true,            // 见 §6,仅平台级不可用时 false
  "empty": false,               // available 且窗口内零数据时 true
  "scope": "self" | "global" | "member:<userId>",
  "window": "30d",
  "grain": "day",
  "grainFallback": false,
  "timezone": "Asia/Shanghai",
  "kpi": {
    "spend":       { "current": 0, "previous": 0 | null, "deltaPct": 0 | null },
    "requests":    { "current": 0, "previous": 0 | null, "deltaPct": 0 | null },
    "totalTokens": { "current": 0, "previous": 0 | null, "deltaPct": 0 | null }
  },
  "trend":     [ { "startMs":0, "label":"", "totalTokens":0, "requests":0, "spend":0 } ],
  "models":    [ { "model":"", "spend":0, "totalTokens":0, "requests":0 } ],
  "hourOfDay": [ { "hour":0, "totalTokens":0, "requests":0, "spend":0 } ]   // 长度恒 24
}
// scope=global 额外: "perUser":[{ "userId":"", "points":[{ "startMs":0,"spend":0 }] }],
//                     "summary":{ ...见 §4 }
// scope=self|member 额外: "recent":[{ "tsMs":0,"model":"","totalTokens":0,"spend":0 }]
```

- `self`:**无** `perUser`、`summary` 键。
- `global`:**无** `recent` 键。
- `perUser` topN = 8(窗口内 spend 降序);`recent` limit = 20。
- **KPI delta 规则**:`previousFromMs < Date.now() - 30d`(超出 events 保留)
  时,`previous` 与 `deltaPct` 均为 `null`(前端显示"—")。据 §2 表:
  `24h/48h/7d` 返回真实环比;`30d` 的 `previous`/`deltaPct` 恒 `null`。
  否则 `deltaPct = previous>0 ? round((cur-prev)/prev*100) : (cur>0 ? null : 0)`。

## § 4. 全局 summary —— DO-backed 重算(不调 LiteLLM)

`scope=global` 的 `summary` **不复用 `admin.ts:adminSummary`**(其直读
LiteLLM,会违反 CQRS)。改为:

```jsonc
"summary": {
  "userCount": 0,     // IndexDO.listAllUsers 计数(分页累计,沿用既有上限语义)
  "adminCount": 0,    // IndexDO 中 role==="admin" 计数
  "teamCount": 0,     // IndexDO.listTeams().length
  "totalSpend": 0,    // UsageDO 全局窗口内 spend(queryKpiWithDelta.current.spend)
  "totalBudget": 0,   // IndexDO 各 UserRecord.maxBudget 求和(缺省视为 0)
  "riskCount": 0      // IndexDO maxBudget>0 且 该用户 UsageDO 窗口内 spend>maxBudget 的用户数
}
```

- `summary` 全部来自 **IndexDO(DO-backed 配置 SoT)+ UsageDO**,请求路径
  零 `litellmFetch`。
- `riskCount` 计算需逐用户 spend:用 `queryKpiWithDelta`(scope=user)或
  在 `buildDashboard` 内对 `IndexDO.listAllUsers` 的用户批量取 UsageDO
  窗口 spend;为控成本,沿用 IndexDO 既有分页上限,`summary` 标注
  `sampled:true` 当截断(与现有 admin summary 的 sampled 语义一致)。

## § 5. 路由与鉴权接线

- 新增 `src/litellm-portal/dashboard.ts`,导出纯函数
  `buildDashboard(deps, opts)`,`deps` 注入 UsageDO stub 与 IndexDO stub
  (便于测试),`opts={ scope, window, grain }`。内部 `Promise.all` 并行调
  L1 查询 +(global)IndexDO 计数,按 scope 整形。
- `index.ts` 路由:
  - `/api/usage/overview`:走现有身份解析,取 `identity.litellmUserId` → self。
  - `/api/admin/usage/overview`:经现有 `requireAdmin` 中间件;`member` 仅此路由
    解析(非 admin 经中间件先行拦截,不可达 handler)。
- 不改 L1 `UsageDO`;请求路径**零新增 `litellmFetch`**。

## § 6. 错误与空数据语义(修订)

- `available:false` **仅**用于平台级不可用:`env.USAGE_DO` 未配置 /
  UsageDO 未完成首次摄取 / 同步失败标记。HTTP 200。
- 窗口内合法零数据:`available:true` + `empty:true` + 空数组 + KPI 全 0
  (L1 查询对空数据返回空数组/零,L2 透传)。HTTP 200。
- 非法 window/grain:HTTP 400 `{ error:"unsupported_usage_window",
  allowed:["24h","48h","7d","30d"] }`(沿用现有错误体风格)。
- `member=<userId>` 不存在/无数据:`available:true,empty:true`,HTTP 200,
  **不 404**(避免用户枚举探测)。
- `requireAdmin` 失败:沿用现有 HTTP 403 `{ error:"admin_required" }`。

## § 7. 旧端点废弃与间隙风险(精确化)

- 删除路由 `/api/usage/timeseries`、`/api/admin/usage/timeseries`,并移除
  `timeseries.ts` / `usage.ts` 中**仅服务于这两个端点**的 LiteLLM 读取链;
  被别处复用的纯工具函数(时区/分桶)保留或迁入 `dashboard.ts`,不做无关重构。
- **刻意接受的破坏性变更**(用户已拍板):L2 上线到 L3 完成前,以下前端
  调用点将 404,个人用量图与管理员用量区不可用:
  - `src/litellm-portal/app.tsx:725`(`/api/usage/timeseries`)
  - `src/litellm-portal/hooks/use-admin-usage.ts:12` /
    `src/litellm-portal/admin-components.tsx:938`(`/api/admin/usage/timeseries`)
- 缓解:**L2 与 L3 应紧邻发布**(spec 记录此约束);若需更稳,L3 可先于
  L2 删除旧端点前接好新端点(发布顺序由 L3 plan 决定)。

## § 8. 测试策略

- `dashboard.ts` 纯函数单测:注入 mock UsageDO + IndexDO stub(`vi.fn()`),
  断言:self/global/member 三形状的**键省略**(`expect(res).not.toHaveProperty("perUser")`
  等)、`Promise.all` 装配、`deltaPct`/`previous` 在 30d 窗口为 `null`、
  `empty` 与 `available` 语义、`grainFallback`、`toUsageScope` 映射、
  summary 的 IndexDO 计数与 riskCount 计算、sampled 截断。
- 路由集成测:沿用 `index.test.ts` 风格 —— 鉴权(self 需登录、admin 端点
  与 `member` 需 admin、`/api/usage/overview` 与 `/api/admin/usage/overview`)、
  非法 window→400、旧端点已 404、请求路径无 `litellmFetch`(可用模块级 spy 断言)。
- 表驱动 + `vitest`。

## 验收标准(L2)

1. self/global/member 经聚合端点(`/api/usage/overview`、`/api/admin/usage/overview`)
   返回正确**省略键**的形状,纯函数+路由测试通过。
2. 旧 `/api/usage/timeseries`、`/api/admin/usage/timeseries` 删除并 404;
   仓库请求路径无 `litellmFetch`(sync 路径不受影响);summary 不调 adminSummary。
3. 鉴权正确(`/api/usage/overview` 需登录;`/api/admin/usage/overview` 需 admin);
   非法 window→400;平台不可用→`available:false`;空窗口→`available:true,empty:true`。
4. KPI 环比:`24h/48h/7d` 真实值;`30d` 的 previous/deltaPct 为 `null`。
5. 既有测试套件绿;`tsc --noEmit` 0 error;wrangler dry-run 通过。

## 经 Codex review 已纳入的修订

CRITICAL(adminSummary 重新引入 LiteLLM 读)→ §4 改 DO-backed;
HIGH(签名漂移/长窗口/perUser 长窗口)→ §2 改按 L1 实际签名 + 窗口收敛
`24h/48h/7d/30d`,§范围 明确不做 90d/12mo/month;
MEDIUM(available 混义、member 适配、KPI previous 不全)→ §6 拆分
`available/empty`、§2 `toUsageScope`、§3 KPI delta 30d=null 规则;
LOW(recent 非窗口、键裁剪契约)→ §2 标注 recent 与窗口无关、§3 改
discriminated union 省略键。保留用户已拍板的"删旧端点"决定,§7 精确化
404 调用点并要求 L2/L3 紧邻发布。

## 后续子项目(非本 spec)

- **L3**:Kumo 设计语言消费 L2 聚合端点还原 reference dashboard;只读
  成员下钻;数据缺口替代(状态列→按天成功率;成员"模型权限"→近 30d
  实际使用模型)。长期趋势(90d/12mo)若需要,先回 L1 增量再扩 L2。
