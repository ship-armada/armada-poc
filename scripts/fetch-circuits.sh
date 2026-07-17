#!/usr/bin/env bash
# ABOUTME: Fetches the pinned armada-circuits release artifacts (WASM/ZKEY/VKEY) and installs
# ABOUTME: them at <repo-parent>/armada-circuits/build/, where lib/sdk/armada-artifacts.ts expects them.
set -euo pipefail

# The trusted setup is non-reproducible: the release asset IS the canonical artifact
# set. Every consumer (local dev, CI, deployments) must use this exact release.
# To bump: cut a new release in ship-armada/armada-circuits, then update the three
# pins below (hashes are in the release's SHA256SUMS + `shasum -a 256 SHA256SUMS`).
CIRCUITS_REPO="ship-armada/armada-circuits"
CIRCUITS_TAG="v0.1.0-dev"
TARBALL="armada-circuits-${CIRCUITS_TAG}.tgz"
TARBALL_SHA256="e7c4e5eac92973a9d43733efa240f52793b8609eb338db0bbd3a7e1550be369a"
SUMSFILE_SHA256="e5e21a52db55e776a6ad7d9c2fbd368a9ed93cfe376954e242ad299341fe3f2e"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# Destination: sibling of the repo checkout (see lib/sdk/armada-artifacts.ts).
# Override with $1 for non-standard layouts.
DEST="${1:-"$(dirname "$REPO_ROOT")/armada-circuits/build"}"
STAMP="$DEST/.fetched-${CIRCUITS_TAG}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$TARBALL_SHA256" ]; then
  echo "Armada circuits ${CIRCUITS_TAG} already present at $DEST"
  exit 0
fi

echo "Fetching armada-circuits ${CIRCUITS_TAG} → $DEST"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

gh release download "$CIRCUITS_TAG" --repo "$CIRCUITS_REPO" --dir "$WORKDIR" \
  --pattern "$TARBALL" --pattern SHA256SUMS

actual_tarball_sha="$(sha256 "$WORKDIR/$TARBALL")"
if [ "$actual_tarball_sha" != "$TARBALL_SHA256" ]; then
  echo "ERROR: $TARBALL sha256 mismatch" >&2
  echo "  expected: $TARBALL_SHA256" >&2
  echo "  actual:   $actual_tarball_sha" >&2
  exit 1
fi

actual_sums_sha="$(sha256 "$WORKDIR/SHA256SUMS")"
if [ "$actual_sums_sha" != "$SUMSFILE_SHA256" ]; then
  echo "ERROR: SHA256SUMS sha256 mismatch" >&2
  echo "  expected: $SUMSFILE_SHA256" >&2
  echo "  actual:   $actual_sums_sha" >&2
  exit 1
fi

mkdir -p "$DEST"
tar -xzf "$WORKDIR/$TARBALL" -C "$DEST"

# Belt-and-braces: verify every extracted file against the per-file manifest
# (the tarball's own line refers to the archive, not an extracted file).
(cd "$DEST" && grep -v "$TARBALL" "$WORKDIR/SHA256SUMS" | \
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet -; else shasum -a 256 -c -; fi >/dev/null)

echo "$TARBALL_SHA256" > "$STAMP"
echo "Done: $(ls "$DEST" | grep -c 'x') circuit shapes installed at $DEST"
