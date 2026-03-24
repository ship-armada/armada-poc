// ABOUTME: Deployment script for Armada governance contracts (timelock, token, treasury, governor, steward).
// ABOUTME: Handles role grants, steward contract registration, and whitelist initialization.

/**
 * Deploy Armada Governance Contracts
 *
 * Deploys:
 * - TimelockController (OZ)
 * - ArmadaToken (ARM) with ERC20Votes
 * - ArmadaTreasuryGov (with outflow rate limits)
 * - ArmadaGovernor
 * - TreasurySteward
 * - RevenueCounter (UUPS proxy)
 *
 * Post-deploy configuration:
 * - ARM token: setNoDelegation, initWhitelist, setWindDownContract (deferred)
 * - Treasury: initOutflowConfig for USDC and ARM
 * - Timelock: grant roles to governor, renounce admin
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_governance.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_governance.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getChainRole,
  getGovernanceDeploymentFile,
} from "../config/networks";
import { createNonceManager } from "./deploy-utils";

interface GovernanceDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    timelockController: string;
    armToken: string;
    treasury: string;
    governor: string;
    steward: string;
    revenueCounter: string;
    revenueCounterImpl: string;
  };
  config: {
    timelockMinDelay: number;
    totalSupply: string;
    treasuryAllocation: string;
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

  const timelockDelay = config.timelockDelay;

  // Emergency pause config: deployer as initial guardian, 14 day max pause
  // TODO: Transfer guardian to a dedicated multisig after deployment
  const guardianAddress = deployer.address;
  const maxPauseDuration = 14 * 24 * 60 * 60; // 14 days

  console.log("=== Deploying Armada Governance Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Timelock delay: ${timelockDelay}s`);
  console.log("");

  // 1. Deploy TimelockController (needed before ArmadaToken for timelock address)
  console.log("1. Deploying TimelockController...");
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    timelockDelay, [], [], deployer.address, nm.override()
  );
  await timelock.deploymentTransaction()!.wait();
  const timelockAddress = await timelock.getAddress();
  console.log(`   TimelockController: ${timelockAddress}`);

  // 2. Deploy ArmadaToken (needs timelock address for addToWhitelist gating)
  console.log("2. Deploying ArmadaToken...");
  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address, timelockAddress, nm.override());
  await armToken.deploymentTransaction()!.wait();
  const armTokenAddress = await armToken.getAddress();
  console.log(`   ArmadaToken: ${armTokenAddress}`);

  // 3. Deploy ArmadaTreasuryGov
  console.log("3. Deploying ArmadaTreasuryGov...");
  const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
  const treasury = await ArmadaTreasuryGov.deploy(
    timelockAddress, guardianAddress, maxPauseDuration, nm.override()
  );
  await treasury.deploymentTransaction()!.wait();
  const treasuryAddress = await treasury.getAddress();
  console.log(`   ArmadaTreasuryGov: ${treasuryAddress}`);

  // 4. Deploy ArmadaGovernor
  console.log("4. Deploying ArmadaGovernor...");
  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const governor = await ArmadaGovernor.deploy(
    armTokenAddress, timelockAddress, treasuryAddress,
    guardianAddress, maxPauseDuration, nm.override()
  );
  await governor.deploymentTransaction()!.wait();
  const governorAddress = await governor.getAddress();
  console.log(`   ArmadaGovernor: ${governorAddress}`);

  // 5. Deploy TreasurySteward (identity management only — proposals flow through governor)
  console.log("5. Deploying TreasurySteward...");
  const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
  const steward = await TreasurySteward.deploy(
    timelockAddress,
    guardianAddress, maxPauseDuration, nm.override()
  );
  await steward.deploymentTransaction()!.wait();
  const stewardAddress = await steward.getAddress();
  console.log(`   TreasurySteward: ${stewardAddress}`);

  // 5b. Register steward contract on governor (one-time setter)
  await (await governor.setStewardContract(stewardAddress, nm.override())).wait();
  console.log(`   Governor: setStewardContract(${stewardAddress})`);

  // 6. Deploy RevenueCounter (UUPS proxy)
  console.log("6. Deploying RevenueCounter (UUPS proxy)...");
  const RevenueCounter = await ethers.getContractFactory("RevenueCounter");
  const revenueCounterImpl = await RevenueCounter.deploy(nm.override());
  await revenueCounterImpl.deploymentTransaction()!.wait();
  const revenueCounterImplAddress = await revenueCounterImpl.getAddress();
  console.log(`   RevenueCounter (impl): ${revenueCounterImplAddress}`);

  const initData = RevenueCounter.interface.encodeFunctionData("initialize", [timelockAddress]);
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const revenueCounterProxy = await ERC1967Proxy.deploy(
    revenueCounterImplAddress, initData, nm.override()
  );
  await revenueCounterProxy.deploymentTransaction()!.wait();
  const revenueCounterAddress = await revenueCounterProxy.getAddress();
  console.log(`   RevenueCounter (proxy): ${revenueCounterAddress}`);

  // ============ Post-deploy configuration ============

  // 7. Configure timelock roles
  console.log("7. Configuring timelock roles...");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  await (await timelock.grantRole(PROPOSER_ROLE, governorAddress, nm.override())).wait();
  console.log("   Granted PROPOSER_ROLE to governor");
  await (await timelock.grantRole(EXECUTOR_ROLE, governorAddress, nm.override())).wait();
  console.log("   Granted EXECUTOR_ROLE to governor");
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  await (await timelock.grantRole(CANCELLER_ROLE, governorAddress, nm.override())).wait();
  console.log("   Granted CANCELLER_ROLE to governor (for SC veto)");

  // 8. Configure ARM token (one-time setters)
  console.log("8. Configuring ARM token...");
  await (await armToken.setNoDelegation(treasuryAddress, nm.override())).wait();
  console.log(`   setNoDelegation: ${treasuryAddress} (treasury)`);

  // Whitelist: treasury, deployer (for initial distribution), crowdfund (if applicable)
  const whitelistAddresses = [deployer.address, treasuryAddress];
  await (await armToken.initWhitelist(whitelistAddresses, nm.override())).wait();
  console.log(`   initWhitelist: ${whitelistAddresses.length} addresses`);
  // NOTE: setWindDownContract is deferred — the wind-down contract doesn't exist yet.
  // It will be set by the deployer once the wind-down contract is deployed.

  // 9. Distribute ARM tokens
  const treasuryAllocation = ethers.parseUnits(config.armDistribution.treasury, 18);
  console.log("9. Distributing ARM tokens...");
  await (await armToken.transfer(treasuryAddress, treasuryAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.treasury} ARM to treasury`);

  // 10. Initialize treasury outflow limits
  // TODO: These defaults should be moved to config/networks.ts when finalized
  console.log("10. Initializing treasury outflow limits...");
  // Outflow limits are configured per-token via governance after deployment.
  // The deployer (as initial owner/timelock admin) cannot call initOutflowConfig directly
  // because the treasury's owner is the timelock. Outflow config will be set via the
  // first governance proposal after ARM delegation and governance activation.
  console.log("   Outflow limits will be configured via governance proposal post-launch");

  // 11. Renounce timelock admin (last step — deployer relinquishes admin role)
  console.log("11. Renouncing timelock admin...");
  await (await timelock.renounceRole(ADMIN_ROLE, deployer.address, nm.override())).wait();
  console.log("   Renounced TIMELOCK_ADMIN_ROLE from deployer");

  // Save deployment
  const deployment: GovernanceDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      timelockController: timelockAddress,
      armToken: armTokenAddress,
      treasury: treasuryAddress,
      governor: governorAddress,
      steward: stewardAddress,
      revenueCounter: revenueCounterAddress,
      revenueCounterImpl: revenueCounterImplAddress,
    },
    config: {
      timelockMinDelay: timelockDelay,
      totalSupply: "12000000",
      treasuryAllocation: config.armDistribution.treasury,
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getGovernanceDeploymentFile();
  saveDeployment(outputFile, deployment);
  console.log(`\nDeployment saved to: deployments/${outputFile}`);
  console.log("\n=== Governance deployment complete ===");
  console.log("\nPost-launch TODO:");
  console.log("  1. Set ARM whitelist for crowdfund address (via addToWhitelist governance proposal)");
  console.log("  2. Configure treasury outflow limits for USDC and ARM (via governance proposal)");
  console.log("  3. Set wind-down contract on ARM token (deployer calls setWindDownContract)");
  console.log("  4. Set fee collector on RevenueCounter (via governance proposal)");
  console.log("  5. Transfer guardian to dedicated multisig (via governance proposal)");
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
