/**
 * Deploy HubUnshieldProxy to Hub Chain
 *
 * This contract enables cross-chain unshield by bridging USDC from Hub to Client chain.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("=== Deploying HubUnshieldProxy to Hub Chain ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log("");

  // Load hub deployment to get MockUSDC address
  const deploymentsDir = path.join(__dirname, "../deployments");
  const hubPath = path.join(deploymentsDir, "hub.json");

  if (!fs.existsSync(hubPath)) {
    throw new Error("Hub deployment not found. Run 'npm run deploy:hub' first.");
  }

  const hubDeployment = JSON.parse(fs.readFileSync(hubPath, "utf-8"));
  const mockUSDCAddress = hubDeployment.contracts.mockUSDC;

  console.log(`MockUSDC address: ${mockUSDCAddress}`);

  // Client chain ID (Client A)
  const clientChainId = 31338;

  // Deploy HubUnshieldProxy
  console.log("\nDeploying HubUnshieldProxy...");
  const HubUnshieldProxy = await ethers.getContractFactory("HubUnshieldProxy");
  const hubUnshieldProxy = await HubUnshieldProxy.deploy(mockUSDCAddress, clientChainId);
  await hubUnshieldProxy.waitForDeployment();
  const hubUnshieldProxyAddress = await hubUnshieldProxy.getAddress();
  console.log(`HubUnshieldProxy: ${hubUnshieldProxyAddress}`);

  // Update hub.json with the new contract
  hubDeployment.contracts.hubUnshieldProxy = hubUnshieldProxyAddress;
  hubDeployment.timestamp = new Date().toISOString();

  fs.writeFileSync(hubPath, JSON.stringify(hubDeployment, null, 2));

  console.log("\n=== Deployment Complete ===");
  console.log(`HubUnshieldProxy deployed to: ${hubUnshieldProxyAddress}`);
  console.log(`Updated: ${hubPath}`);

  return { hubUnshieldProxy: hubUnshieldProxyAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
