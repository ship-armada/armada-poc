/**
 * Verify SNARK Verification Mode
 *
 * Quick script to check if testingMode is disabled (SNARK verification enabled)
 * on the deployed PrivacyPool contract.
 *
 * Usage:
 *   npx hardhat run scripts/verify_snark_mode.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getNetworkConfig } from "../config/networks";
import { TESTING_ARTIFACT_CONFIGS } from "../lib/artifacts";

async function main() {
  console.log("=== Verifying SNARK Verification Mode ===\n");

  // Load deployment. Manifests are namespaced by environment (e.g. -sepolia for testnet,
  // empty for local), matching what deploy_privacy_pool.ts writes — so this must run against
  // the manifest for the --network it was invoked with, not the local one.
  const config = getNetworkConfig();
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  const manifestName = `privacy-pool-hub${suffix}.json`;
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const hubDeploymentPath = path.join(deploymentsDir, manifestName);

  if (!fs.existsSync(hubDeploymentPath)) {
    console.error(`Error: ${manifestName} not found`);
    console.error("Run deploy_privacy_pool.ts first");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(hubDeploymentPath, "utf-8"));
  const privacyPoolAddress = deployment.contracts.privacyPool;

  console.log("PrivacyPool address:", privacyPoolAddress);

  // Get contract instance
  const privacyPool = await ethers.getContractAt("PrivacyPool", privacyPoolAddress);

  // Check testingMode
  const testingMode = await privacyPool.testingMode();

  console.log("\n--- Results ---");
  console.log("testingMode():", testingMode);

  if (testingMode) {
    console.log("\n⚠️  WARNING: Testing mode is ENABLED");
    console.log("   SNARK proofs are NOT being verified!");
    console.log("   This should only be used for debugging.");
    console.log("\n   To disable testing mode:");
    console.log("   await privacyPool.setTestingMode(false)");
  } else {
    console.log("\n✓ SNARK verification is ENABLED");
    console.log("  All transaction proofs will be cryptographically verified.");
  }

  // Also check if verification keys are loaded
  console.log("\n--- Verification Keys Check ---");

  // Check every shape the deploy registers. TESTING_ARTIFACT_CONFIGS is the single source of
  // truth that loadVerificationKeys iterates at deploy time, so this reports exactly which and
  // how many vkeys are actually on-chain — not a hand-picked sample.
  let loaded = 0;
  const missing: string[] = [];
  for (const { nullifiers, commitments } of TESTING_ARTIFACT_CONFIGS) {
    const shape = `${nullifiers}x${commitments}`;
    try {
      const vk = await privacyPool.getVerificationKey(nullifiers, commitments);
      if (vk.alpha1.x !== 0n) {
        loaded++;
        console.log(`  VK[${shape}]: ✓ Loaded`);
      } else {
        missing.push(shape);
        console.log(`  VK[${shape}]: ✗ Not set`);
      }
    } catch (e) {
      missing.push(shape);
      console.log(`  VK[${shape}]: ✗ Error reading`);
    }
  }

  console.log(
    `\n  ${loaded}/${TESTING_ARTIFACT_CONFIGS.length} verification keys registered on-chain`
  );
  if (missing.length > 0) {
    console.log(`  ⚠️  Missing (${missing.length}): ${missing.join(", ")}`);
  } else {
    console.log("  ✓ All expected shapes registered");
  }

  console.log("\n=== Verification Complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
