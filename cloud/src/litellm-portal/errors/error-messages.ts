/**
 * §F.3 (V2.0 §2.4 + §4#6): server error CODE → localized human message.
 *
 * THE single source of truth. Applied at the shared extractError boundary
 * (tenant-portal/hooks.ts + ops-console/hooks.ts) so no raw code/tech string
 * ever reaches a Banner/PanelError. Each message folds the 3-element rule
 * (what happened · your input is preserved · clear next step) into one
 * human sentence. Values are zh source strings (Lingui message ids — same
 * idiom as the rest of the catalog); en is added to both catalogs (Step 6 +
 * Task 9). SECURITY: messages never expose internal impl (DO names, paths,
 * auth mechanism, stack); unknown codes → GENERIC_FALLBACK_ID, never the raw
 * code.
 */
export const GENERIC_FALLBACK_ID = "操作未完成，请重试；若反复出现请联系管理员。";

const MAP: Record<string, string> = {
  admin_required: "需要平台管理员权限才能执行此操作。请用管理员账号登录后重试。",
  owner_required: "此操作仅平台 Owner 可执行。请联系平台 Owner 处理。",
  tenant_admin_required: "需要团队管理员权限才能执行此操作。请联系团队管理员处理。",
  // permission/impersonation: recovery without leaking the auth mechanism.
  impersonation_required:
    "对该团队的写操作需先以租户身份进入。请从运营台点击「进入租户」后重试，你填写的内容未丢失。",
  unauthorized: "登录状态已失效。请重新登录后重试。",
  no_tenant_scope: "当前账号未归属任何团队，无法执行该操作。请联系管理员分配团队。",
  email_required: "请填写邮箱后重试。",
  team_id_required: "缺少团队信息，请返回重新选择团队后重试。",
  user_id_required: "缺少用户信息，请返回重新选择用户后重试。",
  key_id_required: "缺少 Key 信息，请刷新后重试。",
  team_and_user_required: "请同时选择团队与用户后重试。",
  invalid_json: "提交的内容格式有误。请检查输入后重试，你填写的内容未丢失。",
  invalid_body: "提交的内容不完整或格式有误。请检查必填项后重试，输入未丢失。",
  validation_error: "部分输入不符合要求。请按提示修正后重试，输入未丢失。",
  invalid_period: "选择的账单周期无效。请重新选择有效周期后重试。",
  key_alias_required: "请填写 Key 名称后重试，你填写的内容未丢失。",
  key_alias_conflict: "该 Key 名称已被占用。请改用其它名称后重试，你填写的内容未丢失。",
  event_id_required: "缺少审计事件信息，请返回重新选择事件后重试。",
  confirm_alias_required: "请输入完整名称以确认此操作。",
  confirm_alias_mismatch: "确认名称与目标不一致，操作已取消。请重新输入完全一致的名称。",
  confirm_email_required: "请输入完整邮箱以确认此操作。",
  confirm_email_mismatch: "确认邮箱与目标不一致，操作已取消。请重新输入完全一致的邮箱。",
  key_not_found: "未找到对应的 API Key，可能已被删除。请刷新列表后重试。",
  team_not_found: "未找到对应的团队，可能已变更。请刷新后重试。",
  user_not_found: "未找到对应的用户，可能已变更。请刷新后重试。",
  invite_not_found: "未找到对应的邀请，可能已被撤销或失效。请刷新邀请列表。",
  invite_already_consumed: "该邀请已被接受，无需重复操作。请刷新邀请列表查看最新状态。",
  audit_event_not_found: "未找到对应的审计事件，可能已变更。请刷新后重试。",
  not_found: "未找到请求的资源，可能已变更或被移除。请刷新后重试。",
  billing_archive_not_found: "该周期暂无可下载的账单归档。请确认周期后重试，或稍后再试。",
  billing_archive_unavailable: "账单归档服务暂不可用。请稍后重试；若持续请联系管理员。",
  index_do_unavailable: "数据服务暂时不可用。请稍后重试；若持续请联系管理员。",
  team_config_do_unavailable: "团队配置服务暂时不可用。请稍后重试；若持续请联系管理员。",
  impersonation_secret_unavailable:
    "进入租户的服务暂时不可用。请稍后重试；若持续请联系管理员。",
  litellm_team_create_failed: "团队创建未成功。请稍后重试，你填写的内容未丢失；若持续请联系管理员。",
};

export const KNOWN_ERROR_CODES = Object.keys(MAP);

/** Resolve a server/client error code to its localized human message id.
 *  Unknown / undefined / non-string → the generic safe fallback. NEVER
 *  returns the raw code. */
export function errorMessage(code: unknown): string {
  if (typeof code !== "string") return GENERIC_FALLBACK_ID;
  return MAP[code] ?? GENERIC_FALLBACK_ID;
}
