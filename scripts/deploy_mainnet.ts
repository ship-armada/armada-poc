// ABOUTME: Hardened crowdfund-launch orchestrator — CCTP-record, governance, crowdfund (hub-only).
// ABOUTME: Env-driven (mainnet launch or the Sepolia #319 dry-run via HARDEN_TIMELOCK=true).

/**
 * Mainnet Crowdfund-Launch Orchestrator
 *
 * Runs the HARDENED crowdfund-launch deploy subset on the configured hub:
 *   1. CCTP-record  — write real USDC + CCTP V2 addresses into the hub manifest
 *   2. Governance   — timelock (at minDelay 0 when hardening) + token/treasury/governor/…
 *   3. Crowdfund    — LAST; under the harden profile this raises the timelock delay to
 *                     its production value and renounces all deployer timelock roles.
 *
 * This is intentionally NOT the full shielded-pool deploy. The harden profile (#347)
 * renounces the deployer's timelock roles at the end of crowdfund, so any later
 * timelock-only wiring (fee module, adapter authorization) would revert. Those phases
 * belong to the separate shielded-pool launch and must not be part of a hardened run.
 *
 * Env-driven via config.hub.hardhatNetwork (mainnetHub / sepoliaHub):
 *   - Mainnet launch:  source config/mainnet.env && npm run setup:mainnet
 *   - #319 dry-run:    source config/sepolia.env && HARDEN_TIMELOCK=true npm run setup:mainnet
 *   - Preview only:    add `-- --dry-run` to print the sequence without executing
 *
 * Prerequisites (fail loud if missing): deployer key funded on the hub; real CCTP V2
 * addresses + USDC configured; treasury / security council / launch team / RevenueLock
 * beneficiaries set. See config/mainnet.env.
 */

import { execSync } from "child_process";
import { getNetworkConfig } from "../config/networks";

// --dry-run prints the deploy sequence without executing it (preview the launch plan).
const DRY_RUN = process.argv.slice(2).includes("--dry-run");

function banner(description: string, cmd: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${description}`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`> ${cmd}\n`);
}

function run(cmd: string, description: string): void {
  banner(description, cmd);
  if (DRY_RUN) {
    console.log("  [dry-run] skipped");
    return;
  }
  try {
    execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
  } catch (e) {
    console.error(`\nFailed: ${description}`);
    console.error(`Command: ${cmd}`);
    process.exit(1);
  }
}

/** Run a non-deploy check that should not abort the orchestrator on failure. */
function runNonFatal(cmd: string, description: string): void {
  banner(description, cmd);
  if (DRY_RUN) {
    console.log("  [dry-run] skipped");
    return;
  }
  try {
    execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
  } catch (e) {
    console.warn(`\nWARNING: ${description} reported issues — review the output above.`);
  }
}

async function main() {
  const config = getNetworkConfig();
  const hubNet = config.hub.hardhatNetwork;

  // This orchestrator is for real-CCTP, non-local crowdfund launches (mainnet, or the
  // Sepolia dry-run). Local uses `npm run setup:crowdfund`.
  if (config.env === "local") {
    console.error("Error: this orchestrator is for mainnet / Sepolia-dry-run. For local use: npm run setup:crowdfund");
    process.exit(1);
  }
  if (config.cctpMode !== "real") {
    console.error("Error: CCTP_MODE must be 'real' for the crowdfund-launch orchestrator.");
    process.exit(1);
  }
  if (!config.deployerPrivateKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY is required.");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("  CROWDFUND-LAUNCH DEPLOYMENT (hub-only)");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Env:           ${config.env}`);
  console.log(`  Hub:           ${config.hub.name} (Chain ${config.hub.chainId}, network ${hubNet})`);
  console.log(`  CCTP Mode:     ${config.cctpMode}`);
  console.log(`  Harden:        ${config.hardenTimelock}`);
  console.log(`  Timelock:      ${config.hardenTimelock ? `deploy at 0 → raise to ${config.timelockDelay}s → renounce` : `${config.timelockDelay}s (deployer keeps roles)`}`);
  console.log();

  if (!config.hardenTimelock) {
    console.warn("WARNING: HARDEN_TIMELOCK is off — the deployer will RETAIN timelock roles after deploy.");
    console.warn("         For a production launch or the #319 dry-run, set HARDEN_TIMELOCK=true.\n");
  }

  run("npx hardhat compile", "Compiling contracts");

  // 1. CCTP-record. deploy_cctp_sepolia.ts records REAL Circle CCTP addresses for any
  //    real-CCTP env (not Sepolia-specific despite the name) and writes the hub manifest
  //    the crowdfund reads for its USDC address.
  run(
    `npx hardhat run scripts/deploy_cctp_sepolia.ts --network ${hubNet}`,
    "1/3 Recording real CCTP addresses (hub)"
  );

  // 2. Governance (timelock at minDelay 0 when hardening; deployer granted ops roles).
  run(
    `npx hardhat run scripts/deploy_governance.ts --network ${hubNet}`,
    "2/3 Deploying governance"
  );

  // 3. Crowdfund — LAST. Under harden this wires wind-down + outflow, raises the timelock
  //    delay, and renounces every deployer timelock role.
  run(
    `npx hardhat run scripts/deploy_crowdfund.ts --network ${hubNet}`,
    "3/3 Deploying crowdfund (+ timelock harden)"
  );

  // Verification (non-fatal — a check, not a deploy step).
  runNonFatal(
    `npx hardhat run scripts/verify_deployment.ts --network ${hubNet}`,
    "Verifying deployment"
  );

  console.log("\n" + "=".repeat(60));
  console.log("  CROWDFUND-LAUNCH DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log();
  if (config.hardenTimelock) {
    console.log("Post-deploy checks:");
    console.log("  - Deployer holds NO timelock roles (admin/proposer/executor/canceller).");
    console.log(`  - Timelock minDelay == ${config.timelockDelay}s (production value).`);
    console.log("  - Wind-down wiring + treasury outflow limits set (see verify output).");
  }
  console.log("  - Treasury outflow limits are PLACEHOLDERS until #348 is finalized.");
  console.log("  - Shielded-pool phases (privacy pool, yield, fee module) are a SEPARATE later deploy.");
  console.log();
}

main().catch((e) => {
  console.error("Deployment failed:", e);
  process.exit(1);
});
