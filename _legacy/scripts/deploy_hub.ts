import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy contracts to Hub Chain (Chain H)
 *
 * Deploys:
 * - MockUSDC (for CCTP simulation)
 *
 * Note: Railgun contracts are deployed separately via deploy_railgun.ts
 * Note: V2 contracts (HubCCTPReceiverV2) are deployed via deploy_v2.ts
 */

async function main() {
  console.log("=== Deploying to Hub Chain (H) ===\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // ============ Deploy MockUSDC ============
  console.log("Step 1: Deploying MockUSDC...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy("Mock USDC", "USDC");
  await mockUSDC.waitForDeployment();
  const mockUSDCAddress = await mockUSDC.getAddress();
  console.log(`  MockUSDC deployed to: ${mockUSDCAddress}`);

  // ============ Summary ============
  console.log("\n" + "=".repeat(50));
  console.log("HUB CHAIN BASE DEPLOYMENT COMPLETE");
  console.log("=".repeat(50));
  console.log(`
Chain ID: ${network.chainId}
Deployer: ${deployer.address}

Contracts:
  MockUSDC: ${mockUSDCAddress}

NEXT STEPS:
1. Run deploy_railgun.ts to deploy Railgun contracts
2. Run deploy_unshield_proxy.ts to deploy HubUnshieldProxy
3. Run deploy_v2.ts to deploy HubCCTPReceiverV2
4. Run link_deployments.ts to link client to hub
`);

  // ============ Save deployment info ============
  const deploymentInfo = {
    chainId: Number(network.chainId),
    deployer: deployer.address,
    contracts: {
      mockUSDC: mockUSDCAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(deploymentsDir, "hub.json"),
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("Deployment info saved to deployments/hub.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
