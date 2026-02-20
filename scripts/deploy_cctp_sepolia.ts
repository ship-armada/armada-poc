/**
 * Configure CCTP for Real (Sepolia) Mode
 *
 * Instead of deploying mock CCTP contracts, this script writes Circle's
 * real CCTP V2 contract addresses into deployment JSON files so that
 * downstream scripts (privacy pool, yield, relayer) work unchanged.
 *
 * Prerequisites:
 *   - source config/sepolia.env
 *   - DEPLOYER_PRIVATE_KEY set and funded with Sepolia ETH
 *
 * Usage:
 *   npx hardhat run scripts/deploy_cctp_sepolia.ts --network sepoliaHub
 *   npx hardhat run scripts/deploy_cctp_sepolia.ts --network sepoliaClientA
 *   npx hardhat run scripts/deploy_cctp_sepolia.ts --network sepoliaClientB
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPAddresses,
  getCCTPDeploymentFile,
  validateCCTPConfig,
  type ChainRole,
} from "../config/networks";

interface DeploymentInfo {
  chainId: number;
  domain: number;
  deployer: string;
  cctpMode: "real";
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
  };
  timestamp: string;
}

async function configureCCTP(role: ChainRole): Promise<DeploymentInfo> {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();
  const chain = role === "hub" ? config.hub
    : role === "clientA" ? config.clientA
    : config.clientB;

  // Validate that all CCTP addresses are configured
  validateCCTPConfig(role);
  const cctp = getCCTPAddresses(role);

  console.log(`=== Configuring Real CCTP V2 for ${chain.name} ===`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`Chain ID:           ${chainId}`);
  console.log(`CCTP Domain:        ${chain.cctpDomain}`);
  console.log(`CCTP Mode:          real (Circle contracts)`);
  console.log("");
  console.log("Circle CCTP V2 Addresses:");
  console.log(`  USDC:               ${cctp.usdc}`);
  console.log(`  TokenMessengerV2:   ${cctp.tokenMessenger}`);
  console.log(`  MessageTransmitterV2: ${cctp.messageTransmitter}`);
  console.log("");

  // Verify contracts exist on-chain
  console.log("Verifying contracts on-chain...");

  const usdcCode = await ethers.provider.getCode(cctp.usdc);
  if (usdcCode === "0x") {
    throw new Error(`USDC contract not found at ${cctp.usdc} on chain ${chainId}`);
  }
  console.log("  USDC: verified");

  const messengerCode = await ethers.provider.getCode(cctp.tokenMessenger);
  if (messengerCode === "0x") {
    throw new Error(`TokenMessengerV2 not found at ${cctp.tokenMessenger} on chain ${chainId}`);
  }
  console.log("  TokenMessengerV2: verified");

  const transmitterCode = await ethers.provider.getCode(cctp.messageTransmitter);
  if (transmitterCode === "0x") {
    throw new Error(`MessageTransmitterV2 not found at ${cctp.messageTransmitter} on chain ${chainId}`);
  }
  console.log("  MessageTransmitterV2: verified");

  // Verify USDC has correct decimals
  const usdc = await ethers.getContractAt("IERC20Metadata", cctp.usdc);
  const decimals = await usdc.decimals();
  console.log(`  USDC decimals: ${decimals}`);
  if (decimals !== 6n) {
    throw new Error(`Expected USDC with 6 decimals, got ${decimals}`);
  }

  // Check deployer USDC balance
  const usdcBalance = await usdc.balanceOf(deployer.address);
  console.log(`  Deployer USDC balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);

  // Check deployer ETH balance
  const ethBalance = await ethers.provider.getBalance(deployer.address);
  console.log(`  Deployer ETH balance: ${ethers.formatEther(ethBalance)} ETH`);

  if (ethBalance < ethers.parseEther("0.01")) {
    console.warn("\n  WARNING: Low ETH balance. Fund deployer before deploying contracts.");
  }

  console.log("");

  const deployment: DeploymentInfo = {
    chainId,
    domain: chain.cctpDomain,
    deployer: deployer.address,
    cctpMode: "real",
    contracts: {
      usdc: cctp.usdc,
      messageTransmitter: cctp.messageTransmitter,
      tokenMessenger: cctp.tokenMessenger,
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

  if (config.cctpMode !== "real") {
    console.error("Error: CCTP_MODE must be 'real' for this script.");
    console.error("Run: source config/sepolia.env");
    process.exit(1);
  }

  const role = getChainRole(chainId);
  if (!role) {
    console.error(`Unknown chain ID: ${chainId}`);
    console.error(`Expected: ${config.hub.chainId} (hub), ${config.clientA.chainId} (clientA), or ${config.clientB.chainId} (clientB)`);
    process.exit(1);
  }

  const deployment = await configureCCTP(role);
  const filename = getCCTPDeploymentFile(role);

  saveDeployment(filename, deployment);
  console.log(`=== Configuration Complete ===`);
  console.log(`Saved to: deployments/${filename}`);
  console.log("");
  console.log("Next step: deploy privacy pool contracts");
  console.log(`  npx hardhat run scripts/deploy_privacy_pool.ts --network ${
    role === "hub" ? "sepoliaHub" : role === "clientA" ? "sepoliaClientA" : "sepoliaClientB"
  }`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
