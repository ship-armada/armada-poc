#!/usr/bin/env bash
# ABOUTME: Downloads Sepolia deployment manifests into public/api/deployments for production builds.
# ABOUTME: Mirrors apps/armada-interface/netlify.toml — run before vite build on Vercel/Netlify.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/public/api/deployments"
INSTANCE="${DEPLOYMENT_INSTANCE:-demo1}"
# Manifest ref (P1-23). These manifests carry fund-receiving contract addresses, so for production
# pin DEPLOYMENT_REF to a commit SHA of ship-armada/armada-deployments — that freezes the addresses
# into the build. Optional: defaults to the mutable `main` branch when unset (convenient, but a
# repo change then flows into the next build, which is the supply-chain risk pinning avoids).
REF="${DEPLOYMENT_REF:-main}"
if [ -z "${DEPLOYMENT_REF:-}" ]; then
  echo "WARNING: DEPLOYMENT_REF unset — fetching from mutable 'main'. Pin to a commit SHA for production."
fi
BASE="https://raw.githubusercontent.com/ship-armada/armada-deployments/${REF}/testnet/${INSTANCE}"

mkdir -p "${OUT}"
echo "Fetching deployment manifests (instance: ${INSTANCE}, ref: ${REF})…"

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
