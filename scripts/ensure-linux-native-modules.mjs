#!/usr/bin/env node
// ABOUTME: Installs Linux x64 native npm optional packages after install (Vercel npm bug #4828).
// ABOUTME: No-op off linux/x64. Covers Rollup, Lightning CSS, and Tailwind Oxide used by armada-interface.

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:process'

if (platform !== 'linux' || arch !== 'x64') {
  process.exit(0)
}

const root = process.cwd()
const require = createRequire(import.meta.url)

function readVersion(packageDir) {
  const pkgPath = join(root, 'node_modules', ...packageDir.split('/'), 'package.json')
  if (!existsSync(pkgPath)) return null
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version
}

function tryRollupVersion() {
  try {
    return require('rollup/package.json').version
  } catch {
    return readVersion('rollup')
  }
}

/** @type {string[]} */
const toInstall = []

const rollupVersion = tryRollupVersion()
if (rollupVersion) {
  toInstall.push(`@rollup/rollup-linux-x64-gnu@${rollupVersion}`)
}

const lightningVersion = readVersion('lightningcss')
if (lightningVersion) {
  toInstall.push(`lightningcss-linux-x64-gnu@${lightningVersion}`)
}

const oxideVersion = readVersion('@tailwindcss/oxide')
if (oxideVersion) {
  toInstall.push(`@tailwindcss/oxide-linux-x64-gnu@${oxideVersion}`)
}

if (toInstall.length === 0) {
  console.warn('[ensure-linux-native-modules] no packages to install (node_modules missing?)')
  process.exit(0)
}

console.log(`[ensure-linux-native-modules] installing: ${toInstall.join(', ')}`)
execSync(`npm install ${toInstall.join(' ')} --legacy-peer-deps --no-save`, {
  stdio: 'inherit',
  env: { ...process.env, npm_config_optional: 'true' },
})
