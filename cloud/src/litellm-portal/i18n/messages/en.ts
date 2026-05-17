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
};

export default messages;
