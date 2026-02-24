/**
 * Set Treasury Address
 *
 * Updates the treasury address on an already-deployed PrivacyPool.
 * Reads the new address from the TREASURY_ADDRESS env variable.
 *
 * Prerequisites:
 *   - PrivacyPool deployed (hub deployment file must exist)
 *   - Caller must be the PrivacyPool owner
 *   - TREASURY_ADDRESS set in environment
 *
 * Usage:
 *   source config/sepolia.env && npx hardhat run scripts/set_treasury.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getChainRole,
  getPrivacyPoolDeploymentFile,
} from "../config/networks";
import { createNonceManager } from "./deploy-utils";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();
  const nm = await createNonceManager(deployer);

  const role = getChainRole(chainId);
  if (role !== "hub") {
    console.error("setTreasury can only be called on the Hub chain");
    process.exit(1);
  }

  const newTreasury = config.treasuryAddress;
  if (!newTreasury) {
    console.error("TREASURY_ADDRESS env variable is not set");
    console.error("Set it in config/sepolia.env or export it directly");
    process.exit(1);
  }

  // Load hub deployment
  const filename = getPrivacyPoolDeploymentFile("hub");
  const filePath = path.join(__dirname, "..", "deployments", filename);
  if (!fs.existsSync(filePath)) {
    console.error(`Hub deployment not found: ${filename}`);
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const privacyPoolAddress = deployment.contracts.privacyPool;

  const privacyPool = await ethers.getContractAt("PrivacyPool", privacyPoolAddress);

  // Read current state
  const currentTreasury = await privacyPool.treasury();
  const owner = await privacyPool.owner();

  console.log("=== Set Treasury ===");
  console.log(`PrivacyPool: ${privacyPoolAddress}`);
  console.log(`Owner:       ${owner}`);
  console.log(`Caller:      ${deployer.address}`);
  console.log(`Current:     ${currentTreasury}`);
  console.log(`New:         ${newTreasury}`);

  if (currentTreasury.toLowerCase() === newTreasury.toLowerCase()) {
    console.log("\nTreasury is already set to this address. Nothing to do.");
    return;
  }

  // Set treasury
  console.log("\nSending setTreasury transaction...");
  const tx = await privacyPool.setTreasury(newTreasury, nm.override());
  console.log(`Tx: ${tx.hash}`);
  await tx.wait();

  // Verify
  const updatedTreasury = await privacyPool.treasury();
  console.log(`\nVerified: treasury is now ${updatedTreasury}`);
  console.log("=== Done ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
