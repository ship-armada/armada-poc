/**
 * Deploy Armada Crowdfund Contracts
 *
 * Deploys:
 * - ArmadaToken (ARM)
 * - ArmadaCrowdfund
 *
 * For local dev, deploys a fresh MockUSDCV2.
 * For testnet, uses real USDC from the CCTP deployment.
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_crowdfund.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_crowdfund.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPDeploymentFile,
  getCrowdfundDeploymentFile,
  isCCTPReal,
} from "../config/networks";

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
  const config = getNetworkConfig();

  const role = getChainRole(chainId);
  if (!role) {
    console.error(`Unknown chain ID: ${chainId}`);
    process.exit(1);
  }

  console.log("=== Deploying Armada Crowdfund Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  // 1. Deploy ArmadaToken
  console.log("1. Deploying ArmadaToken...");
  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address);
  await armToken.waitForDeployment();
  const armTokenAddress = await armToken.getAddress();
  console.log(`   ArmadaToken: ${armTokenAddress}`);

  // 2. Get or deploy USDC
  let usdcAddress: string;
  if (isCCTPReal()) {
    // Use real USDC from CCTP deployment
    const cctpFilename = getCCTPDeploymentFile(role);
    const cctpDeployment = loadDeployment(cctpFilename);
    if (!cctpDeployment) {
      throw new Error(`CCTP deployment not found (${cctpFilename}). Run deploy_cctp first.`);
    }
    usdcAddress = cctpDeployment.contracts.usdc;
    console.log(`2. Using real USDC at: ${usdcAddress}`);
  } else {
    // Deploy fresh MockUSDCV2 for isolated crowdfund testing
    console.log("2. Deploying MockUSDCV2...");
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log(`   MockUSDCV2: ${usdcAddress}`);
  }

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

  const outputFile = getCrowdfundDeploymentFile();
  saveDeployment(outputFile, deployment);
  console.log(`\nDeployment saved to: deployments/${outputFile}`);
  console.log("\n=== Crowdfund deployment complete ===");
}

function loadDeployment(filename: string): any | null {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveDeployment(filename: string, data: any): void {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const filePath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
