/**
 * Deploy Armada Governance Contracts
 *
 * Deploys:
 * - ArmadaToken (ARM)
 * - VotingLocker
 * - TimelockController (OZ)
 * - ArmadaTreasuryGov
 * - ArmadaGovernor
 * - TreasurySteward
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
    armToken: string;
    votingLocker: string;
    timelockController: string;
    treasury: string;
    governor: string;
    steward: string;
  };
  config: {
    timelockMinDelay: number;
    stewardActionDelay: number;
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
  const stewardDelay = config.stewardDelay;

  console.log("=== Deploying Armada Governance Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Timelock delay: ${timelockDelay}s`);
  console.log(`Steward delay: ${stewardDelay}s`);
  console.log("");

  // 1. Deploy ArmadaToken
  console.log("1. Deploying ArmadaToken...");
  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address, nm.override());
  await armToken.deploymentTransaction()!.wait();
  const armTokenAddress = await armToken.getAddress();
  console.log(`   ArmadaToken: ${armTokenAddress}`);

  // 2. Deploy VotingLocker
  console.log("2. Deploying VotingLocker...");
  const VotingLocker = await ethers.getContractFactory("VotingLocker");
  const votingLocker = await VotingLocker.deploy(armTokenAddress, nm.override());
  await votingLocker.deploymentTransaction()!.wait();
  const votingLockerAddress = await votingLocker.getAddress();
  console.log(`   VotingLocker: ${votingLockerAddress}`);

  // 3. Deploy TimelockController
  console.log("3. Deploying TimelockController...");
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    timelockDelay, [], [], deployer.address, nm.override()
  );
  await timelock.deploymentTransaction()!.wait();
  const timelockAddress = await timelock.getAddress();
  console.log(`   TimelockController: ${timelockAddress}`);

  // 4. Deploy ArmadaTreasuryGov
  console.log("4. Deploying ArmadaTreasuryGov...");
  const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
  const treasury = await ArmadaTreasuryGov.deploy(timelockAddress, nm.override());
  await treasury.deploymentTransaction()!.wait();
  const treasuryAddress = await treasury.getAddress();
  console.log(`   ArmadaTreasuryGov: ${treasuryAddress}`);

  // 5. Deploy ArmadaGovernor
  console.log("5. Deploying ArmadaGovernor...");
  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const governor = await ArmadaGovernor.deploy(
    votingLockerAddress, armTokenAddress, timelockAddress, treasuryAddress, nm.override()
  );
  await governor.deploymentTransaction()!.wait();
  const governorAddress = await governor.getAddress();
  console.log(`   ArmadaGovernor: ${governorAddress}`);

  // 6. Deploy TreasurySteward
  console.log("6. Deploying TreasurySteward...");
  const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
  const steward = await TreasurySteward.deploy(timelockAddress, treasuryAddress, stewardDelay, nm.override());
  await steward.deploymentTransaction()!.wait();
  const stewardAddress = await steward.getAddress();
  console.log(`   TreasurySteward: ${stewardAddress}`);

  // 7. Configure timelock roles
  console.log("7. Configuring timelock roles...");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  await (await timelock.grantRole(PROPOSER_ROLE, governorAddress, nm.override())).wait();
  console.log("   Granted PROPOSER_ROLE to governor");
  await (await timelock.grantRole(EXECUTOR_ROLE, governorAddress, nm.override())).wait();
  console.log("   Granted EXECUTOR_ROLE to governor");

  // 8. Renounce admin
  await (await timelock.renounceRole(ADMIN_ROLE, deployer.address, nm.override())).wait();
  console.log("   Renounced TIMELOCK_ADMIN_ROLE from deployer");

  // 9. Distribute ARM tokens
  const treasuryAllocation = ethers.parseUnits(config.armDistribution.treasury, 18);
  console.log("9. Distributing ARM tokens...");
  await (await armToken.transfer(treasuryAddress, treasuryAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.treasury} ARM to treasury`);

  // Save deployment
  const deployment: GovernanceDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      armToken: armTokenAddress,
      votingLocker: votingLockerAddress,
      timelockController: timelockAddress,
      treasury: treasuryAddress,
      governor: governorAddress,
      steward: stewardAddress,
    },
    config: {
      timelockMinDelay: timelockDelay,
      stewardActionDelay: stewardDelay,
      totalSupply: "100000000",
      treasuryAllocation: config.armDistribution.treasury,
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getGovernanceDeploymentFile();
  saveDeployment(outputFile, deployment);
  console.log(`\nDeployment saved to: deployments/${outputFile}`);
  console.log("\n=== Governance deployment complete ===");
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
