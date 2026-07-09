// ABOUTME: Verifies the demo-critical ZK circuit artifacts are present in public/artifacts.
// ABOUTME: The small variants (01x02/02x02/02x03) are committed; the heavy 8x4 (~30 MB) is left to the SDK's IPFS read-through cache. Kept as a build/deploy guard (prebuild + prepare:artifacts).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dest = path.resolve(__dirname, '../public/artifacts')

// Keep in sync with PRELOAD_VARIANTS in src/lib/railgun/artifacts.ts. 08x04 is deliberately
// excluded — it's ~30 MB and rarely hit; the SDK fetches it from IPFS on the rare occasion.
const VARIANTS = ['01x02', '02x02', '02x03']
const REQUIRED_FILES = ['circuit.wasm', 'zkey', 'vkey.json']

const missing = []
for (const variant of VARIANTS) {
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dest, variant, file))) {
      missing.push(`${variant}/${file}`)
    }
  }
}

if (missing.length > 0) {
  console.error('Missing committed ZK artifacts in public/artifacts:', missing.join(', '))
  console.error('These are version-controlled; a clean checkout should already have them.')
  process.exit(1)
}

console.log(`Verified ${VARIANTS.length} committed artifact variants (${VARIANTS.join(', ')}).`)
