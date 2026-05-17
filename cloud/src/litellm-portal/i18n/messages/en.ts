/**
 * Compiled en message catalog — machine-translation skeleton.
 * TODO(i18n): all entries below need human review before production use.
 */
const messages: Record<string, string> = {
  // Header / platform
  "面向智云团队的 AI 能力自助台：仪表盘聚焦用量趋势、预算与模型分布，管理操作集中到独立管理区。":
    "AI capability self-service portal for the Zhiyun team: dashboards focus on usage trends, budgets, and model distribution; management actions live in the dedicated management area.",

  // HeaderActions
  "切换浅色模式": "Switch to light mode",
  "切换深色模式": "Switch to dark mode",
  "深色": "Dark",
  "浅色": "Light",
  "退出登录": "Log out",
  "退出当前登录会话": "End the current login session",

  // Dashboard scope
  "个人视图": "Personal view",
  "全局管理": "Global admin",

  // HeroStats
  "当前身份": "Current identity",
  "累计花费": "Total spend",
  "近 30 天": "Last 30 days",
  "权限范围": "Access scope",
  "暂无数据": "No data",

  // BudgetBadge / budget labels
  "超预算": "Over budget",
  "即将超支": "Near limit",
  "正常": "Normal",

  // UsagePanel
  "Token 用量趋势": "Token usage trend",
  "时间范围预设": "Time range preset",
  "时间粒度": "Time grain",
  "自动": "Auto",
  "用量数据加载失败": "Failed to load usage data",
  "高频模型": "Top models",
  "暂无用量数据": "No usage data",
  "已达到分页上限": "Pagination limit reached",
  "自动粒度": "Auto grain",
  "手动粒度": "Manual grain",

  // UsageSummary metrics
  "总 Tokens": "Total tokens",
  "请求数": "Requests",
  "花费": "Spend",
  "数据来源": "Data source",
  "实时请求日志": "Real-time request logs",
  "全局请求日志": "Global request logs",
  "LiteLLM 日聚合": "LiteLLM daily aggregation",

  // UsageBucketsTable
  "时间": "Time",
  "请求": "Requests",

  // ModelAccessCard
  "团队可用模型": "Team available models",
  "模型数量较少，已直接展示完整清单。": "Few models — full list shown.",
  "团队暂未配置可用模型": "No models configured for this team",

  // ApiKeysCard
  "仅列出当前 LiteLLM 用户拥有的密钥。": "Lists only API keys owned by the current LiteLLM user.",
  "暂无 API Key": "No API keys",
  "名称": "Name",
  "模型": "Models",
  "预算": "Budget",
  "过期时间": "Expires",
  "操作": "Actions",

  // CreateKeyButton
  "创建 Key": "Create key",
  "Key 已创建": "Key created",
  "创建新 API Key": "Create new API key",
  "请立即复制完整 Key，关闭后无法再次查看。": "Copy the full key now — it will not be shown again after closing.",
  "创建一个新的 API Key，绑定到当前登录用户。": "Create a new API key bound to the current logged-in user.",
  "请立即复制": "Copy now",
  "关闭此对话框后将无法再次查看完整 Key。": "The full key cannot be viewed again after closing this dialog.",
  "Key 名称": "Key name",
  "完整 Key": "Full key",
  "复制完整 Key": "Copy full key",
  "已复制，关闭": "Copied — close",
  "创建失败": "Creation failed",
  "创建": "Create",
  "取消": "Cancel",
  "允许模型": "Allowed models",
  "继承当前用户可用模型": "Inherit current user's available models",
  "预算上限（USD）": "Budget limit (USD)",
  "留空表示不限": "Leave blank for no limit",
  "有效期": "Duration",
  "永不过期": "Never expires",
  "请输入 Key 名称": "Please enter a key name",

  // DeleteKeyButton
  "删除": "Delete",
  "删除 API Key？": "Delete API key?",
  "删除失败": "Deletion failed",
  "确认删除": "Confirm delete",

  // TeamsAccessCard
  "团队权限": "Team access",
  "只展示当前账号所属团队的信息。": "Shows information for teams the current account belongs to.",
  "当前 LiteLLM 用户未关联团队": "Current LiteLLM user has no associated teams",
  "团队": "Team",
  "未限制": "Unrestricted",

  // AdminSection
  "全局管理（只读）": "Global admin (read-only)",
  "仅管理员可见": "Visible to admins only",

  // AdminHeroStats
  "全局账户": "Global accounts",
  "全局花费": "Global spend",
  "资源覆盖": "Resource coverage",
  "风险雷达": "Risk radar",
  "全局概览加载失败": "Failed to load global summary",

  // AdminUsersTable
  "全员账户": "All accounts",
  "全员账户加载失败": "Failed to load user accounts",
  "暂无用户数据": "No user data",
  "邮箱": "Email",
  "角色": "Role",
  "累计消费": "Total spend",
  "团队数": "Teams",
  "最大预算": "Max budget",

  // AdminTeamsTable
  "全部团队": "All teams",
  "全部团队加载失败": "Failed to load teams",
  "暂无团队数据": "No team data",
  "别名": "Alias",
  "可用模型": "Available models",
  "消费": "Spend",

  // AdminAuditFeed
  "审计日志": "Audit log",
  "审计日志加载失败": "Failed to load audit log",
  "暂无审计日志": "No audit log entries",
  "创建时间": "Created at",
  "操作者": "Actor",
  "对象类型": "Object type",
  "对象 ID": "Object ID",
  "详情": "Details",
  "展开": "Expand",
  "收起": "Collapse",
  "变更后": "After",

  // AdminGlobalUsage
  "全局用量趋势": "Global usage trend",
  "全局用量加载失败": "Failed to load global usage",

  // AdminErrorBanner
  "数据加载失败": "Failed to load data",

  // Pagination
  "分页": "Pagination",
  "首页": "First page",
  "上一页": "Previous page",
  "下一页": "Next page",
  "末页": "Last page",
  "页码": "Page number",
  "每页条数": "Items per page",

  // PortalErrorBanner
  "页面数据加载失败": "Failed to load page data",

  // source labels
  "来自当前用户所属团队配置": "From the current user's team configuration",
  "当前团队未限制模型，显示 LiteLLM 可用模型": "Team has no model restriction — showing all LiteLLM models",
  "来自 Worker 模型白名单": "From the Worker model allowlist",
  "来自 LiteLLM 全局模型": "From LiteLLM global models",
  "模型清单已按服务端权限过滤": "Model list filtered by server-side permissions",

  // grainLabels
  "分钟": "minute",
  "小时": "hour",
  "天": "day",
  "月": "month",

  // UsageChart loading
  "正在加载用量图表": "Loading usage chart",

  // loading/error states
  "网络请求失败": "Network request failed",

  // resource & risk section labels
  "资源与权限": "Resources & permissions",
  "审计与风险": "Audit & risk",

  // AdminStatusHeader
  "只读": "Read-only",
  "样本视图": "Sample view",
  "系统正常": "System healthy",

  // AdminAuditFeed empty state
  "尚未记录管理员操作，admin 写操作开启后此处会出现条目。":
    "No admin operations have been recorded yet. Entries will appear here once admin write operations are enabled.",

  // AccountCell
  "无邮箱": "No email",

  // ModelChips
  "+N 更多": "+N more",

  // TopModelsPanel
  "高频模型排名": "Top models ranking",

  // AdminGlobalUsage collapsible bucket table
  "分时段用量明细": "Usage by time bucket",
  "展开或折叠分时段用量明细": "Expand or collapse usage by time bucket",

  // Audit detail labels
  "原始数据": "Raw data",

  // Tenant Portal shell nav
  "概览": "Overview",
  "用量": "Usage",
  "API Key": "API Key",
  "成员": "Members",
  "账单": "Billing",

  // Tenant Portal Phase-2 owner notice
  "运营控制台将在 Phase 2 提供": "Operations Console arrives in Phase 2",
  // English source string used in the <Trans> macro (zh-CN.ts maps it back) — not a dupe, keep both.
  "Operations Console arrives in Phase 2": "Operations Console arrives in Phase 2",
  "管理控制台": "Operations Console",

  // Tenant Portal route placeholders / member guard
  "待实现": "Coming soon",
  "无权访问": "No access",
  "该页面仅对团队管理员开放。": "This page is available to team admins only.",

  // TenantAlertsScreen
  "告警 Webhook": "Alert Webhook",
  "配置预算告警通知的 Webhook 地址。": "Configure the Webhook URL for budget alert notifications.",
  "更新 Webhook": "Update Webhook",
  "设置或清除告警 Webhook URL。客户端不校验 URL，服务端负责安全验证。":
    "Set or clear the alert Webhook URL. The client does not validate the URL — the server is the security boundary.",
  "Webhook URL": "Webhook URL",
  "仅接受 HTTPS 地址，服务端校验 SSRF 安全。": "HTTPS only. Server-side SSRF safety check applies.",
  "变更原因": "Reason",
  "常规维护": "Routine maintenance",
  "安全事件": "Security incident",
  "用户申请": "User request",
  "预算调整": "Budget adjustment",
  "其他": "Other",
  "清除": "Clear",
  "保存": "Save",
  "操作失败": "Operation failed",
  "保存失败": "Save failed",
  "清除失败": "Clear failed",
  "当前 Webhook URL": "Current Webhook URL",
  "未配置告警 Webhook": "No alert Webhook configured",
  "Webhook 配置加载失败": "Failed to load Webhook config",

  // TenantBillingScreen
  "账单下载": "Billing Download",
  "按账期下载团队 CSV 账单。服务端已按团队过滤，客户端不聚合数据。":
    "Download team CSV billing by period. The server filters by team — the client does not aggregate data.",
  "账期": "Billing period",
  "下载": "Download",
  "下载 ${period}": "Download ${period}",
  "账单列表加载失败": "Failed to load billing periods",
  "暂无账单": "No billing periods",
  "下载失败": "Download failed",

  // TenantOverviewScreen (net-new keys only; 团队/累计花费/高频模型 already defined above)
  "暂无模型数据": "No model data",
  "当前租户团队": "Current tenant team",
  "个人花费": "Personal spend",
  "团队预算": "Team budget",
  "已配置": "Configured",
  "加载失败": "Load failed",
  "次请求": "requests",
  "个模型": "models",

  // TenantMembersScreen
  "成员与邀请": "Members & Invites",
  "管理团队成员的邀请状态。": "Manage team member invite statuses.",
  "发送邀请": "Send Invite",
  "邀请新成员加入当前团队。": "Invite a new member to the current team.",
  "邀请列表加载失败": "Failed to load invites",
  "暂无邀请记录": "No invites yet",
  "状态": "Status",
  "撤销": "Revoke",
  "撤销邀请？": "Revoke invite?",
  "将撤销「{email}」的邀请。此操作不可撤销。": "The invite for \"{email}\" will be revoked. This action cannot be undone.",
  "撤销失败": "Revoke failed",
  "输入邮箱确认": "Type email to confirm",
  "请输入「${email}」以确认撤销": "Enter \"${email}\" to confirm revocation",
  "确认撤销": "Confirm revoke",
  "请输入邮箱": "Please enter an email",
  "邀请发送失败": "Failed to send invite",
  "邀请": "Invite",
  "管理员": "Admin",

  // Tenant Portal shell aria labels
  "租户品牌": "Tenant brand",
  "租户导航": "Tenant navigation",

  // TenantOverviewScreen — webhook unconfigured badge
  "未配置": "Not configured",

  // TenantMembersScreen — invite status display labels
  "待处理": "Pending",
  "已使用": "Accepted",
  "已撤销": "Revoked",

  // TenantMembersScreen — teamRole display labels
  "成员角色：成员": "Member",
  "成员角色：管理员": "Admin",

  // ---------------------------------------------------------------------------
  // Ops Console (Phase 2) — net-new keys
  // ---------------------------------------------------------------------------

  // OpsConsoleShell — chrome, chip, nav, forbidden card
  "运营控制台": "Operations Console",
  "内部·特权": "Internal · Privileged",
  "运营导航": "Operations navigation",
  "租户总览": "Tenant Overview",
  "发放与邀请": "Provisioning & Invites",
  "全局用量": "Global Usage",
  "审计": "Audit",
  "平台设置": "Platform Settings",
  "仅平台 Owner 可访问": "Platform Owner access only",
  "运营控制台仅对平台 Owner 开放。": "The Operations Console is restricted to the platform Owner.",
  "返回首页": "Back to home",

  // OpsTenantOverviewScreen
  "所有租户的成员、花费、告警与账单状态。":
    "Members, spend, alerts, and billing status across all tenants.",
  "租户列表加载失败": "Failed to load tenants",
  "暂无租户": "No tenants",
  "租户": "Tenant",
  "成员数": "Members",
  "本周期花费/预算": "Cycle spend / budget",

  // OpsProvisioningScreen
  "请输入团队名称": "Please enter a team name",
  "创建团队失败": "Failed to create team",
  "创建团队": "Create team",
  "为新租户创建一个团队。": "Create a team for a new tenant.",
  "团队名称": "Team name",
  "请输入邮箱与团队 ID": "Please enter an email and team ID",
  "邀请用户加入指定团队。": "Invite a user to the specified team.",
  "所属团队": "Team",
  "所属团队标识": "Team identifier",
  "请输入团队 ID 与用户 ID": "Please enter a team ID and user ID",
  "指派角色失败": "Failed to assign role",
  "指派租户角色": "Assign tenant role",
  "为团队成员指派租户管理员或成员角色。":
    "Assign the tenant-admin or member role to a team member.",
  "团队 ID": "Team ID",
  "用户 ID": "User ID",
  "租户角色": "Tenant role",
  "租户管理员": "Tenant admin",
  "指派角色": "Assign role",

  // OpsAuditScreen
  "审计事件加载失败": "Failed to load audit event",
  "未找到审计事件": "Audit event not found",
  "审计事件详情": "Audit event detail",
  "动作": "Action",
  "对象": "Object",
  "变更前": "Before",
  "原因": "Reason",
  "暂无审计记录": "No audit records",
  "平台审计": "Platform Audit",
  "跨租户的运营动作审计日志。": "Cross-tenant audit log of operational actions.",

  // OpsPlatformSettingsScreen
  "平台设置加载失败": "Failed to load platform settings",
  "平台名称": "Platform name",
  "写操作开关": "Write operations toggle",
  "写操作已启用": "Write operations enabled",
  "写操作已禁用": "Write operations disabled",
  "偏好默认值": "Preference defaults",
  "角色 / tenantRole 管理": "Role / tenantRole management",
  "平台名称、写操作开关与相关管理入口。":
    "Platform name, write-operations toggle, and related management entries.",

  // OpsTenantDetailScreen
  "租户详情加载失败": "Failed to load tenant detail",
  "未找到租户": "Tenant not found",
  "进入租户": "Enter tenant",
  "本周期花费": "Cycle spend",
  "账单期数": "Billing periods",
  "该租户的所有成员及其门户角色与花费。":
    "All members of this tenant with their portal roles and spend.",
  "暂无成员": "No members",
  "门户角色": "Portal role",

  // OpsUserDetailScreen
  "用户详情加载失败": "Failed to load user detail",
  "未找到用户": "User not found",
  "平台角色": "Platform role",
  "Key 数量": "Key count",

  // Impersonation banner (rendered by TenantPortalShell when impersonating)
  "正在以租户身份操作": "Operating as a tenant",
  "{realActor} 正在代表团队 {effectiveTeamId} 操作。所有操作均被审计。":
    "{realActor} is acting on behalf of team {effectiveTeamId}. All actions are audited.",
  "退出代操作": "Exit impersonation",

  // Error UX contract (Phase 3 §F.3) — humanized server error codes
  "操作未完成，请重试；若反复出现请联系管理员。":
    "The operation didn't complete. Please try again; if it keeps happening, contact an administrator.",
  "需要平台管理员权限才能执行此操作。请用管理员账号登录后重试。":
    "This action requires platform administrator access. Please sign in with an admin account and try again.",
  "此操作仅平台 Owner 可执行。请联系平台 Owner 处理。":
    "Only a platform Owner can perform this action. Please ask a platform Owner to handle it.",
  "需要团队管理员权限才能执行此操作。请联系团队管理员处理。":
    "This action requires team administrator access. Please ask a team administrator to handle it.",
  "对该团队的写操作需先以租户身份进入。请从运营台点击「进入租户」后重试，你填写的内容未丢失。":
    "Writing to this team requires entering as the tenant first. Click “Enter tenant” in the operations console and try again — nothing you typed was lost.",
  "登录状态已失效。请重新登录后重试。":
    "Your session has expired. Please sign in again and try once more.",
  "当前账号未归属任何团队，无法执行该操作。请联系管理员分配团队。":
    "Your account isn't assigned to any team, so this action can't run. Please ask an administrator to assign you a team.",
  "请填写邮箱后重试。": "Please enter an email address and try again.",
  "缺少团队信息，请返回重新选择团队后重试。":
    "Team information is missing. Please go back, reselect the team, and try again.",
  "缺少用户信息，请返回重新选择用户后重试。":
    "User information is missing. Please go back, reselect the user, and try again.",
  "缺少 Key 信息，请刷新后重试。":
    "Key information is missing. Please refresh and try again.",
  "请同时选择团队与用户后重试。":
    "Please select both a team and a user, then try again.",
  "提交的内容格式有误。请检查输入后重试，你填写的内容未丢失。":
    "The submitted content is malformed. Please check your input and try again — nothing you typed was lost.",
  "提交的内容不完整或格式有误。请检查必填项后重试，输入未丢失。":
    "The submitted content is incomplete or malformed. Please check the required fields and try again — your input was kept.",
  "部分输入不符合要求。请按提示修正后重试，输入未丢失。":
    "Some input doesn't meet the requirements. Please fix the highlighted fields and try again — your input was kept.",
  "选择的账单周期无效。请重新选择有效周期后重试。":
    "The selected billing period is invalid. Please pick a valid period and try again.",
  "请填写 Key 名称后重试，你填写的内容未丢失。":
    "Please enter a Key name and try again — nothing you typed was lost.",
  "该 Key 名称已被占用。请改用其它名称后重试，你填写的内容未丢失。":
    "That Key name is already taken. Please choose a different name and try again — nothing you typed was lost.",
  "缺少审计事件信息，请返回重新选择事件后重试。":
    "Audit event information is missing. Please go back, reselect the event, and try again.",
  "请输入完整名称以确认此操作。":
    "Please type the full name to confirm this action.",
  "确认名称与目标不一致，操作已取消。请重新输入完全一致的名称。":
    "The confirmation name doesn't match the target, so the action was cancelled. Please type the exact matching name.",
  "请输入完整邮箱以确认此操作。":
    "Please type the full email address to confirm this action.",
  "确认邮箱与目标不一致，操作已取消。请重新输入完全一致的邮箱。":
    "The confirmation email doesn't match the target, so the action was cancelled. Please type the exact matching email.",
  "未找到对应的 API Key，可能已被删除。请刷新列表后重试。":
    "The matching API Key wasn't found — it may have been deleted. Please refresh the list and try again.",
  "未找到对应的团队，可能已变更。请刷新后重试。":
    "The matching team wasn't found — it may have changed. Please refresh and try again.",
  "未找到对应的用户，可能已变更。请刷新后重试。":
    "The matching user wasn't found — it may have changed. Please refresh and try again.",
  "未找到对应的邀请，可能已被撤销或失效。请刷新邀请列表。":
    "The matching invite wasn't found — it may have been revoked or expired. Please refresh the invite list.",
  "该邀请已被接受，无需重复操作。请刷新邀请列表查看最新状态。":
    "This invite was already accepted, so there's nothing more to do. Please refresh the invite list to see the latest status.",
  "未找到对应的审计事件，可能已变更。请刷新后重试。":
    "The matching audit event wasn't found — it may have changed. Please refresh and try again.",
  "未找到请求的资源，可能已变更或被移除。请刷新后重试。":
    "The requested resource wasn't found — it may have changed or been removed. Please refresh and try again.",
  "该周期暂无可下载的账单归档。请确认周期后重试，或稍后再试。":
    "No downloadable billing archive exists for that period yet. Please confirm the period and try again, or come back later.",
  "账单归档服务暂不可用。请稍后重试；若持续请联系管理员。":
    "The billing archive service is temporarily unavailable. Please try again later; if it persists, contact an administrator.",
  "数据服务暂时不可用。请稍后重试；若持续请联系管理员。":
    "The data service is temporarily unavailable. Please try again later; if it persists, contact an administrator.",
  "团队配置服务暂时不可用。请稍后重试；若持续请联系管理员。":
    "The team configuration service is temporarily unavailable. Please try again later; if it persists, contact an administrator.",
  "进入租户的服务暂时不可用。请稍后重试；若持续请联系管理员。":
    "The enter-tenant service is temporarily unavailable. Please try again later; if it persists, contact an administrator.",
  "团队创建未成功。请稍后重试，你填写的内容未丢失；若持续请联系管理员。":
    "Team creation didn't succeed. Please try again later — nothing you typed was lost; if it persists, contact an administrator.",
};

export default messages;
