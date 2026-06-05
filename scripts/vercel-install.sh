#!/usr/bin/env bash
# ABOUTME: Vercel install hook for the armada-interface monorepo — clean install + Rollup Linux native binary.
# ABOUTME: Referenced from apps/armada-interface/vercel.json (paths are relative to that app directory).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo "[vercel-install] cleaning node_modules…"
rm -rf node_modules

echo "[vercel-install] npm install (legacy-peer-deps)…"
npm install --legacy-peer-deps --include=optional

echo "[vercel-install] ensure linux native modules (rollup, lightningcss, oxide)…"
node scripts/ensure-linux-native-modules.mjs

echo "[vercel-install] done."
