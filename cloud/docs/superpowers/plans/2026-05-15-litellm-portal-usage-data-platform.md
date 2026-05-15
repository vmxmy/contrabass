# LiteLLM Portal L1 用量数据平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `UsageDO`(DO SQLite)+ sync 摄取层,把 LiteLLM 用量数据备进 SQLite,供后续 L2 只读查询,请求路径不再读 LiteLLM。

**Architecture:** CQRS 读模型。sync(后台 cron,允许读 LiteLLM)增量摄取 `/spend/logs/v2` 与 `/user/daily/activity/aggregated` 写入单个全局 `UsageDO` 的 SQLite 表;查询方法在 DO 内用参数化 SQL 完成分桶/时区聚合。L1 不改任何现有请求路由,只新增 DO 与 sync 入口。

**Tech Stack:** TypeScript, Cloudflare Durable Objects (SQLite storage), Zod, Vitest, `node:sqlite` 内存桩(`src/test/sql-storage.ts`)。

参考 spec: `docs/superpowers/specs/2026-05-15-litellm-portal-usage-data-platform-design.md`

---

## 关键既有模式(实现者必读)

- DO 类范式见 `src/litellm-portal/durable/index-do.ts`:`class XDO extends DurableObject<LiteLLMPortalEnv>`;惰性 `private async sql(): Promise<SqlStorage | null>` 经 `(this.ctx.storage as SqlCapableStorage).sql`;`initializeSql()` 内 `CREATE TABLE IF NOT EXISTS`;`firstRow(cursor)`、`type SqlRow = Record<string, SqlStorageValue>`、`sql.exec<T>(query, ...bindings)`。
- DO 测试范式见 `src/litellm-portal/durable/index-do.test.ts`:`makeTestSqlStorage()`(来自 `../../test/sql-storage`,node:sqlite 内存库)注入 `storage.sql`,`new XDO(ctx, env)`。
- sync 测试范式见 `src/litellm-portal/sync/spend-snapshot-cron.test.ts`:`globalThis.fetch = vi.fn().mockImplementation(...)` 桩 LiteLLM,DO stub 用 `vi.fn()`。
- litellm 辅助(`src/litellm-portal/litellm.ts`):`litellmFetch(env, path, init?)`、`extractRecords`、`firstString(rec, keys)`、`numberLikeField(rec, key)`、`litellmDateTime(date)`;`readJson` 在 `src/litellm-portal/utils.ts`,`isRecord` 同文件。
- spend-logs 解析参考 `src/litellm-portal/timeseries.ts`:日期字段 `["startTime","start_time","timestamp","created_at","createdAt"]`(数字按秒/毫秒判别);模型字段 `["model","model_name","modelName","model_id","modelGroup","model_group"]`;token/spend 回退链同 `addSpendLogRecordToBucket`。
- 展示时区 `Asia/Shanghai`,偏移 `+08:00`(见 `timeseries.ts` 顶部常量)。

## 文件结构

- 新建 `src/litellm-portal/durable/usage-do.ts` — `UsageDO` 类:schema、写入(`writeSpendEvents`、`upsertDailyRows`)、游标(`getSyncCursor`/`setSyncCursor`)、保留清理(`pruneRetention`)、7 个只读查询方法。
- 新建 `src/litellm-portal/durable/usage-do.test.ts` — `UsageDO` 单元测试。
- 新建 `src/litellm-portal/durable/usage-schemas.ts` — Zod 行/参数 schema 与 TS 类型。
- 新建 `src/litellm-portal/sync/usage-importer.ts` — `ingestSpendLogs(env)`、`refreshDailyActivity(env)`、`pruneUsageRetention(env)`。
- 新建 `src/litellm-portal/sync/usage-importer.test.ts` — sync 摄取测试。
- 修改 `src/litellm-portal/types.ts` — `LiteLLMPortalEnv` 增加 `USAGE_DO?: DurableObjectNamespace`。
- 修改 `src/litellm-portal/index.ts` — `scheduled()` 增加新 cron 分支并 export `UsageDO`。
- 修改 `wrangler.litellm-portal.toml` — 新增 `USAGE_DO` 绑定、migration tag `v5`、cron 触发器。

---

### Task 1: 环境绑定与 wrangler 配置

**Files:**
- Modify: `src/litellm-portal/types.ts:48-53`
- Modify: `wrangler.litellm-portal.toml:39-49`(绑定与 migration)
- Modify: `wrangler.litellm-portal.toml:141-142`(crons)

- [ ] **Step 1: 在 LiteLLMPortalEnv 增加 USAGE_DO**

在 `src/litellm-portal/types.ts` 中 `TEAM_CONFIG_DO?: DurableObjectNamespace;` 之后插入:

```typescript
  /** Singleton UsageDO owning spend-event + daily-activity SQLite tables.
   *  Sync cron writes; request path reads only. See spec
   *  docs/superpowers/specs/2026-05-15-litellm-portal-usage-data-platform-design.md */
  USAGE_DO?: DurableObjectNamespace;
```

- [ ] **Step 2: wrangler 绑定 + migration tag v5**

在 `wrangler.litellm-portal.toml` 的 `TEAM_CONFIG_DO` 绑定块之后(第 41-42 行后)插入:

```toml
[[durable_objects.bindings]]
name = "USAGE_DO"
class_name = "UsageDOSQLite"
```

在 `tag = "v4"` 的 migration 块之后追加:

```toml
# Step: add the new SQLite-backed UsageDO (usage data platform L1). New class,
# no rename/delete — additive, safe in a single deploy.
[[migrations]]
tag = "v5"
new_sqlite_classes = ["UsageDOSQLite"]
```

- [ ] **Step 3: 新增 cron 触发器**

将 `wrangler.litellm-portal.toml` 第 142 行:

```toml
crons = ["0 9 * * *", "* * * * *"]
```

改为:

```toml
crons = ["0 9 * * *", "* * * * *", "*/5 * * * *", "0 * * * *"]
```

- [ ] **Step 4: 提交**

```bash
git add cloud/src/litellm-portal/types.ts cloud/wrangler.litellm-portal.toml
git commit -m "chore(litellm-portal): add UsageDO binding, v5 migration, usage crons"
```

---

### Task 2: usage-schemas.ts — Zod 类型

**Files:**
- Create: `src/litellm-portal/durable/usage-schemas.ts`
- Test: (随 Task 3 一起验证;本任务仅类型,无独立运行测试)

- [ ] **Step 1: 写 schema 文件**

创建 `src/litellm-portal/durable/usage-schemas.ts`:

```typescript
import { z } from "zod";

/** One ingested spend-log row (raw request grain). */
export const SpendEventSchema = z.object({
  requestId: z.string().min(1),
  tsMs: z.number().int().nonnegative(),
  userId: z.string(),
  teamId: z.string(),
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  spend: z.number().nonnegative(),
}).strict();
export type SpendEvent = z.infer<typeof SpendEventSchema>;

/** One daily-activity rollup row. userId is "__global__" for aggregated source. */
export const DailyRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  userId: z.string(),
  model: z.string(),
  spend: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  successRequests: z.number().int().nonnegative().nullable(),
  failedRequests: z.number().int().nonnegative().nullable(),
}).strict();
export type DailyRow = z.infer<typeof DailyRowSchema>;

export const UsageSyncSource = z.enum(["spend_logs", "daily_activity"]);
export type UsageSyncSourceT = z.infer<typeof UsageSyncSource>;

export type UsageScope = { kind: "global" } | { kind: "user"; userId: string };

export type UsageWindowSpec = { fromMs: number; toMs: number };

export type TimeseriesBucket = {
  startMs: number;
  label: string;
  totalTokens: number;
  requests: number;
  spend: number;
};

export type ModelSlice = { model: string; spend: number; totalTokens: number; requests: number };
export type HourBucket = { hour: number; totalTokens: number; requests: number; spend: number };
export type RecentEvent = { tsMs: number; model: string; totalTokens: number; spend: number };
export type PerUserSeries = { userId: string; points: Array<{ startMs: number; spend: number }> };
export type UserDetail = {
  spend: number;
  requests: number;
  totalTokens: number;
  models: ModelSlice[];
  hours: HourBucket[];
};
export type KpiWithDelta = {
  current: { spend: number; requests: number; totalTokens: number };
  previous: { spend: number; requests: number; totalTokens: number };
};
```

- [ ] **Step 2: 提交**

```bash
git add cloud/src/litellm-portal/durable/usage-schemas.ts
git commit -m "feat(litellm-portal): usage data platform schemas"
```

---

### Task 3: UsageDO — schema 初始化

**Files:**
- Create: `src/litellm-portal/durable/usage-do.ts`
- Create: `src/litellm-portal/durable/usage-do.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/durable/usage-do.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { UsageDO } from "./usage-do";
import type { LiteLLMPortalEnv } from "../types";
import { makeTestSqlStorage } from "../../test/sql-storage";

function makeUsageDO() {
  const env = {} as LiteLLMPortalEnv;
  const ctx = { storage: { sql: makeTestSqlStorage() } } as unknown as DurableObjectState;
  return new UsageDO(ctx, env);
}

describe("UsageDO schema", () => {
  it("initializes tables and is idempotent across calls", async () => {
    const obj = makeUsageDO();
    // #when first write triggers schema init
    await obj.writeSpendEvents([]);
    // #then a second call must not throw (CREATE TABLE IF NOT EXISTS)
    await expect(obj.writeSpendEvents([])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: FAIL — `Cannot find module './usage-do'`

- [ ] **Step 3: 写 UsageDO 骨架 + schema**

创建 `src/litellm-portal/durable/usage-do.ts`:

```typescript
import { DurableObject } from "cloudflare:workers";
import type { LiteLLMPortalEnv } from "../types";
import { SpendEventSchema, type SpendEvent } from "./usage-schemas";

type SqlRow = Record<string, SqlStorageValue>;
type SqlCapableStorage = DurableObjectStorage & { sql?: SqlStorage };

function firstRow<T extends SqlRow>(cursor: SqlStorageCursor<T>): T | undefined {
  return cursor.toArray()[0];
}

export class UsageDO extends DurableObject<LiteLLMPortalEnv> {
  private sqlReady: Promise<SqlStorage | null> | null = null;

  private async sql(): Promise<SqlStorage | null> {
    if (this.sqlReady === null) {
      this.sqlReady = this.initializeSql();
    }
    return this.sqlReady;
  }

  private async initializeSql(): Promise<SqlStorage | null> {
    const sql = (this.ctx.storage as SqlCapableStorage).sql;
    if (sql == null || typeof sql.exec !== "function") return null;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS cb_usage_events (
        request_id TEXT PRIMARY KEY,
        ts_ms INTEGER NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        spend REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cb_usage_events_ts_idx ON cb_usage_events (ts_ms);
      CREATE INDEX IF NOT EXISTS cb_usage_events_user_ts_idx ON cb_usage_events (user_id, ts_ms);
      CREATE INDEX IF NOT EXISTS cb_usage_events_model_ts_idx ON cb_usage_events (model, ts_ms);
      CREATE TABLE IF NOT EXISTS cb_usage_daily (
        date TEXT NOT NULL,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        spend REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        success_requests INTEGER,
        failed_requests INTEGER,
        PRIMARY KEY (date, user_id, model)
      );
      CREATE INDEX IF NOT EXISTS cb_usage_daily_date_idx ON cb_usage_daily (date);
      CREATE INDEX IF NOT EXISTS cb_usage_daily_user_date_idx ON cb_usage_daily (user_id, date);
      CREATE TABLE IF NOT EXISTS cb_usage_sync_state (
        source TEXT PRIMARY KEY,
        cursor_ms INTEGER,
        last_run_iso TEXT,
        last_error TEXT
      );
    `);
    return sql;
  }

  async writeSpendEvents(events: SpendEvent[]): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    for (const raw of events) {
      const e = SpendEventSchema.parse(raw);
      sql.exec(
        `INSERT INTO cb_usage_events
           (request_id, ts_ms, user_id, team_id, model, prompt_tokens, completion_tokens, total_tokens, spend)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING`,
        e.requestId, e.tsMs, e.userId, e.teamId, e.model,
        e.promptTokens, e.completionTokens, e.totalTokens, e.spend,
      );
    }
  }
}

export { firstRow };
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/durable/usage-do.ts cloud/src/litellm-portal/durable/usage-do.test.ts
git commit -m "feat(litellm-portal): UsageDO schema + writeSpendEvents"
```

---

### Task 4: writeSpendEvents 去重 + 游标读写

**Files:**
- Modify: `src/litellm-portal/durable/usage-do.ts`
- Modify: `src/litellm-portal/durable/usage-do.test.ts`

- [ ] **Step 1: 写失败测试**

在 `usage-do.test.ts` 末尾追加:

```typescript
describe("UsageDO writeSpendEvents dedupe + cursor", () => {
  it("INSERT OR IGNORE dedupes by requestId across calls", async () => {
    const obj = makeUsageDO();
    const ev = {
      requestId: "r1", tsMs: 1000, userId: "u1", teamId: "t1", model: "gpt",
      promptTokens: 1, completionTokens: 2, totalTokens: 3, spend: 0.5,
    };
    await obj.writeSpendEvents([ev]);
    await obj.writeSpendEvents([{ ...ev, spend: 999 }]);
    // #then duplicate ignored — original spend retained, single row
    const recent = await obj.queryRecentEvents({ userId: "u1", limit: 10 });
    expect(recent).toEqual([{ tsMs: 1000, model: "gpt", totalTokens: 3, spend: 0.5 }]);
  });

  it("sync cursor get returns null then round-trips set", async () => {
    const obj = makeUsageDO();
    expect(await obj.getSyncCursor("spend_logs")).toBeNull();
    await obj.setSyncCursor("spend_logs", { cursorMs: 5000, lastError: null });
    expect(await obj.getSyncCursor("spend_logs")).toBe(5000);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: FAIL — `obj.queryRecentEvents is not a function`

- [ ] **Step 3: 实现 queryRecentEvents + 游标方法**

在 `UsageDO` 类内 `writeSpendEvents` 之后追加:

```typescript
  async queryRecentEvents(opts: { userId: string; limit: number }): Promise<
    Array<{ tsMs: number; model: string; totalTokens: number; spend: number }>
  > {
    const sql = await this.sql();
    if (sql === null) return [];
    // Clamp: SQLite LIMIT -1 means "no limit" — never let a caller request
    // an unbounded scan.
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), 1000);
    const rows = sql.exec<SqlRow>(
      `SELECT ts_ms, model, total_tokens, spend
         FROM cb_usage_events
        WHERE user_id = ?
        ORDER BY ts_ms DESC
        LIMIT ?`,
      opts.userId, limit,
    ).toArray();
    return rows.map((r) => ({
      tsMs: Number(r.ts_ms),
      model: String(r.model),
      totalTokens: Number(r.total_tokens),
      spend: Number(r.spend),
    }));
  }

  async getSyncCursor(source: string): Promise<number | null> {
    const sql = await this.sql();
    if (sql === null) return null;
    const row = firstRow(sql.exec<{ cursor_ms: number | null }>(
      "SELECT cursor_ms FROM cb_usage_sync_state WHERE source = ?",
      source,
    ));
    return row?.cursor_ms == null ? null : Number(row.cursor_ms);
  }

  async setSyncCursor(
    source: string,
    opts: { cursorMs: number; lastError: string | null },
  ): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    sql.exec(
      `INSERT INTO cb_usage_sync_state (source, cursor_ms, last_run_iso, last_error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         cursor_ms = excluded.cursor_ms,
         last_run_iso = excluded.last_run_iso,
         last_error = excluded.last_error`,
      source, opts.cursorMs, new Date().toISOString(), opts.lastError,
    );
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/durable/usage-do.ts cloud/src/litellm-portal/durable/usage-do.test.ts
git commit -m "feat(litellm-portal): UsageDO dedupe, queryRecentEvents, sync cursor"
```

---

### Task 5: upsertDailyRows + pruneRetention

**Files:**
- Modify: `src/litellm-portal/durable/usage-do.ts`
- Modify: `src/litellm-portal/durable/usage-do.test.ts`

- [ ] **Step 1: 写失败测试**

在 `usage-do.test.ts` 末尾追加:

```typescript
describe("UsageDO upsertDailyRows + pruneRetention", () => {
  it("upsert overwrites the (date,user,model) row", async () => {
    const obj = makeUsageDO();
    const base = {
      date: "2026-05-10", userId: "__global__", model: "gpt",
      spend: 1, totalTokens: 10, promptTokens: 4, completionTokens: 6,
      requests: 2, successRequests: 2, failedRequests: 0,
    };
    await obj.upsertDailyRows([base]);
    await obj.upsertDailyRows([{ ...base, spend: 9, requests: 5 }]);
    const k = await obj.queryKpiWithDelta({
      scope: { kind: "global" },
      currentFromMs: Date.parse("2026-05-10T00:00:00+08:00"),
      currentToMs: Date.parse("2026-05-11T00:00:00+08:00"),
      previousFromMs: Date.parse("2026-05-09T00:00:00+08:00"),
      previousToMs: Date.parse("2026-05-10T00:00:00+08:00"),
    });
    expect(k.current.spend).toBe(9);
    expect(k.current.requests).toBe(5);
  });

  it("pruneRetention deletes old events and old daily rows", async () => {
    const obj = makeUsageDO();
    const now = Date.parse("2026-05-15T12:00:00+08:00");
    await obj.writeSpendEvents([
      { requestId: "old", tsMs: now - 40 * 86400000, userId: "u1", teamId: "t", model: "m",
        promptTokens: 0, completionTokens: 0, totalTokens: 1, spend: 0 },
      { requestId: "fresh", tsMs: now - 1 * 86400000, userId: "u1", teamId: "t", model: "m",
        promptTokens: 0, completionTokens: 0, totalTokens: 1, spend: 0 },
    ]);
    await obj.upsertDailyRows([
      { date: "2024-01-01", userId: "__global__", model: "m", spend: 0, totalTokens: 0,
        promptTokens: 0, completionTokens: 0, requests: 0, successRequests: null, failedRequests: null },
    ]);
    await obj.pruneRetention(now);
    const recent = await obj.queryRecentEvents({ userId: "u1", limit: 10 });
    expect(recent.map((r) => r.tsMs)).toEqual([now - 1 * 86400000]);
    expect(await obj.countDailyRows()).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: FAIL — `obj.upsertDailyRows is not a function`

- [ ] **Step 3: 实现 upsertDailyRows / pruneRetention / countDailyRows**

在 `UsageDO` 内追加(`import` 行补 `DailyRowSchema, type DailyRow`):

文件顶部 import 改为:
```typescript
import { SpendEventSchema, type SpendEvent, DailyRowSchema, type DailyRow } from "./usage-schemas";
```

类内追加:
```typescript
  private static readonly EVENT_RETENTION_MS = 30 * 86400000;

  async upsertDailyRows(rows: DailyRow[]): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    for (const raw of rows) {
      const d = DailyRowSchema.parse(raw);
      sql.exec(
        `INSERT INTO cb_usage_daily
           (date, user_id, model, spend, total_tokens, prompt_tokens,
            completion_tokens, requests, success_requests, failed_requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date, user_id, model) DO UPDATE SET
           spend = excluded.spend,
           total_tokens = excluded.total_tokens,
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           requests = excluded.requests,
           success_requests = excluded.success_requests,
           failed_requests = excluded.failed_requests`,
        d.date, d.userId, d.model, d.spend, d.totalTokens, d.promptTokens,
        d.completionTokens, d.requests, d.successRequests, d.failedRequests,
      );
    }
  }

  async pruneRetention(nowMs: number): Promise<void> {
    const sql = await this.sql();
    if (sql === null) return;
    sql.exec(
      "DELETE FROM cb_usage_events WHERE ts_ms < ?",
      nowMs - UsageDO.EVENT_RETENTION_MS,
    );
    const cutoffDate = new Date(nowMs - 365 * 86400000).toISOString().slice(0, 10);
    sql.exec("DELETE FROM cb_usage_daily WHERE date < ?", cutoffDate);
  }

  async countDailyRows(): Promise<number> {
    const sql = await this.sql();
    if (sql === null) return 0;
    const row = firstRow(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cb_usage_daily"));
    return row?.n ?? 0;
  }
```

- [ ] **Step 4: 实现 queryKpiWithDelta(测试依赖)**

在 `UsageDO` 内追加:

```typescript
  async queryKpiWithDelta(opts: {
    scope: { kind: "global" } | { kind: "user"; userId: string };
    currentFromMs: number; currentToMs: number;
    previousFromMs: number; previousToMs: number;
    eventsOnly?: boolean;
  }): Promise<{
    current: { spend: number; requests: number; totalTokens: number };
    previous: { spend: number; requests: number; totalTokens: number };
  }> {
    const sql = await this.sql();
    const zero = { spend: 0, requests: 0, totalTokens: 0 };
    if (sql === null) return { current: { ...zero }, previous: { ...zero } };
    const userId = opts.scope.kind === "user" ? opts.scope.userId : null;
    // cb_usage_daily.date is an Asia/Shanghai (UTC+8) business date:
    // refreshDailyActivity requests LiteLLM with timezone=-480 so LiteLLM
    // buckets by Shanghai day, so these shDate() bounds match exactly.
    // The daily table holds per-model rows plus one synthetic model='__all__'
    // per-day total row; the fallback below filters model='__all__' so it
    // never double-counts per-model rows against the total.
    const SHANGHAI_TZ_MS = 8 * 60 * 60 * 1000;
    const shDate = (ms: number) =>
      new Date(ms + SHANGHAI_TZ_MS).toISOString().slice(0, 10);
    const agg = (fromMs: number, toMs: number) => {
      const where = userId === null ? "" : " AND user_id = ?";
      const args: SqlStorageValue[] = userId === null
        ? [fromMs, toMs] : [fromMs, toMs, userId];
      const row = firstRow(sql.exec<SqlRow>(
        `SELECT COALESCE(SUM(spend),0) AS s,
                COALESCE(SUM(total_tokens),0) AS t,
                COUNT(*) AS r
           FROM cb_usage_events
          WHERE ts_ms >= ? AND ts_ms < ?${where}`,
        ...args,
      ));
      return {
        spend: Number(row?.s ?? 0),
        totalTokens: Number(row?.t ?? 0),
        requests: Number(row?.r ?? 0),
      };
    };
    // For global daily-only data fall back to cb_usage_daily when no events.
    const current = agg(opts.currentFromMs, opts.currentToMs);
    const previous = agg(opts.previousFromMs, opts.previousToMs);
    if (!opts.eventsOnly && current.requests === 0 && current.spend === 0) {
      const dRow = firstRow(sql.exec<SqlRow>(
        `SELECT COALESCE(SUM(spend),0) AS s, COALESCE(SUM(total_tokens),0) AS t,
                COALESCE(SUM(requests),0) AS r
           FROM cb_usage_daily
          WHERE date >= ? AND date < ? AND model = '__all__'${userId === null ? "" : " AND user_id = ?"}`,
        ...(userId === null
          ? [shDate(opts.currentFromMs), shDate(opts.currentToMs)]
          : [shDate(opts.currentFromMs), shDate(opts.currentToMs), userId]),
      ));
      if (dRow) {
        current.spend = Number(dRow.s);
        current.totalTokens = Number(dRow.t);
        current.requests = Number(dRow.r);
      }
    }
    return { current, previous };
  }
```

- [ ] **Step 5: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: 提交**

```bash
git add cloud/src/litellm-portal/durable/usage-do.ts cloud/src/litellm-portal/durable/usage-do.test.ts cloud/src/litellm-portal/durable/usage-schemas.ts
git commit -m "feat(litellm-portal): UsageDO daily upsert, retention prune, kpi delta"
```

---

### Task 6: 查询方法 — timeseries + modelBreakdown

**Files:**
- Modify: `src/litellm-portal/durable/usage-do.ts`
- Modify: `src/litellm-portal/durable/usage-do.test.ts`

- [ ] **Step 1: 写失败测试**

在 `usage-do.test.ts` 末尾追加:

```typescript
describe("UsageDO queryTimeseries + queryModelBreakdown", () => {
  const day0 = Date.parse("2026-05-12T10:00:00+08:00");
  const day1 = Date.parse("2026-05-13T10:00:00+08:00");

  async function seed(obj: UsageDO) {
    await obj.writeSpendEvents([
      { requestId: "a", tsMs: day0, userId: "u1", teamId: "t", model: "gpt",
        promptTokens: 1, completionTokens: 1, totalTokens: 2, spend: 1 },
      { requestId: "b", tsMs: day1, userId: "u1", teamId: "t", model: "gpt",
        promptTokens: 1, completionTokens: 1, totalTokens: 3, spend: 2 },
      { requestId: "c", tsMs: day1, userId: "u2", teamId: "t", model: "claude",
        promptTokens: 1, completionTokens: 1, totalTokens: 5, spend: 4 },
    ]);
  }

  it("queryTimeseries day grain buckets by Asia/Shanghai day, global scope", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryTimeseries({
      scope: { kind: "global" }, grain: "day",
      fromMs: Date.parse("2026-05-12T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(r.map((b) => [b.label, b.spend, b.requests])).toEqual([
      ["05-12", 1, 1],
      ["05-13", 6, 2],
    ]);
  });

  it("queryModelBreakdown aggregates per model, user scope", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryModelBreakdown({
      scope: { kind: "user", userId: "u1" },
      fromMs: Date.parse("2026-05-12T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(r).toEqual([{ model: "gpt", spend: 3, totalTokens: 5, requests: 2 }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: FAIL — `obj.queryTimeseries is not a function`

- [ ] **Step 3: 实现时区辅助 + 两个查询**

在 `usage-do.ts` 顶部 `firstRow` 之后追加时区辅助:

```typescript
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai

function shanghaiDayLabel(tsMs: number): string {
  const d = new Date(tsMs + TZ_OFFSET_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function shanghaiDayStartMs(tsMs: number): number {
  const d = new Date(tsMs + TZ_OFFSET_MS);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return utcMidnight - TZ_OFFSET_MS;
}

function shanghaiHourStartMs(tsMs: number): number {
  const d = new Date(tsMs + TZ_OFFSET_MS);
  const utcHour = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  return utcHour - TZ_OFFSET_MS;
}

function shanghaiHourLabel(tsMs: number): string {
  const d = new Date(tsMs + TZ_OFFSET_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:00`;
}
```

在 `UsageDO` 内追加:

```typescript
  private scopeClause(
    scope: { kind: "global" } | { kind: "user"; userId: string },
  ): { clause: string; arg: string | null } {
    return scope.kind === "user"
      ? { clause: " AND user_id = ?", arg: scope.userId }
      : { clause: "", arg: null };
  }

  async queryTimeseries(opts: {
    scope: { kind: "global" } | { kind: "user"; userId: string };
    grain: "hour" | "day";
    fromMs: number; toMs: number;
  }): Promise<Array<{ startMs: number; label: string; totalTokens: number; requests: number; spend: number }>> {
    const sql = await this.sql();
    if (sql === null) return [];
    const { clause, arg } = this.scopeClause(opts.scope);
    const args: SqlStorageValue[] = arg === null
      ? [opts.fromMs, opts.toMs] : [opts.fromMs, opts.toMs, arg];
    const rows = sql.exec<SqlRow>(
      `SELECT ts_ms, total_tokens, spend
         FROM cb_usage_events
        WHERE ts_ms >= ? AND ts_ms < ?${clause}
        ORDER BY ts_ms ASC`,
      ...args,
    ).toArray();
    const buckets = new Map<number, { totalTokens: number; requests: number; spend: number }>();
    for (const r of rows) {
      const ts = Number(r.ts_ms);
      const key = opts.grain === "day" ? shanghaiDayStartMs(ts) : shanghaiHourStartMs(ts);
      const cur = buckets.get(key) ?? { totalTokens: 0, requests: 0, spend: 0 };
      cur.totalTokens += Number(r.total_tokens);
      cur.requests += 1;
      cur.spend += Number(r.spend);
      buckets.set(key, cur);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([startMs, v]) => ({
        startMs,
        label: opts.grain === "day" ? shanghaiDayLabel(startMs) : shanghaiHourLabel(startMs),
        totalTokens: v.totalTokens,
        requests: v.requests,
        spend: Math.round(v.spend * 1e6) / 1e6,
      }));
  }

  async queryModelBreakdown(opts: {
    scope: { kind: "global" } | { kind: "user"; userId: string };
    fromMs: number; toMs: number;
  }): Promise<Array<{ model: string; spend: number; totalTokens: number; requests: number }>> {
    const sql = await this.sql();
    if (sql === null) return [];
    const { clause, arg } = this.scopeClause(opts.scope);
    const args: SqlStorageValue[] = arg === null
      ? [opts.fromMs, opts.toMs] : [opts.fromMs, opts.toMs, arg];
    const rows = sql.exec<SqlRow>(
      `SELECT model,
              COALESCE(SUM(spend),0) AS s,
              COALESCE(SUM(total_tokens),0) AS t,
              COUNT(*) AS r
         FROM cb_usage_events
        WHERE ts_ms >= ? AND ts_ms < ?${clause}
        GROUP BY model
        ORDER BY s DESC, t DESC`,
      ...args,
    ).toArray();
    return rows.map((r) => ({
      model: String(r.model),
      spend: Math.round(Number(r.s) * 1e6) / 1e6,
      totalTokens: Number(r.t),
      requests: Number(r.r),
    }));
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/durable/usage-do.ts cloud/src/litellm-portal/durable/usage-do.test.ts
git commit -m "feat(litellm-portal): UsageDO queryTimeseries + queryModelBreakdown"
```

---

### Task 7: 查询方法 — hourOfDay + perUserSeries + userDetail

**Files:**
- Modify: `src/litellm-portal/durable/usage-do.ts`
- Modify: `src/litellm-portal/durable/usage-do.test.ts`

- [ ] **Step 1: 写失败测试**

在 `usage-do.test.ts` 末尾追加:

```typescript
describe("UsageDO hourOfDay + perUserSeries + userDetail", () => {
  const t09 = Date.parse("2026-05-13T09:30:00+08:00");
  const t09b = Date.parse("2026-05-13T09:45:00+08:00");
  const t14 = Date.parse("2026-05-13T14:00:00+08:00");

  async function seed(obj: UsageDO) {
    await obj.writeSpendEvents([
      { requestId: "a", tsMs: t09, userId: "u1", teamId: "t", model: "gpt",
        promptTokens: 0, completionTokens: 0, totalTokens: 2, spend: 1 },
      { requestId: "b", tsMs: t09b, userId: "u1", teamId: "t", model: "gpt",
        promptTokens: 0, completionTokens: 0, totalTokens: 3, spend: 2 },
      { requestId: "c", tsMs: t14, userId: "u2", teamId: "t", model: "claude",
        promptTokens: 0, completionTokens: 0, totalTokens: 4, spend: 3 },
    ]);
  }

  it("queryHourOfDay returns 24 buckets, summed into hour-of-day", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryHourOfDay({
      scope: { kind: "global" },
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(r).toHaveLength(24);
    expect(r[9]).toEqual({ hour: 9, totalTokens: 5, requests: 2, spend: 3 });
    expect(r[14]).toEqual({ hour: 14, totalTokens: 4, requests: 1, spend: 3 });
    expect(r[0]).toEqual({ hour: 0, totalTokens: 0, requests: 0, spend: 0 });
  });

  it("queryPerUserSeries returns one series per user, topN by spend", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const r = await obj.queryPerUserSeries({
      grain: "day",
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
      topN: 5,
    });
    const u2 = r.find((s) => s.userId === "u2");
    const u1 = r.find((s) => s.userId === "u1");
    expect(u2?.points[0].spend).toBe(3);
    expect(u1?.points[0].spend).toBe(3);
  });

  it("queryUserDetail aggregates models + hours for one user", async () => {
    const obj = makeUsageDO();
    await seed(obj);
    const d = await obj.queryUserDetail({
      userId: "u1",
      fromMs: Date.parse("2026-05-13T00:00:00+08:00"),
      toMs: Date.parse("2026-05-14T00:00:00+08:00"),
    });
    expect(d.spend).toBe(3);
    expect(d.requests).toBe(2);
    expect(d.models).toEqual([{ model: "gpt", spend: 3, totalTokens: 5, requests: 2 }]);
    expect(d.hours[9]).toEqual({ hour: 9, totalTokens: 5, requests: 2, spend: 3 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: FAIL — `obj.queryHourOfDay is not a function`

- [ ] **Step 3: 实现三个查询**

在 `UsageDO` 内追加:

```typescript
  async queryHourOfDay(opts: {
    scope: { kind: "global" } | { kind: "user"; userId: string };
    fromMs: number; toMs: number;
  }): Promise<Array<{ hour: number; totalTokens: number; requests: number; spend: number }>> {
    const sql = await this.sql();
    const out = Array.from({ length: 24 }, (_, hour) => ({
      hour, totalTokens: 0, requests: 0, spend: 0,
    }));
    if (sql === null) return out;
    const { clause, arg } = this.scopeClause(opts.scope);
    const args: SqlStorageValue[] = arg === null
      ? [opts.fromMs, opts.toMs] : [opts.fromMs, opts.toMs, arg];
    const rows = sql.exec<SqlRow>(
      `SELECT ts_ms, total_tokens, spend
         FROM cb_usage_events
        WHERE ts_ms >= ? AND ts_ms < ?${clause}`,
      ...args,
    ).toArray();
    for (const r of rows) {
      const d = new Date(Number(r.ts_ms) + TZ_OFFSET_MS);
      const h = d.getUTCHours();
      out[h].totalTokens += Number(r.total_tokens);
      out[h].requests += 1;
      out[h].spend += Number(r.spend);
    }
    for (const b of out) b.spend = Math.round(b.spend * 1e6) / 1e6;
    return out;
  }

  async queryPerUserSeries(opts: {
    grain: "hour" | "day";
    fromMs: number; toMs: number; topN: number;
  }): Promise<Array<{ userId: string; points: Array<{ startMs: number; spend: number }> }>> {
    const sql = await this.sql();
    if (sql === null) return [];
    // Clamp: SQLite LIMIT -1 = "no limit"; bound topN to a sane range.
    const topN = Math.min(Math.max(1, Math.trunc(opts.topN)), 100);
    const top = sql.exec<SqlRow>(
      `SELECT user_id, COALESCE(SUM(spend),0) AS s
         FROM cb_usage_events
        WHERE ts_ms >= ? AND ts_ms < ?
        GROUP BY user_id
        ORDER BY s DESC
        LIMIT ?`,
      opts.fromMs, opts.toMs, topN,
    ).toArray().map((r) => String(r.user_id));
    const series: Array<{ userId: string; points: Array<{ startMs: number; spend: number }> }> = [];
    for (const userId of top) {
      const rows = sql.exec<SqlRow>(
        `SELECT ts_ms, spend FROM cb_usage_events
          WHERE user_id = ? AND ts_ms >= ? AND ts_ms < ?
          ORDER BY ts_ms ASC`,
        userId, opts.fromMs, opts.toMs,
      ).toArray();
      const m = new Map<number, number>();
      for (const r of rows) {
        const key = opts.grain === "day"
          ? shanghaiDayStartMs(Number(r.ts_ms))
          : shanghaiHourStartMs(Number(r.ts_ms));
        m.set(key, (m.get(key) ?? 0) + Number(r.spend));
      }
      series.push({
        userId,
        points: [...m.entries()].sort((a, b) => a[0] - b[0])
          .map(([startMs, spend]) => ({ startMs, spend: Math.round(spend * 1e6) / 1e6 })),
      });
    }
    return series;
  }

  async queryUserDetail(opts: {
    userId: string; fromMs: number; toMs: number;
  }): Promise<{
    spend: number; requests: number; totalTokens: number;
    models: Array<{ model: string; spend: number; totalTokens: number; requests: number }>;
    hours: Array<{ hour: number; totalTokens: number; requests: number; spend: number }>;
  }> {
    const scope = { kind: "user" as const, userId: opts.userId };
    const [models, hours, kpi] = await Promise.all([
      this.queryModelBreakdown({ scope, fromMs: opts.fromMs, toMs: opts.toMs }),
      this.queryHourOfDay({ scope, fromMs: opts.fromMs, toMs: opts.toMs }),
      this.queryKpiWithDelta({
        scope,
        currentFromMs: opts.fromMs, currentToMs: opts.toMs,
        previousFromMs: opts.fromMs, previousToMs: opts.fromMs,
        eventsOnly: true,
      }),
    ]);
    return {
      spend: kpi.current.spend,
      requests: kpi.current.requests,
      totalTokens: kpi.current.totalTokens,
      models,
      hours,
    };
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/durable/usage-do.ts cloud/src/litellm-portal/durable/usage-do.test.ts
git commit -m "feat(litellm-portal): UsageDO hourOfDay, perUserSeries, userDetail"
```

---

### Task 8: sync — ingestSpendLogs(增量摄取)

**Files:**
- Create: `src/litellm-portal/sync/usage-importer.ts`
- Create: `src/litellm-portal/sync/usage-importer.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/litellm-portal/sync/usage-importer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestSpendLogs } from "./usage-importer";
import type { LiteLLMPortalEnv } from "../types";

function makeUsageStub() {
  let cursor: number | null = null;
  return {
    getSyncCursor: vi.fn(async () => cursor),
    setSyncCursor: vi.fn(async (_s: string, o: { cursorMs: number }) => { cursor = o.cursorMs; }),
    writeSpendEvents: vi.fn(async () => undefined),
  };
}

function makeEnv(usageStub: unknown): LiteLLMPortalEnv {
  return {
    LITELLM_BASE_URL: "https://litellm.test",
    LITELLM_MASTER_KEY: "k",
    USAGE_DO: {
      idFromName: (n: string) => ({ name: n }),
      get: () => usageStub,
    } as unknown,
  } as unknown as LiteLLMPortalEnv;
}

describe("ingestSpendLogs", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("writes parsed events and advances cursor to max ts", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { request_id: "r1", startTime: "2026-05-13T01:00:00", user_id: "u1",
          team_id: "t1", model: "gpt", prompt_tokens: 1, completion_tokens: 2,
          total_tokens: 3, spend: 0.5 },
      ],
      total_pages: 1,
    }), { status: 200 }));
    const r = await ingestSpendLogs(env);
    expect(r.ingested).toBe(1);
    expect(usage.writeSpendEvents).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: "r1", userId: "u1", totalTokens: 3, spend: 0.5 }),
    ]);
    expect(usage.setSyncCursor).toHaveBeenCalledWith(
      "spend_logs",
      expect.objectContaining({ lastError: null }),
    );
  });

  it("records lastError and does not advance cursor on fetch failure", async () => {
    const usage = makeUsageStub();
    const env = makeEnv(usage);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const r = await ingestSpendLogs(env);
    expect(r.ingested).toBe(0);
    expect(r.error).toBeTruthy();
    const lastCall = usage.setSyncCursor.mock.calls.at(-1);
    expect(lastCall?.[1].lastError).toBeTruthy();
  });

  it("returns gracefully when USAGE_DO unset", async () => {
    const r = await ingestSpendLogs({ LITELLM_BASE_URL: "x", LITELLM_MASTER_KEY: "x" } as LiteLLMPortalEnv);
    expect(r.ingested).toBe(0);
    expect(r.error).toContain("USAGE_DO");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/sync/usage-importer.test.ts`
Expected: FAIL — `Cannot find module './usage-importer'`

- [ ] **Step 3: 实现 ingestSpendLogs**

创建 `src/litellm-portal/sync/usage-importer.ts`:

```typescript
import type { LiteLLMPortalEnv } from "../types";
import type { UsageDO } from "../durable/usage-do";
import type { SpendEvent } from "../durable/usage-schemas";
import { litellmFetch, firstString, numberLikeField, litellmDateTime } from "../litellm";
import { readJson, isRecord } from "../utils";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const LOOKBACK_MS = 5 * 60 * 1000;
const BACKFILL_MS = 30 * 86400000;

export type IngestResult = { ingested: number; error: string | null };

function usageStub(env: LiteLLMPortalEnv): UsageDO | null {
  if (!env.USAGE_DO) return null;
  return env.USAGE_DO.get(env.USAGE_DO.idFromName("usage")) as unknown as UsageDO;
}

function parseEventDate(record: Record<string, unknown>): number | undefined {
  for (const key of ["startTime", "start_time", "timestamp", "created_at", "createdAt"]) {
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 10_000_000_000 ? v * 1000 : v;
    }
    if (typeof v === "string" && v.trim().length > 0) {
      const norm = v.includes("T") ? v : v.replace(" ", "T");
      // Match timeseries.ts: bare YYYY-MM-DD → UTC midnight; otherwise append Z if no tz.
      const withTz = /(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(norm)
        ? norm
        : /^\d{4}-\d{2}-\d{2}$/u.test(norm)
          ? `${norm}T00:00:00.000Z`
          : `${norm}Z`;
      const t = Date.parse(withTz);
      if (!Number.isNaN(t)) return t;
    }
  }
  return undefined;
}

function toSpendEvent(record: Record<string, unknown>): SpendEvent | null {
  const tsMs = parseEventDate(record);
  if (tsMs === undefined) return null;
  const requestId = firstString(record, ["request_id", "requestId", "id", "log_id"])
    ?? `${tsMs}:${firstString(record, ["user_id", "userId"]) ?? ""}:${firstString(record, ["model", "model_name"]) ?? ""}`;
  const prompt = numberLikeField(record, "prompt_tokens") ?? numberLikeField(record, "promptTokens") ?? 0;
  const completion = numberLikeField(record, "completion_tokens") ?? numberLikeField(record, "completionTokens") ?? 0;
  const total = numberLikeField(record, "total_tokens") ?? numberLikeField(record, "totalTokens") ?? prompt + completion;
  return {
    requestId,
    tsMs,
    userId: firstString(record, ["user_id", "userId"]) ?? "",
    teamId: firstString(record, ["team_id", "teamId"]) ?? "",
    model: firstString(record, ["model", "model_name", "modelName", "model_id", "modelGroup", "model_group"]) ?? "",
    promptTokens: Math.max(0, Math.trunc(prompt)),
    completionTokens: Math.max(0, Math.trunc(completion)),
    totalTokens: Math.max(0, Math.trunc(total)),
    spend: Math.max(0, numberLikeField(record, "spend") ?? numberLikeField(record, "cost") ?? 0),
  };
}

function extractRows(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body)) return Array.isArray(body) ? body.filter(isRecord) : [];
  for (const key of ["data", "results", "logs", "spend_logs"]) {
    const nested = body[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

export async function ingestSpendLogs(env: LiteLLMPortalEnv): Promise<IngestResult> {
  const stub = usageStub(env);
  if (stub === null) return { ingested: 0, error: "USAGE_DO binding not configured" };

  const now = Date.now();
  const cursor = await stub.getSyncCursor("spend_logs");
  const startMs = cursor === null ? now - BACKFILL_MS : cursor - LOOKBACK_MS;
  const start = new Date(startMs);
  const end = new Date(now);

  let ingested = 0;
  let maxTs = cursor ?? startMs;
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        start_date: litellmDateTime(start),
        end_date: litellmDateTime(end),
        page: String(page),
        page_size: String(PAGE_SIZE),
        sort_by: "startTime",
        sort_order: "asc",
      });
      const response = await litellmFetch(env, `/spend/logs/v2?${params.toString()}`);
      const body = await readJson(response);
      const rows = extractRows(body);
      const events: SpendEvent[] = [];
      for (const row of rows) {
        const e = toSpendEvent(row);
        if (e !== null) {
          events.push(e);
          if (e.tsMs > maxTs) maxTs = e.tsMs;
        }
      }
      if (events.length > 0) {
        await stub.writeSpendEvents(events);
        ingested += events.length;
      }
      const totalPages = isRecord(body)
        ? numberLikeField(body, "total_pages") ?? numberLikeField(body, "totalPages") ?? numberLikeField(body, "pages")
        : undefined;
      if (totalPages !== undefined) {
        if (page >= totalPages) break;
      } else if (rows.length < PAGE_SIZE) {
        break;
      }
    }
    await stub.setSyncCursor("spend_logs", { cursorMs: maxTs, lastError: null });
    return { ingested, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await stub.setSyncCursor("spend_logs", { cursorMs: cursor ?? startMs, lastError: reason });
    return { ingested, error: reason };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/sync/usage-importer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/sync/usage-importer.ts cloud/src/litellm-portal/sync/usage-importer.test.ts
git commit -m "feat(litellm-portal): incremental spend-logs ingest into UsageDO"
```

---

### Task 9: sync — refreshDailyActivity + pruneUsageRetention

**Files:**
- Modify: `src/litellm-portal/sync/usage-importer.ts`
- Modify: `src/litellm-portal/sync/usage-importer.test.ts`

- [ ] **Step 1: 写失败测试**

在 `usage-importer.test.ts` 末尾追加:

```typescript
import { refreshDailyActivity, pruneUsageRetention } from "./usage-importer";

function makeDailyStub() {
  return {
    upsertDailyRows: vi.fn(async () => undefined),
    setSyncCursor: vi.fn(async () => undefined),
    pruneRetention: vi.fn(async () => undefined),
  };
}

describe("refreshDailyActivity", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("upserts per-model rows from aggregated daily activity", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        {
          date: "2026-05-14",
          metrics: { spend: 5, total_tokens: 100, prompt_tokens: 40, completion_tokens: 60, api_requests: 10 },
          metadata: { total_successful_requests: 9, total_failed_requests: 1 },
          breakdown: { models: { gpt: { spend: 4, total_tokens: 80, api_requests: 8 },
                                 claude: { spend: 1, total_tokens: 20, api_requests: 2 } } },
        },
      ],
    }), { status: 200 }));
    const r = await refreshDailyActivity(env);
    expect(r.error).toBeNull();
    const rows = stub.upsertDailyRows.mock.calls[0][0];
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: "2026-05-14", userId: "__global__", model: "gpt", spend: 4, requests: 8 }),
      expect.objectContaining({ date: "2026-05-14", userId: "__global__", model: "claude", spend: 1 }),
      expect.objectContaining({ date: "2026-05-14", userId: "__global__", model: "__all__",
        spend: 5, requests: 10, successRequests: 9, failedRequests: 1 }),
    ]));
  });
});

describe("pruneUsageRetention", () => {
  it("calls UsageDO.pruneRetention with now", async () => {
    const stub = makeDailyStub();
    const env = makeEnv(stub);
    await pruneUsageRetention(env);
    expect(stub.pruneRetention).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd cloud && bun run vitest run src/litellm-portal/sync/usage-importer.test.ts`
Expected: FAIL — `refreshDailyActivity is not exported`

- [ ] **Step 3: 实现 refreshDailyActivity + pruneUsageRetention**

在 `usage-importer.ts` 末尾追加(并补 import:`import type { DailyRow } from "../durable/usage-schemas";`):

```typescript
function dailyResults(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body)) return [];
  for (const key of ["results", "data", "days"]) {
    const nested = body[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

// LiteLLM daily-activity is requested with timezone=-480 so LiteLLM buckets
// each `date` by Asia/Shanghai (UTC+8). cb_usage_daily.date is therefore a
// true Shanghai business date — matches queryKpiWithDelta's shDate() bounds.
const DAILY_TZ_OFFSET_MINUTES = "-480";
const DAILY_BACKFILL_DAYS = 365;
const DAILY_REFRESH_DAYS = 3; // trailing window each tick to absorb late data
const DAILY_MAX_PAGES = 60;
const DAILY_TZ_MS = 8 * 60 * 60 * 1000;

function shanghaiDate(ms: number): string {
  return new Date(ms + DAILY_TZ_MS).toISOString().slice(0, 10);
}

/** SpendMetrics → DailyRow numeric fields (shared by per-model + __all__). */
function metricsToRow(
  date: string,
  model: string,
  m: Record<string, unknown>,
): DailyRow {
  const succ = numberLikeField(m, "successful_requests");
  const fail = numberLikeField(m, "failed_requests");
  return {
    date,
    userId: "__global__",
    model,
    spend: numberLikeField(m, "spend") ?? 0,
    totalTokens: Math.trunc(numberLikeField(m, "total_tokens") ?? 0),
    promptTokens: Math.trunc(numberLikeField(m, "prompt_tokens") ?? 0),
    completionTokens: Math.trunc(numberLikeField(m, "completion_tokens") ?? 0),
    requests: Math.trunc(numberLikeField(m, "api_requests") ?? 0),
    successRequests: succ != null ? Math.trunc(succ) : null,
    failedRequests: fail != null ? Math.trunc(fail) : null,
  };
}

export async function refreshDailyActivity(env: LiteLLMPortalEnv): Promise<IngestResult> {
  const stub = usageStub(env);
  if (stub === null) return { ingested: 0, error: "USAGE_DO binding not configured" };

  // Cursor presence = "365d backfill already done". null → backfill 365d;
  // otherwise just refresh a short trailing window each tick.
  const priorCursor = await stub.getSyncCursor("daily_activity");
  const now = Date.now();
  const spanDays = priorCursor === null ? DAILY_BACKFILL_DAYS : DAILY_REFRESH_DAYS;
  const startDate = shanghaiDate(now - spanDays * 86400000);
  const endDate = shanghaiDate(now);

  let ingested = 0;
  try {
    for (let page = 1; page <= DAILY_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        timezone: DAILY_TZ_OFFSET_MINUTES,
        page: String(page),
        page_size: "1000",
      });
      const response = await litellmFetch(env, `/user/daily/activity/aggregated?${params.toString()}`);
      const body = await readJson(response);
      const rows: DailyRow[] = [];
      for (const day of dailyResults(body)) {
        const date = firstString(day, ["date"]);
        if (date === undefined) continue;
        const dayMetrics = isRecord(day.metrics) ? day.metrics : {};
        const breakdown = isRecord(day.breakdown) ? day.breakdown : {};
        const models = isRecord(breakdown.models)
          ? breakdown.models
          : isRecord(breakdown.model_groups)
            ? breakdown.model_groups
            : {};
        for (const [model, entry] of Object.entries(models)) {
          if (!isRecord(entry)) continue;
          const em = isRecord(entry.metrics) ? entry.metrics : {};
          rows.push(metricsToRow(date, model, em));
        }
        // Synthetic per-day total row (model='__all__') from day.metrics —
        // SpendMetrics carries per-day successful_requests/failed_requests.
        rows.push(metricsToRow(date, "__all__", dayMetrics));
      }
      if (rows.length > 0) {
        await stub.upsertDailyRows(rows);
        ingested += rows.length;
      }
      // DailySpendMetadata on the response carries pagination.
      const meta = isRecord(body) && isRecord(body.metadata) ? body.metadata : {};
      const totalPages = numberLikeField(meta, "total_pages");
      const hasMore = meta.has_more === true;
      if (totalPages !== undefined) {
        if (page >= totalPages) break;
      } else if (!hasMore) {
        break;
      }
    }
    await stub.setSyncCursor("daily_activity", { cursorMs: now, lastError: null });
    return { ingested, error: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    // Only record the cursor/error if a prior cursor exists. If priorCursor is
    // null (365d backfill never completed), DON'T write one — a non-null value
    // would falsely flag "backfill done" and the 365d backfill would be skipped
    // forever. Leaving it null makes the next tick retry the full backfill.
    if (priorCursor !== null) {
      await stub.setSyncCursor("daily_activity", { cursorMs: priorCursor, lastError: reason });
    }
    return { ingested, error: reason };
  }
}

export async function pruneUsageRetention(env: LiteLLMPortalEnv): Promise<{ ok: boolean }> {
  const stub = usageStub(env);
  if (stub === null) return { ok: false };
  await stub.pruneRetention(Date.now());
  return { ok: true };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd cloud && bun run vitest run src/litellm-portal/sync/usage-importer.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add cloud/src/litellm-portal/sync/usage-importer.ts cloud/src/litellm-portal/sync/usage-importer.test.ts
git commit -m "feat(litellm-portal): daily-activity refresh + usage retention prune"
```

---

### Task 10: 注册 UsageDO + 接入 scheduled() cron

**Files:**
- Modify: `src/litellm-portal/index.ts:1-25`(import + export)
- Modify: `src/litellm-portal/index.ts:227-242`(scheduled 分支)
- Test: `src/litellm-portal/index.test.ts`(若存在 cron 测试则追加;否则本任务无新测试,靠 dry-run 验证)

- [ ] **Step 1: export UsageDO 并 import sync 函数**

在 `src/litellm-portal/index.ts` 顶部,`runSpendSnapshotTick` 的 import 之后追加:

```typescript
import { ingestSpendLogs, refreshDailyActivity, pruneUsageRetention } from "./sync/usage-importer";
export { UsageDO } from "./durable/usage-do";
```

(确认文件已 `export { IndexDO }` 等其它 DO 类的位置一致;若现有 DO export 集中在某处,放同处。)

- [ ] **Step 2: 在 scheduled() 增加分支**

将 `src/litellm-portal/index.ts` 的 `scheduled` 方法体改为:

```typescript
  async scheduled(controller, env, ctx) {
    if (controller.cron === "0 9 * * *") {
      ctx.waitUntil(scanBudgetThresholds(env));
      ctx.waitUntil(pruneUsageRetention(env));
      return;
    }
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(runSpendSnapshotTick(env));
      return;
    }
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(ingestSpendLogs(env));
      return;
    }
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(refreshDailyActivity(env));
      return;
    }
  },
```

- [ ] **Step 3: 类型检查**

Run: `cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`

- [ ] **Step 4: 提交**

```bash
git add cloud/src/litellm-portal/index.ts
git commit -m "feat(litellm-portal): export UsageDO, wire usage sync crons"
```

---

### Task 11: 全量验证

**Files:** 无新增

- [ ] **Step 1: 跑全套测试**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable/usage-do.test.ts src/litellm-portal/sync/usage-importer.test.ts`
Expected: 所有用例 PASS(共 15 个)

- [ ] **Step 2: 回归测试不破坏既有套件**

Run: `cd cloud && bun run vitest run src/litellm-portal/durable src/litellm-portal/sync`
Expected: 既有 `index-do.test.ts` / `team-config-do.test.ts` / `spend-snapshot-cron.test.ts` 等全绿

- [ ] **Step 3: 类型 + wrangler dry-run**

Run:
```bash
cd cloud && bun run tsc --noEmit 2>&1 | grep -c 'error TS'
bunx wrangler deploy --dry-run --config wrangler.litellm-portal.toml 2>&1 | grep -iE "error|10061|10064|UsageDO" | head -5
```
Expected: tsc `0`;dry-run 无 `error`/`10061`/`10064`,可见 `UsageDOSQLite` 绑定被接受

- [ ] **Step 4: 最终提交(若有未提交收尾)**

```bash
git add -A cloud/src/litellm-portal cloud/wrangler.litellm-portal.toml
git commit -m "test(litellm-portal): L1 usage data platform full verification" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- §1 架构/数据流 → Task 8/9/10(sync 入口 + cron),CQRS 边界(L1 不改路由,仅新增 DO API)。
- §2 SQLite schema → Task 3(三表 + 索引,(date,user_id,model) 主键保留;`user_id="__global__"` 承载聚合源行,偏差已记于下)。
- §3 摄取机制(增量游标/回看/cadence/回填/保留)→ Task 4(游标)、Task 8(增量+5min 回看+30d 回填+分页上限)、Task 9(日聚合刷新今天+昨天、保留清理)。
- §4 七个查询方法 → queryTimeseries/queryModelBreakdown(T6)、queryHourOfDay/queryPerUserSeries/queryUserDetail(T7)、queryRecentEvents(T4)、queryKpiWithDelta(T5)。
- §5 失败处理 → Task 8/9(catch 写 lastError、游标不前进);`available:false` 语义由 L2 消费,L1 查询空数据返回空数组/零值。
- §6 测试策略 → 每个 DO/sync 任务均 TDD,沿用 `makeTestSqlStorage` 与 fetch 桩。
- 验收 1-4 → Task 11 覆盖。

**偏差记录(spec 一致性):** spec §2 的 `cb_usage_daily` 主键为 `(date,user_id,model)`。LiteLLM `/user/daily/activity/aggregated` 为全局聚合(无 per-user),故日聚合源行写入 `user_id="__global__"`,并新增合成 `model="__all__"` 行承载当日成功/失败总数(spend-logs 无 status,与 spec §2 "成功/失败只在 cb_usage_daily" 一致)。列与主键形状与 spec 完全一致,未改 DDL,仅约定特殊值;成员级 success rate 按 spec 由 L3 替代,`queryUserDetail` 不返回 success rate。此偏差不改变 spec 表结构,属实现约定。

**Placeholder scan:** 无 TBD/TODO;每个改码步骤均含完整代码与可运行命令。

**Type consistency:** `SpendEvent`/`DailyRow`(usage-schemas.ts)在 DO 与 importer 间一致;`getSyncCursor`/`setSyncCursor` 签名(`{cursorMs,lastError}`)在 Task 4 定义、Task 8/9 调用一致;`queryX` 方法 scope 形状 `{kind:"global"}|{kind:"user",userId}` 全程一致;`UsageDO` 导出名在 Task 3 创建、Task 10 `export { UsageDO }` 一致;wrangler `class_name = "UsageDOSQLite"` 与 export 的 `UsageDO` 通过 migration `new_sqlite_classes` 映射(与既有 IndexDO/IndexDOSQLite 模式一致)。
