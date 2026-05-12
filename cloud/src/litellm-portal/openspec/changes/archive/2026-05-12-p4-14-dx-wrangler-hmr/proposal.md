## Why

Dev 体验当前：

- 用 `/tmp/litellm-portal-real-local-server.mjs` 自定义 Node 服务器，esbuild 一次性 bundle，源码改动需 **手动重启进程**
- `app.generated.ts` 是构建产物，每次客户端代码改动都要重跑 `scripts/build-litellm-portal-app.mjs`
- 没有 HMR，刷新整页才能看到改动
- pre-commit 没集成 typecheck/test/lint

## What Changes

- **统一到 `wrangler dev`**：直接用 Cloudflare 官方 dev runtime（与 prod 一致）
- **Vite + HMR**：客户端代码 Vite dev server 提供热更新，wrangler 通过 `__VITE__` 配置 fallback 拉资产
- **删除自定义 local server** + `app.generated.ts` 构建步骤
- **pre-commit hooks**：husky + lint-staged 跑 typecheck（增量）+ vitest（变更文件）+ prettier
- **建议性 commit hook**：检测潜在 secret（gitleaks）
- **`.editorconfig` 与 `.prettierrc`** 强制统一
- **VS Code workspace settings**：launch.json 配 debug、tasks.json 配快捷构建

## Capabilities

### New Capabilities
- **hmr-dev-loop**：保存即看效果，无重启
- **commit-time-gates**：本地 typecheck/test 防御

### Removed Capabilities
- 自定义 Node dev server `/tmp/litellm-portal-real-local-server.mjs`
- `app.generated.ts` 中间产物

## Impact

- **新增**：`vite.config.ts`、`.husky/`、`.prettierrc`、`.editorconfig`
- **改造**：`package.json` 脚本 `dev:litellm-portal` → `vite dev` + `wrangler dev` 并行
- **删除**：`scripts/build-litellm-portal-app.mjs`（生产构建用 Vite `vite build`）
- **改造**：`scripts/generate-litellm-portal-kumo-css.mjs` 保留或并入 Vite plugin
- **Breaking**：dev 流程不一样；老 dev server 路径不再有效
- **测试**：CI pipeline 步骤可能简化（vite build 替代 esbuild）
