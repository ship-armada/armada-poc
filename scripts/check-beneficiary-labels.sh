#!/usr/bin/env bash
# ABOUTME: Blocks commits that would publish names tied to RevenueLock beneficiary addresses.
# ABOUTME: Used by the pre-commit hook; checks the staged (index) copy of each file passed in.

set -euo pipefail

# A mainnet beneficiary list may be committed only with neutral labels ("beneficiary 001").
# The named original lives outside the repo, and its filename ends in .named.json, so a
# copy that drifts back into the repo is refused whatever its content.
#
# Messages print file paths and entry numbers only, never a label, so the check itself
# cannot write a name into terminal or CI logs.

NEUTRAL_LABEL_CHECK='
let input = "";
process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
  let list;
  try {
    list = JSON.parse(input);
  } catch {
    console.log("not valid JSON");
    return;
  }
  if (!Array.isArray(list)) {
    console.log("not a JSON array");
    return;
  }
  const bad = list.flatMap((b, i) => (/^beneficiary \d{3}$/.test(b?.label) ? [] : [i + 1]));
  if (bad.length > 0) console.log(`non-neutral label in entries ${bad.join(", ")}`);
});
'

FAILED=false
for f in "$@"; do
  base=$(basename "$f")

  if [[ "$base" == *.named.json ]]; then
    echo "ERROR: $f is a named beneficiary file (*.named.json) and must never be committed."
    FAILED=true
    continue
  fi

  if [[ "$base" == *beneficiar*mainnet*.json ]]; then
    if ! staged=$(git show ":$f" 2>/dev/null); then
      echo "ERROR: could not read the staged copy of $f."
      FAILED=true
      continue
    fi
    problem=$(printf '%s' "$staged" | node -e "$NEUTRAL_LABEL_CHECK")
    if [[ -n "$problem" ]]; then
      echo "ERROR: $f: $problem."
      FAILED=true
    fi
  fi
done

if [[ "$FAILED" == true ]]; then
  echo ""
  echo "Mainnet beneficiary lists may be committed only with neutral labels"
  echo "(\"beneficiary 001\", \"beneficiary 002\", ...). Keep the named list outside the repo."
  exit 1
fi
