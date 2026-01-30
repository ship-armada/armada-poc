/**
 * Deploy Armada Yield Contracts
 *
 * Deploys the yield infrastructure:
 * - ArmadaYieldVault: ERC-20 wrapper around Aave Spoke
 * - ArmadaYieldAdapter: Lend/redeem operations for privacy pool
 *
 * Prerequisites:
 *   - CCTP infrastructure deployed (for USDC address)
 *   - Mock Aave deployed (for MockAaveSpoke address)
 *   - Run deploy_cctp_v3.ts and deploy_aave_mock.ts first
 *
 * Usage:
 *   npx hardhat run scripts/deploy_yield.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface YieldDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armadaTreasury: string;
    armadaYieldVault: string;
    armadaYieldAdapter: string;
  };
  config: {
    usdc: string;
    mockAaveSpoke: string;
    reserveId: number;
    yieldFeeBps: number;
  };
  timestamp: string;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("=== Deploying Armada Yield Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log("");

  // Load dependencies
  const deploymentsDir = path.join(__dirname, "..", "deployments");

  // Determine network name
  let networkName: string;
  if (chainId === 31337) {
    networkName = "hub";
  } else if (chainId === 31338) {
    networkName = "client";
  } else if (chainId === 31339) {
    networkName = "clientB";
  } else {
    console.error(`Unknown chain ID: ${chainId}`);
    process.exit(1);
  }

  // Load CCTP deployment for USDC
  const cctpDeploymentFile = path.join(deploymentsDir, `${networkName}-v3.json`);
  if (!fs.existsSync(cctpDeploymentFile)) {
    console.error(`CCTP deployment not found: ${cctpDeploymentFile}`);
    console.error("Run deploy_cctp_v3.ts first");
    process.exit(1);
  }
  const cctpDeployment = JSON.parse(fs.readFileSync(cctpDeploymentFile, "utf8"));
  const usdcAddress = cctpDeployment.contracts.usdc;
  const tokenMessengerAddress = cctpDeployment.contracts.tokenMessenger;
  console.log(`Using USDC at: ${usdcAddress}`);
  console.log(`Using TokenMessenger at: ${tokenMessengerAddress}`);

  // Load Aave Mock deployment
  const aaveDeploymentFile = path.join(deploymentsDir, `aave-mock-${networkName}.json`);
  if (!fs.existsSync(aaveDeploymentFile)) {
    console.error(`Aave Mock deployment not found: ${aaveDeploymentFile}`);
    console.error("Run deploy_aave_mock.ts first");
    process.exit(1);
  }
  const aaveDeployment = JSON.parse(fs.readFileSync(aaveDeploymentFile, "utf8"));
  const mockAaveSpokeAddress = aaveDeployment.contracts.mockAaveSpoke;
  const reserveId = aaveDeployment.reserves.usdc.reserveId;
  console.log(`Using MockAaveSpoke at: ${mockAaveSpokeAddress}`);
  console.log(`Using reserve ID: ${reserveId}`);

  // 1. Deploy ArmadaTreasury
  console.log("\n1. Deploying ArmadaTreasury...");
  const ArmadaTreasury = await ethers.getContractFactory("ArmadaTreasury");
  const armadaTreasury = await ArmadaTreasury.deploy();
  await armadaTreasury.waitForDeployment();
  const armadaTreasuryAddress = await armadaTreasury.getAddress();
  console.log(`   ArmadaTreasury: ${armadaTreasuryAddress}`);

  // 2. Deploy ArmadaYieldVault
  console.log("\n2. Deploying ArmadaYieldVault...");
  const ArmadaYieldVault = await ethers.getContractFactory("ArmadaYieldVault");
  const armadaYieldVault = await ArmadaYieldVault.deploy(
    mockAaveSpokeAddress,
    reserveId,
    armadaTreasuryAddress,
    "Armada Yield USDC",
    "ayUSDC"
  );
  await armadaYieldVault.waitForDeployment();
  const armadaYieldVaultAddress = await armadaYieldVault.getAddress();
  console.log(`   ArmadaYieldVault: ${armadaYieldVaultAddress}`);

  // 3. Deploy ArmadaYieldAdapter
  console.log("\n3. Deploying ArmadaYieldAdapter...");
  const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
  const armadaYieldAdapter = await ArmadaYieldAdapter.deploy(
    usdcAddress,
    armadaYieldVaultAddress
  );
  await armadaYieldAdapter.waitForDeployment();
  const armadaYieldAdapterAddress = await armadaYieldAdapter.getAddress();
  console.log(`   ArmadaYieldAdapter: ${armadaYieldAdapterAddress}`);

  // 4. Configure ArmadaYieldVault to recognize adapter
  console.log("\n4. Configuring ArmadaYieldVault...");
  await (await armadaYieldVault.setAdapter(armadaYieldAdapterAddress)).wait();
  console.log(`   Adapter set to: ${armadaYieldAdapterAddress}`);

  // 5. Configure ArmadaYieldAdapter
  console.log("\n5. Configuring ArmadaYieldAdapter...");
  await (await armadaYieldAdapter.setRelayer(deployer.address, true)).wait();
  console.log(`   Relayer added: ${deployer.address}`);

  // 6. Set TokenMessenger for cross-chain CCTP support
  console.log("\n6. Setting TokenMessenger for CCTP...");
  await (await armadaYieldAdapter.setTokenMessenger(tokenMessengerAddress)).wait();
  console.log(`   TokenMessenger set to: ${tokenMessengerAddress}`);

  // Save deployment
  const deployment: YieldDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      armadaTreasury: armadaTreasuryAddress,
      armadaYieldVault: armadaYieldVaultAddress,
      armadaYieldAdapter: armadaYieldAdapterAddress,
    },
    config: {
      usdc: usdcAddress,
      mockAaveSpoke: mockAaveSpokeAddress,
      reserveId,
      yieldFeeBps: 1000, // 10%
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = path.join(deploymentsDir, `yield-${networkName}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(deployment, null, 2));

  console.log("\n=== Deployment Complete ===");
  console.log(`Saved to: ${outputFile}`);
  console.log("\nContracts:");
  console.log(`  ArmadaTreasury:     ${armadaTreasuryAddress}`);
  console.log(`  ArmadaYieldVault:   ${armadaYieldVaultAddress}`);
  console.log(`  ArmadaYieldAdapter: ${armadaYieldAdapterAddress}`);
  console.log("\nConfiguration:");
  console.log(`  USDC:           ${usdcAddress}`);
  console.log(`  MockAaveSpoke:  ${mockAaveSpokeAddress}`);
  console.log(`  Reserve ID:     ${reserveId}`);
  console.log(`  Yield Fee:      10%`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
