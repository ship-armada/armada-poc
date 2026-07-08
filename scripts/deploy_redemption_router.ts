// ABOUTME: Deploys the contingency RedemptionRouter during the post-wind-down redemption window.
// ABOUTME: NOT part of npm run setup — run manually per docs/winddown-redemption-runbook.md.

/**
 * Deploy RedemptionRouter (wind-down contingency — issue #256)
 *
 * This script is intentionally NOT wired into the setup pipeline. It is a
 * runbook artifact, executed once during the 7-day REDEMPTION_DELAY window
 * AFTER wind-down triggers and AFTER all treasury sweeps have completed.
 *
 * What it does:
 *   1. Reads the wind-down + redemption addresses from the governance manifest.
 *   2. Refuses to run if wind-down has not triggered (except on local, for rehearsal).
 *   3. Builds the complete swept-token list from ArmadaWindDown's TokenSwept events.
 *   4. Cross-checks each token's balance on the redemption contract and warns
 *      about any remaining unswept treasury balance (sweep first!).
 *   5. Prints a checksummable summary and STOPS (dry run) unless
 *      CONFIRM_ROUTER_DEPLOY=1 is set.
 *   6. Deploys, reads allTokens() back to verify the baked list, and writes a
 *      redemption-router manifest.
 *
 * After deploying: verify the source on the block explorer and publish the
 * router address + token list in the wind-down manifest (see runbook).
 *
 * Usage (rehearsal, local):
 *   npx hardhat run scripts/deploy_redemption_router.ts --network hub
 *
 * Usage (production):
 *   CONFIRM_ROUTER_DEPLOY=1 npx hardhat run scripts/deploy_redemption_router.ts --network <hub network>
 */

import { ethers } from "hardhat";
import { getNetworkConfig, getGovernanceDeploymentFile, isLocal } from "../config/networks";
import { createNonceManager, loadDeployment, saveDeployment } from "./deploy-utils";

// Public RPCs commonly cap eth_getLogs ranges; query TokenSwept in chunks.
const LOG_CHUNK_BLOCKS = 50_000;

async function fetchSweptTokens(windDown: any, fromBlock: number): Promise<string[]> {
  const latest = await ethers.provider.getBlockNumber();
  const swept = new Set<string>();
  for (let start = fromBlock; start <= latest; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(start + LOG_CHUNK_BLOCKS - 1, latest);
    const events = await windDown.queryFilter(windDown.filters.TokenSwept(), start, end);
    for (const ev of events) {
      swept.add(ethers.getAddress(ev.args[0]));
    }
  }
  // The router (like ArmadaRedemption.redeem) requires ascending numeric order.
  return [...swept].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const config = getNetworkConfig();
  const nm = await createNonceManager(deployer);

  console.log("=== RedemptionRouter Deployment (wind-down contingency) ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  const govFile = getGovernanceDeploymentFile();
  const gov = loadDeployment(govFile);
  if (!gov) {
    console.error(`Governance manifest not found: ${govFile}`);
    process.exit(1);
  }
  const { armToken: armTokenAddr, redemption: redemptionAddr, windDown: windDownAddr } = gov.contracts;
  if (!redemptionAddr || redemptionAddr === ethers.ZeroAddress ||
      !windDownAddr || windDownAddr === ethers.ZeroAddress) {
    console.error(`Manifest ${govFile} has no redemption/windDown addresses — deploy_crowdfund.ts must run first.`);
    process.exit(1);
  }

  const windDown = await ethers.getContractAt("ArmadaWindDown", windDownAddr);
  const redemption = await ethers.getContractAt("ArmadaRedemption", redemptionAddr);
  const treasuryAddr: string = gov.contracts.treasury;

  // The router only makes sense post-trigger: its token list is the set of
  // assets actually swept. Pre-trigger there is nothing to bake in.
  const triggered: boolean = await windDown.triggered();
  if (!triggered) {
    if (isLocal()) {
      console.warn("WARNING: wind-down not triggered (allowed on local for rehearsal only).");
    } else {
      console.error("Wind-down has not triggered — there is nothing to route yet. Aborting.");
      process.exit(1);
    }
  }

  // Build the swept-token list from on-chain events.
  const fromBlock: number = gov.deployBlock ?? 0;
  const tokens = await fetchSweptTokens(windDown, fromBlock);

  console.log("--- Swept-token list (from TokenSwept events) ---");
  let anyUnswept = false;
  for (const token of tokens) {
    const erc20 = await ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata", token
    );
    let symbol = "???";
    try { symbol = await erc20.symbol(); } catch { /* non-standard token; address is the identifier */ }
    const redemptionBal = await erc20.balanceOf(redemptionAddr);
    const treasuryBal = await erc20.balanceOf(treasuryAddr);
    console.log(`  ${token}  ${symbol}`);
    console.log(`    redemption balance: ${redemptionBal}`);
    if (treasuryBal > 0n) {
      anyUnswept = true;
      console.log(`    !! treasury still holds ${treasuryBal} — sweep again before deploying`);
    }
  }
  if (tokens.length === 0) {
    console.log("  (none — ETH-only wind-down?)");
  }
  const redemptionEth = await ethers.provider.getBalance(redemptionAddr);
  const treasuryEth = await ethers.provider.getBalance(treasuryAddr);
  console.log(`  ETH on redemption: ${ethers.formatEther(redemptionEth)}`);
  if (treasuryEth > 0n) {
    anyUnswept = true;
    console.log(`  !! treasury still holds ${ethers.formatEther(treasuryEth)} ETH — run sweepETH first`);
  }
  console.log("");

  if (anyUnswept) {
    console.warn("WARNING: unswept treasury balances detected. Redemptions through a router");
    console.warn("deployed now would forfeit shares of later sweeps. Complete all sweeps first.");
  }

  if (process.env.CONFIRM_ROUTER_DEPLOY !== "1") {
    console.log("Dry run complete. Review the token list above against the wind-down manifest,");
    console.log("then re-run with CONFIRM_ROUTER_DEPLOY=1 to deploy.");
    return;
  }

  console.log("Deploying RedemptionRouter...");
  const RedemptionRouter = await ethers.getContractFactory("RedemptionRouter");
  const router = await RedemptionRouter.deploy(armTokenAddr, redemptionAddr, tokens, nm.override());
  await router.deploymentTransaction()!.wait();
  const routerAddr = await router.getAddress();
  console.log(`  RedemptionRouter: ${routerAddr}`);

  // Read the baked list back — the on-chain state, not the constructor args,
  // is what users will trust.
  const baked: string[] = await router.allTokens();
  if (baked.length !== tokens.length || baked.some((t, i) => ethers.getAddress(t) !== tokens[i])) {
    console.error("FATAL: allTokens() does not match the intended list. Do NOT publish this router.");
    process.exit(1);
  }
  console.log("  allTokens() verified against intended list.");

  const manifestFile = govFile.replace("governance", "redemption-router");
  saveDeployment(manifestFile, {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployBlock: await ethers.provider.getBlockNumber(),
    contracts: {
      redemptionRouter: routerAddr,
      redemption: redemptionAddr,
      windDown: windDownAddr,
      armToken: armTokenAddr,
    },
    config: {
      tokens,
      redemptionEthBalance: redemptionEth.toString(),
    },
    timestamp: new Date().toISOString(),
  });
  console.log(`  Manifest written: deployments/${manifestFile}`);
  console.log("");
  console.log("Next steps (see docs/winddown-redemption-runbook.md):");
  console.log("  1. Verify the router source on the block explorer.");
  console.log("  2. Publish the router address + token list in the signed wind-down manifest.");
  console.log("  3. Users: approve ARM to the router, then call redeemAll(armAmount, recipient).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
