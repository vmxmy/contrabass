/**
 * Phase-1 Tenant Portal message-key fixture.
 *
 * The canonical allowlist of Lingui message IDs that belong to the Phase-1
 * tenant-portal namespace. Extracted verbatim from
 * `tenant-portal/i18n-completeness.test.ts` so that the Phase-2 ops-console
 * completeness test can reason about Phase-1 ↔ Ops key overlap without
 * duplicating the list.
 *
 * Membership is behavior-preserving: do NOT add/remove entries here to satisfy
 * a new namespace — Ops keys live in `ops-console/i18n-completeness.test.ts`.
 */
export const PHASE1_TENANT_KEYS = [
  // Shell nav items
  "概览",
  "用量",
  "API Key",
  "成员",
  "账单",

  // Shell aria labels
  "租户品牌",
  "租户导航",

  // Owner ops-console entry (F3 — replaces the retired Phase-2 notice)
  "进入运营控制台",
  "使用运营控制台管理团队、用量与审计",

  // Routes — placeholder / member guard
  "待实现",
  "无权访问",
  "该页面仅对团队管理员开放。",

  // TenantOverviewScreen
  "当前租户团队",
  "团队",
  "个人花费",
  "累计花费",
  "近 30 天",
  "次请求",
  "个模型",
  "团队预算",
  "告警 Webhook",
  "已配置",
  "未配置",
  "加载失败",
  "高频模型",
  "暂无模型数据",

  // TenantAlertsScreen
  "告警 Webhook",
  "配置预算告警通知的 Webhook 地址。",
  "更新 Webhook",
  "设置或清除告警 Webhook URL。客户端不校验 URL，服务端负责安全验证。",
  "Webhook URL",
  "仅接受 HTTPS 地址，服务端校验 SSRF 安全。",
  "变更原因",
  "常规维护",
  "安全事件",
  "用户申请",
  "预算调整",
  "其他",
  "清除",
  "保存",
  "操作失败",
  "保存失败",
  "清除失败",
  "当前 Webhook URL",
  "未配置告警 Webhook",
  "Webhook 配置加载失败",

  // TenantBillingScreen
  "账单下载",
  "按账期下载团队 CSV 账单。服务端已按团队过滤，客户端不聚合数据。",
  "账期",
  "下载",
  "下载 ${period}",
  "账单列表加载失败",
  "暂无账单",
  "下载失败",

  // TenantMembersScreen
  "成员与邀请",
  "管理团队成员的邀请状态。",
  "发送邀请",
  "邀请新成员加入当前团队。",
  "邀请列表加载失败",
  "暂无邀请记录",
  "状态",
  "撤销",
  "撤销邀请？",
  "将撤销「{email}」的邀请。此操作不可撤销。",
  "撤销失败",
  "输入邮箱确认",
  "请输入「${email}」以确认撤销",
  "确认撤销",
  "请输入邮箱",
  "邀请发送失败",
  "邀请",
  "角色",
  "邮箱",
  "操作",
  "取消",
  "管理员",

  // InviteStatusBadge display labels
  "待处理",
  "已使用",
  "已撤销",

  // teamRole display labels
  "成员角色：成员",
  "成员角色：管理员",
] as const;
