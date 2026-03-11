// ABOUTME: Full lifecycle demo narrating Armada from crowdfund through governance treasury distribution.
// ABOUTME: Deploys all contracts, runs crowdfund, reclaims to treasury, activates governance, and executes proposals.

/**
 * Full Lifecycle Demo — End-to-end narrated walkthrough
 *
 * Deploys the entire Armada system with a single canonical ARM token and runs
 * through six phases that mirror the real activation sequence:
 *
 *   Phase 1: Deploy — governance stack + crowdfund with shared ARM + unified treasury
 *   Phase 2: Crowdfund — seeds → invite → commit → finalize → claim
 *   Phase 3: Treasury Reclaim — withdrawProceeds + withdrawUnallocatedArm → treasury
 *   Phase 4: Governance Activation — lock ARM → quorum analysis
 *   Phase 5: Treasury Proposal — governance distributes USDC from treasury
 *   Phase 6: Steward Election — community-required quorum + operational spend
 *
 * Uses evm_increaseTime to fast-forward through delays.
 *
 * Usage (standalone, uses Hardhat's built-in network):
 *   npx hardhat run scripts/full_lifecycle_demo.ts
 */

import { ethers, network } from "hardhat";

// ============ Named Constants ============

// ARM distribution (must sum to 100M total supply)
const TREASURY_ARM  = "65000000";   // protocol treasury, governed by proposals
const CROWDFUND_ARM = "1800000";    // backs MAX_SALE at $1/ARM
// Deployer remainder: 33.2M (100M - 65M - 1.8M) — production allocation TBD

// Timing (seconds)
const ONE_DAY    = 86400;
const TWO_DAYS   = 2 * ONE_DAY;
const FIVE_DAYS  = 5 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;
const FOUR_DAYS  = 4 * ONE_DAY;
const ONE_WEEK   = 7 * ONE_DAY;
const TWO_WEEKS  = 14 * ONE_DAY;

// Crowdfund parameters
const NUM_SEEDS = 80;                // enough to exceed MIN_SALE ($1M)
const SEED_CAP   = "15000";         // $15K USDC per seed (hop 0)
const HOP1_CAP   = "4000";          // $4K USDC per hop-1
const HOP2_CAP   = "1000";          // $1K USDC per hop-2
const NUM_SEED_INVITERS = 3;        // first 3 seeds each invite 3 hop-1
const INVITES_PER_SEED  = 3;
const INVITES_PER_HOP1  = 2;

// Governance parameters
const DEPLOYER_LOCK_ARM    = "10000000";  // 10M ARM — team governance stake
const DISTRIBUTE_AMOUNT    = "10000";     // USDC distributed via treasury proposal
const STEWARD_SPEND_AMOUNT = "1000";      // USDC spent by steward from operational budget
// Steward action delay: 120% of governance cycle (2d + 5d + 2d = 9d)
const STEWARD_ACTION_DELAY = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);
const TIMELOCK_MIN_DELAY   = TWO_DAYS;

// Governance enums
const ProposalType = { ParameterChange: 0, Treasury: 1, StewardElection: 2 };
const Vote = { Against: 0, For: 1, Abstain: 2 };
const PhaseNames  = ["SETUP", "INVITATION", "COMMITMENT", "FINALIZED", "CANCELED"];
const StateNames  = ["PENDING", "ACTIVE", "DEFEATED", "SUCCEEDED", "QUEUED", "EXECUTED", "CANCELED"];

// ============ Utility Functions ============

function log(tag: string, msg: string) {
  const padded = `[${tag}]`.padEnd(14);
  console.log(`${padded} ${msg}`);
}

async function fastForward(seconds: number, label: string) {
  console.log("");
  console.log(`             \u23e9 Fast-forward ${label}...`);
  await network.provider.send("evm_increaseTime", [seconds + 1]);
  await network.provider.send("evm_mine");
  console.log("");
}

function fmtUsdc(amount: bigint): string {
  return `$${(Number(amount) / 1e6).toLocaleString()}`;
}

function fmtArm(amount: bigint): string {
  return `${(Number(amount) / 1e18).toLocaleString()} ARM`;
}

function verify(label: string, condition: boolean): void {
  const icon = condition ? "\u2713" : "\u2717 UNEXPECTED";
  log("VERIFY", `${label}: ${icon}`);
}

function section(title: string) {
  console.log("");
  console.log("-".repeat(70));
  console.log(`  ${title}`);
  console.log("-".repeat(70));
  console.log("");
}

function majorSection(title: string) {
  console.log("");
  console.log("=".repeat(70));
  console.log(`  ${title}`);
  console.log("=".repeat(70));
  console.log("");
}

// ============ Main ============

async function main() {
  const signers = await ethers.getSigners();

  // Signer allocation
  const deployer         = signers[0];
  const grantRecipient   = signers[1];   // receives USDC from governance proposal
  const stewardCandidate = signers[2];   // elected as treasury steward
  const seeds            = signers.slice(3, 3 + NUM_SEEDS);             // 80 seeds
  const hop1Addrs        = signers.slice(83, 83 + NUM_SEED_INVITERS * INVITES_PER_SEED); // 9 hop-1
  const hop2Addrs        = signers.slice(92, 92 + hop1Addrs.length * INVITES_PER_HOP1);  // 18 hop-2

  majorSection("ARMADA FULL LIFECYCLE DEMO");

  // ================================================================
  //  PHASE 1: DEPLOY
  // ================================================================

  section("PHASE 1: Deploy \u2014 Shared ARM + Unified Treasury");

  log("DEPLOY", "Deploying governance stack...");

  // 1a. ARM token — canonical, 100M fixed supply
  const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
  const armToken = await ArmadaToken.deploy(deployer.address);
  await armToken.waitForDeployment();
  log("DEPLOY", `ArmadaToken: ${await armToken.getAddress()}`);

  const MAX_PAUSE = 14 * ONE_DAY;

  // 1b. TimelockController (deployed first — needed as pauseTimelock)
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(TIMELOCK_MIN_DELAY, [], [], deployer.address);
  await timelock.waitForDeployment();
  const tlAddr = await timelock.getAddress();
  log("DEPLOY", `TimelockController: ${tlAddr}`);

  // 1c. VotingLocker
  const VotingLocker = await ethers.getContractFactory("VotingLocker");
  const votingLocker = await VotingLocker.deploy(
    await armToken.getAddress(), deployer.address, MAX_PAUSE, tlAddr
  );
  await votingLocker.waitForDeployment();
  log("DEPLOY", `VotingLocker: ${await votingLocker.getAddress()}`);

  // 1d. Treasury (owned by timelock from the start)
  const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
  const treasury = await ArmadaTreasuryGov.deploy(tlAddr, deployer.address, MAX_PAUSE);
  await treasury.waitForDeployment();
  log("DEPLOY", `ArmadaTreasuryGov: ${await treasury.getAddress()}`);

  // 1e. Governor
  const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
  const governor = await ArmadaGovernor.deploy(
    await votingLocker.getAddress(),
    await armToken.getAddress(),
    tlAddr,
    await treasury.getAddress(),
    deployer.address, MAX_PAUSE
  );
  await governor.waitForDeployment();
  log("DEPLOY", `ArmadaGovernor: ${await governor.getAddress()}`);

  // Set governor on VotingLocker (needed for vote cooldown)
  await votingLocker.setGovernor(await governor.getAddress());

  // 1f. TreasurySteward
  const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
  const stewardContract = await TreasurySteward.deploy(
    tlAddr, await treasury.getAddress(), await governor.getAddress(), STEWARD_ACTION_DELAY,
    deployer.address, MAX_PAUSE
  );
  await stewardContract.waitForDeployment();
  log("DEPLOY", `TreasurySteward: ${await stewardContract.getAddress()}`);

  // 1g. Mock USDC
  const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
  const usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
  await usdc.waitForDeployment();
  log("DEPLOY", `MockUSDCV2: ${await usdc.getAddress()}`);

  // 1h. Crowdfund (shared ARM token + unified treasury)
  log("DEPLOY", "Deploying crowdfund with shared ARM + treasury...");
  const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
  const crowdfund = await ArmadaCrowdfund.deploy(
    await usdc.getAddress(),
    await armToken.getAddress(),
    deployer.address,       // admin
    await treasury.getAddress()  // immutable treasury destination
  );
  await crowdfund.waitForDeployment();
  log("DEPLOY", `ArmadaCrowdfund: ${await crowdfund.getAddress()}`);

  // 1i. Transfer ARM
  const treasuryArm  = ethers.parseUnits(TREASURY_ARM, 18);
  const crowdfundArm  = ethers.parseUnits(CROWDFUND_ARM, 18);
  await armToken.transfer(await treasury.getAddress(), treasuryArm);
  await armToken.transfer(await crowdfund.getAddress(), crowdfundArm);
  log("FUND", `${TREASURY_ARM} ARM \u2192 treasury`);
  log("FUND", `${CROWDFUND_ARM} ARM \u2192 crowdfund`);

  const deployerArm = await armToken.balanceOf(deployer.address);
  log("FUND", `${(Number(deployerArm) / 1e18).toLocaleString()} ARM remains with deployer`);

  // 1j. Quorum exclusion — exclude crowdfund from quorum denominator
  await governor.setExcludedAddresses([await crowdfund.getAddress()]);
  log("GOV", "Crowdfund excluded from governor quorum denominator");

  // 1k. Configure timelock roles
  await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
  await timelock.grantRole(await timelock.EXECUTOR_ROLE(), await governor.getAddress());
  await timelock.renounceRole(await timelock.TIMELOCK_ADMIN_ROLE(), deployer.address);
  log("GOV", "Timelock: governor has proposer+executor, deployer admin renounced");

  // 1l. Mint USDC to treasury for governance distribution demos
  await usdc.mint(await treasury.getAddress(), ethers.parseUnits("50000", 6));
  log("FUND", "$50,000 USDC minted to treasury (for governance demo)");

  // Verification
  console.log("");
  const totalSupply    = await armToken.totalSupply();
  const treasuryBal    = await armToken.balanceOf(await treasury.getAddress());
  const crowdfundBal   = await armToken.balanceOf(await crowdfund.getAddress());
  const deployerBal    = await armToken.balanceOf(deployer.address);
  const sum = treasuryBal + crowdfundBal + deployerBal;

  verify("ARM total supply = 100M", totalSupply === ethers.parseUnits("100000000", 18));
  verify("Treasury ARM = 65M", treasuryBal === treasuryArm);
  verify("Crowdfund ARM = 1.8M", crowdfundBal === crowdfundArm);
  verify("Deployer remainder = 33.2M", deployerBal === ethers.parseUnits("33200000", 18));
  verify("All balances sum to total supply", sum === totalSupply);
  verify("Treasury owner = timelock", await treasury.owner() === await timelock.getAddress());

  // ================================================================
  //  PHASE 2: CROWDFUND LIFECYCLE
  // ================================================================

  section("PHASE 2: Crowdfund \u2014 Seeds \u2192 Invite \u2192 Commit \u2192 Finalize \u2192 Claim");

  // 2a: Add seeds
  await crowdfund.addSeeds(seeds.map(s => s.address));
  log("SEED", `Added ${seeds.length} seeds (hop 0, $${SEED_CAP} cap, 3 invites each)`);

  // 2b: Start invitations
  await crowdfund.startInvitations();
  log("START", "Invitation window opened (2-week duration)");

  // 2c: Invitation chains — first 3 seeds invite hop-1, hop-1 invite hop-2
  let hop1Count = 0;
  for (let i = 0; i < NUM_SEED_INVITERS; i++) {
    for (let j = 0; j < INVITES_PER_SEED && hop1Count < hop1Addrs.length; j++) {
      await crowdfund.connect(seeds[i]).invite(hop1Addrs[hop1Count].address);
      hop1Count++;
    }
    log("INVITE", `Seed-${String.fromCharCode(65 + i)} invites ${INVITES_PER_SEED} \u2192 hop 1`);
  }

  let hop2Count = 0;
  for (let i = 0; i < hop1Addrs.length; i++) {
    for (let j = 0; j < INVITES_PER_HOP1 && hop2Count < hop2Addrs.length; j++) {
      await crowdfund.connect(hop1Addrs[i]).invite(hop2Addrs[hop2Count].address);
      hop2Count++;
    }
  }
  log("INVITE", `${hop1Count} hop-1 addresses invited ${hop2Count} hop-2 addresses`);

  const [, , wc0] = await crowdfund.getHopStats(0);
  const [, , wc1] = await crowdfund.getHopStats(1);
  const [, , wc2] = await crowdfund.getHopStats(2);
  log("STATS", `Whitelisted \u2014 Hop 0: ${wc0} | Hop 1: ${wc1} | Hop 2: ${wc2}`);

  await fastForward(TWO_WEEKS, "2 weeks (invitation window)");

  // 2d: Commitment phase
  log("PHASE", "Commitment window open (1-week duration)");

  // Seeds commit at max cap
  for (const s of seeds) {
    const amount = ethers.parseUnits(SEED_CAP, 6);
    await usdc.mint(s.address, amount);
    await usdc.connect(s).approve(await crowdfund.getAddress(), amount);
    await crowdfund.connect(s).commit(amount);
  }
  log("COMMIT", `${seeds.length} seeds commit $${SEED_CAP} each = ${fmtUsdc(ethers.parseUnits(SEED_CAP, 6) * BigInt(seeds.length))}`);

  // Hop-1 commit at max cap
  for (let i = 0; i < hop1Count; i++) {
    const amount = ethers.parseUnits(HOP1_CAP, 6);
    await usdc.mint(hop1Addrs[i].address, amount);
    await usdc.connect(hop1Addrs[i]).approve(await crowdfund.getAddress(), amount);
    await crowdfund.connect(hop1Addrs[i]).commit(amount);
  }
  log("COMMIT", `${hop1Count} hop-1 commit $${HOP1_CAP} each = ${fmtUsdc(ethers.parseUnits(HOP1_CAP, 6) * BigInt(hop1Count))}`);

  // Hop-2 commit at max cap
  for (let i = 0; i < hop2Count; i++) {
    const amount = ethers.parseUnits(HOP2_CAP, 6);
    await usdc.mint(hop2Addrs[i].address, amount);
    await usdc.connect(hop2Addrs[i]).approve(await crowdfund.getAddress(), amount);
    await crowdfund.connect(hop2Addrs[i]).commit(amount);
  }
  log("COMMIT", `${hop2Count} hop-2 commit $${HOP2_CAP} each = ${fmtUsdc(ethers.parseUnits(HOP2_CAP, 6) * BigInt(hop2Count))}`);

  const totalCommitted = await crowdfund.totalCommitted();
  log("STATS", `Total committed: ${fmtUsdc(totalCommitted)}`);
  for (let h = 0; h < 3; h++) {
    const [tc, uc] = await crowdfund.getHopStats(h);
    log("STATS", `  Hop ${h}: ${uc} committers, ${fmtUsdc(tc)}`);
  }

  await fastForward(ONE_WEEK, "1 week (commitment window)");

  // 2e: Finalize
  await crowdfund.finalize();
  const phase = Number(await crowdfund.phase());
  log("FINALIZE", `Phase: ${PhaseNames[phase]}`);

  const saleSize = await crowdfund.saleSize();
  log("FINALIZE", `Sale size: ${fmtUsdc(saleSize)} (BASE_SALE; below 1.5\u00d7 elastic trigger)`);

  // Show allocation math per hop
  for (let h = 0; h < 3; h++) {
    const reserve = await crowdfund.finalReserves(h);
    const demand  = await crowdfund.finalDemands(h);
    const overSub = demand > reserve;
    const allocLabel = overSub
      ? `PRO-RATA (${((Number(reserve) / Number(demand)) * 100).toFixed(1)}%)`
      : "FULL ALLOC";
    log("ALLOC", `Hop ${h}: reserve ${fmtUsdc(reserve)} | demand ${fmtUsdc(demand)} \u2192 ${allocLabel}`);
  }

  const totalAllocArm  = await crowdfund.totalAllocated();
  const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
  log("ALLOC", `Total allocated: ${fmtArm(totalAllocArm)} (${fmtUsdc(totalAllocUsdc)} USDC value)`);

  // 2f: Claims — all seeds (needed for governance), plus sample hop-1/hop-2
  log("CLAIM", `Claiming for all ${seeds.length} seeds...`);
  let totalSeedArm  = 0n;
  let totalSeedRefund = 0n;
  for (const s of seeds) {
    await crowdfund.connect(s).claim();
    const bal = await armToken.balanceOf(s.address);
    totalSeedArm += bal;
  }
  // Show one example seed allocation
  const [exAlloc, exRefund] = await crowdfund.getAllocation(seeds[0].address);
  log("CLAIM", `  Example seed: ${fmtArm(exAlloc)} + ${fmtUsdc(exRefund)} refund`);
  log("CLAIM", `  Total seed ARM claimed: ${fmtArm(totalSeedArm)}`);

  // Claim a few hop-1 and hop-2 for demonstration
  const hop1Claimers = Math.min(3, hop1Count);
  for (let i = 0; i < hop1Claimers; i++) {
    await crowdfund.connect(hop1Addrs[i]).claim();
  }
  const [h1Alloc, h1Refund] = await crowdfund.getAllocation(hop1Addrs[0].address);
  log("CLAIM", `  ${hop1Claimers} hop-1 claim: ${fmtArm(h1Alloc)} + ${fmtUsdc(h1Refund)} refund each`);

  const hop2Claimers = Math.min(3, hop2Count);
  for (let i = 0; i < hop2Claimers; i++) {
    await crowdfund.connect(hop2Addrs[i]).claim();
  }
  const [h2Alloc, h2Refund] = await crowdfund.getAllocation(hop2Addrs[0].address);
  log("CLAIM", `  ${hop2Claimers} hop-2 claim: ${fmtArm(h2Alloc)} + ${fmtUsdc(h2Refund)} refund each`);

  verify("Phase is FINALIZED", phase === 3);
  verify("Total committed > MIN_SALE ($1M)", totalCommitted > ethers.parseUnits("1000000", 6));

  // ================================================================
  //  PHASE 3: TREASURY RECLAIM
  // ================================================================

  section("PHASE 3: Treasury Reclaim \u2014 Proceeds + Unallocated ARM");

  const treasuryUsdcBefore = await usdc.balanceOf(await treasury.getAddress());
  const treasuryArmBefore  = await armToken.balanceOf(await treasury.getAddress());
  log("BEFORE", `Treasury USDC: ${fmtUsdc(treasuryUsdcBefore)}`);
  log("BEFORE", `Treasury ARM:  ${fmtArm(treasuryArmBefore)}`);

  // Withdraw USDC proceeds (accrued from claims above)
  await crowdfund.withdrawProceeds();
  const proceedsAccrued = await crowdfund.totalProceedsAccrued();
  log("WITHDRAW", `USDC proceeds withdrawn: ${fmtUsdc(proceedsAccrued)} \u2192 treasury`);

  // Withdraw unallocated ARM
  await crowdfund.withdrawUnallocatedArm();
  log("WITHDRAW", "Unallocated ARM withdrawn \u2192 treasury");

  const treasuryUsdcAfter = await usdc.balanceOf(await treasury.getAddress());
  const treasuryArmAfter  = await armToken.balanceOf(await treasury.getAddress());
  log("AFTER", `Treasury USDC: ${fmtUsdc(treasuryUsdcAfter)}`);
  log("AFTER", `Treasury ARM:  ${fmtArm(treasuryArmAfter)}`);

  const cfArmRemaining = await armToken.balanceOf(await crowdfund.getAddress());
  log("CROWDFUND", `ARM remaining in crowdfund: ${fmtArm(cfArmRemaining)} (owed to unclaimed participants)`);

  verify("Treasury USDC increased", treasuryUsdcAfter > treasuryUsdcBefore);
  verify("Treasury ARM increased", treasuryArmAfter > treasuryArmBefore);

  // ================================================================
  //  PHASE 4: GOVERNANCE ACTIVATION
  // ================================================================

  section("PHASE 4: Governance Activation \u2014 Lock ARM + Quorum Analysis");

  // Deployer locks team stake
  const deployerLockAmt = ethers.parseUnits(DEPLOYER_LOCK_ARM, 18);
  await armToken.connect(deployer).approve(await votingLocker.getAddress(), deployerLockAmt);
  await votingLocker.connect(deployer).lock(deployerLockAmt);
  log("LOCK", `Deployer locks ${DEPLOYER_LOCK_ARM} ARM (team governance stake)`);

  // All seeds lock their claimed ARM
  let totalSeedLocked = 0n;
  for (const s of seeds) {
    const bal = await armToken.balanceOf(s.address);
    if (bal > 0n) {
      await armToken.connect(s).approve(await votingLocker.getAddress(), bal);
      await votingLocker.connect(s).lock(bal);
      totalSeedLocked += bal;
    }
  }
  log("LOCK", `${seeds.length} seeds lock claimed ARM: ${fmtArm(totalSeedLocked)} total`);

  // Mine a block so checkpoints are visible for proposals
  await network.provider.send("evm_mine");

  // Quorum analysis
  const eligibleSupply = await armToken.totalSupply()
    - await armToken.balanceOf(await treasury.getAddress())
    - await armToken.balanceOf(await crowdfund.getAddress());

  console.log("");
  log("QUORUM", `Total ARM supply:      ${fmtArm(await armToken.totalSupply())}`);
  log("QUORUM", `Treasury balance:      ${fmtArm(await armToken.balanceOf(await treasury.getAddress()))}`);
  log("QUORUM", `Crowdfund balance:     ${fmtArm(await armToken.balanceOf(await crowdfund.getAddress()))}`);
  log("QUORUM", `Eligible supply:       ${fmtArm(eligibleSupply)}`);
  console.log("");

  const quorum20pct = (eligibleSupply * 2000n) / 10000n;
  const quorum30pct = (eligibleSupply * 3000n) / 10000n;
  const totalLocked = deployerLockAmt + totalSeedLocked;
  const proposalThreshold = await armToken.totalSupply() / 10000n * 10n; // 0.1%

  log("QUORUM", `Treasury/ParameterChange (20%): ${fmtArm(quorum20pct)}`);
  log("QUORUM", `  Deployer alone: ${fmtArm(deployerLockAmt)} ${deployerLockAmt >= quorum20pct ? "\u2713 SUFFICIENT" : "\u2717 INSUFFICIENT"}`);
  log("QUORUM", `StewardElection (30%):          ${fmtArm(quorum30pct)}`);
  log("QUORUM", `  Deployer alone: ${fmtArm(deployerLockAmt)} ${deployerLockAmt >= quorum30pct ? "\u2713 SUFFICIENT" : "\u2717 INSUFFICIENT"}`);
  log("QUORUM", `  Deployer + seeds: ${fmtArm(totalLocked)} ${totalLocked >= quorum30pct ? "\u2713 SUFFICIENT" : "\u2717 INSUFFICIENT"}`);

  if (deployerLockAmt < quorum30pct && totalLocked >= quorum30pct) {
    log("NOTE", "Community participation is REQUIRED for steward elections!");
  }

  log("THRESHOLD", `Proposal threshold (0.1%): ${fmtArm(proposalThreshold)}`);
  verify("Deployer exceeds proposal threshold", deployerLockAmt >= proposalThreshold);
  verify("Treasury quorum reachable", totalLocked >= quorum20pct);
  verify("StewardElection quorum reachable", totalLocked >= quorum30pct);

  // ================================================================
  //  PHASE 5: TREASURY PROPOSAL
  // ================================================================

  section("PHASE 5: Treasury Proposal \u2014 Distribute USDC via Governance");

  const distributeAmt = ethers.parseUnits(DISTRIBUTE_AMOUNT, 6);
  const targets5 = [await treasury.getAddress()];
  const values5  = [0n];
  const calldatas5 = [treasury.interface.encodeFunctionData("distribute", [
    await usdc.getAddress(), grantRecipient.address, distributeAmt
  ])];

  await governor.connect(deployer).propose(
    ProposalType.Treasury, targets5, values5, calldatas5,
    `Distribute ${DISTRIBUTE_AMOUNT} USDC to community grant recipient`
  );
  const pid1 = Number(await governor.proposalCount());
  log("PROPOSE", `Proposal #${pid1}: "Distribute $${DISTRIBUTE_AMOUNT} USDC to grant recipient"`);
  log("PROPOSE", `Type: Treasury (2d delay, 5d voting, 2d execution, 20% quorum)`);
  log("STATE", `Proposal #${pid1}: ${StateNames[Number(await governor.state(pid1))]}`);

  await fastForward(TWO_DAYS, "2 days (voting delay)");
  log("STATE", `Proposal #${pid1}: ${StateNames[Number(await governor.state(pid1))]}`);

  // Deployer votes FOR
  await governor.connect(deployer).castVote(pid1, Vote.For);
  log("VOTE", `Deployer votes FOR with ${fmtArm(deployerLockAmt)}`);

  // Some seeds vote FOR
  for (let i = 0; i < 8; i++) {
    await governor.connect(seeds[i]).castVote(pid1, Vote.For);
  }
  log("VOTE", `8 seeds vote FOR`);

  // One seed votes AGAINST (show dissent)
  await governor.connect(seeds[8]).castVote(pid1, Vote.Against);
  log("VOTE", `Seed-I votes AGAINST (dissent)`);

  // One seed abstains
  await governor.connect(seeds[9]).castVote(pid1, Vote.Abstain);
  log("VOTE", `Seed-J abstains`);

  const [,,,,forVotes1, againstVotes1, abstainVotes1] = await governor.getProposal(pid1);
  log("TALLY", `For: ${fmtArm(forVotes1)} | Against: ${fmtArm(againstVotes1)} | Abstain: ${fmtArm(abstainVotes1)}`);

  const actualQuorum1 = await governor.quorum(pid1);
  log("QUORUM", `Required: ${fmtArm(actualQuorum1)} | For votes: ${fmtArm(forVotes1)} \u2192 ${forVotes1 >= actualQuorum1 ? "MET \u2713" : "NOT MET \u2717"}`);

  await fastForward(FIVE_DAYS, "5 days (voting period)");
  log("STATE", `Proposal #${pid1}: ${StateNames[Number(await governor.state(pid1))]}`);

  await governor.queue(pid1);
  log("QUEUE", "Queued to timelock (2-day execution delay)");

  await fastForward(TWO_DAYS, "2 days (execution delay)");

  const recipientBefore = await usdc.balanceOf(grantRecipient.address);
  const treasuryUsdcBefore5 = await usdc.balanceOf(await treasury.getAddress());
  await governor.execute(pid1);

  const recipientAfter = await usdc.balanceOf(grantRecipient.address);
  const treasuryUsdcAfter5 = await usdc.balanceOf(await treasury.getAddress());
  log("EXECUTE", `Proposal #${pid1} executed!`);
  log("RESULT", `Recipient USDC: ${fmtUsdc(recipientBefore)} \u2192 ${fmtUsdc(recipientAfter)}`);
  log("RESULT", `Treasury USDC:  ${fmtUsdc(treasuryUsdcBefore5)} \u2192 ${fmtUsdc(treasuryUsdcAfter5)}`);

  verify("Recipient received USDC", recipientAfter === recipientBefore + distributeAmt);
  verify("Proposal executed", Number(await governor.state(pid1)) === 5);

  // ================================================================
  //  PHASE 6: STEWARD ELECTION + OPERATIONAL SPEND
  // ================================================================

  section("PHASE 6: Steward Election \u2014 Community-Required Quorum");

  const electTargets = [
    await stewardContract.getAddress(),
    await treasury.getAddress(),
  ];
  const electValues = [0n, 0n];
  const electCalldatas = [
    stewardContract.interface.encodeFunctionData("electSteward", [stewardCandidate.address]),
    treasury.interface.encodeFunctionData("setSteward", [stewardCandidate.address]),
  ];

  await governor.connect(deployer).propose(
    ProposalType.StewardElection, electTargets, electValues, electCalldatas,
    "Elect treasury steward"
  );
  const pid2 = Number(await governor.proposalCount());
  log("PROPOSE", `Proposal #${pid2}: "Elect treasury steward"`);
  log("PROPOSE", `Type: StewardElection (2d delay, 7d voting, 4d execution, 30% quorum)`);
  log("STATE", `Proposal #${pid2}: ${StateNames[Number(await governor.state(pid2))]}`);

  await fastForward(TWO_DAYS, "2 days (voting delay)");
  log("STATE", `Proposal #${pid2}: ${StateNames[Number(await governor.state(pid2))]}`);

  // Deployer votes — but show it's insufficient alone for 30% quorum
  await governor.connect(deployer).castVote(pid2, Vote.For);
  const actualQuorum2 = await governor.quorum(pid2);
  log("VOTE", `Deployer votes FOR with ${fmtArm(deployerLockAmt)}`);
  log("NOTE", `Deployer alone: ${fmtArm(deployerLockAmt)} < ${fmtArm(actualQuorum2)} quorum \u2192 INSUFFICIENT`);
  log("NOTE", "Need community participation to pass steward election...");

  // All seeds vote FOR
  for (const s of seeds) {
    const locked = await votingLocker.getLockedBalance(s.address);
    if (locked > 0n) {
      await governor.connect(s).castVote(pid2, Vote.For);
    }
  }
  log("VOTE", `${seeds.length} seeds vote FOR (${fmtArm(totalSeedLocked)} total)`);

  const [,,,,forVotes2, againstVotes2, abstainVotes2] = await governor.getProposal(pid2);
  log("TALLY", `For: ${fmtArm(forVotes2)} | Against: ${fmtArm(againstVotes2)} | Abstain: ${fmtArm(abstainVotes2)}`);
  log("QUORUM", `Required: ${fmtArm(actualQuorum2)} | For votes: ${fmtArm(forVotes2)} \u2192 ${forVotes2 >= actualQuorum2 ? "MET \u2713" : "NOT MET \u2717"}`);
  log("NOTE", "Community made the difference!");

  await fastForward(SEVEN_DAYS, "7 days (extended voting period)");
  log("STATE", `Proposal #${pid2}: ${StateNames[Number(await governor.state(pid2))]}`);

  await governor.queue(pid2);
  log("QUEUE", "Queued to timelock (4-day execution delay)");

  await fastForward(FOUR_DAYS, "4 days (extended execution delay)");

  await governor.execute(pid2);
  log("EXECUTE", `Proposal #${pid2} executed!`);
  log("STEWARD", `Steward: ${stewardCandidate.address.slice(0, 10)}...`);
  log("STEWARD", `Active: ${await stewardContract.isStewardActive()}`);

  verify("Steward election executed", Number(await governor.state(pid2)) === 5);
  verify("Steward is active", await stewardContract.isStewardActive());

  // Steward operational spend
  console.log("");
  log("STEWARD", "Steward uses operational budget (1% of treasury per 30-day period)...");

  const stewardSpendAmt = ethers.parseUnits(STEWARD_SPEND_AMOUNT, 6);
  const treasuryUsdcBefore6 = await usdc.balanceOf(await treasury.getAddress());
  const budget = treasuryUsdcBefore6 / 100n; // 1%

  await treasury.connect(stewardCandidate).stewardSpend(
    await usdc.getAddress(), grantRecipient.address, stewardSpendAmt
  );

  const treasuryUsdcAfter6 = await usdc.balanceOf(await treasury.getAddress());
  log("STEWARD", `Spent $${STEWARD_SPEND_AMOUNT} USDC from operational budget`);
  log("STEWARD", `Monthly budget: ${fmtUsdc(budget)} (1% of ${fmtUsdc(treasuryUsdcBefore6)})`);
  log("RESULT", `Treasury USDC: ${fmtUsdc(treasuryUsdcBefore6)} \u2192 ${fmtUsdc(treasuryUsdcAfter6)}`);
  log("RESULT", `Recipient total USDC: ${fmtUsdc(await usdc.balanceOf(grantRecipient.address))}`);

  verify("Steward spend succeeded", treasuryUsdcAfter6 === treasuryUsdcBefore6 - stewardSpendAmt);

  // ================================================================
  //  EPILOGUE: FINAL STATE
  // ================================================================

  majorSection("FINAL STATE SUMMARY");

  const finalTreasuryArm   = await armToken.balanceOf(await treasury.getAddress());
  const finalTreasuryUsdc  = await usdc.balanceOf(await treasury.getAddress());
  const finalCrowdfundArm  = await armToken.balanceOf(await crowdfund.getAddress());
  const finalDeployerArm   = await armToken.balanceOf(deployer.address);
  const finalLockerArm     = await armToken.balanceOf(await votingLocker.getAddress());
  const finalRecipientUsdc = await usdc.balanceOf(grantRecipient.address);

  console.log("  ARM Distribution:");
  console.log(`    Treasury (governed):     ${fmtArm(finalTreasuryArm)}`);
  console.log(`    VotingLocker (locked):   ${fmtArm(finalLockerArm)}`);
  console.log(`    Deployer (free):         ${fmtArm(finalDeployerArm)}`);
  console.log(`    Crowdfund (unclaimed):   ${fmtArm(finalCrowdfundArm)}`);
  console.log(`    Total:                   ${fmtArm(await armToken.totalSupply())}`);
  console.log("");
  console.log("  USDC Distribution:");
  console.log(`    Treasury:                ${fmtUsdc(finalTreasuryUsdc)}`);
  console.log(`    Grant recipient:         ${fmtUsdc(finalRecipientUsdc)}`);
  console.log("");
  console.log("  Governance:");
  console.log(`    Proposals created:       ${await governor.proposalCount()}`);
  console.log(`    Proposal #1:             Treasury distribution (${StateNames[Number(await governor.state(pid1))]})`);
  console.log(`    Proposal #2:             Steward election (${StateNames[Number(await governor.state(pid2))]})`);
  console.log(`    Active steward:          ${stewardCandidate.address.slice(0, 10)}...`);

  majorSection("DEMO COMPLETE");

  console.log("  Lifecycle demonstrated:");
  console.log("  1. Deploy: canonical ARM token + governance stack + crowdfund (unified treasury)");
  console.log("  2. Crowdfund: seeds \u2192 invite \u2192 commit \u2192 finalize \u2192 claim");
  console.log("  3. Treasury reclaim: USDC proceeds + unallocated ARM \u2192 treasury");
  console.log("  4. Governance activation: lock ARM, verify quorum reachability");
  console.log("  5. Treasury proposal: distribute USDC via governance vote");
  console.log("  6. Steward election: community-required quorum + operational spend");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
