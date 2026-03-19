// ABOUTME: Deploys ArmadaCrowdfund using shared ARM token and treasury from governance deployment.
// ABOUTME: Reads USDC from CCTP deployment, sets quorum exclusion, and writes crowdfund-hub manifest.

/**
 * Deploy Armada Crowdfund Contract
 *
 * Deploys ArmadaCrowdfund using the shared ARM token and treasury from
 * the governance deployment. Governance must be deployed first.
 *
 * Uses the shared USDC from the CCTP deployment (both local and testnet).
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
  getGovernanceDeploymentFile,
} from "../config/networks";
import { createNonceManager } from "./deploy-utils";

interface CrowdfundDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armToken: string;
    usdc: string;
    crowdfund: string;
    treasury: string;
    governor: string;
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
  const nm = await createNonceManager(deployer);

  const role = getChainRole(chainId);
  if (!role) {
    console.error(`Unknown chain ID: ${chainId}`);
    process.exit(1);
  }

  console.log("=== Deploying Armada Crowdfund ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  // 1. Load governance deployment (required — provides shared ARM token + treasury)
  console.log("1. Loading governance deployment...");
  const govFilename = getGovernanceDeploymentFile();
  const govDeployment = loadDeployment(govFilename);
  if (!govDeployment) {
    throw new Error(
      `Governance deployment not found (${govFilename}). Run deploy_governance first.`
    );
  }
  const armTokenAddress = govDeployment.contracts.armToken;
  const treasuryAddress = govDeployment.contracts.treasury;
  const governorAddress = govDeployment.contracts.governor;
  console.log(`   ARM Token (shared): ${armTokenAddress}`);
  console.log(`   Treasury: ${treasuryAddress}`);
  console.log(`   Governor: ${governorAddress}`);

  const armToken = await ethers.getContractAt("ArmadaToken", armTokenAddress);

  // 2. Load shared USDC from CCTP deployment
  console.log("2. Loading USDC from CCTP deployment...");
  const cctpFilename = getCCTPDeploymentFile(role);
  const cctpDeployment = loadDeployment(cctpFilename);
  if (!cctpDeployment) {
    throw new Error(`CCTP deployment not found (${cctpFilename}). Run deploy_cctp first.`);
  }
  const usdcAddress: string = cctpDeployment.contracts.usdc;
  console.log(`   USDC (shared): ${usdcAddress}`);

  // 3. Deploy ArmadaCrowdfund (with treasury as immutable destination)
  console.log("3. Deploying ArmadaCrowdfund...");
  const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
  const crowdfund = await ArmadaCrowdfund.deploy(
    usdcAddress, armTokenAddress, deployer.address, treasuryAddress, deployer.address, nm.override()
  );
  await crowdfund.deploymentTransaction()!.wait();
  const crowdfundAddress = await crowdfund.getAddress();
  console.log(`   ArmadaCrowdfund: ${crowdfundAddress}`);

  // 4. Fund ARM to crowdfund from deployer's remaining balance
  const armFundAmount = ethers.parseUnits(config.armDistribution.crowdfund, 18);
  const deployerArmBalance = await armToken.balanceOf(deployer.address);
  console.log(`4. Funding ARM to crowdfund...`);
  console.log(`   Deployer ARM balance: ${ethers.formatUnits(deployerArmBalance, 18)}`);
  if (deployerArmBalance < armFundAmount) {
    throw new Error(
      `Insufficient ARM balance. Need ${config.armDistribution.crowdfund}, ` +
      `have ${ethers.formatUnits(deployerArmBalance, 18)}`
    );
  }
  await (await armToken.transfer(crowdfundAddress, armFundAmount, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.crowdfund} ARM to crowdfund contract`);

  // 4b. Verify ARM pre-load
  console.log("   Verifying ARM pre-load...");
  await (await crowdfund.loadArm(nm.override())).wait();
  console.log("   ARM pre-load verified (loadArm() succeeded)");

  // 5. Register crowdfund as excluded from quorum denominator
  console.log("5. Registering crowdfund in governor quorum exclusion...");
  const governor = await ethers.getContractAt("ArmadaGovernor", governorAddress);
  await (await governor.setExcludedAddresses([crowdfundAddress], nm.override())).wait();
  console.log(`   Crowdfund excluded from quorum denominator`);

  // Save deployment
  const deployment: CrowdfundDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      armToken: armTokenAddress,
      usdc: usdcAddress,
      crowdfund: crowdfundAddress,
      treasury: treasuryAddress,
      governor: governorAddress,
    },
    config: {
      baseSale: "1200000",
      maxSale: "1800000",
      minSale: "1000000",
      armPrice: "1.00",
      armFunded: config.armDistribution.crowdfund,
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getCrowdfundDeploymentFile();
  saveDeployment(outputFile, deployment);
  console.log(`\nDeployment saved to: deployments/${outputFile}`);

  // Summary
  const deployerRemaining = await armToken.balanceOf(deployer.address);
  console.log("\n=== ARM Distribution Summary ===");
  console.log(`  Treasury:  ${config.armDistribution.treasury} ARM`);
  console.log(`  Crowdfund: ${config.armDistribution.crowdfund} ARM`);
  console.log(`  Deployer:  ${ethers.formatUnits(deployerRemaining, 18)} ARM (remainder — production allocation TBD)`);
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
