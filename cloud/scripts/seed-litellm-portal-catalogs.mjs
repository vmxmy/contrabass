// One-shot migration: carry the existing human zh-CN/en translations (keyed by
// SOURCE TEXT in the legacy i18n/messages/{locale}.ts maps) into the freshly
// extracted id-keyed .po catalogs (keyed by macro hash id, with the source
// text in msgid). For each .po entry whose msgid equals a legacy source-text
// key, write the legacy translation into msgstr. No translation is lost; any
// .po entry with no legacy match is left as-is for human follow-up.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../src/litellm-portal/i18n/", import.meta.url);

// Task 2 reshaped three JS-`${}` templates into ICU placeholders, so their new
// `.po` msgid no longer byte-matches the legacy source-text key and the
// exact-match seed above leaves en `msgstr` empty. Carry the human English
// forward explicitly, normalized to ICU `{name}` / positional `{0}{1}`
// (the impersonation <Trans> extracts positional args). en-only; zh-CN is the
// source locale and Task 3 already wrote identity msgstr for these ids.
const EN_PLACEHOLDER_REMAP = {
  "下载 {period}": "Download {period}",
  "请输入「{email}」以确认撤销": 'Enter "{email}" to confirm revocation',
  "{0} 正在代表团队 {1} 操作。所有操作均被审计。":
    "{0} is acting on behalf of team {1}. All actions are audited.",
};

// §F.3 + tenant SideNav headings — faithful English of the new zh msgids.
// Keyed by the zh source (msgid). Authored 2026-05-18; per-string fidelity
// verified in Task 4d Stage-1 RETAINED review.
const F3_EN = {
  "操作未完成，请重试；若反复出现请联系管理员。":
    "The action did not complete. Please try again; if it keeps happening, contact your administrator.",
  "需要平台管理员权限才能执行此操作。请用管理员账号登录后重试。":
    "Platform administrator access is required for this action. Sign in with an administrator account and try again.",
  "此操作仅平台 Owner 可执行。请联系平台 Owner 处理。":
    "Only the platform Owner can perform this action. Please contact the platform Owner.",
  "需要团队管理员权限才能执行此操作。请联系团队管理员处理。":
    "Team administrator access is required for this action. Please contact a team administrator.",
  "对该团队的写操作需先以租户身份进入。请从运营台点击「进入租户」后重试，你填写的内容未丢失。":
    "Writing to this team requires entering as a tenant first. From the operations console, click “Enter tenant” and try again — your input has been preserved.",
  "登录状态已失效。请重新登录后重试。":
    "Your session has expired. Please sign in again and retry.",
  "当前账号未归属任何团队，无法执行该操作。请联系管理员分配团队。":
    "This account is not assigned to any team, so this action cannot be performed. Please ask an administrator to assign a team.",
  "请填写邮箱后重试。": "Please enter an email address and try again.",
  "缺少团队信息，请返回重新选择团队后重试。":
    "Team information is missing. Please go back, reselect the team, and try again.",
  "缺少用户信息，请返回重新选择用户后重试。":
    "User information is missing. Please go back, reselect the user, and try again.",
  "缺少 Key 信息，请刷新后重试。":
    "API key information is missing. Please refresh and try again.",
  "请同时选择团队与用户后重试。":
    "Please select both a team and a user, then try again.",
  "提交的内容格式有误。请检查输入后重试，你填写的内容未丢失。":
    "The submitted content is malformed. Please check your input and try again — your input has been preserved.",
  "提交的内容不完整或格式有误。请检查必填项后重试，输入未丢失。":
    "The submitted content is incomplete or malformed. Please check the required fields and try again — your input has been preserved.",
  "部分输入不符合要求。请按提示修正后重试，输入未丢失。":
    "Some input does not meet the requirements. Please correct it as indicated and try again — your input has been preserved.",
  "选择的账单周期无效。请重新选择有效周期后重试。":
    "The selected billing period is invalid. Please choose a valid period and try again.",
  "请填写 Key 名称后重试，你填写的内容未丢失。":
    "Please enter a key name and try again — your input has been preserved.",
  "该 Key 名称已被占用。请改用其它名称后重试，你填写的内容未丢失。":
    "That key name is already in use. Please choose a different name and try again — your input has been preserved.",
  "缺少审计事件信息，请返回重新选择事件后重试。":
    "Audit event information is missing. Please go back, reselect the event, and try again.",
  "请输入完整名称以确认此操作。":
    "Enter the full name to confirm this action.",
  "确认名称与目标不一致，操作已取消。请重新输入完全一致的名称。":
    "The confirmation name does not match the target; the action was cancelled. Please enter the exact name.",
  "请输入完整邮箱以确认此操作。":
    "Enter the full email address to confirm this action.",
  "确认邮箱与目标不一致，操作已取消。请重新输入完全一致的邮箱。":
    "The confirmation email does not match the target; the action was cancelled. Please enter the exact email address.",
  "未找到对应的 API Key，可能已被删除。请刷新列表后重试。":
    "The API key was not found and may have been deleted. Please refresh the list and try again.",
  "未找到对应的团队，可能已变更。请刷新后重试。":
    "The team was not found and may have changed. Please refresh and try again.",
  "未找到对应的用户，可能已变更。请刷新后重试。":
    "The user was not found and may have changed. Please refresh and try again.",
  "未找到对应的邀请，可能已被撤销或失效。请刷新邀请列表。":
    "The invitation was not found and may have been revoked or expired. Please refresh the invitation list.",
  "该邀请已被接受，无需重复操作。请刷新邀请列表查看最新状态。":
    "This invitation has already been accepted; no further action is needed. Refresh the invitation list to see the latest status.",
  "未找到对应的审计事件，可能已变更。请刷新后重试。":
    "The audit event was not found and may have changed. Please refresh and try again.",
  "未找到请求的资源，可能已变更或被移除。请刷新后重试。":
    "The requested resource was not found and may have changed or been removed. Please refresh and try again.",
  "该周期暂无可下载的账单归档。请确认周期后重试，或稍后再试。":
    "There is no downloadable billing archive for this period. Please confirm the period and try again, or check back later.",
  "账单归档服务暂不可用。请稍后重试；若持续请联系管理员。":
    "The billing archive service is temporarily unavailable. Please try again later; if it persists, contact your administrator.",
  "数据服务暂时不可用。请稍后重试；若持续请联系管理员。":
    "The data service is temporarily unavailable. Please try again later; if it persists, contact your administrator.",
  "团队配置服务暂时不可用。请稍后重试；若持续请联系管理员。":
    "The team configuration service is temporarily unavailable. Please try again later; if it persists, contact your administrator.",
  "进入租户的服务暂时不可用。请稍后重试；若持续请联系管理员。":
    "The enter-tenant service is temporarily unavailable. Please try again later; if it persists, contact your administrator.",
  "团队创建未成功。请稍后重试，你填写的内容未丢失；若持续请联系管理员。":
    "Team creation did not succeed. Please try again later — your input has been preserved; if it persists, contact your administrator.",
  "我的": "Personal",
  "团队管理": "Team management",
};

// Source-keyed en write for the new §F.3 / heading msgids. F3_EN is THE
// authored, reviewed English for these security-relevant §F.3 ids (Task 4d
// Step 5.3) — authoritative over any legacy carry, so this runs last and
// overwrites the msgstr for every msgid present in F3_EN.
function applyF3En(poText) {
  return poText.replace(
    /(msgid\s+("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)\nmsgstr\s+)("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)/g,
    (whole, _head, rawMsgid) => {
      const src = JSON.parse(`[${rawMsgid.replace(/"\n"/g, '","')}]`).join("");
      if (Object.prototype.hasOwnProperty.call(F3_EN, src)) {
        return whole.replace(
          /msgstr\s+"(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*/,
          `msgstr ${JSON.stringify(F3_EN[src])}`,
        );
      }
      return whole;
    },
  );
}

function remapEnPlaceholders(poText) {
  return poText.replace(
    /(msgid\s+("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)\nmsgstr\s+)("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)/g,
    (whole, _head, rawMsgid) => {
      const src = JSON.parse(`[${rawMsgid.replace(/"\n"/g, '","')}]`).join("");
      if (Object.prototype.hasOwnProperty.call(EN_PLACEHOLDER_REMAP, src)) {
        return whole.replace(
          /msgstr\s+"(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*/,
          `msgstr ${JSON.stringify(EN_PLACEHOLDER_REMAP[src])}`,
        );
      }
      return whole;
    },
  );
}

async function loadLegacyMap(locale) {
  const mod = await import(new URL(`messages/${locale}.ts`, root).href);
  return mod.default;
}

function patchPo(poText, legacyMap) {
  // .po blocks: optional comments, msgid "<src>", msgstr "<value>"
  return poText.replace(
    /(msgid\s+("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)\nmsgstr\s+)("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)/g,
    (whole, _head, rawMsgid, _rawMsgstr) => {
      const src = JSON.parse(`[${rawMsgid.replace(/"\n"/g, '","')}]`).join("");
      if (src.length > 0 && Object.prototype.hasOwnProperty.call(legacyMap, src)) {
        const translated = legacyMap[src];
        return whole.replace(/msgstr\s+"(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*/,
          `msgstr ${JSON.stringify(translated)}`);
      }
      return whole;
    },
  );
}

for (const locale of ["zh-CN", "en"]) {
  const poUrl = new URL(`locales/${locale}/messages.po`, root);
  const poPath = fileURLToPath(poUrl);
  const legacy = await loadLegacyMap(locale);
  let patched = patchPo(readFileSync(poPath, "utf8"), legacy);
  if (locale === "en") patched = applyF3En(remapEnPlaceholders(patched));
  writeFileSync(poPath, patched);
  console.log(`seeded ${locale}: ${Object.keys(legacy).length} legacy entries applied`);
}
