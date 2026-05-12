import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { makeConfig } from "@lingui/conf";

const linguiConfig = makeConfig({
  locales: ["zh-CN", "en"],
  sourceLocale: "zh-CN",
  catalogs: [{ path: "src/litellm-portal/i18n/messages/{locale}", include: ["src/litellm-portal"] }],
});

export default defineConfig({
  plugins: [react({ babel: { plugins: [["@lingui/babel-plugin-lingui-macro", { linguiConfig }]] } })],
  build: {
    rollupOptions: {
      input: "src/litellm-portal/client.tsx",
      output: {
        entryFileNames: "portal.[hash].js",
        chunkFileNames: "portal-[name].[hash].js",
        assetFileNames: "portal-[name].[hash][extname]",
        dir: "dist",
      },
    },
  },
  server: {
    port: 5173,
    // Allow wrangler dev (localhost:8787) to load assets from Vite dev server
    cors: true,
  },
});
