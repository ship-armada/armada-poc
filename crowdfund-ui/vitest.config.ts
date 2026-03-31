// ABOUTME: Root vitest configuration for the crowdfund-ui monorepo.
// ABOUTME: Includes path aliases needed by all packages' test files.

import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      // Observer package uses @ alias for src/
      '@': path.resolve(__dirname, 'packages/observer/src'),
    },
  },
  define: {
    'import.meta.env.VITE_NETWORK': '"local"',
  },
  test: {
    globals: true,
  },
})
