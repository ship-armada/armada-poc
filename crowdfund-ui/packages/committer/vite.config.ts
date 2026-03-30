// ABOUTME: Vite config for the crowdfund committer app.
// ABOUTME: Wallet-connected participant UI — commit USDC, invite, claim ARM/refunds.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Serves deployment JSON files from the project's deployments/ directory
function serveDeployments() {
  return {
    name: 'serve-deployments',
    configureServer(server: any) {
      server.middlewares.use(
        '/api/deployments',
        (req: any, res: any, _next: any) => {
          const filename = req.url?.replace(/^\//, '') || ''
          const deploymentsDir = path.resolve(__dirname, '../../../../deployments')
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
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: ['../../../..'],
    },
  },
})
