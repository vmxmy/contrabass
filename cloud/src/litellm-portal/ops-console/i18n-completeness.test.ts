/**
 * i18n completeness test for the Ops Console namespace.
 *
 * Asserts that every key used by the ops-console screens, shell, and the
 * impersonation banner is present in BOTH the `en` and `zh-CN` catalogs, and
 * that the two catalogs share exactly the same complete key set.
 *
 * HOW IT WORKS
 * ============
 * We maintain an explicit allowlist of Lingui message IDs that belong to the
 * ops-console namespace (`OPS_KEYS`). This is intentionally explicit rather
 * than parsing source ASTs — it is the safety-net sweep that catches any key
 * omitted from either catalog.
 *
 * NO-SILENT-SHADOW GUARD
 * ======================
 * The Ops Console reuses many generic surface forms ("成员", "账单", "邮箱",
 * "角色", …) that already exist as Phase-1 tenant-portal keys. Reuse is fine
 * ONLY when the existing English translation is also correct for the Ops
 * usage. `INTENTIONAL_SHARED` is the audited list of such genuine shared
 * keys. The guard fails if an Ops key collides with a Phase-1 key WITHOUT
 * being declared intentional — that would mean an Ops string is silently
 * inheriting a Phase-1 English translation that may not fit its Ops context.
 *
 * When you add a new key used by ops-console code, add it here too, and add
 * matching entries to BOTH catalogs before merging.
 */
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/messages/en";
import zhCNMessages from "../i18n/messages/zh-CN";
import { PHASE1_TENANT_KEYS } from "../i18n/__fixtures__/phase1-keys";

const TENANT_PORTAL_KEYS_OVERLAP = new Set<string>(PHASE1_TENANT_KEYS);

// ---------------------------------------------------------------------------
// Ops-console message keys — the complete expected set for this namespace
// ---------------------------------------------------------------------------
const OPS_KEYS = [
  // OpsConsoleShell — chrome, chip, nav, forbidden card
  "运营控制台",
  "内部·特权",
  "运营导航",
  "租户总览",
  "发放与邀请",
  "全局用量",
  "审计",
  "平台设置",
  "仅平台 Owner 可访问",
  "运营控制台仅对平台 Owner 开放。",
  "返回首页",

  // OpsTenantOverviewScreen
  "所有租户的成员、花费、告警与账单状态。",
  "租户列表加载失败",
  "网络请求失败",
  "暂无租户",
  "租户",
  "成员数",
  "本周期花费/预算",
  "告警 Webhook",
  "账单",
  "已配置",
  "未配置",

  // OpsProvisioningScreen
  "请输入团队名称",
  "创建团队失败",
  "创建团队",
  "为新租户创建一个团队。",
  "团队名称",
  "请输入邮箱与团队 ID",
  "邀请发送失败",
  "发送邀请",
  "邀请用户加入指定团队。",
  "邮箱",
  "请输入邮箱",
  "所属团队",
  "所属团队标识",
  "角色",
  "成员",
  "管理员",
  "请输入团队 ID 与用户 ID",
  "指派角色失败",
  "指派租户角色",
  "为团队成员指派租户管理员或成员角色。",
  "团队 ID",
  "用户 ID",
  "租户角色",
  "租户管理员",
  "指派角色",

  // OpsAuditScreen
  "审计事件加载失败",
  "未找到审计事件",
  "审计事件详情",
  "动作",
  "操作者",
  "对象",
  "时间",
  "变更前",
  "变更后",
  "原因",
  "审计日志加载失败",
  "暂无审计记录",
  "详情",
  "平台审计",
  "跨租户的运营动作审计日志。",

  // OpsPlatformSettingsScreen
  "平台设置加载失败",
  "平台名称",
  "写操作开关",
  "写操作已启用",
  "写操作已禁用",
  "偏好默认值",
  "角色 / tenantRole 管理",
  "平台名称、写操作开关与相关管理入口。",

  // OpsTenantDetailScreen
  "租户详情加载失败",
  "未找到租户",
  "进入租户",
  "预算",
  "本周期花费",
  "账单期数",
  "成员",
  "该租户的所有成员及其门户角色与花费。",
  "暂无成员",
  "门户角色",
  "花费",

  // OpsUserDetailScreen
  "用户详情加载失败",
  "未找到用户",
  "平台角色",
  "所属团队",
  "Key 数量",

  // Impersonation banner (rendered by TenantPortalShell when impersonating)
  "正在以租户身份操作",
  "{realActor} 正在代表团队 {effectiveTeamId} 操作。所有操作均被审计。",
  "退出代操作",
] as const;

// Deduplicate (some keys like "成员"/"预算" appear in multiple screens)
const UNIQUE_KEYS = [...new Set<string>(OPS_KEYS)];

// ---------------------------------------------------------------------------
// Audited intentional Phase-1 ↔ Ops shared keys.
//
// Each entry is an Ops key that ALSO exists as a Phase-1 tenant-portal key
// whose existing English translation is verified to be semantically correct
// for the Ops usage too (genuine reuse, not a silent mistranslation).
// ---------------------------------------------------------------------------
const INTENTIONAL_SHARED = new Set<string>([
  "成员", // "Members" — Ops member section / invite role; same meaning
  "账单", // "Billing" — Ops tenant-overview billing column; same meaning
  "告警 Webhook", // "Alert Webhook" — identical concept
  "已配置", // "Configured" — webhook configured badge; identical
  "未配置", // "Not configured" — webhook unconfigured badge; identical
  "邮箱", // "Email" — invite form / detail field; identical
  "角色", // "Role" — Ops invite role select; identical
  "请输入邮箱", // "Please enter an email" — invite validation; identical
  "发送邀请", // "Send Invite" — Ops invite form action; identical
  "邀请发送失败", // "Failed to send invite" — Ops invite error; identical
  "管理员", // "Admin" — Ops invite teamRole option; identical
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ops-console i18n completeness", () => {
  it("every ops-console key exists in en catalog", () => {
    const missing = UNIQUE_KEYS.filter((key) => !(key in enMessages));
    expect(missing, `Missing from en: ${JSON.stringify(missing)}`).toHaveLength(0);
  });

  it("every ops-console key exists in zh-CN catalog", () => {
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

  it("no ops-console key silently shadows a Phase-1 tenant-portal key (overlap must be declared intentional)", () => {
    const sharedButNotDeclared = UNIQUE_KEYS.filter(
      (key) =>
        TENANT_PORTAL_KEYS_OVERLAP.has(key) && !INTENTIONAL_SHARED.has(key),
    );
    expect(
      sharedButNotDeclared,
      `Ops keys colliding with Phase-1 keys without being declared in INTENTIONAL_SHARED: ${JSON.stringify(sharedButNotDeclared)}. Either rename the Ops key with a context suffix or, if the English is genuinely identical, add it to INTENTIONAL_SHARED.`,
    ).toHaveLength(0);
  });
});
