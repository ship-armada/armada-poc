/**
 * Deploy CCTP V2 Infrastructure (Mock Mode)
 *
 * This script deploys the mock CCTP V2 infrastructure needed for cross-chain messaging:
 *   - MockUSDCV2 (simple ERC20 with mint/burn)
 *   - MockMessageTransmitterV2 (message passing simulation)
 *   - MockTokenMessengerV2 (token burn/mint logic)
 *
 * For real CCTP (Sepolia testnet), use deploy_cctp_sepolia.ts instead.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_cctp_v3.ts --network hub
 *   npx hardhat run scripts/deploy_cctp_v3.ts --network client
 *   npx hardhat run scripts/deploy_cctp_v3.ts --network clientB
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPDeploymentFile,
  type ChainRole,
} from "../config/networks";

interface DeploymentInfo {
  chainId: number;
  domain: number;
  deployer: string;
  cctpMode: "mock";
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
  };
  timestamp: string;
}

async function deployCCTP(role: ChainRole): Promise<DeploymentInfo> {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();
  const chain = role === "hub" ? config.hub
    : role === "clientA" ? config.clientA
    : config.clientB;
  const domain = chain.cctpDomain;

  console.log(`=== Deploying CCTP V2 Infrastructure to ${chain.name} ===`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Domain ID: ${domain}`);
  console.log("");

  // 1. Deploy MockUSDCV2
  console.log("1. Deploying MockUSDCV2...");
  const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
  const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`   USDC: ${usdcAddress}`);

  // 2. Deploy MockMessageTransmitterV2
  console.log("\n2. Deploying MockMessageTransmitterV2...");
  const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
  const messageTransmitter = await MockMessageTransmitterV2.deploy(domain, deployer.address);
  await messageTransmitter.waitForDeployment();
  const messageTransmitterAddress = await messageTransmitter.getAddress();
  console.log(`   MessageTransmitter: ${messageTransmitterAddress}`);

  // 3. Deploy MockTokenMessengerV2
  console.log("\n3. Deploying MockTokenMessengerV2...");
  const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
  const tokenMessenger = await MockTokenMessengerV2.deploy(
    messageTransmitterAddress,
    usdcAddress,
    domain
  );
  await tokenMessenger.waitForDeployment();
  const tokenMessengerAddress = await tokenMessenger.getAddress();
  console.log(`   TokenMessenger: ${tokenMessengerAddress}`);

  // 4. Link MessageTransmitter to TokenMessenger
  console.log("\n4. Linking contracts...");
  await (await messageTransmitter.setTokenMessenger(tokenMessengerAddress)).wait();
  console.log("   MessageTransmitter linked to TokenMessenger");

  // 5. Add TokenMessenger as minter on USDC
  await (await usdc.addMinter(tokenMessengerAddress)).wait();
  console.log("   TokenMessenger added as USDC minter");

  const deployment: DeploymentInfo = {
    chainId,
    domain,
    deployer: deployer.address,
    cctpMode: "mock",
    contracts: {
      usdc: usdcAddress,
      messageTransmitter: messageTransmitterAddress,
      tokenMessenger: tokenMessengerAddress,
    },
    timestamp: new Date().toISOString(),
  };

  return deployment;
}

function saveDeployment(filename: string, data: DeploymentInfo): void {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const filePath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();

  const role = getChainRole(chainId);
  if (!role) {
    console.error(`Unknown chain ID: ${chainId}`);
    console.error(`Configured chains: hub=${config.hub.chainId}, clientA=${config.clientA.chainId}, clientB=${config.clientB.chainId}`);
    process.exit(1);
  }

  const deployment = await deployCCTP(role);
  const filename = getCCTPDeploymentFile(role);

  saveDeployment(filename, deployment);
  console.log(`\n=== Deployment Complete ===`);
  console.log(`Saved to: deployments/${filename}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
