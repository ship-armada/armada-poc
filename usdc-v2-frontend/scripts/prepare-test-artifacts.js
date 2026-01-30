/**
 * Prepare Test Artifacts for Browser Use
 *
 * This script decompresses the brotli-compressed test artifacts from
 * railgun-circuit-test-artifacts and copies them to public/artifacts
 * for use in the browser.
 *
 * Run: node scripts/prepare-test-artifacts.js
 */

import fs from 'fs'
import path from 'path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Circuit configs that are deployed to the contract
// Must match TESTING_ARTIFACT_CONFIGS in poc/lib/artifacts.ts
const CIRCUIT_CONFIGS = [
  { nullifiers: 1, commitments: 2 }, // Shield: 1 input -> 2 outputs
  { nullifiers: 2, commitments: 2 }, // Simple transfer
  { nullifiers: 2, commitments: 3 }, // Transfer with change
  { nullifiers: 8, commitments: 4 }, // Medium consolidation
]

const ARTIFACTS_SOURCE = path.join(
  __dirname,
  '../../node_modules/railgun-circuit-test-artifacts/circuits',
)
const ARTIFACTS_DEST = path.join(__dirname, '../public/artifacts')

function circuitConfigToName(config) {
  return `${config.nullifiers.toString().padStart(2, '0')}x${config.commitments.toString().padStart(2, '0')}`
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function decompressAndCopy(sourcePath, destPath) {
  const compressed = fs.readFileSync(sourcePath)
  const decompressed = zlib.brotliDecompressSync(compressed)
  fs.writeFileSync(destPath, decompressed)
  return decompressed.length
}

async function main() {
  console.log('Preparing test artifacts for browser use...\n')

  // Ensure destination directory exists
  ensureDir(ARTIFACTS_DEST)

  let totalSize = 0

  for (const config of CIRCUIT_CONFIGS) {
    const name = circuitConfigToName(config)
    const sourceDir = path.join(ARTIFACTS_SOURCE, name)
    const destDir = path.join(ARTIFACTS_DEST, name)

    console.log(`Processing ${name}...`)

    if (!fs.existsSync(sourceDir)) {
      console.error(`  ERROR: Source directory not found: ${sourceDir}`)
      continue
    }

    ensureDir(destDir)

    // Decompress zkey
    const zkeySource = path.join(sourceDir, 'zkey.br')
    const zkeyDest = path.join(destDir, 'zkey')
    if (fs.existsSync(zkeySource)) {
      const size = decompressAndCopy(zkeySource, zkeyDest)
      console.log(`  zkey: ${(size / 1024 / 1024).toFixed(2)} MB`)
      totalSize += size
    }

    // Decompress wasm
    const wasmSource = path.join(sourceDir, 'wasm.br')
    const wasmDest = path.join(destDir, 'circuit.wasm')
    if (fs.existsSync(wasmSource)) {
      const size = decompressAndCopy(wasmSource, wasmDest)
      console.log(`  wasm: ${(size / 1024 / 1024).toFixed(2)} MB`)
      totalSize += size
    }

    // Copy vkey (already JSON, no decompression needed)
    const vkeySource = path.join(sourceDir, 'vkey.json')
    const vkeyDest = path.join(destDir, 'vkey.json')
    if (fs.existsSync(vkeySource)) {
      fs.copyFileSync(vkeySource, vkeyDest)
      const size = fs.statSync(vkeyDest).size
      console.log(`  vkey: ${(size / 1024).toFixed(2)} KB`)
      totalSize += size
    }
  }

  console.log(`\nTotal artifacts size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
  console.log(`\nArtifacts written to: ${ARTIFACTS_DEST}`)
  console.log('\nDone!')
}

main().catch(console.error)
