// ABOUTME: Vite config for @armada/interface — USDC shield/yield/payment wallet on the Armada protocol.
// ABOUTME: Serves deployment JSON via dev plugin (committer pattern); runs on port 5176 to avoid collisions with crowdfund apps (5173/4/5) and the showcase (5180).

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { ethers } from 'ethers'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
)

/**
 * Local-mode dev endpoint: POST /api/fund-gas { address, chainId } → uses the well-known Anvil
 * deployer account to call `faucet.dripTo(address)`, sending 1 000 mockUSDC + a small ETH
 * sponsor amount to the recipient. Lets a brand-new wallet onboard against local Anvil without
 * needing the user to import a dev account first.
 *
 * Disabled on sepolia builds — returns 503 so any stray client call fails loudly.
 */
function fundGasEndpoint() {
  // The standard Anvil "test test ..." mnemonic account #0 — publicly known. Has 10 000 ETH on
  // every fresh Anvil instance. Safe to hardcode in dev config; never used outside local mode.
  const ANVIL_DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  const RPC_BY_CHAIN_ID: Record<number, string> = {
    31337: 'http://localhost:8545',
    31338: 'http://localhost:8546',
    31339: 'http://localhost:8547',
  }
  // Maps chainId → secondary manifest filename (the file that carries the faucet address).
  // Mirrors the deployment naming convention; if it changes, update this map too.
  const MANIFEST_BY_CHAIN_ID: Record<number, string> = {
    31337: 'hub-v3.json',
    31338: 'client-v3.json',
    31339: 'clientB-v3.json',
  }
  const FAUCET_ABI = ['function dripTo(address recipient) external']

  return {
    name: 'fund-gas',
    configureServer(server: any) {
      server.middlewares.use('/api/fund-gas', async (req: any, res: any, _next: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        if (process.env.VITE_NETWORK === 'sepolia') {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Faucet not available on Sepolia.' }))
          return
        }

        let body = ''
        req.on('data', (chunk: any) => { body += chunk })
        req.on('end', async () => {
          try {
            const { address, chainId } = JSON.parse(body) as { address: string; chainId: number }
            if (!address || !chainId) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Missing address or chainId' }))
              return
            }
            const rpcUrl = RPC_BY_CHAIN_ID[chainId]
            const manifestName = MANIFEST_BY_CHAIN_ID[chainId]
            if (!rpcUrl || !manifestName) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `Unknown chainId: ${chainId}` }))
              return
            }
            const manifestPath = path.resolve(__dirname, '../../deployments', manifestName)
            if (!fs.existsSync(manifestPath)) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: `Manifest not found: ${manifestName}` }))
              return
            }
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
            const faucetAddress = manifest?.contracts?.faucet
            if (!faucetAddress) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Faucet address not in manifest' }))
              return
            }
            const provider = new ethers.JsonRpcProvider(rpcUrl)
            const deployer = new ethers.Wallet(ANVIL_DEPLOYER_PK, provider)
            const faucet = new ethers.Contract(faucetAddress, FAUCET_ABI, deployer)
            const dripFn = faucet.dripTo as (a: string) => Promise<ethers.ContractTransactionResponse>
            const tx = await dripFn(address)
            await tx.wait()
            // eslint-disable-next-line no-console
            console.log(`[fund-gas] Dripped to ${address} on chain ${chainId} (tx ${tx.hash})`)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: true, txHash: tx.hash }))
          } catch (error: any) {
            // eslint-disable-next-line no-console
            console.error('[fund-gas] Error:', error?.message ?? error)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: error?.message ?? 'fund-gas failed' }))
          }
        })
      })
    },
  }
}

/**
 * Serves deployment JSON files from the project's `deployments/` directory.
 * Path-traversal guard prevents reads outside that directory.
 *
 * Copied from `crowdfund-ui/packages/committer/vite.config.ts`. When committer
 * and this app both evolve this plugin, extract it. Until then, keep in sync.
 */
function serveDeployments() {
  return {
    name: 'serve-deployments',
    configureServer(server: any) {
      server.middlewares.use(
        '/api/deployments',
        (req: any, res: any, _next: any) => {
          const filename = req.url?.replace(/^\//, '') || ''
          const deploymentsDir = path.resolve(__dirname, '../../deployments')
          const filepath = path.resolve(deploymentsDir, filename)

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
    // wasm + topLevelAwait MUST come before react() so the Railgun SDK's ZK WASM modules
    // (Poseidon hash, curve25519-scalarmult) load as ES modules at runtime instead of being
    // served through Vite's SPA HTML fallback (which manifests as `WebAssembly.instantiate:
    // expected magic word 00 61 73 6d, found 3c 21 64 6f` — i.e. the wasm fetch returned
    // index.html). topLevelAwait is required because the wasm plugin's emitted modules use
    // top-level `await` to defer the rest of the module until the WASM is ready.
    wasm(),
    topLevelAwait(),
    react(),
    tailwindcss(),
    // Railgun SDK + transitive deps (level-js, circomlibjs, ethereum-cryptography, etc.) reach
    // for Node built-ins at runtime. Polyfill the minimum set that the SDK actually touches —
    // expanding this list later is cheap, but each entry adds bundle weight.
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'events', 'assert', 'crypto'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    serveDeployments(),
    fundGasEndpoint(),
    // Sentry sourcemap upload + release. Self-disables when SENTRY_AUTH_TOKEN is unset, so local
    // dev builds and previews without Sentry env vars build cleanly with zero overhead. Must run
    // LAST so the bundle + sourcemaps are finalised before upload. `filesToDeleteAfterUpload`
    // removes the .map files from dist/ once uploaded so they're never published — defence in
    // depth for a privacy app on top of `build.sourcemap: 'hidden'` (which already strips the
    // sourceMappingURL reference). Release name defaults to the plugin's git auto-detection when
    // VITE_SENTRY_RELEASE is unset, keeping the uploaded maps aligned with the runtime release.
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      release: process.env.VITE_SENTRY_RELEASE
        ? { name: process.env.VITE_SENTRY_RELEASE }
        : undefined,
      sourcemaps: {
        assets: ['./dist/**'],
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
  ],
  build: {
    // Bump the browser baseline above Vite's default 'modules' target
    // (chrome87 / edge88 / firefox78 / safari14 — early 2020). The default trips
    // `vite-plugin-top-level-await` during bundling: the plugin emits a wrapper
    // that uses destructuring patterns esbuild's downleveler refuses to compile
    // for chrome87. es2022 supports both destructuring AND native top-level
    // await — no downleveling needed, smaller bundle, faster build. Modern
    // wallet dapps (RainbowKit, viem, wagmi) already require a similar baseline
    // at runtime; matching it here just removes the bundler-side hoop-jumping.
    target: 'es2022',
    // Emit sourcemaps ONLY when a Sentry auth token is present (i.e. the upload will actually
    // run). `hidden` strips the `//# sourceMappingURL=` reference from the shipped JS, and the
    // plugin's `filesToDeleteAfterUpload` removes the .map files from dist/ once uploaded — so a
    // Sentry-configured build publishes NO maps yet Sentry symbolicates server-side. Without a
    // token the plugin is disabled and `filesToDeleteAfterUpload` would never fire, so we must
    // not emit maps at all here — otherwise an un-configured deploy would publish unreferenced
    // (but fetchable) maps, which a privacy app should never ship.
    sourcemap: process.env.SENTRY_AUTH_TOKEN ? 'hidden' : false,
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    // level-js (used by the Railgun engine's LevelDB store) references Node's `global`.
    // Replace it with `globalThis` so the module evaluates in the browser. Mirrors the
    // legacy app's esbuild/define pattern; the heavier `vite-plugin-node-polyfills` isn't
    // required unless other Node-flavored deps surface at runtime (Buffer, process, etc.).
    global: 'globalThis',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        // Same replacement applied during dep pre-bundling — level-js gets compiled here.
        global: 'globalThis',
      },
    },
    // These packages contain `import.meta.url`-relative .wasm imports that esbuild's
    // prebundler can't statically resolve. Excluding them keeps the wasm() plugin's runtime
    // ESM loader in charge — same fix the legacy usdc-v2-frontend applied.
    exclude: [
      '@railgun-community/poseidon-hash-wasm',
      '@railgun-community/curve25519-scalarmult-wasm',
    ],
  },
  server: {
    port: 5176,
    strictPort: true,
    fs: {
      allow: ['../..'],
    },
  },
})
