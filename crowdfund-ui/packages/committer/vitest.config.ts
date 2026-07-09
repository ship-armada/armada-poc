// ABOUTME: Vitest configuration for unit tests.
// ABOUTME: Uses the same path aliases as the main app.
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@armada/crowdfund-shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  define: {
    'import.meta.env.VITE_NETWORK': '"local"',
    'import.meta.env.VITE_CROWDFUND_PROFILE': '"mainnet"',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
