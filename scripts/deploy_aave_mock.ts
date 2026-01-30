/**
 * Deploy Mock Aave Spoke
 *
 * Deploys a simplified Aave V4 Spoke mock for local devnet testing.
 * The mock implements the same interface as real Aave V4, allowing
 * frontends to switch between mock and real Aave with zero code changes.
 *
 * Prerequisites:
 *   - CCTP infrastructure deployed (for MockUSDCV2 address)
 *   - Run deploy_cctp_v3.ts first
 *
 * Usage:
 *   npx hardhat run scripts/deploy_aave_mock.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Default yield rate: 500,000% APY (for testing - generates visible yield in seconds)
// In production, this would be ~5% (500 bps)
const DEFAULT_YIELD_BPS = 5000000;

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

  console.log("=== Deploying Mock Aave Spoke ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log("");

  // Load CCTP deployment to get USDC address
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  let cctpDeploymentFile: string;

  if (chainId === 31337) {
    cctpDeploymentFile = path.join(deploymentsDir, "hub-v3.json");
  } else if (chainId === 31338) {
    cctpDeploymentFile = path.join(deploymentsDir, "client-v3.json");
  } else if (chainId === 31339) {
    cctpDeploymentFile = path.join(deploymentsDir, "clientB-v3.json");
  } else {
    console.error(`Unknown chain ID: ${chainId}`);
    process.exit(1);
  }

  if (!fs.existsSync(cctpDeploymentFile)) {
    console.error(`CCTP deployment not found: ${cctpDeploymentFile}`);
    console.error("Run deploy_cctp_v3.ts first");
    process.exit(1);
  }

  const cctpDeployment = JSON.parse(fs.readFileSync(cctpDeploymentFile, "utf8"));
  const usdcAddress = cctpDeployment.contracts.usdc;
  console.log(`Using USDC at: ${usdcAddress}`);

  // 1. Deploy MockAaveSpoke
  console.log("\n1. Deploying MockAaveSpoke...");
  const MockAaveSpoke = await ethers.getContractFactory("MockAaveSpoke");
  const mockAaveSpoke = await MockAaveSpoke.deploy();
  await mockAaveSpoke.waitForDeployment();
  const mockAaveSpokeAddress = await mockAaveSpoke.getAddress();
  console.log(`   MockAaveSpoke: ${mockAaveSpokeAddress}`);

  // 2. Add USDC as minter for MockAaveSpoke (so it can mint yield)
  console.log("\n2. Adding MockAaveSpoke as USDC minter...");
  const usdc = await ethers.getContractAt("MockUSDCV2", usdcAddress);
  await (await usdc.addMinter(mockAaveSpokeAddress)).wait();
  console.log("   MockAaveSpoke added as USDC minter");

  // 3. Add USDC reserve with 5% APY
  console.log("\n3. Adding USDC reserve...");
  const tx = await mockAaveSpoke.addReserve(
    usdcAddress,
    DEFAULT_YIELD_BPS,  // 5% APY
    true                // mintableYield = true
  );
  await tx.wait();
  console.log(`   USDC reserve added (reserveId: 0, APY: ${DEFAULT_YIELD_BPS / 100}%)`);

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
        annualYieldBps: DEFAULT_YIELD_BPS,
      },
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = path.join(deploymentsDir, `aave-mock-${chainId === 31337 ? "hub" : chainId === 31338 ? "client" : "clientB"}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(deployment, null, 2));

  console.log("\n=== Deployment Complete ===");
  console.log(`Saved to: ${outputFile}`);
  console.log("\nContracts:");
  console.log(`  MockAaveSpoke: ${mockAaveSpokeAddress}`);
  console.log(`  USDC Reserve:  reserveId=0, APY=${DEFAULT_YIELD_BPS / 100}%`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
