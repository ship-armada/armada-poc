#!/usr/bin/env bash
# ABOUTME: Downloads Sepolia deployment manifests into public/api/deployments for production builds.
# ABOUTME: Mirrors apps/armada-interface/netlify.toml — run before vite build on Vercel/Netlify.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/public/api/deployments"
INSTANCE="${DEPLOYMENT_INSTANCE:-demo1}"
BASE="https://raw.githubusercontent.com/ship-armada/armada-deployments/main/testnet/${INSTANCE}"

mkdir -p "${OUT}"
echo "Fetching deployment manifests (instance: ${INSTANCE})…"

curl -sfL -o "${OUT}/hub-sepolia-v3.json" "${BASE}/sepolia/cctp.json"
curl -sfL -o "${OUT}/client-sepolia-v3.json" "${BASE}/base-sepolia/cctp.json"
curl -sfL -o "${OUT}/clientB-sepolia-v3.json" "${BASE}/arbitrum-sepolia/cctp.json"
curl -sfL -o "${OUT}/privacy-pool-hub-sepolia.json" "${BASE}/sepolia/privacy-pool.json"
curl -sfL -o "${OUT}/privacy-pool-client-sepolia.json" "${BASE}/base-sepolia/privacy-pool.json"
curl -sfL -o "${OUT}/privacy-pool-clientB-sepolia.json" "${BASE}/arbitrum-sepolia/privacy-pool.json"
curl -sfL -o "${OUT}/yield-hub-sepolia.json" "${BASE}/sepolia/yield.json"
# Fee module lives in armada-poc deployments/ (not armada-deployments remote yet).
cp "$(cd "${ROOT}/../.." && pwd)/deployments/fee-module-hub-sepolia.json" "${OUT}/fee-module-hub-sepolia.json"

echo "Done."
