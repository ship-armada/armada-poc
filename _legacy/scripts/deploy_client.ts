import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy contracts to Client Chain (Chain A)
 *
 * Deploys:
 * - MockUSDC
 *
 * Note: V2 contracts (ClientShieldProxyV2) are deployed via deploy_v2.ts
 * After all deployments, run link_deployments.ts to connect client to hub
 */

async function main() {
  console.log("=== Deploying to Client Chain (A) ===\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // ============ Deploy MockUSDC ============
  console.log("Deploying MockUSDC...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy("Mock USDC", "USDC");
  await mockUSDC.waitForDeployment();
  const mockUSDCAddress = await mockUSDC.getAddress();
  console.log(`MockUSDC deployed to: ${mockUSDCAddress}`);

  // ============ Mint initial USDC to test users ============
  console.log("\nMinting initial USDC to test users...");
  const testUsers = [
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Anvil account 1
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Anvil account 2
  ];

  const mintAmount = ethers.parseUnits("10000", 6); // 10,000 USDC each

  for (const user of testUsers) {
    const tx = await mockUSDC.mint(user, mintAmount);
    await tx.wait();
    console.log(`  Minted ${ethers.formatUnits(mintAmount, 6)} USDC to ${user}`);
  }

  // ============ Summary ============
  console.log("\n" + "=".repeat(50));
  console.log("CLIENT CHAIN BASE DEPLOYMENT COMPLETE");
  console.log("=".repeat(50));
  console.log(`
Chain ID: ${network.chainId}
Deployer: ${deployer.address}

Contracts:
  MockUSDC: ${mockUSDCAddress}

NEXT STEPS:
1. Run deploy_v2.ts --network client to deploy ClientShieldProxyV2
2. Run link_deployments.ts to connect client to hub
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
    path.join(deploymentsDir, "client.json"),
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("Deployment info saved to deployments/client.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
