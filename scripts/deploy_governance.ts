// ABOUTME: Deployment script for Armada governance contracts (timelock, token, treasury, governor, steward, pause).
// ABOUTME: Handles role grants, steward contract registration, and whitelist initialization. Redemption/wind-down deploy in deploy_crowdfund.ts.

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
 * - RevenueLock (immutable, team + airdrop token release)
 * - ShieldPauseController
 * - ArmadaRedemption
 * - ArmadaWindDown
 *
 * Post-deploy configuration:
 * - ARM token: initNoDelegation, initWhitelist, initAuthorizedDelegators, setWindDownContract
 * - Treasury: initOutflowConfig, setWindDownContract
 * - Governor: setWindDownContract
 * - ShieldPauseController: setWindDownContract
 * - Timelock: grant roles to governor, renounce admin
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_governance.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_governance.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getChainRole,
  getGovernanceDeploymentFile,
} from "../config/networks";
import { createNonceManager, rejectAnvilAddresses, saveDeployment } from "./deploy-utils";

interface GovernanceDeployment {
  chainId: number;
  deployer: string;
  deployBlock: number;
  contracts: {
    timelockController: string;
    armToken: string;
    treasury: string;
    governor: string;
    governorImpl: string;
    steward: string;
    adapterRegistry: string;
    revenueCounter: string;
    revenueCounterImpl: string;
    revenueLock: string;
    shieldPauseController: string;
    redemption: string;
    windDown: string;
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
    timelockAddress, nm.override()
  );
  await treasury.deploymentTransaction()!.wait();
  const treasuryAddress = await treasury.getAddress();
  console.log(`   ArmadaTreasuryGov: ${treasuryAddress}`);

  // 4. Deploy ArmadaGovernor (UUPS proxy)
  console.log("4. Deploying ArmadaGovernor (UUPS proxy)...");
  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const governorImpl = await ArmadaGovernor.deploy(nm.override());
  await governorImpl.deploymentTransaction()!.wait();
  const governorImplAddress = await governorImpl.getAddress();
  console.log(`   ArmadaGovernor (impl): ${governorImplAddress}`);

  const governorInitData = ArmadaGovernor.interface.encodeFunctionData("initialize", [
    armTokenAddress, timelockAddress, treasuryAddress,
  ]);
  const GovernorProxy = await ethers.getContractFactory("ERC1967Proxy");
  const governorProxy = await GovernorProxy.deploy(
    governorImplAddress, governorInitData, nm.override()
  );
  await governorProxy.deploymentTransaction()!.wait();
  const governorAddress = await governorProxy.getAddress();
  const governor = ArmadaGovernor.attach(governorAddress) as typeof governorImpl;
  console.log(`   ArmadaGovernor (proxy): ${governorAddress}`);

  // Extended selectors are hardcoded in initialize() — no deployment step needed.

  // 5. Deploy TreasurySteward (identity management only — proposals flow through governor)
  console.log("5. Deploying TreasurySteward...");
  const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
  const steward = await TreasurySteward.deploy(
    timelockAddress, nm.override()
  );
  await steward.deploymentTransaction()!.wait();
  const stewardAddress = await steward.getAddress();
  console.log(`   TreasurySteward: ${stewardAddress}`);

  // 5b. Register steward contract on governor (one-time setter)
  await (await governor.setStewardContract(stewardAddress, nm.override())).wait();
  console.log(`   Governor: setStewardContract(${stewardAddress})`);

  // 5c. Deploy AdapterRegistry (standalone, owned by timelock)
  console.log("   Deploying AdapterRegistry...");
  const AdapterRegistry = await ethers.getContractFactory("AdapterRegistry");
  const adapterRegistry = await AdapterRegistry.deploy(timelockAddress, nm.override());
  await adapterRegistry.deploymentTransaction()!.wait();
  const adapterRegistryAddress = await adapterRegistry.getAddress();
  console.log(`   AdapterRegistry: ${adapterRegistryAddress}`);

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

  // 7. Deploy RevenueLock (immutable — holds team + airdrop ARM)
  console.log("7. Deploying RevenueLock...");
  const revenueLockAllocation = ethers.parseUnits(config.armDistribution.revenueLock, 18);

  // TODO: Set REVENUE_LOCK_BENEFICIARIES_JSON with finalized mainnet list (see issue #144)
  // Beneficiaries come from network config (Anvil placeholders for local, env var for non-local)
  const beneficiaryConfig = config.revenueLockBeneficiaries;
  const revenueLockBeneficiaries = beneficiaryConfig.map(b => b.address);
  const revenueLockAmounts = beneficiaryConfig.map(b => ethers.parseUnits(b.amount, 18));

  // Guard: reject Anvil default addresses on non-local environments
  rejectAnvilAddresses(revenueLockBeneficiaries, "RevenueLock beneficiaries");
  if (config.treasuryAddress) {
    rejectAnvilAddresses([config.treasuryAddress], "Treasury address");
  }

  for (const b of beneficiaryConfig) {
    console.log(`   Beneficiary: ${b.address} — ${b.amount} ARM (${b.label})`);
  }

  const RevenueLock = await ethers.getContractFactory("RevenueLock");
  const revenueLockContract = await RevenueLock.deploy(
    armTokenAddress, revenueCounterAddress,
    revenueLockBeneficiaries, revenueLockAmounts, nm.override()
  );
  await revenueLockContract.deploymentTransaction()!.wait();
  const revenueLockAddress = await revenueLockContract.getAddress();
  console.log(`   RevenueLock: ${revenueLockAddress}`);

  // Post-deploy read-back verification: confirm on-chain state matches intent
  console.log("   Verifying RevenueLock beneficiary allocations...");
  for (let i = 0; i < beneficiaryConfig.length; i++) {
    const expectedAddr = beneficiaryConfig[i].address;
    const expectedAmount = ethers.parseUnits(beneficiaryConfig[i].amount, 18);
    const onChainAllocation = await revenueLockContract.allocation(expectedAddr);
    if (onChainAllocation !== expectedAmount) {
      throw new Error(
        `RevenueLock read-back MISMATCH for ${expectedAddr} (${beneficiaryConfig[i].label}):\n` +
        `  Expected: ${ethers.formatUnits(expectedAmount, 18)} ARM\n` +
        `  On-chain: ${ethers.formatUnits(onChainAllocation, 18)} ARM\n` +
        `  ABORTING — the deployed RevenueLock state does not match the intended config.`
      );
    }
  }
  const onChainTotal = await revenueLockContract.totalAllocation();
  const expectedTotal = revenueLockAmounts.reduce((sum, a) => sum + a, 0n);
  if (onChainTotal !== expectedTotal) {
    throw new Error(
      `RevenueLock total allocation MISMATCH:\n` +
      `  Expected: ${ethers.formatUnits(expectedTotal, 18)} ARM\n` +
      `  On-chain: ${ethers.formatUnits(onChainTotal, 18)} ARM\n` +
      `  ABORTING — possible extra beneficiaries or amount corruption.`
    );
  }
  console.log(`   ✓ All ${beneficiaryConfig.length} beneficiaries verified, total: ${ethers.formatUnits(onChainTotal, 18)} ARM`);

  // 8. Deploy ShieldPauseController
  console.log("8. Deploying ShieldPauseController...");
  const ShieldPauseController = await ethers.getContractFactory("ShieldPauseController");
  const shieldPause = await ShieldPauseController.deploy(
    governorAddress, timelockAddress, nm.override()
  );
  await shieldPause.deploymentTransaction()!.wait();
  const shieldPauseAddress = await shieldPause.getAddress();
  console.log(`   ShieldPauseController: ${shieldPauseAddress}`);

  // 9-10. ArmadaRedemption + ArmadaWindDown
  // Deferred to deploy_crowdfund.ts — these contracts require the crowdfund address,
  // which is not available until after crowdfund deployment.
  const redemptionAddress = ethers.ZeroAddress;
  const windDownAddress = ethers.ZeroAddress;
  console.log("9-10. ArmadaRedemption + ArmadaWindDown: DEFERRED (deployed by deploy_crowdfund.ts)");

  // ============ Post-deploy configuration ============

  // 11. Configure timelock roles
  console.log("11. Configuring timelock roles...");
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

  // 12. Configure ARM token (one-time setters)
  console.log("12. Configuring ARM token...");
  await (await armToken.initNoDelegation([treasuryAddress], nm.override())).wait();
  console.log(`   initNoDelegation: [${treasuryAddress}] (treasury)`);

  // initWhitelist is one-shot and must include the crowdfund address (per ARM token spec §5).
  // Deferred to deploy_crowdfund.ts which runs after governance and has the crowdfund address.
  console.log("   initWhitelist: DEFERRED (called by deploy_crowdfund with crowdfund address)");

  // initAuthorizedDelegators is one-shot and must include all delegators (RevenueLock + Crowdfund).
  // Deferred to deploy_crowdfund.ts which runs after governance and has both addresses available.
  console.log("   initAuthorizedDelegators: DEFERRED (called by deploy_crowdfund with all delegators)");

  // setWindDownContract: deferred to deploy_crowdfund.ts (wind-down deployed there)
  console.log("   setWindDownContract: DEFERRED (deployed by deploy_crowdfund.ts)");

  // 13. ARM distribution
  // All ARM transfers are deferred to deploy_crowdfund.ts which calls initWhitelist first.
  // The whitelist must be set before any transfer (including to treasury/revenueLock).
  console.log("13. ARM distribution: DEFERRED (called by deploy_crowdfund after initWhitelist)");

  // 14. Initialize treasury outflow limits
  // TODO: These defaults should be moved to config/networks.ts when finalized
  console.log("14. Initializing treasury outflow limits...");
  // Outflow limits are configured per-token via governance after deployment.
  // The deployer (as initial owner/timelock admin) cannot call initOutflowConfig directly
  // because the treasury's owner is the timelock. Outflow config will be set via the
  // first governance proposal after ARM delegation and governance activation.
  console.log("   Outflow limits will be configured via governance proposal post-launch");

  // 15-16. Wind-down wiring + timelock admin renounce
  // Both deferred to deploy_crowdfund.ts. The deployer retains timelock admin until
  // all deployment wiring is complete (Redemption, WindDown, wind-down wiring),
  // then renounces as the final action in deploy_crowdfund.ts.
  console.log("15-16. Wind-down wiring + admin renounce: DEFERRED (completed by deploy_crowdfund.ts)");

  // Save deployment
  const currentBlock = await ethers.provider.getBlockNumber();
  const deployment: GovernanceDeployment = {
    chainId,
    deployer: deployer.address,
    deployBlock: currentBlock,
    contracts: {
      timelockController: timelockAddress,
      armToken: armTokenAddress,
      treasury: treasuryAddress,
      governor: governorAddress,
      governorImpl: governorImplAddress,
      steward: stewardAddress,
      adapterRegistry: adapterRegistryAddress,
      revenueCounter: revenueCounterAddress,
      revenueCounterImpl: revenueCounterImplAddress,
      revenueLock: revenueLockAddress,
      shieldPauseController: shieldPauseAddress,
      redemption: redemptionAddress,
      windDown: windDownAddress,
    },
    config: {
      timelockMinDelay: timelockDelay,
      totalSupply: "1000",
      treasuryAllocation: config.armDistribution.treasury,
    },
    timestamp: new Date().toISOString(),
  };

  const outputFile = getGovernanceDeploymentFile();
  saveDeployment(outputFile, deployment);
  console.log(`\nDeployment saved to: deployments/${outputFile}`);
  console.log("\n=== Governance deployment complete ===");
  console.log("\nPost-launch TODO:");
  console.log("  1. Configure treasury outflow limits for USDC and ARM (via governance proposal)");
  console.log("  2. Set shieldPauseContract on PrivacyPool (owner calls setShieldPauseContract)");
  console.log("\nNext deployment step: run deploy_crowdfund.ts to complete:")
  console.log("  - Crowdfund deployment + ARM distribution");
  console.log("  - ArmadaRedemption + ArmadaWindDown deployment");
  console.log("  - Wind-down wiring to governor/treasury/shieldPause");
  console.log("  - Timelock admin renounce (final action)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
