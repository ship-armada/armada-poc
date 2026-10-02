#!/usr/bin/env bash
# License-hygiene gate for the privacy pool contract rewrite (M8).
#
# Fails CI if any unlicensed/derivative vendored code re-enters the tree:
#   1. contracts/railgun/ must stay deleted
#   2. no UNLICENSED SPDX identifier anywhere under contracts/
#   3. no upstream attribution strings anywhere under contracts/
#   4. the rewritten privacy-pool tree must not reference the legacy protocol by name
# (_legacy/ is frozen superseded history and is exempt from gates 2-4 by design;
#  see _legacy/README.md.)
set -euo pipefail

fail=0

if [ -d contracts/railgun ]; then
  echo "HYGIENE FAIL: contracts/railgun/ exists — vendored unlicensed tree must stay deleted"
  fail=1
fi

if grep -rIl "SPDX-License-Identifier: UNLICENSED" contracts/ >/dev/null 2>&1; then
  echo "HYGIENE FAIL: UNLICENSED SPDX identifier under contracts/:"
  grep -rIl "SPDX-License-Identifier: UNLICENSED" contracts/
  fail=1
fi

if grep -rIl "@author Railgun Contributors" contracts/ >/dev/null 2>&1; then
  echo "HYGIENE FAIL: upstream attribution string under contracts/:"
  grep -rIl "@author Railgun Contributors" contracts/
  fail=1
fi

if grep -rIl --include="*.sol" -i "railgun" contracts/privacy-pool/ contracts/GaslessShieldWrapper.sol contracts/GaslessShieldWrapperClient.sol contracts/yield/ >/dev/null 2>&1; then
  echo "HYGIENE FAIL: legacy-protocol name reference in rewritten contracts:"
  grep -rIl --include="*.sol" -i "railgun" contracts/privacy-pool/ contracts/GaslessShieldWrapper.sol contracts/GaslessShieldWrapperClient.sol contracts/yield/
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "License hygiene OK"
