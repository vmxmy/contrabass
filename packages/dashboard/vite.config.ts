import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const localBackend = env.CONTRABASS_LOCAL_BACKEND || 'http://localhost:8080'
  const cloudBackend = env.CONTRABASS_CLOUD_BACKEND || 'http://localhost:8787'

  return {
    plugins: [react(), tailwindcss()],
    base: './',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: 'dist',
    },
    server: {
      proxy: {
        '/api': localBackend,
        '/v1': cloudBackend,
      },
    },
  }
})
