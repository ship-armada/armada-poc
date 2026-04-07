#!/usr/bin/env bash
# ABOUTME: Scans scripts/ and config/ for hardcoded Anvil/Hardhat default addresses.
# ABOUTME: Used by CI and pre-commit hook to prevent test addresses leaking into deploy paths.

set -euo pipefail

# Anvil/Hardhat default accounts #0-9 (case-insensitive partial matches).
# These are derived from the well-known mnemonic and their private keys are public.
ANVIL_ADDRESSES=(
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906"
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9"
  "0x14dC79964da2C08dA15Fd353d30d9CBa38d7A966"
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"
)

# Files where Anvil addresses are allowed (deny-list definition, local-only config, tests)
ALLOWED_FILES=(
  "scripts/deploy-utils.ts"                # deny-list definition
  "config/networks.ts"                     # local-dev placeholder beneficiaries
  "scripts/deploy_faucet.ts"               # local-dev faucet deployer key
  "scripts/setup_chains.sh"                # Anvil chain launcher (prints accounts)
  "scripts/derive_relayer_railgun_address.ts"  # local-dev relayer key derivation
  "scripts/check-anvil-addresses.sh"       # this script
)

# Build grep pattern: join addresses with | for alternation
PATTERN=$(IFS="|"; echo "${ANVIL_ADDRESSES[*]}")

# Build --exclude arguments for allowed files
EXCLUDE_ARGS=()
for f in "${ALLOWED_FILES[@]}"; do
  EXCLUDE_ARGS+=("--exclude=$(basename "$f")")
done

# Determine scan targets: if file list is passed as arguments, scan those;
# otherwise scan scripts/ and config/ directories.
if [[ $# -gt 0 ]]; then
  FILES=("$@")
  # Filter to only scripts/ and config/ files, skip allowed files
  SCAN_FILES=()
  for f in "${FILES[@]}"; do
    if [[ "$f" == scripts/* || "$f" == config/* ]]; then
      skip=false
      for allowed in "${ALLOWED_FILES[@]}"; do
        if [[ "$f" == "$allowed" ]]; then
          skip=true
          break
        fi
      done
      if [[ "$skip" == false ]]; then
        SCAN_FILES+=("$f")
      fi
    fi
  done
  if [[ ${#SCAN_FILES[@]} -eq 0 ]]; then
    exit 0  # No relevant files to scan
  fi
  HITS=$(grep -inH -E "$PATTERN" "${SCAN_FILES[@]}" 2>/dev/null || true)
else
  HITS=$(grep -rinH -E "$PATTERN" scripts/ config/ "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)
fi

if [[ -n "$HITS" ]]; then
  echo "ERROR: Anvil/Hardhat default addresses found in deploy scripts!"
  echo ""
  echo "These well-known test addresses must not appear in deployment code paths."
  echo "Use config/networks.ts environment-namespaced fields instead."
  echo ""
  echo "Violations:"
  echo "$HITS"
  echo ""
  echo "Allowed files (excluded from this check):"
  for f in "${ALLOWED_FILES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo "OK: No Anvil default addresses found in deploy scripts."
