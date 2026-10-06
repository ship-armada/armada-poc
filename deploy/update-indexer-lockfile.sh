#!/usr/bin/env bash
# ABOUTME: Regenerates crowdfund-ui/packages/indexer/package-lock.json, the standalone
# ABOUTME: lockfile the indexer Docker image installs from with `npm ci`.
set -euo pipefail

# Run after changing the indexer's package.json (from anywhere in the repo):
#   ./deploy/update-indexer-lockfile.sh
#
# The lock is resolved in a scratch dir because the indexer is also an npm workspace
# member: running npm inside crowdfund-ui/packages/indexer would act on the workspace
# root and its lockfile instead. The existing lockfile is carried over, so dependencies
# whose package.json ranges are unchanged keep their pinned versions. To refresh every
# dependency to the newest matching version, delete the lockfile first.
#
# --legacy-peer-deps: npm 10 crashes ("Cannot read properties of null (reading
# 'edgesOut')") resolving the optional peer graph of vite/vitest. The Dockerfile's
# `npm ci` uses the same flag.

INDEXER_DIR="$(git rev-parse --show-toplevel)/crowdfund-ui/packages/indexer"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cp "$INDEXER_DIR/package.json" "$SCRATCH/"
if [ -f "$INDEXER_DIR/package-lock.json" ]; then
  cp "$INDEXER_DIR/package-lock.json" "$SCRATCH/"
fi

(cd "$SCRATCH" && npm install --package-lock-only --legacy-peer-deps --no-audit --no-fund)

cp "$SCRATCH/package-lock.json" "$INDEXER_DIR/package-lock.json"
echo "Updated $INDEXER_DIR/package-lock.json — rebuild the image to verify."
