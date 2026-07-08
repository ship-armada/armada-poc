// ABOUTME: Vitest configuration — jsdom env, RTL matchers, fake IndexedDB, shared @ path alias.
// ABOUTME: Kept separate from vite.config.ts so we don't drag the deployments dev plugin into test runs.

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: {
    'import.meta.env.VITE_NETWORK': '"local"',
    'import.meta.env.VITE_APP_VERSION': '"0.0.0-test"',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
})
