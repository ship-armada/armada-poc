import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'path'
import fs from 'fs'
import { JsonRpcProvider, Wallet, Contract } from 'ethers'

// Anvil deployer account (has 10,000 ETH on each chain)
const DEPLOYER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// RPC URLs for local chains
// Hub uses 31337 and port 8545 to match Railgun SDK's Hardhat network config
const RPC_URLS: Record<number, string> = {
  31337: 'http://localhost:8545', // Hub
  31338: 'http://localhost:8546', // Client A
  31339: 'http://localhost:8547', // Client B
}

// Deployment file names per chain (V3 first, then V2 fallback)
const DEPLOYMENT_FILES_V3: Record<number, string> = {
  31337: 'hub-v3',
  31338: 'client-v3',
  31339: 'clientB-v3',
}

const DEPLOYMENT_FILES_V2: Record<number, string> = {
  31337: 'hub',
  31338: 'client',
  31339: 'clientB',
}

// Faucet ABI (only what we need)
const FAUCET_ABI = ['function dripTo(address recipient) external']

// Plugin to serve deployment files from parent directory
function serveDeployments() {
  return {
    name: 'serve-deployments',
    configureServer(server: any) {
      server.middlewares.use('/api/deployments', (req: any, res: any, _next: any) => {
        const filename = req.url?.replace(/^\//, '') || ''
        const filepath = path.resolve(__dirname, '../deployments', filename)

        if (fs.existsSync(filepath)) {
          const content = fs.readFileSync(filepath, 'utf-8')
          res.setHeader('Content-Type', 'application/json')
          res.end(content)
        } else {
          res.statusCode = 404
          res.end('Not found')
        }
      })
    },
  }
}

// Plugin to fund user addresses with ETH for gas
function fundGasEndpoint() {
  return {
    name: 'fund-gas',
    configureServer(server: any) {
      // Handle POST /api/fund-gas
      server.middlewares.use('/api/fund-gas', async (req: any, res: any, _next: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }

        // Parse JSON body
        let body = ''
        req.on('data', (chunk: any) => { body += chunk })
        req.on('end', async () => {
          try {
            const { address, chainId } = JSON.parse(body)

            if (!address || !chainId) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Missing address or chainId' }))
              return
            }

            const rpcUrl = RPC_URLS[chainId]
            if (!rpcUrl) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `Unknown chainId: ${chainId}` }))
              return
            }

            // Load deployment to get faucet address (try V3 first, then V2)
            const v3File = DEPLOYMENT_FILES_V3[chainId]
            const v2File = DEPLOYMENT_FILES_V2[chainId]

            if (!v3File && !v2File) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `No deployment for chainId: ${chainId}` }))
              return
            }

            // Try V3 first, then V2
            const v3Path = v3File ? path.resolve(__dirname, `../deployments/${v3File}.json`) : null
            const v2Path = v2File ? path.resolve(__dirname, `../deployments/${v2File}.json`) : null

            let deploymentPath: string | null = null
            if (v3Path && fs.existsSync(v3Path)) {
              deploymentPath = v3Path
            } else if (v2Path && fs.existsSync(v2Path)) {
              deploymentPath = v2Path
            }

            if (!deploymentPath) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `Deployment file not found for chainId: ${chainId}` }))
              return
            }

            const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'))
            const faucetAddress = deployment.contracts?.faucet

            if (!faucetAddress) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Faucet not deployed on this chain' }))
              return
            }

            // Call dripTo() on the faucet contract - this gives user 1000 USDC + 1 ETH
            const provider = new JsonRpcProvider(rpcUrl)
            const deployer = new Wallet(DEPLOYER_PRIVATE_KEY, provider)
            const faucet = new Contract(faucetAddress, FAUCET_ABI, deployer)

            const tx = await faucet.dripTo(address)
            await tx.wait()

            console.log(`[faucet] Dripped to ${address} on chain ${chainId} (1000 USDC + 1 ETH)`)

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: true, txHash: tx.hash }))
          } catch (error: any) {
            console.error('[fund-gas] Error:', error.message)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: error.message }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    react(),
    tailwindcss(),
    nodePolyfills({
      // Enable polyfills for Node.js globals and modules
      include: ['buffer', 'process', 'util', 'stream', 'events', 'assert', 'crypto'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    serveDeployments(),
    fundGasEndpoint(),
  ],
  resolve: {
    alias: {
      // Allow importing from engine internal modules (not exported in main index)
      '@railgun-community/engine/dist': path.resolve(
        __dirname,
        'node_modules/@railgun-community/engine/dist'
      ),
      // Force a single shared-models instance for app + wallet SDK
      '@railgun-community/shared-models': path.resolve(
        __dirname,
        'node_modules/@railgun-community/shared-models'
      ),
    },
    dedupe: ['@railgun-community/shared-models'],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
  // Needed for some Railgun dependencies
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    // Exclude WASM modules from pre-bundling (they use import.meta.url)
    exclude: [
      '@railgun-community/poseidon-hash-wasm',
      '@railgun-community/curve25519-scalarmult-wasm',
    ],
  },
  // Ensure WASM files are served correctly
  assetsInclude: ['**/*.wasm'],
})
