# LiteLLM Portal — L3 Kumo Dashboard 前端设计

- 日期: 2026-05-15
- 状态: 已批准设计,待用户复核 → writing-plans
- 分支: `feat/litellm-do-sql-storage`
- 子项目: 三层拆解中的 **L3**(L1 数据平台 → L2 API → **L3 Kumo 前端**)
- 依赖: L2 — spec `docs/superpowers/specs/2026-05-15-litellm-portal-l2-dashboard-api-design.md`
  (端点 `/api/usage/overview`、`/api/admin/usage/overview[?member=]`)
- Plane: project `LPD`,本子项目对应 epic `LPD-3`

## 背景与动机

把 litellm-portal 用量区改造成参考稿
`/Users/xumingyang/ai-platform-report/dashboard.html` 的功能与信息架构
(KPI+环比、消费趋势、模型占比饼、使用时段分布、团队多线趋势、用户消费
排行、告警面板、只读成员下钻),但**保留 Kumo 设计语言**(浅色机构风、
单品牌色、扁平无阴影、药丸几何、等宽数字、语义色仅作文字),而非照搬
reference 的深色配色。数据全部来自 L2 聚合端点(请求路径不读 LiteLLM)。

## 范围

- **本 spec(L3)**:用量区前端重构 —— 图表层(裸 ECharts + Kumo 主题)、
  scope 无关面板、个人/管理员视图、只读成员下钻 overlay、数据钩子。
- **不在本 spec**:L1/L2(已完成设计);keys/models/teams/preferences 等
  既有 island 不改;**不引入写操作**(沿用只读 trust 边界)。

## 已锁定决策

| 决策点 | 选择 |
|---|---|
| 图表渲染 | 裸 ECharts(加注册 Pie/Bar)+ Kumo token 主题包装层;island 懒加载控 bundle |
| 个人面板布局 | reference 直译竖向流 |
| 成员下钻 UX | 全屏 overlay,复用个人面板组件,scope=member |
| 改造范围 | 拆分 + 重构用量区为职责单一模块;无关 island 不动 |
| 告警面板样式 | **状态点(语义色圆点)+ 文字**,无 `-tint` 填充(最贴 Kumo 克制) |

## § 1. 架构与文件结构

React island 架构不变(挂载到 portal Worker shell)。用量区拆为:

```
litellm-portal/dashboard/
  charts/
    echarts-core.ts        # use([...]) 集中注册,仅用到的模块
    kumo-chart-theme.ts    # Kumo token → ECharts option 主题
    trend-chart.tsx        # 单线/多线折线(复用)
    model-donut.tsx        # 环形饼
    rank-bar.tsx           # 横向排行柱
    hour-bars.tsx          # 24h 时段柱
  panels/
    kpi-band.tsx           # KPI + 环比
    recent-table.tsx
    alert-panel.tsx        # 状态点 + 文字
    user-table.tsx         # 可下钻行
  views/
    personal-view.tsx
    admin-view.tsx
    member-overlay.tsx
  use-dashboard.ts         # 数据钩子
```

只重构用量区;`app.tsx` / `admin-components.tsx` 中用量相关部分迁出后瘦身,
keys/models/teams/preferences island 保持不动(不做无关重构)。

## § 2. 数据流

- `use-dashboard.ts` 用 React Query(项目已用)拉 L2 聚合端点。入参
  `window`(`24h|48h|7d|30d`)、可选 `grain`、admin 可选 `member`。
- 一个聚合响应驱动整页:`kpi / trend / models / hourOfDay /
  (perUser | recent) / (summary)`。
- 状态语义:`available:false` → 「数据同步中」占位;`empty:true` → 空状态
  文案;`grainFallback:true` → 非阻断提示。
- 个人视图 scope=self;管理员 scope=global;点用户表行 → member-overlay
  以 `?member=<userId>` 再拉一次(self 响应形状)。

## § 3. 图表层(裸 ECharts + Kumo 主题)

- `echarts-core.ts`:`use([LineChart, BarChart, PieChart, GridComponent,
  TooltipComponent, LegendComponent, SVGRenderer])`(在现有
  `LineChart` 基础上增 Bar/Pie + Legend)。
- `kumo-chart-theme.ts`:坐标轴/网格用 `kumo-line` / `kumo-subtle` token;
  数值 tooltip 等宽;多线/饼用 `ChartPalette.categorical(i, isDark)`
  (现 `chart.tsx` 已用);暗色随 `data-mode` 经 `MutationObserver`
  同步(复用现有模式)。
- 每个图表为懒加载 island(`React.lazy` + `Suspense`,复用现有
  `LazyUsageChart` 模式)以控 bundle。
- 趋势图 `trend-chart.tsx` 复用:个人=单线;管理员=多线(perUser top8);
  成员=个人实线 vs 团队人均虚线参考。

## § 4. 个人面板(reference 直译竖向流)

顺序:KPI 带 → 全宽消费趋势 panel → 模型占比环形 + 使用时段分布 双列
→ 最近请求表。

- 时间控件复用现有 preset rail(`24h/48h/7d/30d`)+ Auto/手动 grain chip。
- KPI:`spend / requests / totalTokens` + 环比;`30d` 窗口
  `deltaPct=null` → 显示「—」(L2 §3 已定该语义)。
- **数据缺口替代**:`/spend/logs/v2` 无 per-request 状态,**最近请求表
  去掉「状态」列**;成功率以**按天成功率**形式在 KPI 区呈现(来自 L2
  KPI / daily 数据)。

## § 5. 团队总览(管理员)

顺序:告警面板 → 4 KPI(团队消费带 `kumo-brand` 进度条)→ 全宽多线
团队趋势 → 用户消费排行横向柱 + 模型分布饼 双列 → 全宽团队时段分布
→ 用户详情表(行可点,`›` 提示)。

- **告警面板**:`alert-panel.tsx` —— 每行 = 语义色小圆点
  (success/warning/danger,仅圆点着色)+ `<b>` 标题 + 说明文字;
  **无 `-tint` 药丸/填充块**(最贴 Kumo「语义色克制」)。数据来自 L2
  `summary`(DO-backed riskCount 等)。
- 进度条用 `kumo-brand`;语义色(超预算等)仅作文字色,不作背景。
- 用户表数据来自现有 `/api/admin/users`(DO-backed,已含 `maxBudget`);
  行点击携带该 `maxBudget` 给 overlay。

## § 6. 成员下钻 overlay(只读)

点用户表行 → 全屏 overlay(`member-overlay.tsx`),复用 `panels/` 与
`charts/`,以 `?member=<userId>` 拉 L2(self 形状):

- 个人 KPI / 趋势(个人实线 vs 团队人均虚线)/ 模型饼 / 时段分布。
- **配额进度**:用点击行已携带的 `maxBudget`(来自 `/api/admin/users`)
  + L2 member `kpi.spend.current` 计算百分比 —— **无需改 L2**。
- **reference 的「个人模型权限」chips** → LiteLLM 无该查询接口,替代为
  **「近 30d 实际使用过的模型」**(来自 member `models`)。
- 全只读,**无编辑配额按钮**(沿用 trust 边界);overlay 含返回/关闭。

## § 7. 测试策略

- 各 `charts/` `panels/` 组件单测(`bun test`,项目 `*.test.tsx` 范式):
  mock 聚合响应,断言渲染、`available:false`/`empty:true` 态、KPI
  `deltaPct=null` 显「—」、scope 字段缺失时不渲染对应面板
  (个人无 perUser/summary、管理员无 recent)。
- `use-dashboard.ts` 单测:`window`/`member` 入参 → 正确 URL;
  `available/empty/grainFallback` 分支。
- 不强制视觉快照(沿用项目现状;`portal.stories` 可补 story,非阻断)。
- 不再引用 `/api/usage/timeseries`(L2 已删并清理其测试)。

## 验收标准(L3)

1. 个人/管理员/成员三视图按 reference IA 渲染,Kumo 设计语言一致
   (浅色、单品牌、扁平、药丸、等宽数字、语义色仅文字 + 告警圆点)。
2. 图表为裸 ECharts + Kumo 主题,bundle 经 island 懒加载控制;
   `echarts-core` 仅注册用到的模块。
3. 数据全部来自 L2 聚合端点;`available/empty/grainFallback` 正确处理;
   前端无 `/api/usage/timeseries` 调用。
4. 成员 overlay 只读、复用面板、配额进度用 `/api/admin/users` 的
   `maxBudget`、权限 chips 替代为近 30d 使用模型。
5. 组件 + 钩子单测通过;`tsc --noEmit` 0 error;既有 portal 测试套件
   保持绿(用量区迁移后旧用例同步更新)。

## 数据缺口替代汇总(贯穿 L1→L3)

| reference 元素 | L3 替代 | 原因 |
|---|---|---|
| 最近请求「状态」列 | 去列;成功率按天在 KPI 区 | spend_logs 无 per-request status |
| 成员「模型权限」chips | 近 30d 实际使用过的模型 | LiteLLM 无 per-user 模型白名单接口 |
| 90d/12mo 长窗口趋势 | 不做(窗口收敛 24h/48h/7d/30d) | L1 events 30d 保留;长期趋势为后续增量 |
| 成员「编辑配额」按钮 | 移除(只读) | 沿用 trust 边界,写操作走 LiteLLM 原生 UI |
