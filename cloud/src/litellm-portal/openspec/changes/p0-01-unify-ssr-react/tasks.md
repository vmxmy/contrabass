## 1. SSR 骨架搭建

- [ ] 1.1 新建 `server.tsx`，导出 `renderPortalSSR(env, identity, initialData): string`
- [ ] 1.2 新建 `shell.tsx`，导出 `<Shell>`（含 `<html><head>` 标签、CSS link、FOUC 脚本、hydrate marker）
- [ ] 1.3 新建 `app.tsx` 内 `<App initialData>` 顶层，承接 SSR 注入数据

## 2. 数据预填管线

- [ ] 2.1 抽取 `/api/dashboard` 处理函数为可在 SSR 内复用的纯函数 `loadDashboard(env, identity)`
- [ ] 2.2 在 `renderPortalSSR` 内调用 `loadDashboard`，把结果以 `<script>window.__INITIAL_DATA__=...</script>` 注入
- [ ] 2.3 客户端 `hydrateRoot` 时读取 `window.__INITIAL_DATA__` 作为 `initialData`

## 3. 删除内联 JS bridge

- [ ] 3.1 删除 `dispatchKeys / dispatchTeams / dispatchStats / renderModels / showError / hideError / refresh`
- [ ] 3.2 删除 `byId / list / api / numberFormatter / fmt / fmtInt / text` 等内联工具
- [ ] 3.3 删除 `litellm-portal:*` 所有 CustomEvent 监听器（在 `app.tsx` 6 处）
- [ ] 3.4 删除所有 `window.__litellmPortal*` globals 与 Window 接口扩展

## 4. 路由切换

- [ ] 4.1 `index.ts` 中 `GET /` 路由改为调用 `renderPortalSSR` 返回 HTML
- [ ] 4.2 删除 `renderPortalHtml(env)` 调用与 `html.ts` import
- [ ] 4.3 删除 `html.ts` 文件

## 5. FOUC 处理

- [ ] 5.1 提取 FOUC 脚本（设置 `data-mode`）为最小化字符串常量
- [ ] 5.2 在 `<Shell>` 内通过 `dangerouslySetInnerHTML` 注入，配合 nonce
- [ ] 5.3 验证浏览器加载无白屏闪烁

## 6. 测试迁移

- [ ] 6.1 删除 `index.test.ts` 中所有"html.toContain"针对内联 JS 的断言
- [ ] 6.2 新增 SSR 输出快照测试（用 `react-dom/server` 渲染并匹配）
- [ ] 6.3 验证 `app.test.tsx` React 组件测试不受影响

## 7. 验证

- [ ] 7.1 `pnpm test src/litellm-portal` 全绿
- [ ] 7.2 `pnpm typecheck` portal 文件 0 错误
- [ ] 7.3 `pnpm build:litellm-portal` 成功
- [ ] 7.4 浏览器手动验证：首屏直接是数据态，无骨架闪烁
- [ ] 7.5 浏览器 DevTools Network 验证：首屏不再有 `/api/dashboard` 请求
