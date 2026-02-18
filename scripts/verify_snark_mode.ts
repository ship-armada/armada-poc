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

async function main() {
  console.log("=== Verifying SNARK Verification Mode ===\n");

  // Load deployment
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const hubDeploymentPath = path.join(deploymentsDir, "privacy-pool-hub.json");

  if (!fs.existsSync(hubDeploymentPath)) {
    console.error("Error: privacy-pool-hub.json not found");
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

  const commonConfigs = [
    [1, 1], // 1 nullifier, 1 commitment (lend/redeem)
    [1, 2], // 1 nullifier, 2 commitments
    [2, 2], // 2 nullifiers, 2 commitments
    [1, 3], // 1 nullifier, 3 commitments
    [2, 3], // 2 nullifiers, 3 commitments
  ];

  for (const [nullifiers, commitments] of commonConfigs) {
    try {
      const vk = await privacyPool.getVerificationKey(nullifiers, commitments);
      const isSet = vk.alpha1.x !== 0n;
      console.log(`  VK[${nullifiers}x${commitments}]: ${isSet ? "✓ Loaded" : "✗ Not set"}`);
    } catch (e) {
      console.log(`  VK[${nullifiers}x${commitments}]: ✗ Error reading`);
    }
  }

  console.log("\n=== Verification Complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
