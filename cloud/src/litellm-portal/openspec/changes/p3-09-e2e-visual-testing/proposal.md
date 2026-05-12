## Why

测试覆盖只有单元 + 集成（`index.test.ts` + `app.test.tsx`），覆盖率高但缺：

- **真实浏览器流程**：tab 切换、role guard、key 创建/删除全链路
- **视觉回归**：kumo 升级或 CSS 改动时无任何防护
- **组件库可视化**：portal 自己的复合组件（HeroStats、AdminCard、TeamsAccessCard）没有 Storybook 文档

## What Changes

- **Playwright E2E** 接入：本地用 `wrangler dev` 或预览部署作为目标
- **关键流程**：
  - 用户：登录 → 看到 hero stats → 切到 admin（被拒）→ 创建 key → 复制 → 删除
  - admin：登录 → 默认 admin tab → 切到用户 tab → 切回 → 翻页 admin users → 看 audit 详情
- **Storybook** 接入：portal 复合组件单独 story
- **Chromatic / Argos** 视觉回归：每 PR 跑 storybook + 关键路由截图对比
- **CI 集成**：GitHub Actions 跑 E2E + 视觉 diff，PR 显示截图差异

## Capabilities

### New Capabilities
- **e2e-coverage**：浏览器级关键路径覆盖
- **visual-regression**：截图 diff 保护视觉
- **component-storybook**：portal 组件可视化文档

## Impact

- **新增**：`tests/e2e/*.spec.ts`、`.storybook/*`、`*.stories.tsx` 文件
- **新增依赖**：`@playwright/test`、`storybook`、`@storybook/react-vite`
- **新增 CI workflow**：`.github/workflows/portal-e2e.yml`
- **新增可选服务**：Chromatic（或 Argos / Percy）
- **Breaking**：无
