// ABOUTME: Deploys ArmadaCrowdfund using shared ARM token and treasury from governance deployment.
// ABOUTME: Reads USDC from CCTP deployment, sets quorum exclusion, and writes crowdfund-hub manifest.

/**
 * Deploy Armada Crowdfund Contract
 *
 * Deploys ArmadaCrowdfund using the shared ARM token and treasury from
 * the governance deployment. Governance must be deployed first.
 *
 * Uses the shared USDC from the CCTP deployment (both local and testnet).
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_crowdfund.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_crowdfund.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPDeploymentFile,
  getCrowdfundDeploymentFile,
  getGovernanceDeploymentFile,
  isLocal,
} from "../config/networks";
import { createNonceManager, rejectAnvilAddresses, loadDeployment, saveDeployment } from "./deploy-utils";

interface CrowdfundDeployment {
  chainId: number;
  deployer: string;
  contracts: {
    armToken: string;
    usdc: string;
    crowdfund: string;
    treasury: string;
    governor: string;
  };
  config: {
    baseSale: string;
    maxSale: string;
    minSale: string;
    armPrice: string;
    armFunded: string;
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

  console.log("=== Deploying Armada Crowdfund ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  // 1. Load governance deployment (required — provides shared ARM token + treasury)
  console.log("1. Loading governance deployment...");
  const govFilename = getGovernanceDeploymentFile();
  const govDeployment = loadDeployment(govFilename);
  if (!govDeployment) {
    throw new Error(
      `Governance deployment not found (${govFilename}). Run deploy_governance first.`
    );
  }
  const armTokenAddress = govDeployment.contracts.armToken;
  const treasuryAddress = govDeployment.contracts.treasury;
  const governorAddress = govDeployment.contracts.governor;
  const revenueLockAddress = govDeployment.contracts.revenueLock;
  const timelockAddress = govDeployment.contracts.timelockController;
  const shieldPauseAddress = govDeployment.contracts.shieldPauseController;
  const revenueCounterAddress = govDeployment.contracts.revenueCounter;
  console.log(`   ARM Token (shared): ${armTokenAddress}`);
  console.log(`   Treasury: ${treasuryAddress}`);
  console.log(`   Governor: ${governorAddress}`);
  console.log(`   RevenueLock: ${revenueLockAddress}`);

  const armToken = await ethers.getContractAt("ArmadaToken", armTokenAddress);

  // 2. Load shared USDC from CCTP deployment
  console.log("2. Loading USDC from CCTP deployment...");
  const cctpFilename = getCCTPDeploymentFile(role);
  const cctpDeployment = loadDeployment(cctpFilename);
  if (!cctpDeployment) {
    throw new Error(`CCTP deployment not found (${cctpFilename}). Run deploy_cctp first.`);
  }
  const usdcAddress: string = cctpDeployment.contracts.usdc;
  console.log(`   USDC (shared): ${usdcAddress}`);

  // 3. Deploy ArmadaCrowdfund (with treasury as immutable destination)
  console.log("3. Deploying ArmadaCrowdfund...");
  const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
  const latestBlock = await ethers.provider.getBlock('latest');
  const openTimestamp = latestBlock!.timestamp + config.crowdfundOpenDelay;
  // Security council: config-driven for non-local, Anvil signer[10] fallback for local
  let securityCouncilAddress: string;
  if (config.securityCouncilAddress) {
    securityCouncilAddress = config.securityCouncilAddress;
  } else if (isLocal()) {
    const signers = await ethers.getSigners();
    securityCouncilAddress = signers[10].address;
  } else {
    throw new Error("SECURITY_COUNCIL_ADDRESS is required for non-local deployments");
  }
  rejectAnvilAddresses([securityCouncilAddress], "Security council");
  if (securityCouncilAddress.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("Security council address must differ from deployer address");
  }
  console.log(`   Launch team: ${deployer.address}`);
  console.log(`   Security council: ${securityCouncilAddress}`);
  const crowdfund = await ArmadaCrowdfund.deploy(
    usdcAddress, armTokenAddress, treasuryAddress, deployer.address, securityCouncilAddress, openTimestamp, nm.override()
  );
  await crowdfund.deploymentTransaction()!.wait();
  const crowdfundAddress = await crowdfund.getAddress();
  console.log(`   ArmadaCrowdfund: ${crowdfundAddress}`);

  // 4. Set transfer whitelist (one-shot — must happen before any ARM transfers)
  // Per ARM token spec §5: crowdfund, treasury, revenueLock.
  // Deployer is included because it needs to distribute ARM in step 5.
  console.log("4. Setting ARM transfer whitelist...");
  await (await armToken.initWhitelist([crowdfundAddress, treasuryAddress, revenueLockAddress, deployer.address], nm.override())).wait();
  console.log(`   initWhitelist: [crowdfund, treasury, revenueLock, deployer]`);

  // 5. Distribute ARM tokens (all distribution deferred from deploy_governance)
  console.log("5. Distributing ARM tokens...");
  const deployerArmBalance = await armToken.balanceOf(deployer.address);
  console.log(`   Deployer ARM balance: ${ethers.formatUnits(deployerArmBalance, 18)}`);

  const treasuryAllocation = ethers.parseUnits(config.armDistribution.treasury, 18);
  const revenueLockAllocation = ethers.parseUnits(config.armDistribution.revenueLock, 18);
  const crowdfundAllocation = ethers.parseUnits(config.armDistribution.crowdfund, 18);
  const totalNeeded = treasuryAllocation + revenueLockAllocation + crowdfundAllocation;
  if (deployerArmBalance < totalNeeded) {
    throw new Error(
      `Insufficient ARM balance. Need ${ethers.formatUnits(totalNeeded, 18)}, ` +
      `have ${ethers.formatUnits(deployerArmBalance, 18)}`
    );
  }
  await (await armToken.transfer(treasuryAddress, treasuryAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.treasury} ARM to treasury`);
  await (await armToken.transfer(revenueLockAddress, revenueLockAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.revenueLock} ARM to RevenueLock`);
  await (await armToken.transfer(crowdfundAddress, crowdfundAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.crowdfund} ARM to crowdfund contract`);

  // 5b. Verify ARM pre-load
  console.log("   Verifying ARM pre-load...");
  await (await crowdfund.loadArm(nm.override())).wait();
  console.log("   ARM pre-load verified (loadArm() succeeded)");

  // 5c. Remove deployer from transfer whitelist (deployer holds 0 ARM after distribution)
  console.log("   Removing deployer from transfer whitelist...");
  await (await armToken.removeDeployerFromWhitelist(nm.override())).wait();
  console.log("   Deployer removed from transfer whitelist");

  // 6. Register crowdfund as excluded from quorum denominator
  console.log("6. Registering crowdfund in governor quorum exclusion...");
  const governor = await ethers.getContractAt("ArmadaGovernor", governorAddress);
  await (await governor.setExcludedAddresses([crowdfundAddress, revenueLockAddress], nm.override())).wait();
  console.log(`   Crowdfund + RevenueLock excluded from quorum denominator`);

  // 7. Authorize delegateOnBehalf callers (one-shot — must include all delegators)
  console.log("7. Authorizing delegateOnBehalf delegators...");
  await (await armToken.initAuthorizedDelegators([revenueLockAddress, crowdfundAddress], nm.override())).wait();
  console.log(`   initAuthorizedDelegators: [${revenueLockAddress}, ${crowdfundAddress}] (RevenueLock + Crowdfund)`);

  // 8. Register crowdfund address for governance quiet period
  console.log("8. Registering crowdfund in governor for quiet period...");
  await (await governor.setCrowdfundAddress(crowdfundAddress, nm.override())).wait();
  console.log(`   Crowdfund registered for 7-day governance quiet period`);

  // 8b. Clear deployer privilege on governor (all deployer-gated one-time setters are done)
  console.log("   Clearing deployer address on governor...");
  await (await governor.clearDeployer(nm.override())).wait();
  console.log("   Governor deployer cleared (no more deployer-gated calls possible)");

  // 9. Deploy ArmadaRedemption (requires crowdfund address)
  console.log("9. Deploying ArmadaRedemption...");
  const ArmadaRedemption = await ethers.getContractFactory("ArmadaRedemption");
  const redemption = await ArmadaRedemption.deploy(
    armTokenAddress, treasuryAddress, revenueLockAddress, crowdfundAddress, nm.override()
  );
  await redemption.deploymentTransaction()!.wait();
  const redemptionAddress = await redemption.getAddress();
  console.log(`   ArmadaRedemption: ${redemptionAddress}`);

  // 10. Deploy ArmadaWindDown (requires redemption address)
  console.log("10. Deploying ArmadaWindDown...");
  const windDownDeadline = Math.floor(new Date(config.windDownDeadline).getTime() / 1000);
  const revenueThreshold = ethers.parseUnits(config.windDownRevenueThreshold, 18);
  const ArmadaWindDown = await ethers.getContractFactory("ArmadaWindDown");
  const windDownContract = await ArmadaWindDown.deploy(
    armTokenAddress, treasuryAddress, governorAddress, redemptionAddress,
    shieldPauseAddress, revenueCounterAddress, timelockAddress,
    revenueThreshold, windDownDeadline, nm.override()
  );
  await windDownContract.deploymentTransaction()!.wait();
  const windDownAddress = await windDownContract.getAddress();
  console.log(`   ArmadaWindDown: ${windDownAddress}`);

  // 11. Wire wind-down to ARM token (deployer-gated one-time setter — direct call)
  console.log("11. Wiring wind-down to ARM token...");
  await (await armToken.setWindDownContract(windDownAddress, nm.override())).wait();
  console.log(`   armToken.setWindDownContract(${windDownAddress})`);

  // 12. Wire wind-down to governor, treasury, and shieldPause via timelock schedule+execute.
  // The deployer still has TIMELOCK_ADMIN_ROLE at this point (renounce is step 14).
  // These are timelock-only calls, so we schedule+execute through the timelock.
  console.log("12. Wiring wind-down to governor/treasury/shieldPause via timelock...");
  const timelock = await ethers.getContractAt("TimelockController", timelockAddress);
  const timelockDelay = await timelock.getMinDelay();

  const governorContract = await ethers.getContractAt("ArmadaGovernor", governorAddress);
  const treasury = await ethers.getContractAt("ArmadaTreasuryGov", treasuryAddress);
  const shieldPause = await ethers.getContractAt("ShieldPauseController", shieldPauseAddress);

  const windDownCalls = [
    { target: governorAddress, calldata: governorContract.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "governor" },
    { target: treasuryAddress, calldata: treasury.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "treasury" },
    { target: shieldPauseAddress, calldata: shieldPause.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "shieldPause" },
  ];

  // Schedule all three calls
  for (const call of windDownCalls) {
    const salt = ethers.id(`winddown-wiring-${call.label}`);
    await (await timelock.schedule(
      call.target, 0, call.calldata, ethers.ZeroHash, salt, timelockDelay, nm.override()
    )).wait();
    console.log(`   Scheduled: ${call.label}.setWindDownContract()`);
  }

  // Wait for timelock delay to pass
  if (timelockDelay > 0n) {
    if (isLocal()) {
      // Fast-forward Anvil past the timelock delay
      const rpcUrl = process.env.HUB_RPC || "http://localhost:8545";
      await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [Number(timelockDelay) + 1] }),
      });
      await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }),
      });
      console.log(`   Fast-forwarded ${timelockDelay}s (Anvil evm_increaseTime)`);
    } else {
      console.log(`   Waiting ${timelockDelay}s for timelock delay...`);
      await new Promise(resolve => setTimeout(resolve, Number(timelockDelay) * 1000 + 5000));
    }
  }

  // Execute all three calls
  for (const call of windDownCalls) {
    const salt = ethers.id(`winddown-wiring-${call.label}`);
    await (await timelock.execute(
      call.target, 0, call.calldata, ethers.ZeroHash, salt, nm.override()
    )).wait();
    console.log(`   Executed: ${call.label}.setWindDownContract()`);
  }

  // 13. Update governance manifest with redemption/windDown addresses
  console.log("13. Updating governance manifest...");
  govDeployment.contracts.redemption = redemptionAddress;
  govDeployment.contracts.windDown = windDownAddress;
  saveDeployment(govFilename, govDeployment);
  console.log(`   Updated ${govFilename} with redemption + windDown addresses`);

  // 14. Renounce timelock admin (final action — all deployment wiring complete)
  console.log("14. Renouncing timelock admin...");
  const ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();
  await (await timelock.renounceRole(ADMIN_ROLE, deployer.address, nm.override())).wait();
  console.log("   Renounced TIMELOCK_ADMIN_ROLE from deployer");

  // Save deployment
  const deployment: CrowdfundDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      armToken: armTokenAddress,
      usdc: usdcAddress,
      crowdfund: crowdfundAddress,
      treasury: treasuryAddress,
      governor: governorAddress,
    },
    config: {
      baseSale: "1200000",
      maxSale: "1800000",
      minSale: "1000000",
      armPrice: "1.00",
      armFunded: config.armDistribution.crowdfund,
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getCrowdfundDeploymentFile();
  saveDeployment(outputFile, deployment);
  console.log(`\nDeployment saved to: deployments/${outputFile}`);

  // Summary
  const deployerRemaining = await armToken.balanceOf(deployer.address);
  console.log("\n=== ARM Distribution Summary ===");
  console.log(`  Treasury:    ${config.armDistribution.treasury} ARM`);
  console.log(`  RevenueLock: ${config.armDistribution.revenueLock} ARM`);
  console.log(`  Crowdfund:   ${config.armDistribution.crowdfund} ARM`);
  console.log(`  Deployer:  ${ethers.formatUnits(deployerRemaining, 18)} ARM (remainder — production allocation TBD)`);
  console.log("\n=== Crowdfund deployment complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
