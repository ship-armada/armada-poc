// ABOUTME: Vite configuration for the standalone governance test UI.
// ABOUTME: Includes a plugin to serve deployment manifests from the parent deployments/ directory.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Serves deployment JSON files from ../deployments/ at /api/deployments/.
 * Same pattern as usdc-v2-frontend.
 *
 * Supports two modes:
 *   GET /api/deployments/<name>.json        → serve a single manifest
 *   GET /api/deployments/?list=<prefix>     → list filenames matching prefix
 */
function serveDeployments() {
  return {
    name: 'serve-deployments',
    configureServer(server: any) {
      server.middlewares.use(
        '/api/deployments',
        (req: any, res: any, _next: any) => {
          const urlPath = req.url || ''
          const deploymentsDir = path.resolve(__dirname, '../deployments')

          // Directory listing mode: /?list=<prefix>
          const listMatch = urlPath.match(/^\/?\?list=([a-zA-Z0-9_-]+)/)
          if (listMatch) {
            const prefix = listMatch[1]
            if (!fs.existsSync(deploymentsDir)) {
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify([]))
              return
            }
            const matches = fs
              .readdirSync(deploymentsDir)
              .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
              .sort()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(matches))
            return
          }

          // Single file mode
          const filename = urlPath.replace(/^\//, '').split('?')[0] || ''
          const filepath = path.resolve(deploymentsDir, filename)

          // Prevent path traversal outside the deployments directory
          if (!filepath.startsWith(deploymentsDir + path.sep) && filepath !== deploymentsDir) {
            res.statusCode = 403
            res.end(JSON.stringify({ error: 'Access denied' }))
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
  plugins: [react(), tailwindcss(), serveDeployments()],
  server: {
    port: 5174,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
