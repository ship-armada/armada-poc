// ABOUTME: Reads Hardhat artifacts and reports deployed bytecode sizes.
// ABOUTME: Exits with code 1 if any contract exceeds the EIP-170 24,576-byte limit.

const fs = require("fs");
const path = require("path");

const EIP_170_LIMIT = 24576;
const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "contracts");

function walkArtifacts(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkArtifacts(full));
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
      results.push(full);
    }
  }
  return results;
}

if (!fs.existsSync(ARTIFACTS_DIR)) {
  console.error(`Artifacts directory not found: ${ARTIFACTS_DIR}`);
  console.error("Run `npm run compile` first.");
  process.exit(1);
}

const sizes = [];
for (const file of walkArtifacts(ARTIFACTS_DIR)) {
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const hex = (artifact.deployedBytecode || "").replace(/^0x/, "");
  if (hex.length === 0) continue; // interfaces, abstract contracts, libraries without code
  const bytes = hex.length / 2;
  sizes.push({ name: artifact.contractName, source: artifact.sourceName, bytes });
}

sizes.sort((a, b) => b.bytes - a.bytes);

const oversized = sizes.filter((s) => s.bytes > EIP_170_LIMIT);

const nameWidth = Math.max(...sizes.map((s) => s.name.length), 8);
console.log(`${"Contract".padEnd(nameWidth)}  ${"Bytes".padStart(7)}  Margin`);
console.log(`${"-".repeat(nameWidth)}  ${"-".repeat(7)}  ${"-".repeat(7)}`);
for (const s of sizes) {
  const margin = EIP_170_LIMIT - s.bytes;
  const flag = margin < 0 ? " !! OVER LIMIT" : "";
  console.log(`${s.name.padEnd(nameWidth)}  ${String(s.bytes).padStart(7)}  ${String(margin).padStart(7)}${flag}`);
}

if (oversized.length > 0) {
  console.error("");
  console.error(`ERROR: ${oversized.length} contract(s) exceed the ${EIP_170_LIMIT}-byte EIP-170 limit:`);
  for (const s of oversized) {
    console.error(`  ${s.name} (${s.source}): ${s.bytes} bytes (${s.bytes - EIP_170_LIMIT} over)`);
  }
  process.exit(1);
}

console.log("");
console.log(`All ${sizes.length} contracts are within the ${EIP_170_LIMIT}-byte limit.`);
