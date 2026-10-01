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
 *   - Mainnet launch:  source config/mainnet.env && DEPLOY_COMMIT=<sha> npm run setup:mainnet -- --confirm-mainnet
 *   - #319 dry-run:    source config/sepolia.env && HARDEN_TIMELOCK=true npm run setup:mainnet
 *   - Preview only:    add `-- --dry-run` to print the sequence without executing
 *
 * A live mainnet deploy requires the explicit --confirm-mainnet flag (real-funds guard) and
 * DEPLOY_COMMIT=<40-char SHA>: before compiling, the orchestrator refuses to start unless
 * HEAD is that commit and the working tree is clean (assertDeployCommit).
 *
 * Not re-runnable: the crowdfund step consumes one-shot setters and distributes ARM. On
 * mainnet the orchestrator refuses to start while governance/crowdfund manifests from an
 * earlier run exist. A run that stops part-way is an interrupted launch — recover it by
 * hand per docs/interrupted-launch-recovery.md.
 *
 * Prerequisites (fail loud if missing): deployer key funded on the hub; real CCTP V2
 * addresses + USDC configured; security council / launch team / RevenueLock
 * beneficiaries set. See config/mainnet.env.
 */

import { execSync } from "child_process";
import { getNetworkConfig, getGovernanceDeploymentFile, getCrowdfundDeploymentFile } from "../config/networks";
import {
  assertNoPriorLaunch,
  INTERRUPTED_LAUNCH_RUNBOOK,
  assertDeployCommit,
  resolveCrowdfundOpenTimestamp,
  CROWDFUND_OPEN_MIN_LEAD_SECONDS,
} from "./deploy-utils";

// --dry-run prints the deploy sequence without executing it (preview the launch plan).
const DRY_RUN = process.argv.slice(2).includes("--dry-run");
// --confirm-mainnet is required to actually deploy to mainnet (real-funds guard).
const CONFIRM_MAINNET = process.argv.slice(2).includes("--confirm-mainnet");

// The only network this orchestrator should ever target is a hub network. Asserting
// it against a fixed set both prevents an unexpected value from reaching execSync and
// catches a missing `source config/<env>.env` (CWE-78 defense-in-depth).
const HUB_NETWORKS: ReadonlyArray<string> = ["sepoliaHub", "mainnetHub"];

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
    console.error(`If any transaction was sent, this is an interrupted launch. On mainnet do NOT`);
    console.error(`re-run — follow ${INTERRUPTED_LAUNCH_RUNBOOK}.`);
    process.exit(1);
  }
}

/**
 * Run a non-deploy check after all transactions are sent. A failure cannot be rolled back,
 * so it does not stop the script mid-way; returns false so main() can end loudly instead.
 */
function runCheck(cmd: string, description: string): boolean {
  banner(description, cmd);
  if (DRY_RUN) {
    console.log("  [dry-run] skipped");
    return true;
  }
  try {
    execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
    return true;
  } catch (e) {
    return false;
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
  if (!HUB_NETWORKS.includes(hubNet)) {
    console.error(`Error: unexpected hub network "${hubNet}". Did you source config/mainnet.env or config/sepolia.env?`);
    process.exit(1);
  }
  // Real-funds guard: a live mainnet deploy must be explicitly confirmed.
  if (config.env === "mainnet" && !DRY_RUN && !CONFIRM_MAINNET) {
    console.error("Refusing to deploy to MAINNET without explicit confirmation.");
    console.error("  Preview:  npm run setup:mainnet -- --dry-run");
    console.error("  Deploy:   DEPLOY_COMMIT=<sha> npm run setup:mainnet -- --confirm-mainnet");
    process.exit(1);
  }
  // Re-run guard: manifests from an earlier mainnet run mean transactions were already
  // sent. Sepolia dry-runs are disposable and may be re-run freely.
  if (config.env === "mainnet") {
    try {
      assertNoPriorLaunch([getGovernanceDeploymentFile(), getCrowdfundDeploymentFile()]);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Commit pin: hardhat compiles whatever is checked out, and a wrong build is only caught
  // after one-shot initializers are spent. Required for a live mainnet run; checked whenever
  // set (dry-run, Sepolia rehearsal).
  const deployCommit = process.env.DEPLOY_COMMIT?.trim() || undefined;
  if (config.env === "mainnet" && !DRY_RUN && !deployCommit) {
    console.error("Error: a live mainnet deploy requires DEPLOY_COMMIT=<40-char SHA> (the commit to deploy).");
    process.exit(1);
  }
  if (deployCommit) {
    try {
      assertDeployCommit(deployCommit);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  } else if (config.env === "mainnet") {
    console.warn("WARNING: DEPLOY_COMMIT not set — the build is NOT pinned (required for the live run).\n");
  }

  // Open-time pre-flight: windowStart is immutable and the crowdfund step runs after
  // governance, so a bad or too-close open time must fail here, before any transaction.
  let openTimestamp: number;
  try {
    openTimestamp = resolveCrowdfundOpenTimestamp(
      config.crowdfundOpenTime, config.crowdfundOpenDelay,
      Math.floor(Date.now() / 1000), CROWDFUND_OPEN_MIN_LEAD_SECONDS
    );
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
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
  console.log(`  Commit:        ${deployCommit ? `${deployCommit} (HEAD matches, tree clean)` : "NOT pinned (DEPLOY_COMMIT not set)"}`);
  console.log(`  Timelock:      ${config.hardenTimelock ? `deploy at 0 → raise to ${config.timelockDelay}s → renounce` : `${config.timelockDelay}s (deployer keeps roles)`}`);
  console.log(`  Sale opens:    ${config.crowdfundOpenTime
    ? `${config.crowdfundOpenTime} (${openTimestamp})`
    : `~${new Date(openTimestamp * 1000).toISOString()} (${config.crowdfundOpenDelay}s after the crowdfund step; set CROWDFUND_OPEN_TIME for an exact time)`}`);
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

  // Verification — a check, not a deploy step. Every transaction has been sent by now, so a
  // failure is reported loudly (and exits non-zero) rather than rolled back.
  const verified = runCheck(
    `npx hardhat run scripts/verify_deployment.ts --network ${hubNet}`,
    "Verifying deployment"
  );
  if (!verified) {
    console.error("\n" + "=".repeat(60));
    console.error("  VERIFICATION FAILED — transactions were sent, but the deployment");
    console.error("  does not match the expected configuration.");
    console.error("  Do NOT announce the sale or pin the frontend. Review the FAIL rows above;");
    console.error(`  do not re-run this script (see ${INTERRUPTED_LAUNCH_RUNBOOK}).`);
    console.error("=".repeat(60));
    process.exit(1);
  }

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
  console.log("  - Two-person verify the on-chain treasury outflow limits against PARAMETER_MANIFEST.md §8.2.");
  console.log("  - Shielded-pool phases (privacy pool, yield, fee module) are a SEPARATE later deploy.");
  console.log();
}

main().catch((e) => {
  console.error("Deployment failed:", e);
  process.exit(1);
});
