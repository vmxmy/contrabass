/**
 * i18n completeness test for the Tenant Portal namespace.
 *
 * Asserts that every key used by the tenant-portal screens, shell, and routes
 * is present in BOTH the `en` and `zh-CN` catalogs, and that the two catalogs
 * have exactly the same key set (no locale-only key).
 *
 * HOW IT WORKS
 * ============
 * We maintain an explicit allowlist of Lingui message IDs that belong to the
 * tenant-portal namespace. This is intentionally explicit rather than trying
 * to parse source ASTs — it is the safety-net sweep that catches any key
 * omitted from either catalog.
 *
 * When you add a new key used by tenant-portal code, add it here too.
 * The test will fail on the first run, which forces the author to also
 * add matching entries to BOTH catalogs before merging.
 */
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/messages/en";
import zhCNMessages from "../i18n/messages/zh-CN";

// ---------------------------------------------------------------------------
// Tenant-portal message keys — the complete expected set for this namespace
// ---------------------------------------------------------------------------
const TENANT_PORTAL_KEYS = [
  // Shell nav items
  "概览",
  "用量",
  "API Key",
  "成员",
  "账单",

  // Shell aria labels
  "租户品牌",
  "租户导航",

  // Phase-2 owner notice
  "运营控制台将在 Phase 2 提供",
  "Operations Console arrives in Phase 2",
  "管理控制台",

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

// Deduplicate (some keys like "告警 Webhook" appear in multiple screens)
const UNIQUE_KEYS = [...new Set(TENANT_PORTAL_KEYS)];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tenant-portal i18n completeness", () => {
  it("every tenant-portal key exists in en catalog", () => {
    const missing = UNIQUE_KEYS.filter((key) => !(key in enMessages));
    expect(missing, `Missing from en: ${JSON.stringify(missing)}`).toHaveLength(0);
  });

  it("every tenant-portal key exists in zh-CN catalog", () => {
    const missing = UNIQUE_KEYS.filter((key) => !(key in zhCNMessages));
    expect(missing, `Missing from zh-CN: ${JSON.stringify(missing)}`).toHaveLength(0);
  });

  it("en and zh-CN catalogs have the same complete key set (no locale-only key in either)", () => {
    const enKeys = new Set(Object.keys(enMessages));
    const zhKeys = new Set(Object.keys(zhCNMessages));

    const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
    const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));

    expect(
      enOnly,
      `Keys in en but not zh-CN: ${JSON.stringify(enOnly)}`,
    ).toHaveLength(0);
    expect(
      zhOnly,
      `Keys in zh-CN but not en: ${JSON.stringify(zhOnly)}`,
    ).toHaveLength(0);
  });
});
