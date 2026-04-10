/**
 * Deploy Mock Aave Spoke
 *
 * Deploys a simplified Aave V4 Spoke mock for testing.
 * Used in both local and testnet environments (no real Aave V4 on Sepolia).
 *
 * Prerequisites:
 *   - CCTP infrastructure deployed/configured (for USDC address)
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_aave_mock.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_aave_mock.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPDeploymentFile,
  getAaveMockDeploymentFile,
  isCCTPReal,
  type ChainRole,
} from "../config/networks";
import { createNonceManager, loadDeployment, saveDeployment } from "./deploy-utils";

interface AaveMockDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    mockAaveSpoke: string;
  };
  reserves: {
    usdc: {
      reserveId: number;
      underlying: string;
      annualYieldBps: number;
    };
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

  const yieldBps = config.aaveYieldBps;

  console.log("=== Deploying Mock Aave Spoke ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Yield Rate: ${yieldBps / 100}% APY`);
  console.log("");

  // Load CCTP deployment to get USDC address
  const cctpFilename = getCCTPDeploymentFile(role);
  const cctpDeployment = loadDeployment(cctpFilename);
  if (!cctpDeployment) {
    console.error(`CCTP deployment not found: ${cctpFilename}`);
    console.error("Run deploy_cctp first");
    process.exit(1);
  }
  const usdcAddress = cctpDeployment.contracts.usdc;
  console.log(`Using USDC at: ${usdcAddress}`);

  // 1. Deploy MockAaveSpoke
  console.log("\n1. Deploying MockAaveSpoke...");
  const MockAaveSpoke = await ethers.getContractFactory("MockAaveSpoke");
  const mockAaveSpoke = await MockAaveSpoke.deploy(nm.override());
  await mockAaveSpoke.deploymentTransaction()!.wait();
  const mockAaveSpokeAddress = await mockAaveSpoke.getAddress();
  console.log(`   MockAaveSpoke: ${mockAaveSpokeAddress}`);

  // 2. Add MockAaveSpoke as USDC minter (only works with MockUSDCV2)
  if (!isCCTPReal()) {
    console.log("\n2. Adding MockAaveSpoke as USDC minter...");
    const usdc = await ethers.getContractAt("MockUSDCV2", usdcAddress);
    await (await usdc.addMinter(mockAaveSpokeAddress, nm.override())).wait();
    console.log("   MockAaveSpoke added as USDC minter");
  } else {
    console.log("\n2. Skipping minter setup (using real USDC - mock will use transfer-based yield)");
  }

  // 3. Add USDC reserve
  console.log("\n3. Adding USDC reserve...");
  const tx = await mockAaveSpoke.addReserve(
    usdcAddress,
    yieldBps,
    !isCCTPReal(), // mintableYield only works with mock USDC
    nm.override()
  );
  await tx.wait();
  console.log(`   USDC reserve added (reserveId: 0, APY: ${yieldBps / 100}%)`);

  // Save deployment
  const deployment: AaveMockDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      mockAaveSpoke: mockAaveSpokeAddress,
    },
    reserves: {
      usdc: {
        reserveId: 0,
        underlying: usdcAddress,
        annualYieldBps: yieldBps,
      },
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getAaveMockDeploymentFile(role);
  saveDeployment(outputFile, deployment);

  console.log("\n=== Deployment Complete ===");
  console.log(`Saved to: deployments/${outputFile}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
