import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
