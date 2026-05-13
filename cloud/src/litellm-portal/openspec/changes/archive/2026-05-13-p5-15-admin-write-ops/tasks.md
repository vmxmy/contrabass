## 1. 端点设计

- [x] 1.1 文档化所有写端点：path / method / body schema / 影响范围 / 危险级别
- [x] 1.2 危险级别分 3 档：low（可 undo）、medium（typed confirm）、high（two-person）

See PR body for the endpoint design table.

## 2. 端点实现（low）

- [x] 2.1 `PATCH /api/admin/keys/:id/disable` — 停 key
- [x] 2.2 `PATCH /api/admin/teams/:id/limits` — 改 RPM/TPM
- [x] 2.3 mutation 端配合乐观更新

## 3. 端点实现（medium）

- [x] 3.1 `PATCH /api/admin/users/:id` — 改 role、alias
- [x] 3.2 `DELETE /api/admin/keys/:id` — 删 key
- [x] 3.3 `ConfirmDialog`：必须输入用户邮箱/key alias 确认

## 4. 端点实现（high）

(deferred — Phase 2, requires new Durable Object)

- [ ] 4.1 `DELETE /api/admin/users/:id` — 删用户
- [ ] 4.2 `PATCH /api/admin/budget/global` — 改全局预算
- [ ] 4.3 PendingApprovalDO：5 分钟过期；第二 admin POST `/api/admin/approvals/:id/approve`
- [ ] 4.4 SSE 通知机制：第一 admin 发起后，UI 显示"等待第二人 approve"，第二人在 admin 视图看到 pending list

## 5. Undo toast

- [x] 5.1 low 级别 mutation 成功 → `<Toasty.Action>` 含 undo 按钮
- [x] 5.2 5 秒内点击 → 反向 mutation
- [x] 5.3 5 秒过 → toast 消失，操作落地

## 6. Audit 扩展

- [x] 6.1 写端点 middleware：`auditWrite({ before, after, reason })`
- [x] 6.2 `reason` 由 UI 强制要求（自由文本 + 预设原因下拉）
- [x] 6.3 audit 详情视图（admin/audit/$eventId）显示 before/after diff（JSON diff 渲染）

## 7. dry-run

- [x] 7.1 `?dryRun=true` 走完业务逻辑但不写 LiteLLM
- [x] 7.2 ConfirmDialog 打开时自动调 dry-run 显示影响摘要

## 8. Feature flag rollout

- [x] 8.1 `LITELLM_PORTAL_WRITE_OPS_ENABLED` env var，false 时所有写端点 404
- [ ] 8.2 灰度开启：先 internal admin → 部分 admin → 全开 (operational, not code)

## 9. 测试

- [x] 9.1 单元：每个端点 happy + 校验失败 + 鉴权失败
- [x] 9.2 集成：typed confirmation 必须匹配
- [ ] 9.3 集成：approval DO 5 分钟过期 (deferred — Phase 2, requires PendingApprovalDO)
- [ ] 9.4 E2E：完整写 → undo 流程 (deferred — Phase 2, E2E infrastructure)
- [ ] 9.5 E2E：高危写 → 第二人 approve 流程 (deferred — Phase 2, high-risk endpoints)
- [x] 9.6 Audit：写完后 audit 行包含 before/after/reason

## 10. 文档

(deferred — Phase 2)

- [ ] 10.1 admin 运维手册：每个操作的影响范围、撤销窗口、approve 路径
- [ ] 10.2 incident response：误删后如何从 audit 还原
