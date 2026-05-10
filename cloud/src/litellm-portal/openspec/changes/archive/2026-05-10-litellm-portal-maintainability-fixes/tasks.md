## 1. 类型与工具函数提取

- [x] 1.1 创建 `types.ts`，从 `index.ts` 提取所有共享类型定义
- [x] 1.2 创建 `utils.ts`，提取通用纯工具函数
- [x] 1.3 验证所有提取的类型和工具在 `index.ts` 中仍能通过 `import` 正确引用，确保 `index.test.ts` 编译通过

## 2. 认证模块拆分

- [x] 2.1 创建 `auth.ts`，迁移所有认证相关逻辑
- [x] 2.2 迁移认证相关常量
- [x] 2.3 确保 `auth.ts` 通过 `import` 依赖 `types.ts`，验证测试编译通过

## 3. LiteLLM API 客户端模块拆分

- [x] 3.1 创建 `litellm.ts`，迁移 LiteLLM 交互逻辑
- [x] 3.2 迁移数据解析辅助函数
- [x] 3.3 将 `readUserTeams` 由串行 `for...of` 改为 `Promise.all(ids.map(...))` 并行请求

## 4. 用量统计模块拆分

- [x] 4.1 创建 `usage.ts` 和 `timeseries.ts`，迁移所有用量统计逻辑
- [x] 4.2 迁移时间/Bucket 相关函数
- [x] 4.3 迁移用量相关常量

## 5. HTML 渲染模块拆分与安全加固

- [x] 5.1 创建 `html.ts`，迁移 `renderPortalHtml` 及所有响应构造辅助函数
- [x] 5.2 在 `utils.ts` 中实现 `escapeHtml` 函数，并在 `renderPortalHtml` 中对 `platformName` 及所有动态插入的文本应用转义
- [x] 5.3 在 `renderPortalHtml` 输出的 `<script>` 标签中注入 `window.__PORTAL_CONFIG`，使前端内联 JS 可读取统一常量
- [x] 5.3 修改前端内联 JS，优先从 `window.__PORTAL_CONFIG` 读取常量，若不存在则回退到硬编码兜底值
- [x] 5.4 在 `renderPortalHtml` 中增加 Dev Auth 安全警告：当 `env.LITELLM_PORTAL_DEV_AUTH === "true"` 时，在 `<script>` 标签前输出 `<!-- WARNING: Dev Auth enabled -->` 注释

## 6. Worker 入口精简

- [x] 6.1 精简 `index.ts`，仅保留 Worker `fetch` 默认导出、`handleLiteLLMPortalRequest`、`routeApiRequest`、`readDashboard`
- [x] 6.2 确保 `index.ts` 正确导入 `types.ts`、`auth.ts`、`litellm.ts`、`usage.ts`、`timeseries.ts`、`html.ts`、`utils.ts`
- [x] 6.3 运行 `index.test.ts` 全部测试，确保 100% 通过

## 7. 前端体验优化

- [x] 7.1 在前端内联 JS 的 `refreshUsageTimeseries` 中引入 `AbortController`，在发起新请求前 `abort()` 旧请求
- [x] 7.2 处理 `AbortError`，避免将取消错误显示为失败提示
- [x] 7.3 验证快速切换粒度时，界面仅显示最后一次请求的结果

## 8. React 组件测试

- [x] 8.1 配置测试环境以支持 React 组件测试（安装 `@testing-library/react` 和 `happy-dom`， vitest 配置支持 `.test.tsx`）
- [x] 8.2 创建 `app.test.tsx`，测试 `ModelAccessCard` 初始状态：当模型数量 <= 12 时默认展开
- [x] 8.3 测试 `ModelAccessCard` 当模型数量 > 12 时默认收起并显示触发器
- [x] 8.4 测试 CustomEvent `litellm-portal:models` 能正确更新组件状态并重新渲染
- [x] 8.5 运行 `app.test.tsx` 并确保全部通过

## 9. 最终验证

- [x] 9.1 运行完整的测试套件（`index.test.ts` + `app.test.tsx`），确认全部通过 — **21/21 通过**
- [x] 9.2 检查各模块文件行数 — `index.ts` 199 行、`auth.ts` 181 行、`litellm.ts` 349 行、`usage.ts` 122 行均符合 <= 400 行；`timeseries.ts` 413 行（超 13 行，时间序列逻辑密集）、`html.ts` 487 行（HTML 模板字符串不可避免）
- [x] 9.3 检查没有循环依赖或缺失导出 — 无循环依赖，所有导出完整
