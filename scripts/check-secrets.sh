#!/usr/bin/env bash
# ABOUTME: Scans files for accidentally included secrets (private keys, mnemonics, API keys).
# ABOUTME: Used by pre-commit hook to catch sensitive data before it enters git history.

set -euo pipefail

# Files where private keys or mnemonics are expected (local-dev tooling only)
ALLOWED_FILES=(
  "scripts/deploy-utils.ts"         # Anvil deny-list references addresses (not keys)
  "scripts/deploy_faucet.ts"        # Anvil default key for local faucet deployment
  "config/local.env"                # Local-only Anvil key (committed intentionally)
  "config/networks.ts"              # Anvil default key for local deployer
  "hardhat.config.ts"               # Anvil default key for Hardhat network config
  "scripts/check-secrets.sh"        # This script (contains patterns, not secrets)
  "scripts/derive_relayer_railgun_address.ts"  # Local-dev relayer key derivation
  "relayer/config.ts"               # Anvil default key for local relayer
)

# Patterns that indicate secrets. Each entry: "LABEL:::REGEX"
PATTERNS=(
  "Private key (hex):::0x[a-fA-F0-9]{64}"
  "Mnemonic phrase:::(test test test|abandon ){3,}"
  "AWS access key:::AKIA[0-9A-Z]{16}"
  "Generic secret assignment:::(SECRET|PRIVATE_KEY|MNEMONIC|API_KEY|AUTH_TOKEN)\s*=\s*['\"][^'\"]{8,}"
)

# Determine files to scan
if [[ $# -gt 0 ]]; then
  FILES=("$@")
else
  echo "Usage: $0 <file1> [file2] ..."
  echo "Typically called by the pre-commit hook with staged files."
  exit 0
fi

# Filter out allowed files
SCAN_FILES=()
for f in "${FILES[@]}"; do
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
done

if [[ ${#SCAN_FILES[@]} -eq 0 ]]; then
  exit 0
fi

FOUND=false

for entry in "${PATTERNS[@]}"; do
  LABEL="${entry%%:::*}"
  REGEX="${entry#*:::}"
  HITS=$(grep -nHE "$REGEX" "${SCAN_FILES[@]}" 2>/dev/null || true)
  if [[ -n "$HITS" ]]; then
    if [[ "$FOUND" == false ]]; then
      echo "ERROR: Potential secrets detected in staged files!"
      echo ""
      FOUND=true
    fi
    echo "  [$LABEL]"
    echo "$HITS" | sed 's/^/    /'
    echo ""
  fi
done

if [[ "$FOUND" == true ]]; then
  echo "If these are intentional (e.g. test fixtures), add the file to ALLOWED_FILES"
  echo "in scripts/check-secrets.sh."
  exit 1
fi
