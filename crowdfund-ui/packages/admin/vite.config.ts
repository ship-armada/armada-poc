// ABOUTME: Vite config for the crowdfund admin app.
// ABOUTME: Launch team and security council operations, plus local dev tools.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { JsonRpcProvider, Wallet, Contract } from 'ethers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Anvil deployer account (publicly known test key)
const DEPLOYER_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const MOCK_USDC_MINT_ABI = ['function mint(address to, uint256 amount) external']

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

// Server-side endpoint to mint MockUSDC (local mode only, uses deployer key)
function mintUsdcEndpoint() {
  return {
    name: 'mint-usdc',
    configureServer(server: any) {
      server.middlewares.use(
        '/api/mint-usdc',
        async (req: any, res: any, _next: any) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method not allowed')
            return
          }

          // Only available in local mode
          if (process.env.VITE_NETWORK === 'sepolia') {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Mint not available on Sepolia. Use Circle faucet.' }))
            return
          }

          let body = ''
          req.on('data', (chunk: any) => { body += chunk })
          req.on('end', async () => {
            try {
              const { recipient, amount, usdcAddress } = JSON.parse(body)

              if (!recipient || !amount || !usdcAddress) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Missing recipient, amount, or usdcAddress' }))
                return
              }

              const provider = new JsonRpcProvider('http://localhost:8545')
              const deployer = new Wallet(DEPLOYER_PRIVATE_KEY, provider)
              const usdc = new Contract(usdcAddress, MOCK_USDC_MINT_ABI, deployer)

              const tx = await usdc.mint(recipient, amount)
              await tx.wait()

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ success: true, txHash: tx.hash }))
            } catch (error: any) {
              console.error('[mint-usdc] Error:', error.message)
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: error.message }))
            }
          })
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
    mintUsdcEndpoint(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5175,
    fs: {
      allow: ['../../..'],
    },
  },
})
