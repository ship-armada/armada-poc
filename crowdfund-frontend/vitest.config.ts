// ABOUTME: Vitest configuration for unit tests.
// ABOUTME: Uses the same path aliases as the main app.
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
  },
})
