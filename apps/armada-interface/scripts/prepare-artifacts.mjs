// ABOUTME: Copies bundled ZK artifacts from usdc-v2-frontend into public/artifacts for local dev.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(__dirname, '../../../usdc-v2-frontend/public/artifacts')
const dest = path.resolve(__dirname, '../public/artifacts')

if (!fs.existsSync(src)) {
  console.error('Missing source artifacts. Expected:', src)
  process.exit(1)
}

fs.cpSync(src, dest, { recursive: true })
console.log('Copied test artifacts to', dest)
