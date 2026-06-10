// ABOUTME: Copies the demo-critical ZK circuit artifacts from usdc-v2-frontend into public/artifacts.
// ABOUTME: Only the small variants the app's tx kinds use (P0-12) — the heavy 8x4 (~30 MB) is left to the SDK's IPFS read-through cache, halving the shipped artifact weight.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(__dirname, '../../../usdc-v2-frontend/public/artifacts')
const dest = path.resolve(__dirname, '../public/artifacts')

// Keep in sync with PRELOAD_VARIANTS in src/lib/railgun/artifacts.ts. 08x04 is deliberately
// excluded — it's ~30 MB and rarely hit; the SDK fetches it from IPFS on the rare occasion.
const VARIANTS = ['01x02', '02x02', '02x03']

if (!fs.existsSync(src)) {
  console.error('Missing source artifacts. Expected:', src)
  process.exit(1)
}

fs.mkdirSync(dest, { recursive: true })
for (const variant of VARIANTS) {
  const variantSrc = path.join(src, variant)
  if (!fs.existsSync(variantSrc)) {
    console.error(`Missing artifact variant ${variant}. Expected:`, variantSrc)
    process.exit(1)
  }
  fs.cpSync(variantSrc, path.join(dest, variant), { recursive: true })
}
console.log(`Copied ${VARIANTS.length} artifact variants (${VARIANTS.join(', ')}) to`, dest)
