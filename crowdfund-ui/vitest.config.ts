// ABOUTME: Root vitest configuration for the crowdfund-ui monorepo.
// ABOUTME: Resolves @ path alias per-package so each app's tests find their own src/.

import { defineConfig, type Plugin } from 'vitest/config'
import path from 'path'

/**
 * Vite plugin that resolves `@/...` imports to the correct package's `src/`
 * directory based on which file is doing the importing. This replaces the
 * deprecated `customResolver` option in resolve.alias.
 */
function perPackageAliasPlugin(): Plugin {
  const packages = ['observer', 'committer', 'admin']
  const pkgSrcDirs = packages.map((pkg) => ({
    pkg,
    src: path.resolve(__dirname, `packages/${pkg}/src`),
  }))

  return {
    name: 'per-package-at-alias',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.startsWith('@/') || !importer) return null
      const relPath = source.slice(2) // strip '@/'
      for (const { src } of pkgSrcDirs) {
        if (importer.startsWith(src)) {
          return path.resolve(src, relPath)
        }
      }
      // Fallback to observer for backward compatibility
      return path.resolve(__dirname, 'packages/observer/src', relPath)
    },
  }
}

export default defineConfig({
  plugins: [perPackageAliasPlugin()],
  define: {
    'import.meta.env.VITE_NETWORK': '"local"',
  },
  test: {
    globals: true,
  },
})
