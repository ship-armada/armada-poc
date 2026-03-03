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
 */
function serveDeployments() {
  return {
    name: 'serve-deployments',
    configureServer(server: any) {
      server.middlewares.use(
        '/api/deployments',
        (req: any, res: any, _next: any) => {
          const filename = req.url?.replace(/^\//, '') || ''
          const filepath = path.resolve(__dirname, '../deployments', filename)

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
