// ABOUTME: Verifies deployed Sepolia contracts on Etherscan using deployment manifests.
// ABOUTME: Chain-aware — hub verifies governance + crowdfund + privacy pool + yield + aave + fee module; clients verify their PrivacyPoolClient + CCTPHookRouter.

/**
 * Verify Sepolia Contracts on Etherscan
 *
 * Reads deployment manifests and reconstructs constructor arguments to verify
 * each contract. Requires ETHERSCAN_API_KEY in environment.
 *
 * Usage (run once per chain — same key works for all three explorers via Etherscan V2):
 *   source config/sepolia.env
 *   export ETHERSCAN_API_KEY=your_key_here
 *   npx hardhat run scripts/verify_sepolia.ts --network sepoliaHub
 *   npx hardhat run scripts/verify_sepolia.ts --network sepoliaClientA   # Base Sepolia
 *   npx hardhat run scripts/verify_sepolia.ts --network sepoliaClientB   # Arbitrum Sepolia
 *
 * Some contracts require values not stored in manifests (e.g. crowdfund openTimestamp).
 * These are read from the deployed contract on-chain where possible.
 *
 * Library-linked modules (MerkleModule, ShieldModule, TransactModule) are skipped — they
 * depend on PoseidonT3/T4 library addresses that aren't captured in any deployment
 * manifest. Verify them manually if needed:
 *   npx hardhat verify --network sepoliaHub --libraries poseidon-libs.json <addr>
 * The contract code is library-linked delegatecall so the PrivacyPool router (which IS
 * verified) is the read-meaningful explorer surface.
 */

import { ethers, run } from "hardhat";
import {
  getNetworkConfig,
  getGovernanceDeploymentFile,
  getCrowdfundDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getYieldDeploymentFile,
  getAaveMockDeploymentFile,
  getFeeModuleDeploymentFile,
  getCCTPDeploymentFile,
} from "../config/networks";
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

/**
 * Build governance + crowdfund tasks. Hub-only — clients don't deploy these.
 */
async function buildGovernanceCrowdfundTasks(): Promise<VerifyTask[]> {
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

  return [
    // --- Governance contracts ---
    {
      name: "TimelockController",
      address: c.timelockController,
      constructorArguments: [gov.config.timelockMinDelay, [], [], gov.deployer],
      contract: "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
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
      // $10k/day rate cap — must match the value used at deployment in deploy_governance.ts.
      // See PARAMETER_MANIFEST.md (ship-armada/crowdfund) and issue #225.
      address: c.revenueLock,
      constructorArguments: [
        c.armToken,
        c.revenueCounter,
        ethers.parseUnits("10000", 18),
        beneficiaryAddresses,
        beneficiaryAmounts,
      ],
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
        c.revenueLock,
        c.timelockController,
        revenueThreshold,    // read from on-chain
        windDownDeadline,    // read from on-chain
      ],
    },
  ];
}

/**
 * Build privacy-pool + yield + aave + fee-module tasks for the hub.
 * Modules linked to Poseidon libraries (Merkle/Shield/Transact) are skipped because the
 * library addresses aren't recorded in any manifest; the user-meaningful surface is the
 * PrivacyPool router which IS verified.
 */
async function buildHubProtocolTasks(): Promise<VerifyTask[]> {
  const pool = loadDeployment(getPrivacyPoolDeploymentFile("hub"));
  const yieldD = loadDeployment(getYieldDeploymentFile());
  const aave = loadDeployment(getAaveMockDeploymentFile("hub"));
  const gov = loadDeployment(getGovernanceDeploymentFile());
  const feeMod = loadDeployment(getFeeModuleDeploymentFile());
  const cctp = loadDeployment(getCCTPDeploymentFile("hub"));

  const tasks: VerifyTask[] = [];

  if (pool?.contracts) {
    const pc = pool.contracts;
    tasks.push(
      { name: "PrivacyPool (hub router)", address: pc.privacyPool, constructorArguments: [] },
      { name: "VerifierModule", address: pc.verifierModule, constructorArguments: [] },
      // hookRouter constructor: (messageTransmitter)
      { name: "CCTPHookRouter (hub)", address: pc.hookRouter, constructorArguments: [pool.cctp.messageTransmitter] },
    );
  }

  if (yieldD?.contracts && aave?.contracts && gov?.contracts && cctp?.contracts) {
    const yc = yieldD.contracts;
    const cfg = yieldD.config;
    tasks.push(
      // ArmadaYieldVault(mockAaveSpoke, reserveId, treasury, name, symbol)
      {
        name: "ArmadaYieldVault",
        address: yc.armadaYieldVault,
        constructorArguments: [
          aave.contracts.mockAaveSpoke,
          cfg.reserveId,
          gov.contracts.treasury,
          "Armada Yield USDC",
          "ayUSDC",
        ],
      },
      // ArmadaYieldAdapter(usdc, vault, adapterRegistry)
      {
        name: "ArmadaYieldAdapter",
        address: yc.armadaYieldAdapter,
        constructorArguments: [
          cctp.contracts.usdc,
          yc.armadaYieldVault,
          gov.contracts.adapterRegistry,
        ],
      },
    );
  }

  if (aave?.contracts) {
    tasks.push({ name: "MockAaveSpoke", address: aave.contracts.mockAaveSpoke, constructorArguments: [] });
  }

  if (feeMod?.contracts && gov?.contracts && pool?.contracts && yieldD?.contracts) {
    const ArmadaFeeModule = await ethers.getContractFactory("ArmadaFeeModule");
    const initData = ArmadaFeeModule.interface.encodeFunctionData("initialize", [
      gov.contracts.timelockController, // owner on non-local
      gov.contracts.treasury,
      pool.contracts.privacyPool,
      yieldD.contracts.armadaYieldVault,
    ]);
    tasks.push(
      { name: "ArmadaFeeModule (implementation)", address: feeMod.contracts.feeModuleImpl, constructorArguments: [] },
      // ERC1967Proxy(implementation, data)
      {
        name: "ArmadaFeeModule (proxy)",
        address: feeMod.contracts.feeModuleProxy,
        constructorArguments: [feeMod.contracts.feeModuleImpl, initData],
        contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      },
    );
  }

  return tasks;
}

/**
 * Build PrivacyPoolClient + CCTPHookRouter tasks for a client chain.
 * Loads the per-role manifest (clientA = Base Sepolia, clientB = Arbitrum Sepolia).
 */
async function buildClientChainTasks(role: "clientA" | "clientB"): Promise<VerifyTask[]> {
  const client = loadDeployment(getPrivacyPoolDeploymentFile(role));
  if (!client?.contracts) {
    throw new Error(`PrivacyPoolClient manifest not found for role=${role}`);
  }
  const cc = client.contracts;
  return [
    { name: "PrivacyPoolClient", address: cc.privacyPoolClient, constructorArguments: [] },
    // hookRouter constructor: (messageTransmitter)
    { name: "CCTPHookRouter (client)", address: cc.hookRouter, constructorArguments: [client.cctp.messageTransmitter] },
  ];
}

async function main() {
  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is required. Get one from https://etherscan.io/apis");
  }

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const tasks: VerifyTask[] = [];
  let label: string;

  // Dispatch by chain id. Hub gets the full protocol stack; clients only their
  // PrivacyPoolClient + CCTPHookRouter.
  switch (chainId) {
    case 11155111: // Ethereum Sepolia (hub)
      label = "Sepolia (hub)";
      tasks.push(...(await buildGovernanceCrowdfundTasks()));
      tasks.push(...(await buildHubProtocolTasks()));
      console.log(
        "\nNote: MerkleModule, ShieldModule, TransactModule are skipped — they link to Poseidon\n" +
        "libraries whose addresses aren't in the deployment manifest. The PrivacyPool router itself\n" +
        "is verified, which is the user-facing explorer surface.",
      );
      break;
    case 84532: // Base Sepolia (clientA)
      label = "Base Sepolia (clientA)";
      tasks.push(...(await buildClientChainTasks("clientA")));
      break;
    case 421614: // Arbitrum Sepolia (clientB)
      label = "Arbitrum Sepolia (clientB)";
      tasks.push(...(await buildClientChainTasks("clientB")));
      break;
    default:
      throw new Error(
        `Unsupported chain id ${chainId}. Run with --network sepoliaHub | sepoliaClientA | sepoliaClientB.`,
      );
  }

  console.log(`\n=== Verifying ${tasks.length} contracts on ${label} Etherscan ===\n`);

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
