/**
 * Deploy Armada Yield Contracts
 *
 * Deploys the yield infrastructure:
 * - ArmadaYieldVault: ERC-20 wrapper around Aave Spoke (yield fees route to ArmadaTreasuryGov)
 * - ArmadaYieldAdapter: Lend/redeem operations for privacy pool
 *
 * Prerequisites:
 *   - CCTP infrastructure deployed/configured (for USDC address)
 *   - Mock Aave deployed (for MockAaveSpoke address)
 *   - Governance deployed (for ArmadaTreasuryGov + adapter registry addresses)
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_yield.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_yield.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPDeploymentFile,
  getAaveMockDeploymentFile,
  getGovernanceDeploymentFile,
  getYieldDeploymentFile,
  type ChainRole,
} from "../config/networks";
import { createNonceManager, loadDeployment, saveDeployment } from "./deploy-utils";

interface YieldDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armadaYieldVault: string;
    armadaYieldAdapter: string;
  };
  config: {
    usdc: string;
    mockAaveSpoke: string;
    reserveId: number;
    yieldFeeBps: number;
    treasury: string;
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

  console.log("=== Deploying Armada Yield Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  // Load CCTP deployment for USDC
  const cctpFilename = getCCTPDeploymentFile(role);
  const cctpDeployment = loadDeployment(cctpFilename);
  if (!cctpDeployment) {
    console.error(`CCTP deployment not found: ${cctpFilename}`);
    process.exit(1);
  }
  const usdcAddress = cctpDeployment.contracts.usdc;
  console.log(`Using USDC at: ${usdcAddress}`);

  // Load Aave Mock deployment
  const aaveFilename = getAaveMockDeploymentFile(role);
  const aaveDeployment = loadDeployment(aaveFilename);
  if (!aaveDeployment) {
    console.error(`Aave Mock deployment not found: ${aaveFilename}`);
    process.exit(1);
  }
  const mockAaveSpokeAddress = aaveDeployment.contracts.mockAaveSpoke;
  const reserveId = aaveDeployment.reserves.usdc.reserveId;
  console.log(`Using MockAaveSpoke at: ${mockAaveSpokeAddress}`);
  console.log(`Using reserve ID: ${reserveId}`);

  // Load Governance deployment for adapter registry address
  const govFilename = getGovernanceDeploymentFile();
  const govDeployment = loadDeployment(govFilename);
  if (!govDeployment) {
    console.error(`Governance deployment not found: ${govFilename}. Deploy governance first.`);
    process.exit(1);
  }
  const adapterRegistryAddress = govDeployment.contracts.adapterRegistry;
  console.log(`Using AdapterRegistry at: ${adapterRegistryAddress}`);

  const treasuryAddress = govDeployment.contracts.treasury;
  if (!treasuryAddress) {
    console.error(`Governance deployment is missing 'treasury' (ArmadaTreasuryGov) address.`);
    process.exit(1);
  }
  console.log(`Using ArmadaTreasuryGov at: ${treasuryAddress}`);

  // 1. Deploy ArmadaYieldVault (yield fees route to ArmadaTreasuryGov via safeTransfer)
  console.log("\n1. Deploying ArmadaYieldVault...");
  const ArmadaYieldVault = await ethers.getContractFactory("ArmadaYieldVault");
  const armadaYieldVault = await ArmadaYieldVault.deploy(
    mockAaveSpokeAddress,
    reserveId,
    treasuryAddress,
    "Armada Yield USDC",
    "ayUSDC",
    nm.override()
  );
  await armadaYieldVault.deploymentTransaction()!.wait();
  const armadaYieldVaultAddress = await armadaYieldVault.getAddress();
  console.log(`   ArmadaYieldVault: ${armadaYieldVaultAddress}`);

  // 2. Deploy ArmadaYieldAdapter (with adapter registry for authorization checks)
  console.log("\n2. Deploying ArmadaYieldAdapter...");
  const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
  const armadaYieldAdapter = await ArmadaYieldAdapter.deploy(
    usdcAddress,
    armadaYieldVaultAddress,
    adapterRegistryAddress,
    nm.override()
  );
  await armadaYieldAdapter.deploymentTransaction()!.wait();
  const armadaYieldAdapterAddress = await armadaYieldAdapter.getAddress();
  console.log(`   ArmadaYieldAdapter: ${armadaYieldAdapterAddress}`);

  // Yield contract ownership transfers to timelock are handled by deploy_fee_module.ts
  // after all owner-gated configuration (link + fee module wiring) is complete.

  // Save deployment
  const deployment: YieldDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      armadaYieldVault: armadaYieldVaultAddress,
      armadaYieldAdapter: armadaYieldAdapterAddress,
    },
    config: {
      usdc: usdcAddress,
      mockAaveSpoke: mockAaveSpokeAddress,
      reserveId,
      yieldFeeBps: 1000, // 10%
      treasury: treasuryAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getYieldDeploymentFile();
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
