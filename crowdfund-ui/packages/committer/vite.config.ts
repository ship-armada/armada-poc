// ABOUTME: Vite config for the crowdfund committer app.
// ABOUTME: Wallet-connected participant UI — commit USDC, invite, claim ARM/refunds.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
)

// Serves deployment JSON files from the project's deployments/ directory
function serveDeployments() {
  return {
    name: 'serve-deployments',
    configureServer(server: any) {
      server.middlewares.use(
        '/api/deployments',
        (req: any, res: any, _next: any) => {
          const filename = req.url?.replace(/^\//, '') || ''
          const deploymentsDir = path.resolve(__dirname, '../../../deployments')
          const filepath = path.resolve(deploymentsDir, filename)

          // Prevent path traversal — resolved path must stay within deployments/
          if (!filepath.startsWith(deploymentsDir + path.sep) && filepath !== deploymentsDir) {
            res.statusCode = 403
            res.end(JSON.stringify({ error: 'Forbidden' }))
            return
          }

          if (fs.existsSync(filepath)) {
            const content = fs.readFileSync(filepath, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.end(content)
          } else {
            res.statusCode = 404
            res.end(JSON.stringify({ error: `Deployment file not found: ${filename}` }))
          }
        },
      )
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    serveDeployments(),
    // Sentry sourcemap upload. Self-disabling when `SENTRY_AUTH_TOKEN` is
    // unset, so local dev builds incur zero overhead and Netlify previews
    // without Sentry env vars still build cleanly. Must run last so the
    // bundle is finalised before sourcemaps are uploaded.
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      // Don't phone home build telemetry to Sentry.
      telemetry: false,
      release: process.env.VITE_SENTRY_RELEASE
        ? { name: process.env.VITE_SENTRY_RELEASE }
        : undefined,
      // Upload sourcemaps to Sentry, then delete the .map files from dist/ so
      // they are never published with the deployed bundle (sourcemap: 'hidden'
      // already strips the //# sourceMappingURL reference, but the files
      // themselves would otherwise ship at guessable names).
      // CAVEAT: this whole plugin no-ops when SENTRY_AUTH_TOKEN is unset
      // (`disable` above), so a build without the token still emits .map files
      // into dist/. SENTRY_AUTH_TOKEN must be set as a Netlify build var for
      // production deploys — see netlify.toml.
      sourcemaps: {
        assets: ['./dist/**'],
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: ['../../..'],
    },
  },
  build: {
    // `hidden` generates sourcemaps for the Sentry plugin to upload, then
    // strips the `//# sourceMappingURL=...` reference from the emitted JS so
    // the maps aren't reachable from the deployed bundle. Sentry still
    // symbolicates events because it has the maps server-side.
    sourcemap: 'hidden',
  },
})
