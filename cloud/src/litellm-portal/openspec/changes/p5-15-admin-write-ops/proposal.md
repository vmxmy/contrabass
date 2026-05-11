## Why

当前 admin 视图是 **只读** 的（4 张 card 都是 GET 端点）。长期 admin 会被要求做：

- 用户停用 / 启用 / 角色调整
- Key 跨用户吊销
- 团队预算 / RPM / TPM 调整
- 模型白名单调整
- 全局预算紧急冻结

写权限一旦开启，需要一整套保护机制；现在没有任何 audit / 撤销 / 双人审核。

## What Changes

- **写端点白名单**：`PATCH /api/admin/users/:id`、`POST /api/admin/users/:id/disable`、`DELETE /api/admin/keys/:id`、`PATCH /api/admin/teams/:id` 等
- **Typed confirmation**：高危操作（删用户、改全局预算）的 Dialog 要求用户输入完整资源名（如邮箱、团队名）才能确认，无 default value
- **Audit log 强制**：每个写操作记录 `actor / action / target / before / after / reason`（reason 由 UI 强制要求输入）
- **5 秒 undo toast**：低危操作（停 key、改 RPM）出现 `<Toasty.Action>` 5 秒内可点 undo
- **Two-person rule**：高危操作（删用户、改全局预算 > 10x）需要第二个 admin 在 5 分钟内 approve
- **Optimistic update with rollback**：mutation 内 `onMutate` 修改 cache，`onError` 回滚
- **变更影响展示**：删用户前 Dialog 显示 "该用户拥有 N 个 Key、所属 M 个团队、近 30 天用量 $X"
- **dry-run 模式**：所有写端点接受 `?dryRun=true`，返回"如果执行会发生什么"

## Capabilities

### New Capabilities
- **admin-write-actions**：完整 CRUD 接口
- **typed-confirmation**：防误删
- **two-person-rule**：高危操作双人审核
- **operation-undo**：5 秒撤销
- **admin-audit-trail**：含 before/after diff

### Modified Capabilities
- **admin 视图**：从只读 → 读写

## Impact

- **新增**：`/api/admin/users/:id/*`、`/api/admin/keys/:id`、`/api/admin/teams/:id/*` 等多个端点
- **新增**：`ConfirmDialog`、`UndoableToast`、`TwoPersonApproval` 组件
- **新增 DO**：`PendingApprovalDO`（5 分钟过期的待审批队列）
- **改造**：`AdminUsersTable` 等加行操作 dropdown（依赖 P2-06）
- **新增 audit schema**：扩展 P3-11 的 audit 数据集
- **Breaking**：admin 视图行为重大变化（默认只读 → 默认可写）；rollout 需要 feature flag
- **测试**：写操作必须有 e2e（与 P3-09 协同）、audit 完整性、undo 路径
