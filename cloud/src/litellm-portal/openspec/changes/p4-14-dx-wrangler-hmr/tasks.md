## 1. Vite 接入

- [ ] 1.1 `pnpm add -D vite @vitejs/plugin-react`
- [ ] 1.2 新建 `vite.config.ts`：input `src/litellm-portal/client.tsx`（hydrate 入口），output `dist/portal.[hash].js`
- [ ] 1.3 与 P4-12 协同：build output 直接上传 R2

## 2. Wrangler + Vite 联调

- [ ] 2.1 dev：Vite dev server on `:5173`，wrangler dev on `:8787`
- [ ] 2.2 Worker SSR 在 dev 时指向 Vite 的 `/@vite/client` + `/src/litellm-portal/client.tsx` 模块
- [ ] 2.3 prod 时指向 R2 上的 hashed asset
- [ ] 2.4 通过环境变量切换

## 3. 删除旧 dev server

- [ ] 3.1 删除 `/tmp/litellm-portal-real-local-server.mjs` 相关脚本
- [ ] 3.2 `package.json` `dev:litellm-portal` 改为 `concurrently "vite" "wrangler dev"`

## 4. 删除 app.generated.ts

- [ ] 4.1 Worker 不再 import `app.generated.ts`
- [ ] 4.2 删除 `scripts/build-litellm-portal-app.mjs`
- [ ] 4.3 删除 `src/litellm-portal/app.generated.ts`、`src/litellm-portal/kumo-css.generated.ts`
- [ ] 4.4 kumo CSS 也由 Vite plugin 处理

## 5. Pre-commit

- [ ] 5.1 `pnpm add -D husky lint-staged prettier`
- [ ] 5.2 `.husky/pre-commit`：跑 `lint-staged`
- [ ] 5.3 lint-staged 配置：`*.ts(x)` → `tsc --noEmit` 增量 + `prettier --write` + `vitest related --run`
- [ ] 5.4 commit-msg hook：commitlint 校验 conventional commits

## 6. Secret 扫描

- [ ] 6.1 `gitleaks` pre-commit hook
- [ ] 6.2 baseline 排除 fixtures

## 7. VS Code workspace

- [ ] 7.1 `.vscode/launch.json`：调试 vitest、调试 wrangler dev
- [ ] 7.2 `.vscode/tasks.json`：常用任务一键运行
- [ ] 7.3 `.vscode/settings.json`：tabSize、formatOnSave、tsdk 指向本地

## 8. 验证

- [ ] 8.1 改 `app.tsx` 一行，浏览器 < 500ms 看到改动（HMR）
- [ ] 8.2 pre-commit 检测出 typecheck 错误时阻止提交
- [ ] 8.3 CI build 与本地 build 输出一致
