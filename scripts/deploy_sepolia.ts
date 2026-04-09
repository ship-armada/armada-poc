/**
 * Sepolia Testnet Deployment Orchestrator
 *
 * Runs the full deployment sequence for Sepolia testnet.
 * This is the single-command equivalent of `npm run setup` for local dev.
 *
 * Phases:
 *   Phase 1: CCTP config (all chains)
 *   Phase 2: Governance + Crowdfund (hub only)
 *   Phase 3: Privacy Pool (hub + clients) — must follow Phase 2 (needs treasury address from governance)
 *   Phase 4: Mock Aave + Yield (hub only) — must follow Phase 2 (needs adapter registry from governance)
 *   Phase 5: Cross-chain linking
 *
 * Prerequisites:
 *   - source config/sepolia.env
 *   - DEPLOYER_PRIVATE_KEY funded with ETH on all target chains
 *   - USDC obtained from https://faucet.circle.com/
 *
 * Usage:
 *   npx ts-node scripts/deploy_sepolia.ts [--phase N] [--hub-only]
 *
 * Options:
 *   --phase N     Run only phase N (1-5)
 *   --hub-only    Skip client chain deployments (Phase 1 hub only)
 */

import { execSync } from "child_process";
import { getNetworkConfig } from "../config/networks";

function run(cmd: string, description: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${description}`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`> ${cmd}\n`);

  try {
    execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
  } catch (e: any) {
    console.error(`\nFailed: ${description}`);
    console.error(`Command: ${cmd}`);
    process.exit(1);
  }
}

async function main() {
  const config = getNetworkConfig();
  const args = process.argv.slice(2);
  const phaseArg = args.indexOf("--phase");
  const targetPhase = phaseArg >= 0 ? parseInt(args[phaseArg + 1], 10) : 0;
  const hubOnly = args.includes("--hub-only");

  if (config.env !== "sepolia") {
    console.error("Error: DEPLOY_ENV must be 'sepolia'");
    console.error("Run: source config/sepolia.env");
    process.exit(1);
  }

  if (!config.deployerPrivateKey) {
    console.error("Error: DEPLOYER_PRIVATE_KEY is required");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("  SEPOLIA TESTNET DEPLOYMENT");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Hub:      ${config.hub.name} (Chain ${config.hub.chainId}, Domain ${config.hub.cctpDomain})`);
  console.log(`  Client A: ${config.clientA.name} (Chain ${config.clientA.chainId}, Domain ${config.clientA.cctpDomain})`);
  console.log(`  Client B: ${config.clientB.name} (Chain ${config.clientB.chainId}, Domain ${config.clientB.cctpDomain})`);
  console.log(`  CCTP Mode: ${config.cctpMode}`);
  console.log();

  const shouldRun = (phase: number) => targetPhase === 0 || targetPhase === phase;

  // ========== Phase 1: CCTP Configuration ==========
  if (shouldRun(1)) {
    console.log("\n" + "#".repeat(60));
    console.log("  PHASE 1: CCTP Configuration");
    console.log("#".repeat(60));

    // Compile first
    run("npx hardhat compile", "Compiling contracts...");

    // Configure real CCTP addresses
    run(
      "npx hardhat run scripts/deploy_cctp_sepolia.ts --network sepoliaHub",
      "Configuring CCTP for Hub (Ethereum Sepolia)"
    );

    if (!hubOnly) {
      run(
        "npx hardhat run scripts/deploy_cctp_sepolia.ts --network sepoliaClientA",
        "Configuring CCTP for Client A (Base Sepolia)"
      );
      run(
        "npx hardhat run scripts/deploy_cctp_sepolia.ts --network sepoliaClientB",
        "Configuring CCTP for Client B (Arbitrum Sepolia)"
      );
    }
  }

  // ========== Phase 2: Governance + Crowdfund ==========
  if (shouldRun(2)) {
    console.log("\n" + "#".repeat(60));
    console.log("  PHASE 2: Governance + Crowdfund (Hub Only)");
    console.log("#".repeat(60));

    run(
      "npx hardhat run scripts/deploy_governance.ts --network sepoliaHub",
      "Deploying Governance Contracts"
    );
    run(
      "npx hardhat run scripts/deploy_crowdfund.ts --network sepoliaHub",
      "Deploying Crowdfund Contracts"
    );
  }

  // ========== Phase 3: Privacy Pool ==========
  // Must follow Phase 2: privacy pool needs treasury address from governance manifest
  if (shouldRun(3)) {
    console.log("\n" + "#".repeat(60));
    console.log("  PHASE 3: Privacy Pool");
    console.log("#".repeat(60));

    run(
      "npx hardhat run scripts/deploy_privacy_pool.ts --network sepoliaHub",
      "Deploying Privacy Pool to Hub"
    );

    if (!hubOnly) {
      run(
        "npx hardhat run scripts/deploy_privacy_pool.ts --network sepoliaClientA",
        "Deploying PrivacyPoolClient to Client A"
      );
      run(
        "npx hardhat run scripts/deploy_privacy_pool.ts --network sepoliaClientB",
        "Deploying PrivacyPoolClient to Client B"
      );
    }
  }

  // ========== Phase 4: Yield Infrastructure ==========
  // Must follow Phase 2: deploy_yield.ts requires the governance manifest
  // (needs AdapterRegistry address from governance deployment)
  if (shouldRun(4)) {
    console.log("\n" + "#".repeat(60));
    console.log("  PHASE 4: Yield Infrastructure (Hub Only)");
    console.log("#".repeat(60));

    run(
      "npx hardhat run scripts/deploy_aave_mock.ts --network sepoliaHub",
      "Deploying Mock Aave Spoke"
    );
    run(
      "npx hardhat run scripts/deploy_yield.ts --network sepoliaHub",
      "Deploying Yield Contracts"
    );
  }

  // ========== Phase 5: Cross-Chain Linking ==========
  if (shouldRun(5)) {
    console.log("\n" + "#".repeat(60));
    console.log("  PHASE 5: Cross-Chain Linking");
    console.log("#".repeat(60));

    run(
      "npx hardhat run scripts/link_privacy_pool.ts --network sepoliaHub",
      "Linking Privacy Pools across chains"
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("  DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log();
  console.log("Next steps:");
  console.log("  1. Fund deployer with testnet USDC: https://faucet.circle.com/");
  console.log("  2. Start relayer: npm run relayer:sepolia");
  console.log("  3. Test cross-chain shield flow");
  console.log();
}

main().catch((e) => {
  console.error("Deployment failed:", e);
  process.exit(1);
});
