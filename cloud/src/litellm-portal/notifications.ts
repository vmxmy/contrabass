import { listAllUsers } from "./litellm";
import { KVUserPrefsStore } from "./preferences";
import type { LiteLLMPortalEnv } from "./types";

type BudgetThresholdEmailData = {
  spend: number;
  maxBudget: number;
  threshold: number;
  ratio: number;
};

type KeyExpirySoonEmailData = {
  keyAlias: string;
  expiresAt: string;
};

type KeyCreationEmailData = {
  keyAlias: string;
  createdAt: string;
};

export type EmailTemplateData = {
  budgetThreshold: BudgetThresholdEmailData;
  keyExpirySoon: KeyExpirySoonEmailData;
  keyCreation: KeyCreationEmailData;
};

export type EmailTemplateName = keyof EmailTemplateData;

type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

type ScanBudgetThresholdsResult = {
  scannedUsers: number;
  emailedUsers: number;
  skippedUsers: number;
  failedUsers: number;
};

const MAILCHANNELS_URL = "https://api.mailchannels.net/tx/v1/send";
const FROM_EMAIL = "no-reply@ziikoo.com";
const FROM_NAME = "智云AI管理平台";
const CRON_PAGE_SIZE = 100;

export async function sendEmail<TTemplate extends EmailTemplateName>(
  to: string,
  template: TTemplate,
  data: EmailTemplateData[TTemplate],
): Promise<void> {
  const rendered = renderEmail(template, data);
  const response = await fetch(MAILCHANNELS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: rendered.subject,
      content: [
        { type: "text/plain", value: rendered.text },
        { type: "text/html", value: rendered.html },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`mailchannels_send_failed_${response.status}`);
  }
}

export function renderEmail<TTemplate extends EmailTemplateName>(
  template: TTemplate,
  data: EmailTemplateData[TTemplate],
): RenderedEmail {
  if (template === "budgetThreshold") {
    return renderBudgetThresholdEmail(data as BudgetThresholdEmailData);
  }
  if (template === "keyExpirySoon") {
    return renderKeyExpirySoonEmail(data as KeyExpirySoonEmailData);
  }
  return renderKeyCreationEmail(data as KeyCreationEmailData);
}

export async function scanBudgetThresholds(
  env: LiteLLMPortalEnv,
  now: Date = new Date(),
): Promise<ScanBudgetThresholdsResult> {
  if (env.USER_PREFS_KV === undefined) {
    return { scannedUsers: 0, emailedUsers: 0, skippedUsers: 0, failedUsers: 0 };
  }
  const store = new KVUserPrefsStore(env.USER_PREFS_KV);
  const dateKey = now.toISOString().slice(0, 10);
  let page = 1;
  let scannedUsers = 0;
  let emailedUsers = 0;
  let skippedUsers = 0;
  let failedUsers = 0;

  while (true) {
    const result = await listAllUsers(env, { page, size: CRON_PAGE_SIZE });
    scannedUsers += result.users.length;

    for (const user of result.users) {
      const email = user.email.trim().toLowerCase();
      const spend = Number(user.spend ?? 0);
      const maxBudget = user.maxBudget;
      if (!email.includes("@") || maxBudget === null || maxBudget <= 0 || !Number.isFinite(spend)) {
        skippedUsers += 1;
        continue;
      }

      const preferences = await store.getForEmail(email);
      if (!preferences.notifications.budgetThresholdEnabled) {
        skippedUsers += 1;
        continue;
      }

      const threshold = preferences.notifications.budgetThreshold;
      const ratio = spend / maxBudget;
      if (ratio < threshold || await store.hasBudgetAlertForDate(email, dateKey)) {
        skippedUsers += 1;
        continue;
      }

      try {
        await sendEmail(email, "budgetThreshold", { spend, maxBudget, threshold, ratio });
        await store.markBudgetAlertForDate(email, dateKey);
        emailedUsers += 1;
      } catch {
        failedUsers += 1;
      }
    }

    if (result.users.length < CRON_PAGE_SIZE || page * result.size >= result.totalCount) {
      break;
    }
    page += 1;
  }

  return { scannedUsers, emailedUsers, skippedUsers, failedUsers };
}

function renderBudgetThresholdEmail(data: BudgetThresholdEmailData): RenderedEmail {
  const percent = Math.round(data.ratio * 100);
  const thresholdPercent = Math.round(data.threshold * 100);
  const subject = `预算提醒：当前用量已达到 ${percent}%`;
  const text = `你的 LiteLLM 当前花费为 ${formatMoney(data.spend)}，预算为 ${formatMoney(data.maxBudget)}，已达到 ${percent}%（提醒阈值 ${thresholdPercent}%）。`;
  return emailFrame(subject, text);
}

function renderKeyExpirySoonEmail(data: KeyExpirySoonEmailData): RenderedEmail {
  const keyAlias = data.keyAlias || "API Key";
  const subject = `API Key 即将过期：${keyAlias}`;
  const text = `你的 LiteLLM API Key「${keyAlias}」将于 ${data.expiresAt} 过期。请及时创建或切换到新的 Key。`;
  return emailFrame(subject, text);
}

function renderKeyCreationEmail(data: KeyCreationEmailData): RenderedEmail {
  const keyAlias = data.keyAlias || "API Key";
  const subject = `API Key 已创建：${keyAlias}`;
  const text = `你的 LiteLLM API Key「${keyAlias}」已于 ${data.createdAt} 创建。如果这不是你本人操作，请联系管理员。`;
  return emailFrame(subject, text);
}

function emailFrame(subject: string, text: string): RenderedEmail {
  const escapedSubject = escapeHtml(subject);
  const escapedText = escapeHtml(text);
  return {
    subject,
    text,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#111827"><h1>${escapedSubject}</h1><p>${escapedText}</p><p style="color:#6b7280;font-size:12px">智云AI管理平台自动通知</p></body></html>`,
  };
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
