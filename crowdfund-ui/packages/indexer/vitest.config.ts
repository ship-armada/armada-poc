// ABOUTME: Vitest configuration for the crowdfund indexer package.
// ABOUTME: Keeps tests in a Node environment because the indexer is not a browser app.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
})
