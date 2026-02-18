/**
 * Load 1x1 Verification Key for Shielded Yield
 *
 * Shielded lend and redeem use CrossContractCalls with 1 nullifier and 1 commitment.
 * If the PrivacyPool was deployed before this config was added to TESTING_ARTIFACT_CONFIGS,
 * run this script to load the missing verification key.
 *
 * Usage:
 *   npx hardhat run scripts/load_verification_key_1x1.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { loadVerificationKeys } from "../lib/artifacts";

async function main() {
  console.log("=== Loading 1x1 Verification Key for Shielded Yield ===\n");

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const hubDeploymentPath = path.join(deploymentsDir, "privacy-pool-hub.json");

  if (!fs.existsSync(hubDeploymentPath)) {
    console.error("Error: privacy-pool-hub.json not found");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(hubDeploymentPath, "utf-8"));
  const privacyPoolAddress = deployment.contracts.privacyPool;

  const privacyPool = await ethers.getContractAt("PrivacyPool", privacyPoolAddress);
  const [signer] = await ethers.getSigners();

  console.log("PrivacyPool:", privacyPoolAddress);
  console.log("Signer:", signer.address);
  console.log("");

  // Check if already loaded
  const existing = await privacyPool.getVerificationKey(1, 1);
  if (existing.alpha1.x !== 0n) {
    console.log("VK[1x1] is already loaded. Nothing to do.");
    return;
  }

  console.log("Loading VK[1x1] (1 nullifier, 1 commitment) for lend/redeem...");
  await loadVerificationKeys(privacyPool, [{ nullifiers: 1, commitments: 1 }], true);
  console.log("\n✓ Done. Shielded lend and redeem should now work.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
