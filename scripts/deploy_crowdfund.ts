/**
 * Deploy Armada Crowdfund Contracts
 *
 * Deploys:
 * - ArmadaToken (ARM) — or reuse from governance deployment
 * - MockUSDCV2 (USDC) — or reuse existing
 * - ArmadaCrowdfund
 *
 * Usage:
 *   npx hardhat run scripts/deploy_crowdfund.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface CrowdfundDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armToken: string;
    usdc: string;
    crowdfund: string;
  };
  config: {
    baseSale: string;
    maxSale: string;
    minSale: string;
    armPrice: string;
    armFunded: string;
  };
  timestamp: string;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("=== Deploying Armada Crowdfund Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log("");

  // 1. Deploy ArmadaToken
  console.log("1. Deploying ArmadaToken...");
  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address);
  await armToken.waitForDeployment();
  const armTokenAddress = await armToken.getAddress();
  console.log(`   ArmadaToken: ${armTokenAddress}`);

  // 2. Deploy MockUSDCV2
  console.log("2. Deploying MockUSDCV2...");
  const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
  const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`   MockUSDCV2: ${usdcAddress}`);

  // 3. Deploy ArmadaCrowdfund
  console.log("3. Deploying ArmadaCrowdfund...");
  const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
  const crowdfund = await ArmadaCrowdfund.deploy(usdcAddress, armTokenAddress, deployer.address);
  await crowdfund.waitForDeployment();
  const crowdfundAddress = await crowdfund.getAddress();
  console.log(`   ArmadaCrowdfund: ${crowdfundAddress}`);

  // 4. Fund ARM to crowdfund (MAX_SALE worth = 1.8M ARM)
  const armFundAmount = ethers.parseUnits("1800000", 18);
  console.log("4. Funding ARM to crowdfund...");
  await armToken.transfer(crowdfundAddress, armFundAmount);
  console.log(`   Sent 1,800,000 ARM to crowdfund contract`);

  // Save deployment
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  let networkName = "hub";
  if (chainId === 31338) networkName = "client";
  else if (chainId === 31339) networkName = "clientB";

  const deployment: CrowdfundDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      armToken: armTokenAddress,
      usdc: usdcAddress,
      crowdfund: crowdfundAddress,
    },
    config: {
      baseSale: "1200000",
      maxSale: "1800000",
      minSale: "1000000",
      armPrice: "1.00",
      armFunded: "1800000",
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = path.join(deploymentsDir, `crowdfund-${networkName}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to: ${outputFile}`);
  console.log("\n=== Crowdfund deployment complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
