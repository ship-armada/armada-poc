// ABOUTME: Verifies deployed Sepolia contracts on Etherscan using deployment manifests.
// ABOUTME: Reads addresses and reconstructable constructor args from governance + crowdfund manifests.

/**
 * Verify Sepolia Contracts on Etherscan
 *
 * Reads deployment manifests and reconstructs constructor arguments to verify
 * each contract. Requires ETHERSCAN_API_KEY in environment.
 *
 * Usage:
 *   source config/sepolia.env
 *   export ETHERSCAN_API_KEY=your_key_here
 *   npx hardhat run scripts/verify_sepolia.ts --network sepoliaHub
 *
 * Some contracts require values not stored in manifests (e.g. crowdfund openTimestamp).
 * These are read from the deployed contract on-chain where possible.
 */

import { ethers, run } from "hardhat";
import { getNetworkConfig, getGovernanceDeploymentFile, getCrowdfundDeploymentFile } from "../config/networks";
import { loadDeployment } from "./deploy-utils";

interface VerifyTask {
  name: string;
  address: string;
  constructorArguments: any[];
  contract?: string; // Fully qualified name for disambiguation
}

async function verify(task: VerifyTask): Promise<boolean> {
  console.log(`\nVerifying ${task.name} at ${task.address}...`);
  try {
    await run("verify:verify", {
      address: task.address,
      constructorArguments: task.constructorArguments,
      ...(task.contract ? { contract: task.contract } : {}),
    });
    console.log(`  ✓ ${task.name} verified`);
    return true;
  } catch (e: any) {
    if (e.message?.includes("Already Verified") || e.message?.includes("already verified")) {
      console.log(`  ✓ ${task.name} already verified`);
      return true;
    }
    console.error(`  ✗ ${task.name} failed: ${e.message}`);
    return false;
  }
}

async function main() {
  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is required. Get one from https://etherscan.io/apis");
  }

  const config = getNetworkConfig();
  const gov = loadDeployment(getGovernanceDeploymentFile());
  const cf = loadDeployment(getCrowdfundDeploymentFile());

  if (!gov) throw new Error(`Governance manifest not found: ${getGovernanceDeploymentFile()}`);
  if (!cf) throw new Error(`Crowdfund manifest not found: ${getCrowdfundDeploymentFile()}`);

  const c = gov.contracts;

  // Read values from on-chain that weren't stored in manifests
  const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", cf.contracts.crowdfund);
  const openTimestamp = await crowdfund.windowStart();
  const securityCouncil = await crowdfund.securityCouncil();

  const windDown = await ethers.getContractAt("ArmadaWindDown", c.windDown);
  const windDownDeadline = await windDown.windDownDeadline();
  const revenueThreshold = await windDown.revenueThreshold();

  // RevenueLock beneficiaries — reconstruct from config
  const beneficiaryConfig = config.revenueLockBeneficiaries;
  const beneficiaryAddresses = beneficiaryConfig.map(b => b.address);
  const beneficiaryAmounts = beneficiaryConfig.map(b => ethers.parseUnits(b.amount, 18));

  // Build verification tasks
  const tasks: VerifyTask[] = [
    // --- Governance contracts ---
    {
      name: "TimelockController",
      address: c.timelockController,
      constructorArguments: [gov.config.timelockMinDelay, [], [], gov.deployer],
      contract: "contracts/governance/TimelockController.sol:TimelockController",
    },
    {
      name: "ArmadaToken",
      address: c.armToken,
      constructorArguments: [gov.deployer, c.timelockController],
    },
    {
      name: "ArmadaTreasuryGov",
      address: c.treasury,
      constructorArguments: [c.timelockController],
    },
    {
      name: "ArmadaGovernor (implementation)",
      address: c.governorImpl,
      constructorArguments: [],
    },
    {
      name: "ArmadaGovernor (proxy)",
      address: c.governor,
      constructorArguments: [
        c.governorImpl,
        new ethers.Interface([
          "function initialize(address,address payable,address)",
        ]).encodeFunctionData("initialize", [c.armToken, c.timelockController, c.treasury]),
      ],
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    },
    {
      name: "TreasurySteward",
      address: c.steward,
      constructorArguments: [c.timelockController],
    },
    {
      name: "AdapterRegistry",
      address: c.adapterRegistry,
      constructorArguments: [c.timelockController],
    },
    {
      name: "RevenueCounter (implementation)",
      address: c.revenueCounterImpl,
      constructorArguments: [],
    },
    {
      name: "RevenueCounter (proxy)",
      address: c.revenueCounter,
      constructorArguments: [
        c.revenueCounterImpl,
        new ethers.Interface([
          "function initialize(address)",
        ]).encodeFunctionData("initialize", [c.timelockController]),
      ],
      contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    },
    {
      name: "RevenueLock",
      address: c.revenueLock,
      constructorArguments: [c.armToken, c.revenueCounter, beneficiaryAddresses, beneficiaryAmounts],
    },
    {
      name: "ShieldPauseController",
      address: c.shieldPauseController,
      constructorArguments: [c.governor, c.timelockController],
    },

    // --- Crowdfund contracts ---
    {
      name: "ArmadaCrowdfund",
      address: cf.contracts.crowdfund,
      constructorArguments: [
        cf.contracts.usdc,
        cf.contracts.armToken,
        cf.contracts.treasury,
        gov.deployer,        // launchTeam = deployer
        securityCouncil,     // read from on-chain
        openTimestamp,        // read from on-chain
      ],
    },
    {
      name: "ArmadaRedemption",
      address: c.redemption,
      constructorArguments: [c.armToken, c.treasury, c.revenueLock, cf.contracts.crowdfund],
    },
    {
      name: "ArmadaWindDown",
      address: c.windDown,
      constructorArguments: [
        c.armToken,
        c.treasury,
        c.governor,
        c.redemption,
        c.shieldPauseController,
        c.revenueCounter,
        c.timelockController,
        revenueThreshold,    // read from on-chain
        windDownDeadline,    // read from on-chain
      ],
    },
  ];

  // Run all verifications
  console.log(`\n=== Verifying ${tasks.length} contracts on Sepolia Etherscan ===\n`);

  let passed = 0;
  let failed = 0;
  for (const task of tasks) {
    const ok = await verify(task);
    if (ok) passed++;
    else failed++;
  }

  console.log(`\n=== Verification complete: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
