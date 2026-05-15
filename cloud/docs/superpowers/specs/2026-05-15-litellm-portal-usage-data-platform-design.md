# LiteLLM Portal — L1 用量数据平台设计

- 日期: 2026-05-15
- 状态: 已批准设计,待 writing-plans
- 分支: `feat/litellm-do-sql-storage`
- 子项目: 三层拆解中的 **L1**(L1 数据平台 → L2 API → L3 Kumo 前端)

## 背景与动机

目标是把 `litellm-portal` 改造成参考稿 `/Users/xumingyang/ai-platform-report/dashboard.html`
的功能与信息架构(模型占比饼图、用户消费排行、24h 时段分布、团队多线趋势、
KPI 环比、只读成员下钻),但**保留 Kumo-UI 设计语言**(浅色机构风、单品牌色、
扁平无阴影、药丸几何、等宽数字),而非照搬其深色配色。

硬约束(用户指定):**后端请求路径不允许直接读 LiteLLM,所有 spend / 用量数据
必须来自 DO SQLite。** sync(后台)路径读 LiteLLM 写 SQLite 是允许的——这是标准
CQRS 读模型。

调查发现当前 DO SQLite 只存配置类数据(`cb_index_teams/users/...` + 每队
`SpendSnapshot` 单标量),**没有任何时序、分模型、分时段、分用户、请求明细数据**;
现有 `/api/usage/timeseries` 直接读 LiteLLM `/spend/logs/v2`,在新约束下违规。
因此必须先建数据层,这是 L2/L3 的前置依赖。

## 范围

- **本 spec(L1)**:新建 `UsageDO`(DO SQLite),sync 摄取层,保留清理,
  以及供 L2 调用的只读查询 API。
- **不在本 spec**:L2(重写 `/api/usage/timeseries`、`/api/admin/*`、新增端点)、
  L3(Kumo 前端图表与布局、成员下钻)。各自后续开 spec。

## 已锁定决策

| 决策点 | 选择 |
|---|---|
| DO 拓扑 | 新建单个全局 `UsageDO`(`idFromName("usage")`) |
| 数据源 | 同时拉原始 `/spend/logs/v2` + `/user/daily/activity/aggregated` |
| 保留期 | 原始日志 30 天 / 日聚合 365 天 |
| 产品边界 | 只读(沿用现有 trust 边界,不引入写操作) |
| 目标 | 全量对齐 reference 的数据需求 |

## § 1. 架构与数据流

```
LiteLLM ──(sync,允许读)──> UsageDO(SQLite)──(请求路径,只读)──> L2 API ──> L3 前端
```

- 新建 `UsageDO`,单实例,与 `IndexDO` / `TeamConfigDO` 职责隔离。
- 两个 sync 入口挂到现有 `scheduled()` cron:
  - 日志摄取:增量拉 `/spend/logs/v2`,写明细行。
  - 日聚合刷新:拉 `/user/daily/activity/aggregated`,upsert 日聚合行
    (含成功/失败数、分模型 breakdown)。
- 请求路径(L2)只调 `UsageDO` 查询方法,**绝不 `litellmFetch`**。
  现有违规的 `/api/usage/timeseries` 在 L2 子项目改造;L1 只负责备好数据。

## § 2. SQLite Schema(UsageDO 内)

```sql
-- 原始请求明细(保留 30d)
CREATE TABLE IF NOT EXISTS cb_usage_events (
  request_id        TEXT PRIMARY KEY,   -- LiteLLM log id,幂等去重
  ts_ms             INTEGER NOT NULL,   -- 请求时间 epoch ms,UTC
  user_id           TEXT,
  team_id           TEXT,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  spend             REAL
);
CREATE INDEX IF NOT EXISTS cb_usage_events_ts_idx        ON cb_usage_events(ts_ms);
CREATE INDEX IF NOT EXISTS cb_usage_events_user_ts_idx   ON cb_usage_events(user_id, ts_ms);
CREATE INDEX IF NOT EXISTS cb_usage_events_model_ts_idx  ON cb_usage_events(model, ts_ms);

-- 日聚合(保留 365d),来源 daily/activity/aggregated
CREATE TABLE IF NOT EXISTS cb_usage_daily (
  date              TEXT NOT NULL,      -- YYYY-MM-DD(展示时区下的业务日)
  user_id           TEXT NOT NULL,
  model             TEXT NOT NULL,
  spend             REAL,
  total_tokens      INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  requests          INTEGER,
  success_requests  INTEGER,
  failed_requests   INTEGER,
  PRIMARY KEY (date, user_id, model)
);
CREATE INDEX IF NOT EXISTS cb_usage_daily_date_idx      ON cb_usage_daily(date);
CREATE INDEX IF NOT EXISTS cb_usage_daily_user_date_idx ON cb_usage_daily(user_id, date);

-- 同步水位/游标
CREATE TABLE IF NOT EXISTS cb_usage_sync_state (
  source       TEXT PRIMARY KEY,        -- 'spend_logs' | 'daily_activity'
  cursor_ms    INTEGER,
  last_run_iso TEXT,
  last_error   TEXT
);
```

要点:

- 成功/失败计数只存在 `cb_usage_daily`。`/spend/logs/v2` 无 per-request status
  字段(LiteLLM 硬限制);reference 的"最近请求表状态列"将在 L3 用按天成功率
  替代(L3 spec 定具体呈现)。
- 数据来源映射:
  - `cb_usage_events` → 24h 时段分布、最近请求明细、任意粒度趋势。
  - `cb_usage_daily` → 长期趋势、成功率、KPI 环比、分模型占比(长期)。
  - **KPI 环比数据源解析(架构 Option A)**:`queryKpiWithDelta` 按请求区间
    相对 30d events 视野对称解析 current/previous —— 区间全在 30d 内走
    `cb_usage_events`,全在 30d 外走 `cb_usage_daily`(`model='__all__'`
    全局总行),跨界 split。**daily 路径仅 global**:`cb_usage_daily` 行
    `user_id` 恒为哨兵 `__global__`,无 per-user 行,故 **user-scope 与
    `eventsOnly` 一律 events-only**;per-user 长期 KPI(daily-backed)为
    未来增量(Option B,需 importer 产出 per-user daily 行),本期不做。
- 时间统一存 epoch ms UTC;展示时区(默认 `Asia/Shanghai`)在 L2/L3 转换。
  `cb_usage_daily.date` 为展示时区下的业务日字符串,便于按日 GROUP BY。

## § 3. 摄取机制

- **增量游标**:`cb_usage_sync_state` 存每个 source 的 `cursor_ms`。日志摄取每次
  从 `cursor_ms - 5min`(重叠回看防边界丢单)开始拉取;靠 `request_id` 主键
  `INSERT OR IGNORE` 去重;tick 成功后推进 `cursor_ms = max(ts_ms ingested)`。
- **cadence**(复用现有 `scheduled()` cron):
  - 日志摄取:每 5 分钟。
  - 日聚合刷新:每小时,且每次刷新"今天 + 昨天"两天,以吸收 LiteLLM 迟到数据
    (upsert 覆盖 `cb_usage_daily` 对应行)。
- **首次回填**:部署后一次性 backfill —— 日志回填 30d、日聚合回填 365d。
  分页沿用现有 `PAGE_CAP=100` 模式;单次 tick 有页数与行数上限,跨 tick 靠游标
  续传;`limited` 标志透出到 sync 结果。
- **保留清理**:每日 cron 执行
  `DELETE FROM cb_usage_events WHERE ts_ms < now-30d`、
  `DELETE FROM cb_usage_daily WHERE date < now-365d`。

## § 4. UsageDO 查询 API(L2 调用面)

只读方法,全部参数化 SQL,内部完成时区与分桶:

| 方法 | 返回 |
|---|---|
| `queryTimeseries({scope, window, grain})` | buckets[](替代现有 timeseries) |
| `queryModelBreakdown({scope, window})` | `[{model, spend, tokens, requests}]` |
| `queryHourOfDay({scope, window})` | 24 桶 |
| `queryPerUserSeries({window, grain, topN})` | 多线趋势(团队视图) |
| `queryRecentEvents({user_id, limit})` | 最近明细(无 status) |
| `queryUserDetail({user_id, window})` | 成员下钻聚合(花费/请求/成功率/分模型/时段) |
| `queryKpiWithDelta({scope, window})` | 当期 + 上一可比期 → 环比 |

`scope` 取 `'global'` 或具体 `user_id`。`window` 为受控枚举(对齐现有
preset:24h/48h/7d/30d 等),不接受任意区间。

## § 5. 失败处理与边界

- sync 失败:记 `cb_usage_sync_state.last_error`,不阻断其他 source;游标不前进
  (下次重试,fail-safe 不丢数据)。
- 查询路径若 UsageDO 无数据 / 未完成首次摄取:返回 `available:false`,
  L2/L3 显示"数据同步中",**绝不回退读 LiteLLM**。
- 单 DO 体积:30d 日志按实际规模监控;若超阈值,先靠保留清理兜底,后续可加
  抽样/降采样,本期不优化、只监控。

## § 6. 测试策略

- `UsageDO` 用现有 `src/test/sql-storage.ts`(`node:sqlite` 模拟 `SqlStorage`)
  做单元测试:schema 建表、`INSERT OR IGNORE` 去重、游标推进、保留清理、
  各查询方法的分桶/时区/scope 正确性。
- sync 摄取:mock `litellmFetch`,断言增量游标、迟到数据吸收、分页续传、
  幂等重跑、`limited` 透出。
- 表驱动 + `vitest`,与现有 `*.test.ts` 风格一致。

## 验收标准(L1)

1. `UsageDO` 建表、去重、游标、保留清理、7 个查询方法均有通过的单元测试。
2. sync 摄取层在 mock LiteLLM 下能增量摄取且幂等重跑无重复。
3. 现有测试套件保持绿色;`UsageDO` 不与 `IndexDO`/`TeamConfigDO` 耦合。
4. 请求路径无新增 `litellmFetch`(L1 不改 L2 路由,但新增 DO API 供其调用)。

## 后续子项目(非本 spec)

- **L2**:重写 `/api/usage/timeseries`、`/api/admin/*` 改读 `UsageDO`;新增
  模型占比 / 时段 / 多线 / 成员详情 / 环比端点。
- **L3**:Kumo 设计语言还原 reference 图表与布局、只读成员下钻;两个数据缺口
  替代方案(状态列→按天成功率;成员"模型权限"chips→近 30d 实际使用过的模型)。
