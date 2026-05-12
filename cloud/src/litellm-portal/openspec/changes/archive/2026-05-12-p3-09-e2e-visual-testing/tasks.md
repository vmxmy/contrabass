## 1. Playwright 接入

- [ ] 1.1 `pnpm add -D @playwright/test`，`npx playwright install --with-deps chromium`
- [ ] 1.2 `playwright.config.ts`：base URL 走 `wrangler dev` 起的本地预览
- [ ] 1.3 dev auth header 模式（已有 `x-litellm-portal-dev-email`）作为登录身份注入

## 2. 用户流程 spec

- [ ] 2.1 `tests/e2e/user-flow.spec.ts`：默认用户登录 → 看到 hero stats → 看不到 admin tab
- [ ] 2.2 `tests/e2e/key-lifecycle.spec.ts`：创建 Key → 看到 SensitiveInput → 复制 → 删除 → toast 出现

## 3. Admin 流程 spec

- [ ] 3.1 `tests/e2e/admin-default.spec.ts`：admin 邮箱登录 → 默认进入 admin tab
- [ ] 3.2 `tests/e2e/admin-pagination.spec.ts`：admin users 翻页 → URL 变化 → 第 2 页数据加载
- [ ] 3.3 `tests/e2e/admin-audit-detail.spec.ts`：审计列表 → 点详情 → URL 包含 eventId
- [ ] 3.4 `tests/e2e/role-guard.spec.ts`：用户身份直接访问 `/admin` → 重定向到 `/`

## 4. Storybook 接入

- [ ] 4.1 `pnpm dlx storybook@latest init`，框架选 react-vite
- [ ] 4.2 配置加载 kumo CSS（`@cloudflare/kumo/styles/standalone`）
- [ ] 4.3 `app.tsx` 内的 export 组件各写一份 story：HeroStats、TeamsAccessCard、ApiKeysCard、AdminCard、PortalTabs、HeaderActions
- [ ] 4.4 每个 story 至少 3 个变体：loading、empty、loaded、error

## 5. 视觉回归

- [ ] 5.1 选择 Chromatic（首选）或 Argos
- [ ] 5.2 `chromatic --project-token=...` 集成进 CI
- [ ] 5.3 baseline 由 main 分支自动建立

## 6. CI 集成

- [ ] 6.1 新建 `.github/workflows/portal-e2e.yml`：matrix on Chromium/Firefox/Webkit
- [ ] 6.2 PR 触发：构建 portal → 启动 wrangler dev → 跑 Playwright → 上传 trace artifact
- [ ] 6.3 Chromatic step：跑 storybook build + publish

## 7. 验证

- [ ] 7.1 所有 spec 本地通过
- [ ] 7.2 CI 在 PR 上跑通 + 视觉差异在 PR 显示
