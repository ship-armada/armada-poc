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
 * Usage:
 *   npx hardhat run scripts/deploy_governance.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

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

  console.log("=== Deploying Armada Governance Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log("");

  const TWO_DAYS = 2 * 86400;
  const ONE_DAY = 86400;

  // 1. Deploy ArmadaToken
  console.log("1. Deploying ArmadaToken...");
  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address);
  await armToken.waitForDeployment();
  const armTokenAddress = await armToken.getAddress();
  console.log(`   ArmadaToken: ${armTokenAddress}`);

  // 2. Deploy VotingLocker
  console.log("2. Deploying VotingLocker...");
  const VotingLocker = await ethers.getContractFactory("VotingLocker");
  const votingLocker = await VotingLocker.deploy(armTokenAddress);
  await votingLocker.waitForDeployment();
  const votingLockerAddress = await votingLocker.getAddress();
  console.log(`   VotingLocker: ${votingLockerAddress}`);

  // 3. Deploy TimelockController
  console.log("3. Deploying TimelockController...");
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    TWO_DAYS, [], [], deployer.address
  );
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log(`   TimelockController: ${timelockAddress}`);

  // 4. Deploy ArmadaTreasuryGov
  console.log("4. Deploying ArmadaTreasuryGov...");
  const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
  const treasury = await ArmadaTreasuryGov.deploy(timelockAddress);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log(`   ArmadaTreasuryGov: ${treasuryAddress}`);

  // 5. Deploy ArmadaGovernor
  console.log("5. Deploying ArmadaGovernor...");
  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const governor = await ArmadaGovernor.deploy(
    votingLockerAddress, armTokenAddress, timelockAddress, treasuryAddress
  );
  await governor.waitForDeployment();
  const governorAddress = await governor.getAddress();
  console.log(`   ArmadaGovernor: ${governorAddress}`);

  // 6. Deploy TreasurySteward
  console.log("6. Deploying TreasurySteward...");
  const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
  const steward = await TreasurySteward.deploy(timelockAddress, treasuryAddress, ONE_DAY);
  await steward.waitForDeployment();
  const stewardAddress = await steward.getAddress();
  console.log(`   TreasurySteward: ${stewardAddress}`);

  // 7. Configure timelock roles
  console.log("7. Configuring timelock roles...");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

  await timelock.grantRole(PROPOSER_ROLE, governorAddress);
  await timelock.grantRole(EXECUTOR_ROLE, governorAddress);
  console.log("   Granted PROPOSER_ROLE and EXECUTOR_ROLE to governor");

  // 8. Renounce admin
  await timelock.renounceRole(ADMIN_ROLE, deployer.address);
  console.log("   Renounced TIMELOCK_ADMIN_ROLE from deployer");

  // 9. Distribute ARM tokens
  const treasuryAllocation = ethers.parseUnits("65000000", 18); // 65M
  console.log("9. Distributing ARM tokens...");
  await armToken.transfer(treasuryAddress, treasuryAllocation);
  console.log(`   Sent 65M ARM to treasury`);

  // Save deployment
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  let networkName = "hub";
  if (chainId === 31338) networkName = "client";
  else if (chainId === 31339) networkName = "clientB";

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
      timelockMinDelay: TWO_DAYS,
      stewardActionDelay: ONE_DAY,
      totalSupply: "100000000",
      treasuryAllocation: "65000000",
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = path.join(deploymentsDir, `governance-${networkName}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to: ${outputFile}`);
  console.log("\n=== Governance deployment complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
