// ABOUTME: Vitest configuration for the shared library unit tests.
// ABOUTME: Minimal config — no path aliases needed (shared uses relative imports).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
})
