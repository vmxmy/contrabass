/**
 * Phase-3 message-key allowlist. Every NEW zh source string introduced by
 * Phase 3: SideNav group headings, the Ops summary chip, four-state titles
 * surfaced by Panel*, the locale-driven chart aria template, the §F.1 density
 * toggle, the §F.4 ErrorBoundary fallback, and EVERY §F.3 error-message
 * contract string (errors/error-messages.ts MAP values + GENERIC_FALLBACK_ID).
 *
 * Reconciled 1:1 against the live Phase-3 macro literals + the final
 * errors/error-messages.ts MAP (2026-05-17). Keys already present in the
 * Phase-1/2 catalogs (e.g. "网络请求失败", "租户", "暂无模型数据", "暂无租户",
 * "租户列表加载失败", and every §F.3 string — added by Task 2C) are still
 * listed here because the Phase-3 completeness test asserts each is present in
 * BOTH catalogs; they must NOT be re-added to the catalogs (presence verified
 * before any catalog edit).
 */
export const PHASE3_KEYS = [
  // SideNav group headings (tenant-portal/shell.tsx resolveNavGroups;
  // ops-console/shell.tsx t`租户` / t`平台` group headings)
  "我的",
  "团队管理",
  "租户",
  "平台",

  // Ops global-state summary chips (ops-console/shell.tsx)
  "告警租户",

  // Four-state titles surfaced by Panel* (already in Phase-1/2 catalogs —
  // reused by the §A.2 Panel* migration, not re-added)
  "网络请求失败",
  "暂无模型数据",
  "暂无租户",
  "租户列表加载失败",

  // Chart aria (locale-driven template, Task 1 — usage-dashboard.tsx;
  // Lingui ICU-escaped braces collapse to literal {window}/{points}/{grain})
  "Token 用量趋势图，时间范围为 {window}，共 {points} 个 {grain} 粒度数据点。",

  // §F.1 density toggle (Task 6B — components/density-toggle.tsx)
  "切换显示密度",
  "紧凑",
  "宽松",

  // §F.4 BlockErrorBoundary fallback (Task 3C — errors/error-boundary.tsx)
  "该模块加载出错",
  "重试",

  // §F.3 error-message contract (Task 2C) — every value string in
  // errors/error-messages.ts MAP + GENERIC_FALLBACK_ID, enumerated 1:1.
  "操作未完成，请重试；若反复出现请联系管理员。",
  "需要平台管理员权限才能执行此操作。请用管理员账号登录后重试。",
  "此操作仅平台 Owner 可执行。请联系平台 Owner 处理。",
  "需要团队管理员权限才能执行此操作。请联系团队管理员处理。",
  "对该团队的写操作需先以租户身份进入。请从运营台点击「进入租户」后重试，你填写的内容未丢失。",
  "登录状态已失效。请重新登录后重试。",
  "当前账号未归属任何团队，无法执行该操作。请联系管理员分配团队。",
  "请填写邮箱后重试。",
  "缺少团队信息，请返回重新选择团队后重试。",
  "缺少用户信息，请返回重新选择用户后重试。",
  "缺少 Key 信息，请刷新后重试。",
  "请同时选择团队与用户后重试。",
  "提交的内容格式有误。请检查输入后重试，你填写的内容未丢失。",
  "提交的内容不完整或格式有误。请检查必填项后重试，输入未丢失。",
  "部分输入不符合要求。请按提示修正后重试，输入未丢失。",
  "选择的账单周期无效。请重新选择有效周期后重试。",
  "请填写 Key 名称后重试，你填写的内容未丢失。",
  "该 Key 名称已被占用。请改用其它名称后重试，你填写的内容未丢失。",
  "缺少审计事件信息，请返回重新选择事件后重试。",
  "请输入完整名称以确认此操作。",
  "确认名称与目标不一致，操作已取消。请重新输入完全一致的名称。",
  "请输入完整邮箱以确认此操作。",
  "确认邮箱与目标不一致，操作已取消。请重新输入完全一致的邮箱。",
  "未找到对应的 API Key，可能已被删除。请刷新列表后重试。",
  "未找到对应的团队，可能已变更。请刷新后重试。",
  "未找到对应的用户，可能已变更。请刷新后重试。",
  "未找到对应的邀请，可能已被撤销或失效。请刷新邀请列表。",
  "该邀请已被接受，无需重复操作。请刷新邀请列表查看最新状态。",
  "未找到对应的审计事件，可能已变更。请刷新后重试。",
  "未找到请求的资源，可能已变更或被移除。请刷新后重试。",
  "该周期暂无可下载的账单归档。请确认周期后重试，或稍后再试。",
  "账单归档服务暂不可用。请稍后重试；若持续请联系管理员。",
  "数据服务暂时不可用。请稍后重试；若持续请联系管理员。",
  "团队配置服务暂时不可用。请稍后重试；若持续请联系管理员。",
  "进入租户的服务暂时不可用。请稍后重试；若持续请联系管理员。",
  "团队创建未成功。请稍后重试，你填写的内容未丢失；若持续请联系管理员。",
] as const;
