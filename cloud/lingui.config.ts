import { defineConfig } from "@lingui/cli";

export default defineConfig({
  locales: ["zh-CN", "en"],
  sourceLocale: "zh-CN",
  catalogs: [
    {
      path: "src/litellm-portal/i18n/locales/{locale}/messages",
      include: ["src/litellm-portal"],
      exclude: ["**/node_modules/**", "**/*.test.tsx", "**/*.test.ts"],
    },
  ],
  compileNamespace: "es",
});
