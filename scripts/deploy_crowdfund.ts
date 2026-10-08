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
import { createNonceManager, crowdfundHandoffNonce, rejectAnvilAddresses, loadDeployment, saveDeployment, saveDeploymentInProgress, assertDeploymentComplete, timelockCall, retryReadOnLag, resolveCrowdfundOpenTimestamp } from "./deploy-utils";
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME_BYTECODE } from "./multicall3-bytecode";

import { ensureRevenueLockActivated, assertAllocatorDistinct, assertLaunchRoleMultisigs, assertRevenueLockAllocation, assertRevenueLockSchedule, assertReservePreFunding, assertCreationProvenance, validateReservePlan } from "./revenue-reserve";
import { assertInitialStewardPreflight, assertUsdcDecimals, seedInitialSteward, stewardBudgetLimit } from "./initial-steward";

interface CrowdfundDeployment {
  chainId: number;
  deployer: string;
  deployBlock: number;
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

  // Fresh Anvil has no Multicall3; the crowdfund UIs batch their contract reads
  // through aggregate3 at the canonical address. Etch the runtime bytecode there
  // (local only — Sepolia/mainnet already have it). Idempotent: skips if present.
  if (isLocal()) {
    const existing = await ethers.provider.getCode(MULTICALL3_ADDRESS);
    if (existing === "0x") {
      await ethers.provider.send("anvil_setCode", [MULTICALL3_ADDRESS, MULTICALL3_RUNTIME_BYTECODE]);
      console.log(`Etched Multicall3 at ${MULTICALL3_ADDRESS}`);
      console.log("");
    }
  }

  // 1. Load governance deployment (required — provides shared ARM token + treasury)
  console.log("1. Loading governance deployment...");
  const govFilename = getGovernanceDeploymentFile();
  const govDeployment = loadDeployment(govFilename);
  if (!govDeployment) {
    throw new Error(
      `Governance deployment not found (${govFilename}). Run deploy_governance first.`
    );
  }
  // A governance stage that stopped part-way is an interrupted launch, not a base to build on.
  assertDeploymentComplete(govDeployment, govFilename);
  // This stage starts seconds after governance's last transaction, when a lagging RPC node can
  // still report an already-used nonce. A hardened run starts from the nonce governance recorded.
  const nm = await createNonceManager(deployer,
    crowdfundHandoffNonce(govDeployment, config.hardenTimelock, isLocal()));
  const armTokenAddress = govDeployment.contracts.armToken;
  const treasuryAddress = govDeployment.contracts.treasury;
  const governorAddress = govDeployment.contracts.governor;
  const revenueLockAddress = govDeployment.contracts.revenueLock;
  const reserveAddress: string | undefined = govDeployment.contracts.revenueReserveDistributor;
  if (Boolean(reserveAddress) !== Boolean(config.revenueReserve)) {
    throw new Error("Reserve config and governance manifest disagree; refusing to fund RevenueLock");
  }
  const reserveCap = validateReservePlan(config.revenueLockBeneficiaries,
    ethers.parseUnits(config.armDistribution.revenueLock, 18), config.revenueReserve);
  const revenueLockAllocation = ethers.parseUnits(config.armDistribution.revenueLock, 18);
  if (!govDeployment.revenueLockConstructorArgs) throw new Error("RevenueLock constructor provenance missing");
  // The orchestrator runs this stage seconds after governance, so these reads may reach
  // an RPC node that has not yet seen the governance transactions.
  await retryReadOnLag("RevenueLock schedule and provenance", async () => {
    // Governance and crowdfund may run days apart with different environment files.
    // Reject funding drift before consuming any crowdfund-stage one-shot initializers.
    await assertRevenueLockAllocation(revenueLockAddress, revenueLockAllocation);
    await assertRevenueLockSchedule(revenueLockAddress, config.revenueLockBeneficiaries,
      reserveAddress ? { address: reserveAddress, cap: reserveCap } : undefined);
    // Authenticate both custody contracts against the creation transactions before
    // consuming one-shot initializers or transferring any ARM.
    await assertCreationProvenance("RevenueLock", revenueLockAddress,
      govDeployment.revenueLockDeploymentTransaction, govDeployment.revenueLockConstructorArgs, govDeployment.deployer);
    if (reserveAddress && config.revenueReserve) {
      await assertCreationProvenance("RevenueReserveDistributor", reserveAddress,
        govDeployment.revenueReserveDistributorDeploymentTransaction,
        [armTokenAddress, config.revenueReserve.allocator, reserveCap], govDeployment.deployer);
    }
  });
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
  // The open time is an operational buffer (deployment verification,
  // announcement lead time, infra readiness) — NOT a seed-setup window.
  // Seeds are added during the launch-team window (the full commitment window); see
  // ArmadaCrowdfund._requireArmLoadedAndPreInviteEnd.
  // Absolute CROWDFUND_OPEN_TIME when set (required on mainnet), else latest block +
  // crowdfundOpenDelay. Zero lead here: the mainnet orchestrator already enforced the
  // minimum lead before any transaction, and this step runs after governance.
  const openTimestamp = resolveCrowdfundOpenTimestamp(
    config.crowdfundOpenTime, config.crowdfundOpenDelay, latestBlock!.timestamp, 0
  );
  console.log(`   Open time: ${openTimestamp} (${new Date(openTimestamp * 1000).toISOString()})`);
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
  // Launch team: config-driven for non-local (a separate key limits deployer
  // exposure during the crowdfund window — see issue #218), deployer fallback
  // for local. When explicitly configured it must differ from the deployer.
  let launchTeamAddress: string;
  if (config.launchTeamAddress) {
    launchTeamAddress = config.launchTeamAddress;
    rejectAnvilAddresses([launchTeamAddress], "Launch team");
    if (launchTeamAddress.toLowerCase() === deployer.address.toLowerCase()) {
      throw new Error("Launch team address must differ from deployer address");
    }
  } else if (isLocal()) {
    launchTeamAddress = deployer.address;
  } else {
    throw new Error("LAUNCH_TEAM_ADDRESS is required for non-local deployments");
  }
  console.log(`   Launch team: ${launchTeamAddress}`);
  console.log(`   Security council: ${securityCouncilAddress}`);
  // This stage may run days after governance with a different env file: re-check before the
  // crowdfund fixes both addresses (mainnet only; Sepolia uses single-key roles).
  if (config.env === "mainnet") {
    await assertLaunchRoleMultisigs(securityCouncilAddress, launchTeamAddress);
  }
  // Reserve allocator (#582): the distributor fixed it in the governance stage; re-check it
  // against the security council and launch team this stage fixes in the crowdfund.
  if (config.revenueReserve) {
    assertAllocatorDistinct(config.revenueReserve.allocator, [
      { label: "deployer", address: deployer.address },
      { label: "security council", address: securityCouncilAddress },
      { label: "launch team", address: launchTeamAddress },
    ]);
  }
  // Initial steward (#221, #222): this stage may run days after governance with a different
  // env file, so re-check the steward against every launch role before its first transaction,
  // and confirm the hub USDC uses the decimals the whole-USD budget is scaled by.
  if (config.initialSteward) {
    await assertInitialStewardPreflight(config.initialSteward, [
      { label: "deployer", address: deployer.address },
      { label: "security council", address: securityCouncilAddress },
      { label: "launch team", address: launchTeamAddress },
      { label: "reserve allocator", address: config.revenueReserve?.allocator ?? "" },
      { label: "treasury", address: treasuryAddress },
      { label: "timelock", address: timelockAddress },
      { label: "governor", address: governorAddress },
    ], !isLocal());
    await assertUsdcDecimals(usdcAddress);
    console.log(`   Initial steward: ${config.initialSteward.address} (pre-flight passed)`);
  }
  const crowdfund = await ArmadaCrowdfund.deploy(
    usdcAddress, armTokenAddress, treasuryAddress, launchTeamAddress, securityCouncilAddress, openTimestamp, nm.override()
  );
  const crowdfundReceipt = await crowdfund.deploymentTransaction()!.wait();
  // Record the contract-creation block (not an end-of-script block number). The
  // indexer and frontends backfill events from this block; capturing it here —
  // before the multi-minute post-deploy wiring runs — ensures early events like
  // ArmLoaded are not skipped (issue #324).
  const crowdfundDeployBlock = crowdfundReceipt!.blockNumber;
  const crowdfundAddress = await crowdfund.getAddress();
  console.log(`   ArmadaCrowdfund: ${crowdfundAddress} (block ${crowdfundDeployBlock})`);

  // Record the crowdfund address now, marked in progress, so a run that stops during the
  // wiring below still leaves it on disk. The complete manifest replaces it at the end.
  const outputFile = getCrowdfundDeploymentFile();
  const deployment: CrowdfundDeployment = {
    chainId,
    deployer: deployer.address,
    deployBlock: crowdfundDeployBlock,
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
  saveDeploymentInProgress(outputFile, deployment);

  // 4. Set transfer whitelist (one-shot — must happen before any ARM transfers)
  // Per ARM token spec §5: crowdfund, treasury, revenueLock.
  // Deployer is included because it needs to distribute ARM in step 12.
  console.log("4. Setting ARM transfer whitelist...");
  await (await armToken.initWhitelist([crowdfundAddress, treasuryAddress, revenueLockAddress, deployer.address, ...(reserveAddress ? [reserveAddress] : [])], nm.override())).wait();
  console.log(`   initWhitelist: [crowdfund, treasury, revenueLock, deployer${reserveAddress ? ", reserve" : ""}]`);

  // 5. Register crowdfund as excluded from quorum denominator
  console.log("5. Registering crowdfund in governor quorum exclusion...");
  const governor = await ethers.getContractAt("ArmadaGovernor", governorAddress);
  await (await governor.setExcludedAddresses([crowdfundAddress, revenueLockAddress, ...(reserveAddress ? [reserveAddress] : [])], nm.override())).wait();
  console.log(`   Crowdfund + RevenueLock${reserveAddress ? " + reserve" : ""} excluded from quorum denominator`);

  // 6. Authorize delegateOnBehalf callers (one-shot — must include all delegators)
  console.log("6. Authorizing delegateOnBehalf delegators...");
  await (await armToken.initAuthorizedDelegators([revenueLockAddress, crowdfundAddress], nm.override())).wait();
  console.log(`   initAuthorizedDelegators: [${revenueLockAddress}, ${crowdfundAddress}] (RevenueLock + Crowdfund)`);

  // 7. Register crowdfund address for governance quiet period
  console.log("7. Registering crowdfund in governor for quiet period...");
  await (await governor.setCrowdfundAddress(crowdfundAddress, nm.override())).wait();
  console.log(`   Crowdfund registered for 10-day governance quiet period`);

  // 7a. Bootstrap the governor's Security Council. Without this, the SC slot stays
  // address(0) at launch — vetoes revert
  // until a passed governance proposal sets it. Governance can replace or eject the
  // SC later via timelock; this only sets the initial value.
  console.log("   Bootstrapping governor security council...");
  await (await governor.setSecurityCouncil(securityCouncilAddress, nm.override())).wait();
  console.log(`   Governor security council set to ${securityCouncilAddress}`);

  // 7b. Clear deployer privilege on governor (all deployer-gated one-time setters are done)
  console.log("   Clearing deployer address on governor...");
  await (await governor.clearDeployer(nm.override())).wait();
  console.log("   Governor deployer cleared (no more deployer-gated calls possible)");

  // 8. Deploy ArmadaRedemption (requires crowdfund address)
  console.log("8. Deploying ArmadaRedemption...");
  const ArmadaRedemption = await ethers.getContractFactory("ArmadaRedemption");
  const redemption = await ArmadaRedemption.deploy(
    armTokenAddress, treasuryAddress, revenueLockAddress, crowdfundAddress, nm.override()
  );
  await redemption.deploymentTransaction()!.wait();
  const redemptionAddress = await redemption.getAddress();
  govDeployment.contracts.redemption = redemptionAddress;
  saveDeployment(govFilename, govDeployment);
  console.log(`   ArmadaRedemption: ${redemptionAddress}`);

  // 9. Deploy ArmadaWindDown (requires redemption address)
  console.log("9. Deploying ArmadaWindDown...");
  const windDownDeadline = Math.floor(new Date(config.windDownDeadline).getTime() / 1000);
  const revenueThreshold = ethers.parseUnits(config.windDownRevenueThreshold, 18);
  const ArmadaWindDown = await ethers.getContractFactory("ArmadaWindDown");
  const windDownContract = await ArmadaWindDown.deploy(
    armTokenAddress, treasuryAddress, governorAddress, redemptionAddress,
    shieldPauseAddress, revenueCounterAddress, revenueLockAddress, timelockAddress,
    revenueThreshold, windDownDeadline, nm.override()
  );
  await windDownContract.deploymentTransaction()!.wait();
  const windDownAddress = await windDownContract.getAddress();
  govDeployment.contracts.windDown = windDownAddress;
  saveDeployment(govFilename, govDeployment);
  console.log(`   ArmadaWindDown: ${windDownAddress}`);

  // 10. Wire wind-down to ARM token (deployer-gated one-time setter — direct call)
  console.log("10. Wiring wind-down to ARM token...");
  await (await armToken.setWindDownContract(windDownAddress, nm.override())).wait();
  console.log(`   armToken.setWindDownContract(${windDownAddress})`);

  // 10b. Wire wind-down to redemption (deployer-gated one-time setter). Redemption
  // reads triggerTime from windDown to enforce the REDEMPTION_DELAY (issue #254).
  console.log("10b. Wiring wind-down to redemption...");
  await (await redemption.setWindDown(windDownAddress, nm.override())).wait();
  console.log(`   redemption.setWindDown(${windDownAddress})`);

  // 10c. Wire wind-down to RevenueLock — deployer-gated one-shot setter, so a direct
  // deployer call. RevenueCounter's setter is now owner-gated (owner == timelock) and
  // is wired via the timelock in step 11 alongside the other timelock-owned contracts.
  console.log("10c. Wiring wind-down to RevenueLock...");
  const revenueLockContract = await ethers.getContractAt("RevenueLock", revenueLockAddress);
  await (await revenueLockContract.setWindDownContract(windDownAddress, nm.override())).wait();
  console.log(`   revenueLock.setWindDownContract(${windDownAddress})`);

  // 11. Wire wind-down to the timelock-owned contracts (governor, treasury, shieldPause,
  // revenueCounter) via the timelock. On local: Anvil impersonation. On non-local: real
  // schedule + execute (instant under the harden profile's minDelay-0 bootstrap).
  console.log("11. Wiring wind-down to governor/treasury/shieldPause/revenueCounter (timelock-only)...");

  const governorContract = await ethers.getContractAt("ArmadaGovernor", governorAddress);
  const treasury = await ethers.getContractAt("ArmadaTreasuryGov", treasuryAddress);
  const shieldPause = await ethers.getContractAt("ShieldPauseController", shieldPauseAddress);
  const revenueCounterContract = await ethers.getContractAt("RevenueCounter", revenueCounterAddress);

  const windDownCalls = [
    { target: governorAddress, calldata: governorContract.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "governor" },
    { target: treasuryAddress, calldata: treasury.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "treasury" },
    { target: shieldPauseAddress, calldata: shieldPause.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "shieldPause" },
    { target: revenueCounterAddress, calldata: revenueCounterContract.interface.encodeFunctionData("setWindDownContract", [windDownAddress]), label: "revenueCounter" },
  ];

  for (const call of windDownCalls) {
    await timelockCall(timelockAddress, call.target, call.calldata, `${call.label}.setWindDownContract()`, nm);
  }

  // 11a. Verify-after-bind (defense-in-depth). The windDown setters on RevenueLock
  // (immutable) and RevenueCounter (one-shot) are now caller-gated, so a front-run is
  // prevented — this read-back catches a wiring bug (wrong address). A mismatch cannot be
  // repaired in place (one-shot), so abort the deploy.
  const rlBoundWindDown = await revenueLockContract.windDownContract();
  const rcBoundWindDown = await revenueCounterContract.windDownContract();
  if (rlBoundWindDown.toLowerCase() !== windDownAddress.toLowerCase()) {
    throw new Error(`RevenueLock.windDownContract mis-bound: ${rlBoundWindDown} != expected ${windDownAddress}`);
  }
  if (rcBoundWindDown.toLowerCase() !== windDownAddress.toLowerCase()) {
    throw new Error(`RevenueCounter.windDownContract mis-bound: ${rcBoundWindDown} != expected ${windDownAddress}`);
  }
  console.log("   Verified windDown binding on RevenueLock + RevenueCounter");

  // 12. Distribute ARM tokens. Fund only after binding, token permissions, quorum
  // exclusions and wind-down wiring are complete.
  console.log("12. Distributing ARM tokens after integration setup...");
  const deployerArmBalance = await armToken.balanceOf(deployer.address);
  console.log(`   Deployer ARM balance: ${ethers.formatUnits(deployerArmBalance, 18)}`);

  const treasuryAllocation = ethers.parseUnits(config.armDistribution.treasury, 18);
  const crowdfundAllocation = ethers.parseUnits(config.armDistribution.crowdfund, 18);
  const totalNeeded = treasuryAllocation + revenueLockAllocation + crowdfundAllocation;
  if (deployerArmBalance < totalNeeded) {
    throw new Error(
      `Insufficient ARM balance. Need ${ethers.formatUnits(totalNeeded, 18)}, ` +
      `have ${ethers.formatUnits(deployerArmBalance, 18)}`
    );
  }
  // Run every gate before the first ARM transfer, including the treasury transfer.
  // A rejected launch must leave the full ARM supply in the deployer's wallet.
  // The gate reads wiring written moments ago, so tolerate a lagging RPC node.
  await retryReadOnLag("Pre-funding gate", async () => {
    if (reserveAddress && config.revenueReserve) {
      await assertReservePreFunding({
        distributorAddress: reserveAddress, allocator: config.revenueReserve.allocator,
        reserveCap, revenueLockAllocation, armTokenAddress, revenueLockAddress, governorAddress, windDownAddress,
        directBeneficiaries: config.revenueLockBeneficiaries,
      });
    } else {
      await assertRevenueLockAllocation(revenueLockAddress, revenueLockAllocation);
      await assertRevenueLockSchedule(revenueLockAddress, config.revenueLockBeneficiaries);
    }
  });
  await (await armToken.transfer(treasuryAddress, treasuryAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.treasury} ARM to treasury`);
  await (await armToken.transfer(revenueLockAddress, revenueLockAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.revenueLock} ARM to RevenueLock`);
  await (await armToken.transfer(crowdfundAddress, crowdfundAllocation, nm.override())).wait();
  console.log(`   Sent ${config.armDistribution.crowdfund} ARM to crowdfund contract`);

  // 12b. Verify ARM pre-load
  console.log("   Verifying ARM pre-load...");
  await (await crowdfund.loadArm(nm.override())).wait();
  console.log("   ARM pre-load verified (loadArm() succeeded)");

  // 12c. Remove deployer from transfer whitelist (deployer holds 0 ARM after distribution)
  console.log("   Removing deployer from transfer whitelist...");
  await (await armToken.removeDeployerFromWhitelist(nm.override())).wait();
  console.log("   Deployer removed from transfer whitelist");

  // 12d. Post-distribution verification gates (issue #228, ARM_TOKEN.md §3).
  // The protocol is NOT considered live until all four conditions hold on-chain.
  // Any failure here halts deployment — a partial deployment is safer than a
  // misconfigured one.
  console.log("   Verifying post-distribution invariants...");

  const treasuryBal = await armToken.balanceOf(treasuryAddress);
  const revenueLockBal = await armToken.balanceOf(revenueLockAddress);
  const crowdfundBal = await armToken.balanceOf(crowdfundAddress);
  const deployerBal = await armToken.balanceOf(deployer.address);
  const totalSupply = await armToken.totalSupply();

  // Gate 1: Exact recipient balances
  if (treasuryBal !== treasuryAllocation) {
    throw new Error(
      `Gate 1 failed — Treasury balance mismatch. Expected ${ethers.formatUnits(treasuryAllocation, 18)}, got ${ethers.formatUnits(treasuryBal, 18)}`
    );
  }
  if (revenueLockBal !== revenueLockAllocation) {
    throw new Error(
      `Gate 1 failed — RevenueLock balance mismatch. Expected ${ethers.formatUnits(revenueLockAllocation, 18)}, got ${ethers.formatUnits(revenueLockBal, 18)}`
    );
  }
  if (crowdfundBal !== crowdfundAllocation) {
    throw new Error(
      `Gate 1 failed — Crowdfund balance mismatch. Expected ${ethers.formatUnits(crowdfundAllocation, 18)}, got ${ethers.formatUnits(crowdfundBal, 18)}`
    );
  }

  // Gate 2: Supply conservation
  const expectedTotalSupply = ethers.parseUnits("12000000", 18);
  if (totalSupply !== expectedTotalSupply) {
    throw new Error(
      `Gate 2 failed — totalSupply mismatch. Expected ${ethers.formatUnits(expectedTotalSupply, 18)}, got ${ethers.formatUnits(totalSupply, 18)}`
    );
  }
  const recipientSum = treasuryBal + revenueLockBal + crowdfundBal;
  if (recipientSum !== totalSupply) {
    throw new Error(
      `Gate 2 failed — sum of recipient balances (${ethers.formatUnits(recipientSum, 18)}) does not equal totalSupply (${ethers.formatUnits(totalSupply, 18)})`
    );
  }

  // Gate 3: Zero residual bootstrap-holder balance
  if (deployerBal !== 0n) {
    throw new Error(
      `Gate 3 failed — deployer ARM balance is non-zero: ${ethers.formatUnits(deployerBal, 18)}`
    );
  }

  // Gate 4: No residual bootstrap-holder allowances to any protocol contract.
  // The deployment script uses transfer() (not transferFrom), so no allowances are
  // ever granted; this check is defense-in-depth against future script changes.
  const allowanceTargets = [
    { address: treasuryAddress, label: "treasury" },
    { address: revenueLockAddress, label: "revenueLock" },
    { address: crowdfundAddress, label: "crowdfund" },
  ];
  for (const target of allowanceTargets) {
    const allowance = await armToken.allowance(deployer.address, target.address);
    if (allowance !== 0n) {
      throw new Error(
        `Gate 4 failed — non-zero deployer allowance to ${target.label} (${target.address}): ${ethers.formatUnits(allowance, 18)}`
      );
    }
  }

  console.log("   Gate 1 passed: recipient balances match allocations");
  console.log("   Gate 2 passed: totalSupply == 12M and equals sum of recipient balances");
  console.log("   Gate 3 passed: deployer ARM balance is zero");
  console.log("   Gate 4 passed: no residual deployer allowances to protocol contracts");

  // 12e. Activate RevenueLock — required before any beneficiary can call release().
  // Permissionless one-shot: another caller may activate after funding. Tolerate
  // that race so treasury limits and timelock hardening below still finish.
  console.log("   Activating RevenueLock...");
  const revenueLock = await ethers.getContractAt("RevenueLock", revenueLockAddress);
  await ensureRevenueLockActivated(revenueLock, nm);
  console.log(`   RevenueLock activated`);

  // 13. Redemption circulating-supply invariant (deploy-time misconfiguration guard).
  // ArmadaRedemption.circulatingSupply() subtracts revenueLock.lockedAtWindDown() and the
  // crowdfund unsold-in-contract from circulatingSupplyOf([treasury, redemption]) — both
  // UNCLAMPED against the running total (only the inner cfBalance-cfStillOwed is clamped).
  // If the excluded/locked terms ever exceed the base, every redeem() reverts permanently
  // and the redemption contract has no admin. This asserts correct parameterization at
  // go-live (security review). It is boundary-exact at deploy (circulating is legitimately
  // ~0), so compare with <=. A runtime clamp is deferred to a future contract revision.
  console.log("13. Asserting redemption circulating-supply invariant...");
  const revenueLockView = await ethers.getContractAt("RevenueLock", revenueLockAddress);
  const circBase = await armToken.circulatingSupplyOf([treasuryAddress, redemptionAddress]);
  const lockedAtWindDown = await revenueLockView.lockedAtWindDown();
  const cfBalance = await armToken.balanceOf(crowdfundAddress);
  const cfStillOwed = await crowdfund.armStillOwed();
  const cfUnsold = cfStillOwed >= cfBalance ? 0n : cfBalance - cfStillOwed;
  const excludedSum = lockedAtWindDown + cfUnsold;
  if (excludedSum > circBase) {
    throw new Error(
      `Redemption invariant FAILED — excluded terms exceed circulating base:\n` +
      `  lockedAtWindDown (${ethers.formatUnits(lockedAtWindDown, 18)}) + cfUnsold (${ethers.formatUnits(cfUnsold, 18)}) ` +
      `= ${ethers.formatUnits(excludedSum, 18)}\n` +
      `  > circulatingSupplyOf([treasury, redemption]) = ${ethers.formatUnits(circBase, 18)}\n` +
      `  ArmadaRedemption.circulatingSupply() would underflow and permanently brick redemptions.\n` +
      `  Check the ARM distribution / RevenueLock allocation parameters.`
    );
  }
  console.log(`   OK: locked+cfUnsold ${ethers.formatUnits(excludedSum, 18)} <= circulating base ${ethers.formatUnits(circBase, 18)}`);

  // 14. Initialize treasury outflow rate limits (timelock-only). Done at deploy so
  // the treasury is rate-limited from launch rather than via a fragile first
  // governance vote. Values come from config.outflowConfig (see issue #348).
  console.log("14. Initializing treasury outflow limits...");
  const outflowTokens = [
    { token: usdcAddress, params: config.outflowConfig.usdc, label: "USDC" },
    { token: armTokenAddress, params: config.outflowConfig.arm, label: "ARM" },
    { token: ethers.ZeroAddress, params: config.outflowConfig.eth, label: "ETH" },
  ];
  for (const t of outflowTokens) {
    const calldata = treasury.interface.encodeFunctionData("initOutflowConfig", [
      t.token, t.params.windowDuration, t.params.limitBps, t.params.limitAbsolute, t.params.floorAbsolute,
    ]);
    await timelockCall(timelockAddress, treasuryAddress, calldata, `treasury.initOutflowConfig(${t.label})`, nm);
  }

  // 14b. Initial steward + USDC steward budget (#221, #222). Elect the configured steward and
  // authorize its USDC budget inside the bootstrap window, then read both back. Must precede
  // step 15 (delay raise) and step 16 (role renounce): afterwards only governance can do it.
  if (config.initialSteward) {
    const steward = config.initialSteward;
    console.log("14b. Electing initial steward + authorizing its USDC steward budget...");
    const { termEnd } = await seedInitialSteward(steward,
      { steward: govDeployment.contracts.steward, treasury: treasuryAddress, usdc: usdcAddress },
      (target, calldata, description) => timelockCall(timelockAddress, target, calldata, description, nm));
    govDeployment.initialSteward = {
      address: steward.address,
      termEnd: termEnd.toString(),
      budgetLimit: stewardBudgetLimit(steward).toString(),
      budgetWindow: steward.budgetWindow,
    };
    saveDeployment(govFilename, govDeployment);
    console.log(`   Steward ${steward.address} elected (term ends ${new Date(Number(termEnd) * 1000).toISOString()})`);
    console.log(`   USDC steward budget: $${steward.budgetUsdc} per ${steward.budgetWindow}s`);
  } else {
    console.log("14b. Initial steward: not configured (elected via governance post-launch)");
  }

  // 15. Harden: raise the timelock delay to its production value as the FINAL
  // timelock op. The deploy ran the timelock at minDelay 0 so the bootstrap ops above
  // executed instantly; after this the real delay is in force (issue #347).
  //
  // ORDERING INVARIANT: in a hardened run this script must be the LAST one to perform
  // any timelock-only op. Step 16 below renounces the deployer's PROPOSER/EXECUTOR
  // roles, so any later timelock-only wiring (e.g. fee-module setFeeCollector, adapter
  // authorizeAdapter in the shielded-pool deploy) would revert. The mainnet orchestrator
  // enforces crowdfund-last ordering for hardened runs; do not harden a full multi-phase
  // deploy that wires the shielded pool after the crowdfund.
  const timelock = await ethers.getContractAt("TimelockController", timelockAddress);
  if (config.hardenTimelock) {
    console.log(`15. Raising timelock delay to ${config.timelockDelay}s (harden)...`);
    const updateDelayCalldata = timelock.interface.encodeFunctionData("updateDelay", [config.timelockDelay]);
    await timelockCall(timelockAddress, timelockAddress, updateDelayCalldata, "timelock.updateDelay(production)", nm);
  }

  // Addresses were persisted immediately after each deployment. Save again here
  // after funding so an interrupted run retains the original constructor inputs.
  saveDeployment(govFilename, govDeployment);

  // 16. Renounce deployer timelock roles (final action — all wiring complete).
  console.log("16. Renouncing timelock roles...");
  if (config.hardenTimelock) {
    // Harden: the deployer temporarily held the ops roles to bootstrap timelock-only
    // wiring above; drop them so no key retains timelock power post-deploy (issue #347).
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    await (await timelock.renounceRole(PROPOSER_ROLE, deployer.address, nm.override())).wait();
    await (await timelock.renounceRole(EXECUTOR_ROLE, deployer.address, nm.override())).wait();
    await (await timelock.renounceRole(CANCELLER_ROLE, deployer.address, nm.override())).wait();
    console.log("   Renounced PROPOSER/EXECUTOR/CANCELLER from deployer");
  }
  const ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();
  await (await timelock.renounceRole(ADMIN_ROLE, deployer.address, nm.override())).wait();
  console.log("   Renounced TIMELOCK_ADMIN_ROLE from deployer");

  // Save the complete deployment (drops the in-progress marker)
  deployment.timestamp = new Date().toISOString();
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
