# LiteLLM Portal — 长期演进 Roadmap

按 **地基 → 上层** 顺序排列。每个目录是一个独立 OpenSpec change，包含 `.openspec.yaml`、`proposal.md`、`tasks.md`。`depends_on` 字段标注前置依赖。

## P0 — 地基（不做则其余都是补丁）

| 编号 | Change | 摘要 |
|---|---|---|
| 01 | [`p0-01-unify-ssr-react`](./p0-01-unify-ssr-react/) | 删除 `html.ts` 字符串模板与 6 个 CustomEvent，统一为 React SSR + hydrate |
| 02 | [`p0-02-typed-rpc-data-layer`](./p0-02-typed-rpc-data-layer/) | Hono RPC + TanStack Query + Zod，端到端类型安全与缓存层 |

## P1 — 状态与持久化

| 编号 | Change | 摘要 |
|---|---|---|
| 03 | [`p1-03-cross-isolate-role-cache`](./p1-03-cross-isolate-role-cache/) | Role cache 升级为 KV + 内存复合 + 显式失效 API |
| 04 | [`p1-04-router-replace-hash-tabs`](./p1-04-router-replace-hash-tabs/) | TanStack Router 替换 URL hash tab，admin 子路由化 |

## P2 — kumo 全量覆盖

| 编号 | Change | 摘要 |
|---|---|---|
| 05 | [`p2-05-kumo-form-coverage`](./p2-05-kumo-form-coverage/) | CreateKey 表单接入 Field / Combobox / SensitiveInput |
| 06 | [`p2-06-kumo-feedback-overlays`](./p2-06-kumo-feedback-overlays/) | Toasty + Tooltip + DropdownMenu + Popover |
| 07 | [`p2-07-kumo-typography-layout`](./p2-07-kumo-typography-layout/) | Text / Surface / Grid / Meter 语义层替换裸 Tailwind |
| 08 | [`p2-08-kumo-admin-navigation`](./p2-08-kumo-admin-navigation/) | Sidebar / Breadcrumbs / CommandPalette / MenuBar |

## P3 — 测试与守卫

| 编号 | Change | 摘要 |
|---|---|---|
| 09 | [`p3-09-e2e-visual-testing`](./p3-09-e2e-visual-testing/) | Playwright E2E + Storybook + Chromatic 视觉回归 |
| 10 | [`p3-10-security-hardening`](./p3-10-security-hardening/) | CSP + Secret Store + Rate Limit + 响应泄漏检测 |
| 11 | [`p3-11-observability-audit`](./p3-11-observability-audit/) | Workers Analytics Engine + 客户端错误上报 + admin audit |

## P4 — 质量 / 性能 / DX

| 编号 | Change | 摘要 |
|---|---|---|
| 12 | [`p4-12-perf-code-split`](./p4-12-perf-code-split/) | 路由级 splitting + R2 静态资产 + source maps |
| 13 | [`p4-13-a11y-i18n`](./p4-13-a11y-i18n/) | axe CI gate + lingui/formatjs 字符串抽取 |
| 14 | [`p4-14-dx-wrangler-hmr`](./p4-14-dx-wrangler-hmr/) | Vite HMR + wrangler dev 联调，删自定义 dev server |

## P5 — 产品扩展

| 编号 | Change | 摘要 |
|---|---|---|
| 15 | [`p5-15-admin-write-ops`](./p5-15-admin-write-ops/) | admin 写操作 + audit + undo + two-person rule |
| 16 | [`p5-16-user-preferences-sync`](./p5-16-user-preferences-sync/) | 服务端用户偏好 + 预算邮件提醒 |

## 依赖图

```
P0-01 ──┬─→ P0-02 ──┬─→ P1-03 ──→ P5-15
        │           ├─→ P1-04 ─→ P2-08
        │           ├─→ P3-10 ─→ P5-15
        │           └─→ P5-16
        ├─→ P3-09
        ├─→ P4-12 ←─ P1-04
        ├─→ P4-13
        └─→ P4-14

P2-05、P2-06、P2-07、P3-11 ── 无强依赖，可并行
P5-15 ←─ P2-06 + P3-10 + P3-11
```

## 执行建议

- **先单独完成 P0-01**：所有其他 change 的前提
- **P0-02 与 P1-04 强耦合**：建议同时设计
- **P2 系列**：依赖 P0 完成后即可并行 4 路开工
- **P3-09 视觉回归**：越早接入越能保护后续重构
- **P5 系列**：等基础设施稳定再启动
