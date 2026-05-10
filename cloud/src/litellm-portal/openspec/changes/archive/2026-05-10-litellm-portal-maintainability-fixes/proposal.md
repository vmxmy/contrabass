## Why

`litellm-portal` 的 `index.ts` 已膨胀至 1800+ 行，承载了 Worker 路由、JWT 认证、LiteLLM API 代理、用量统计、HTML 渲染等全部逻辑，严重影响可读性和后续迭代。同时代码 review 发现 XSS 风险、前后端常量重复定义、API 请求竞态等安全和体验问题。本次 change 旨在通过模块化拆分和安全加固，提升可维护性与可靠性。

## What Changes

- **拆分 `index.ts` 为多个模块文件**：按职责分离为 `auth.ts`（JWT/Access 认证）、`litellm.ts`（API 客户端、用户/Key/团队解析）、`usage.ts`（用量统计与时间序列）、`html.ts`（HTML 模板渲染）、`types.ts`（共享类型定义）。
- **修复 XSS 漏洞**：`renderPortalHtml` 中对 `platformName` 等环境变量输出添加 HTML escape。
- **消除常量重复**：将 `USAGE_WINDOWS`、`DEFAULT_USAGE_WINDOWS`、`sourceLabels` 等前后端共享常量统一通过构建注入或配置下发，避免双处维护。
- **请求竞态保护**：前端 `refreshUsageTimeseries` 增加 `AbortController` 去重机制，防止快速切换粒度时旧数据覆盖新数据。
- **并行化团队请求**：`readUserTeams` 由串行 `for...of` 改为 `Promise.all` 并行获取。
- **Dev Auth 安全警示**：当 `LITELLM_PORTAL_DEV_AUTH` 开启时，输出显著日志警告。
- **补充 React 组件测试**：为 `app.tsx` 的 `ModelAccessCard` 添加单元测试，覆盖展开/收起逻辑与 CustomEvent 响应。

## Capabilities

### New Capabilities
- *(无新增功能需求，本次为重构与安全加固)*

### Modified Capabilities
- *(无 spec 级别的行为变更，仅为实现层面的重构与修复)*

## Impact

- `index.ts`：大幅精简，仅保留 Worker 入口与路由分发。
- 新增/修改：`auth.ts`、`litellm.ts`、`usage.ts`、`html.ts`、`types.ts`、`app.test.tsx`。
- 构建产物 `app.generated.ts` / `kumo-css.generated.ts` 不受影响。
- 对外 API 行为保持不变，无 breaking change。
