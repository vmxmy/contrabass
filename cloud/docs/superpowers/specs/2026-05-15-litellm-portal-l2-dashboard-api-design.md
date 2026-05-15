# LiteLLM Portal — L2 Dashboard API 设计

- 日期: 2026-05-15
- 状态: 已批准设计,待 writing-plans
- 分支: `feat/litellm-do-sql-storage`
- 子项目: 三层拆解中的 **L2**(L1 数据平台 → **L2 API** → L3 Kumo 前端)
- 依赖: L1(`docs/superpowers/specs/2026-05-15-litellm-portal-usage-data-platform-design.md`)
- Plane: project `LPD`,本子项目对应 epic `LPD-2`

## 背景与动机

L1 已把用量数据备进 `UsageDO`(SQLite),并提供只读查询方法
(`queryTimeseries` / `queryModelBreakdown` / `queryHourOfDay` /
`queryPerUserSeries` / `queryRecentEvents` / `queryUserDetail` /
`queryKpiWithDelta`)。L2 在请求路径上把这些方法暴露为聚合 API,
**彻底移除请求路径对 LiteLLM 的直接读取**(现有
`/api/usage/timeseries`、`/api/admin/usage/timeseries` 仍直读 LiteLLM,
违反 CQRS 约束)。L3 前端将消费 L2 的聚合端点还原 reference dashboard。

## 范围

- **本 spec(L2)**:新增聚合 dashboard 端点;删除旧 timeseries 端点及其
  LiteLLM 读取路径;路由/鉴权接线;纯函数装配层 + 测试。
- **不在本 spec**:L1(已完成设计)、L3(前端 Kumo 还原与下钻 UI)。
- **不引入写操作**(沿用只读 trust 边界)。

## 已锁定决策

| 决策点 | 选择 |
|---|---|
| 接口形态 | 聚合端点(每 scope+window 一次请求返回整页面板) |
| 旧端点 | 直接废弃,只上聚合端点(连同其 LiteLLM 读取路径删除) |
| 成员下钻 | `?member=<userId>` 参数复用全局端点,只读,同响应形状 |

## § 1. 端点与契约

| 端点 | 守卫 | scope |
|---|---|---|
| `GET /api/dashboard?window=&grain=` | 登录身份 | 当前用户 `identity.litellmUserId` |
| `GET /api/admin/dashboard?window=&grain=` | `requireAdmin` | global |
| `GET /api/admin/dashboard?window=&grain=&member=<userId>` | `requireAdmin` | 该 userId(只读下钻) |

- 删除 `/api/usage/timeseries`、`/api/admin/usage/timeseries` 路由。
- handler 经 `env.USAGE_DO.get(env.USAGE_DO.idFromName("usage"))` 取 stub
  调 L1 查询方法(沿用 `IndexDO` / `spend-snapshot-cron` 的 DO stub 模式)。

## § 2. window / grain 目录与数据源映射

固定受控枚举(对齐 reference preset),非法值 → HTTP 400:

| window | grain(auto) | 取数源 |
|---|---|---|
| `24h` | hour | events |
| `48h` | hour | events |
| `7d` | day | events |
| `30d` | day | events |
| `90d` | day | daily(超过 events 30d 保留) |
| `12mo` | month | daily |

- `grain` 可显式覆盖,仅允许与该 window 兼容的粒度;不兼容时回落到该
  window 的 auto grain,并在响应 `grainFallback:true` 标注(非阻断)。
- 校验改为 window 驱动(替换现 `parseUsageTimeseriesRequest` 的
  grain 驱动逻辑),错误体沿用现有风格。
- `member=` 下钻只允许 `24h/48h/7d/30d`(均在 events 30d 保留窗口内);
  超出范围的 window + member 组合 → 400。

## § 3. 聚合响应形状

```jsonc
{
  "available": true,                 // UsageDO 无数据/未首次摄取时 false
  "scope": "self" | "global" | "member:<userId>",
  "window": "30d",
  "grain": "day",
  "grainFallback": false,
  "timezone": "Asia/Shanghai",
  "kpi": {
    "spend":       { "current": 0, "previous": 0, "deltaPct": 0 },
    "requests":    { "current": 0, "previous": 0, "deltaPct": 0 },
    "totalTokens": { "current": 0, "previous": 0, "deltaPct": 0 }
  },
  "trend":     [ { "startMs":0, "label":"", "totalTokens":0, "requests":0, "spend":0 } ],
  "models":    [ { "model":"", "spend":0, "totalTokens":0, "requests":0 } ],
  "hourOfDay": [ { "hour":0, "totalTokens":0, "requests":0, "spend":0 } ],   // 长度 24
  "perUser":   [ { "userId":"", "points":[ { "startMs":0, "spend":0 } ] } ], // 仅 global
  "recent":    [ { "tsMs":0, "model":"", "totalTokens":0, "spend":0 } ],     // 仅 self/member
  "summary":   { "userCount":0, "adminCount":0, "teamCount":0,
                 "totalSpend":0, "totalBudget":0, "riskCount":0 }            // 仅 global
}
```

- `self`:无 `perUser`、无 `summary`。
- `global`:无 `recent`。
- `member:<id>`:与 `self` 同形状,`scope` 为 `member:<userId>`。
- `perUser` topN = 8(按窗口内 spend 降序,由 `queryPerUserSeries` 提供)。
- `recent` limit = 20。
- `deltaPct`:`previous==0 && current>0` → 返回 `null`(前端显示"—"而非 ∞)。
- `summary` 复用现有 `/api/admin/summary` 的聚合逻辑(`admin.ts:adminSummary`),
  L2 内部调用其纯函数部分,不重复实现风险计算。

## § 4. 路由与鉴权接线

- 新增 `src/litellm-portal/dashboard.ts`,导出纯函数
  `buildDashboard(env, opts)`,`opts = { scope, window, grain }`,
  `scope ∈ { kind:"self", userId } | { kind:"global" } | { kind:"member", userId }`。
  内部 `Promise.all` 并行调 UsageDO 查询 + (global 时)admin summary,
  按 scope 裁剪字段后返回响应对象。
- `index.ts` 路由:
  - `/api/dashboard`:走现有身份解析,取 `identity.litellmUserId` 作 self scope。
  - `/api/admin/dashboard`:经现有 `requireAdmin` 中间件;`member` 查询参数
    仅在该路由解析,非 admin 不可达(中间件先于 handler)。
- 不改 L1 `UsageDO`;请求路径**零新增 `litellmFetch`**。
- window/grain 解析提取为 `dashboard.ts` 内 `parseDashboardRequest(url)`,
  替代 `timeseries.ts` 的 `parseUsageTimeseriesRequest`。

## § 5. 旧端点废弃与间隙风险

- 删除 `/api/usage/timeseries`、`/api/admin/usage/timeseries` 路由及
  `timeseries.ts` / `usage.ts` 中**仅服务于这两个端点**的 LiteLLM 读取路径。
- 时区/分桶等纯工具函数若被别处复用,迁入 `dashboard.ts` 或保留;
  不做无关重构,只移除 dead 的 LiteLLM 读取链。
- **已知风险(验收已接受)**:L2 上线到 L3 完成前,现有
  `app.tsx` / `chart.tsx` 调用的旧端点返回 404,个人用量图与管理员
  用量区不可用。此窗口期是预期代价,L3 紧跟收口。

## § 6. 错误与空数据语义

- UsageDO 未完成首次摄取或窗口内无数据:`available:false`,HTTP 200。
- 非法 window/grain:HTTP 400 `{ error:"unsupported_usage_window",
  allowed:[...] }`(沿用现有错误体风格)。
- `member=<userId>` 指向不存在/无数据用户:`available:false`,HTTP 200,
  **不返回 404**(避免用户枚举探测)。
- `requireAdmin` 失败:沿用现有 HTTP 403 `{ error:"admin_required" }`。
- UsageDO binding 未配置(`env.USAGE_DO` 缺失):`available:false` +
  服务端日志,不抛 500。

## § 7. 测试策略

- `dashboard.ts` 纯函数单测:mock UsageDO stub(`vi.fn()` 返回各查询
  结果),断言 self/global/member 三形状字段裁剪、`Promise.all` 装配、
  `deltaPct` 边界(prev=0)、`available:false` 透传、grain 回落标注。
- 路由集成测:沿用现有 `index.test.ts` 风格 —— 断言鉴权(`/api/dashboard`
  需登录、`/api/admin/dashboard` 需 admin、`member` 仅 admin 可用)、
  非法 window → 400、旧端点已 404。
- 表驱动 + `vitest`,与现有 `*.test.ts` 一致。

## 验收标准(L2)

1. 三个 scope(self/global/member)经聚合端点返回正确裁剪的形状,
   纯函数 + 路由测试通过。
2. 旧 `/api/usage/timeseries`、`/api/admin/usage/timeseries` 已删除并返回 404;
   仓库内请求路径无 `litellmFetch`(sync 路径不受影响)。
3. 鉴权:个人端点需登录、admin 端点与 `member` 参数需 admin。
4. 非法 window/grain → 400;无数据 → `available:false` 200。
5. 既有测试套件保持绿色;`tsc --noEmit` 0 error;wrangler dry-run 通过。

## 后续子项目(非本 spec)

- **L3**:Kumo 设计语言消费 L2 聚合端点还原 reference dashboard 图表与
  布局;只读成员下钻;两个数据缺口替代(状态列→按天成功率;成员
  "模型权限"→近 30d 实际使用模型)。
