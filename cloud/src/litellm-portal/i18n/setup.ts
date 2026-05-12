import { setupI18n as linguiSetupI18n } from "@lingui/core";
import zhCNMessages from "./messages/zh-CN";
import enMessages from "./messages/en";

export type SupportedLocale = "zh-CN" | "en";

const SUPPORTED_LOCALES: SupportedLocale[] = ["zh-CN", "en"];
const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

const catalogs: Record<SupportedLocale, Record<string, string>> = {
  "zh-CN": zhCNMessages,
  "en": enMessages,
};

/**
 * Detect the best supported locale from an Accept-Language header value.
 * Falls back to zh-CN (the default).
 */
export function detectLocale(acceptLanguage: string | null | undefined): SupportedLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const tags = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.trim(), q: q !== undefined ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .map((item) => item.tag.toLowerCase());

  for (const tag of tags) {
    if (tag === "zh-cn" || tag.startsWith("zh")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }

  return DEFAULT_LOCALE;
}

/**
 * Build and activate a Lingui i18n instance for the given locale.
 * Call this once per request on the server, and once on the client.
 */
export function setupI18n(locale: SupportedLocale = DEFAULT_LOCALE) {
  const messages = catalogs[locale] ?? catalogs[DEFAULT_LOCALE];
  const i18n = linguiSetupI18n();
  i18n.loadAndActivate({ locale, messages });
  return i18n;
}

export { DEFAULT_LOCALE, SUPPORTED_LOCALES };
