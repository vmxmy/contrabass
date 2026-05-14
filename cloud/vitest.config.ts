import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { makeConfig } from "@lingui/conf";
import path from "path";

const linguiConfig = makeConfig({
  locales: ["zh-CN", "en"],
  sourceLocale: "zh-CN",
  catalogs: [{ path: "src/litellm-portal/i18n/messages/{locale}", include: ["src/litellm-portal"] }],
});

export default defineConfig({
  plugins: [react({ babel: { plugins: [["@lingui/babel-plugin-lingui-macro", { linguiConfig }]] } })],
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "src/test/cloudflare-workers-stub.ts"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
});
