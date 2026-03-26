/**
 * Cross-Contract Integration Tests (Phase 6)
 *
 * Tests the full lifecycle across all contracts:
 * 1. End-to-end: crowdfund → claim ARM → delegate → propose → vote → execute
 * 2. Token supply consistency: quorum calculations after crowdfund distributes tokens
 * 3. Adversarial cross-contract: snapshot manipulation, timelock permission checks
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2 };
const ProposalState = {
  Pending: 0, Active: 1, Defeated: 2, Succeeded: 3,
  Queued: 4, Executed: 5, Canceled: 6,
};
const Vote = { Against: 0, For: 1, Abstain: 2 };

const ONE_DAY = 86400;
const TWO_DAYS = 2 * ONE_DAY;
const FIVE_DAYS = 5 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;
const THREE_WEEKS = 21 * ONE_DAY;

const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

// Amount of ARM the deployer keeps for governance testing after treasury + crowdfund allocations.
// Eligible supply ≈ DEPLOYER_KEEP + seed-claimed ARM. Quorum = 20% of eligible.
// Deployer delegates half of DEPLOYER_KEEP. That plus seed claims must exceed quorum.
// With 100 seeds × $15K = $1.5M (hits ELASTIC_TRIGGER), MAX_SALE = $1.8M applies.
// Hop-0 ceiling = 70% × ($1.8M - $90K) = $1,197K. Demand $1.5M > ceiling → pro-rata.
// Each seed gets $1,197K / 100 = $11,970 ARM. Total claimed = 1,197,000 ARM.
// Eligible ≈ 1.2M + ~1.197M = ~2.397M, quorum = 20% ≈ ~479K.
// Deployer delegates 1.2M > 479K quorum. ✓
const DEPLOYER_KEEP = ARM(1_200_000);

describe("Cross-Contract Integration (Phase 6)", function () {
  // Contracts
  let armToken: any;
  let usdc: any;
  let crowdfund: any;
  let timelockController: any;
  let governor: any;
  let treasuryGov: any;

  // Signers
  let deployer: SignerWithAddress;
  let treasuryAddr: SignerWithAddress;
  let seeds: SignerWithAddress[];
  let hop1Addrs: SignerWithAddress[];

  // Role hashes
  const PROPOSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PROPOSER_ROLE"));
  const EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EXECUTOR_ROLE"));
  const TIMELOCK_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ADMIN_ROLE"));

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    treasuryAddr = signers[1];
    seeds = signers.slice(2, 102);      // 100 seeds
    hop1Addrs = signers.slice(102, 112); // 10 hop-1

    // Deploy tokens
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
    await armToken.waitForDeployment();
    await armToken.initWhitelist([deployer.address]);

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Deploy crowdfund
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasuryAddr.address,
      deployer.address,
      deployer.address,       // securityCouncil
      openTimestamp,           // openTimestamp
      false                    // single-tx settlement
    );
    await crowdfund.waitForDeployment();

    // Fund ARM to crowdfund (1.8M for MAX_SALE)
    await armToken.transfer(await crowdfund.getAddress(), CROWDFUND_ARM_FUNDING);
    await crowdfund.loadArm();

    // Deploy governance
    const MAX_PAUSE_DURATION = 14 * ONE_DAY;

    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      ONE_DAY,
      [deployer.address],
      [deployer.address],
      deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    governor = await deployGovernorProxy(
      await armToken.getAddress(),
      timelockAddr,
      treasuryAddr.address,
      deployer.address, MAX_PAUSE_DURATION
    );

    // Grant governor roles on timelock
    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());

    // Register crowdfund for governance quiet period
    await governor.setCrowdfundAddress(await crowdfund.getAddress());

    // Deploy TreasuryGov (holds ARM for governance distributions)
    // Owner is set to timelock at deployment and is immutable — governance controls the treasury
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasuryGov = await ArmadaTreasuryGov.deploy(timelockAddr, deployer.address, MAX_PAUSE_DURATION);
    await treasuryGov.waitForDeployment();

    // Whitelist contracts that transfer ARM tokens
    await armToken.addToWhitelist(await crowdfund.getAddress());

    // Send most ARM to treasury address to make quorum reachable.
    // Keep DEPLOYER_KEEP for governance testing.
    const deployerBal = await armToken.balanceOf(deployer.address);
    const TREASURY_ARM_ALLOCATION = deployerBal - DEPLOYER_KEEP;
    await armToken.transfer(treasuryAddr.address, TREASURY_ARM_ALLOCATION);
  });

  // ============ End-to-End Lifecycle ============

  describe("End-to-End: Crowdfund → Governance", function () {
    it("full lifecycle: crowdfund seeds claim ARM, lock, propose, vote, queue, execute", async function () {
      // === CROWDFUND PHASE ===

      // 1. Add seeds and start invitations
      { const ws = Number(await crowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      // 2. Seeds invite hop-1 addresses
      for (let i = 0; i < 3 && i < hop1Addrs.length; i++) {
        await crowdfund.connect(seeds[i]).invite(hop1Addrs[i].address, 0);
      }

      // 3. All seeds commit $15K each = $1.2M (meets MIN_SALE)
      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(0, amount);
      }

      // 4. Fast-forward past active window
      await time.increase(THREE_WEEKS + 1);

      // 5. Finalize
      await crowdfund.finalize();
      expect(await crowdfund.phase()).to.equal(1); // Finalized

      // 6. Seeds claim their ARM
      const claimedSeeds = seeds.slice(0, 5); // claim first 5 for governance testing
      for (const seed of claimedSeeds) {
        await crowdfund.connect(seed).claim(ethers.ZeroAddress);
      }

      // Verify seeds received ARM
      const seed0Arm = await armToken.balanceOf(claimedSeeds[0].address);
      expect(seed0Arm).to.be.gt(0);

      // === GOVERNANCE PHASE ===

      // 6b. Skip past 7-day governance quiet period
      await time.increase(SEVEN_DAYS + 1);

      // 7. Deployer and seeds delegate to activate ERC20Votes voting power
      await armToken.delegate(deployer.address);

      // 8. Seeds delegate their claimed ARM for voting power
      for (const seed of claimedSeeds) {
        await armToken.connect(seed).delegate(seed.address);
      }

      // Verify voting power
      await mine(1); // need a new block for snapshot
      const seed0VotingPower = await armToken.getVotes(claimedSeeds[0].address);
      expect(seed0VotingPower).to.be.gt(0);

      // 9. Create a governance proposal (treasury owner is already the timelock from deployment)
      // Fund treasury with a small amount of USDC so the distribute call succeeds
      await usdc.mint(await treasuryGov.getAddress(), 1);
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      const proposalTx = await governor.propose(
        ProposalType.Standard,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Test proposal from crowdfund participants"
      );
      const receipt = await proposalTx.wait();
      const proposalId = 1;

      // 10. Wait for voting delay (2 days)
      await time.increase(TWO_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      // 11. Seeds vote FOR the proposal
      for (const seed of claimedSeeds) {
        await governor.connect(seed).castVote(proposalId, Vote.For);
      }

      // Deployer also votes
      await governor.castVote(proposalId, Vote.For);

      // 12. Verify vote tallies
      const [, , , , forVotes, againstVotes, abstainVotes] = await governor.getProposal(proposalId);
      expect(forVotes).to.be.gt(0);
      expect(againstVotes).to.equal(0);

      // 13. Wait for voting period to end (7 days)
      await time.increase(SEVEN_DAYS + 1);

      // Check quorum is reached
      const state = await governor.state(proposalId);
      expect(state).to.equal(ProposalState.Succeeded);

      // 14. Queue to timelock
      await governor.queue(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

      // 15. Wait for execution delay (2 days timelock)
      await time.increase(TWO_DAYS + 1);

      // 16. Execute
      await governor.execute(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Executed);
    });
  });

  // ============ Token Supply Consistency ============

  describe("Token Supply Consistency", function () {
    async function runCrowdfundAndClaim() {
      { const ws = Number(await crowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(0, amount);
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Claim all
      for (const seed of seeds) {
        await crowdfund.connect(seed).claim(ethers.ZeroAddress);
      }

      // Skip past 7-day governance quiet period
      await time.increase(SEVEN_DAYS + 1);
    }

    it("ARM total supply is constant after crowdfund distribution", async function () {
      await runCrowdfundAndClaim();

      const totalSupply = await armToken.totalSupply();
      const INITIAL_SUPPLY = await armToken.INITIAL_SUPPLY();
      expect(totalSupply).to.equal(INITIAL_SUPPLY);
    });

    it("quorum calculation remains correct after crowdfund distributes tokens", async function () {
      await runCrowdfundAndClaim();

      // Quorum = (totalSupply - treasuryBalance) * quorumBps / 10000
      await armToken.delegate(deployer.address); // activate ERC20Votes voting power
      await mine(1);

      // Create proposal to check quorum
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      await governor.propose(
        ProposalType.Standard,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Quorum test"
      );

      const quorum = await governor.quorum(1);
      const totalSupply = await armToken.totalSupply();
      const treasuryBalance = await armToken.balanceOf(treasuryAddr.address);
      const eligibleSupply = totalSupply - treasuryBalance;
      const expectedQuorum = (eligibleSupply * 2000n) / 10000n;

      expect(quorum).to.equal(expectedQuorum);
    });

    it("proposal threshold (0.1% of total supply) is reachable by crowdfund participants", async function () {
      await runCrowdfundAndClaim();

      // With BASE_SALE ($1.2M), hop-0 ceiling = 70% of netRaise = 70% of $1.14M = $798K.
      // 80 seeds * $15K = $1.2M demand > $798K ceiling → pro-rata.
      // Each seed gets (15K * 798K) / 1.2M = $9,975 = 9,975 ARM.
      // Threshold = 0.1% of total supply.

      const threshold = await governor.proposalThreshold();
      const INITIAL_SUPPLY = await armToken.INITIAL_SUPPLY();
      expect(threshold).to.equal((INITIAL_SUPPLY * 10n) / 10000n); // 0.1% = 10 bps

      // Single seed's ARM balance
      const seedBalance = await armToken.balanceOf(seeds[0].address);
      expect(seedBalance).to.be.lt(threshold); // single seed can't propose

      // 11 seeds pooling tokens: transfer to one address
      // Whitelist seeds so they can transfer ARM to the pooled address
      for (let i = 0; i < 11; i++) {
        await armToken.addToWhitelist(seeds[i].address);
      }
      const pooledSeed = seeds[0];
      for (let i = 1; i < 11; i++) {
        const bal = await armToken.balanceOf(seeds[i].address);
        await armToken.connect(seeds[i]).transfer(pooledSeed.address, bal);
      }

      const pooledBalance = await armToken.balanceOf(pooledSeed.address);
      expect(pooledBalance).to.be.gte(threshold); // pooled seeds can propose

      // Delegate and propose
      await armToken.connect(pooledSeed).delegate(pooledSeed.address);
      await mine(1);

      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      await expect(
        governor.connect(pooledSeed).propose(
          ProposalType.Standard,
          [await treasuryGov.getAddress()],
          [0],
          [dummyCalldata],
          "Crowdfund participants' first proposal"
        )
      ).to.not.be.reverted;
    });
  });

  // ============ Adversarial Cross-Contract ============

  describe("Adversarial Cross-Contract", function () {
    async function setupCrowdfundAndGovernance() {
      // Run crowdfund
      { const ws = Number(await crowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(0, amount);
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Claim first 10 seeds
      for (let i = 0; i < 10; i++) {
        await crowdfund.connect(seeds[i]).claim(ethers.ZeroAddress);
      }

      // Skip past 7-day governance quiet period
      await time.increase(SEVEN_DAYS + 1);

      // Deployer delegates to activate ERC20Votes voting power
      await armToken.delegate(deployer.address);
    }

    it("claim ARM, delegate, transfer to other address — other address has no voting power at snapshot", async function () {
      await setupCrowdfundAndGovernance();

      const alice = seeds[0];

      // Alice delegates to herself to activate ERC20Votes voting power
      await armToken.connect(alice).delegate(alice.address);

      // Create proposal (snapshot is taken at current block - 1)
      await mine(1);
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      await governor.propose(
        ProposalType.Standard,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Snapshot test"
      );
      const proposalId = 1;

      // Now alice transfers ARM to a non-participant (address with no prior delegation)
      const aliceBalance = await armToken.balanceOf(alice.address);
      await armToken.addToWhitelist(alice.address); // whitelist so alice can transfer
      const recipient = hop1Addrs[0]; // never delegated before
      await armToken.connect(alice).transfer(recipient.address, aliceBalance);

      // Recipient delegates (after proposal creation)
      await armToken.connect(recipient).delegate(recipient.address);

      // Fast-forward to voting period
      await time.increase(TWO_DAYS + 1);

      // Recipient tries to vote — should fail (no voting power at snapshot block)
      await expect(
        governor.connect(recipient).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");

      // Alice had voting power at snapshot (delegated before proposal), so she CAN still vote
      // even though she transferred her tokens after proposal creation.
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Verify alice's vote was counted
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;
    });

    it("governance proposal can call permissionless withdrawUnallocatedArm via timelock", async function () {
      await setupCrowdfundAndGovernance();

      // withdrawUnallocatedArm is permissionless, so governance can call it
      // even though timelock is not the crowdfund admin.

      // Seeds delegate to activate voting power
      for (let i = 0; i < 10; i++) {
        await armToken.connect(seeds[i]).delegate(seeds[i].address);
      }
      await mine(1);

      // Create proposal to sweep unallocated ARM via timelock
      const sweepCalldata = crowdfund.interface.encodeFunctionData(
        "withdrawUnallocatedArm"
      );

      await governor.propose(
        ProposalType.Standard,
        [await crowdfund.getAddress()],
        [0],
        [sweepCalldata],
        "Sweep unallocated ARM to treasury via governance"
      );
      const proposalId = 1;

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      for (let i = 0; i < 10; i++) {
        await governor.connect(seeds[i]).castVote(proposalId, Vote.For);
      }
      await governor.castVote(proposalId, Vote.For);
      await time.increase(SEVEN_DAYS + 1);

      // Queue and wait
      await governor.queue(proposalId);
      await time.increase(TWO_DAYS + 1);

      // Execute succeeds — withdrawUnallocatedArm is permissionless
      await governor.execute(proposalId);
    });

    it("voting power reflects delegation state at proposal snapshot, not current state", async function () {
      await setupCrowdfundAndGovernance();

      const alice = seeds[0];
      const bob = seeds[1];

      // Alice delegates to activate ERC20Votes voting power
      await armToken.connect(alice).delegate(alice.address);

      // Bob does NOT delegate yet
      await mine(2);

      // Create proposal — snapshot is block.number - 1
      // At snapshot: Alice has voting power, Bob does not
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      await governor.propose(
        ProposalType.Standard,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Snapshot timing test"
      );
      const proposalId = 1;

      // NOW bob delegates (after proposal creation)
      await armToken.connect(bob).delegate(bob.address);

      // Fast-forward to voting
      await time.increase(TWO_DAYS + 1);

      // Alice can vote (had power at snapshot)
      await governor.connect(alice).castVote(proposalId, Vote.For);
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;

      // Bob cannot vote (delegated AFTER snapshot)
      await expect(
        governor.connect(bob).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });

    it("double-claim prevention across crowdfund claim and governance vote", async function () {
      await setupCrowdfundAndGovernance();

      const alice = seeds[0]; // already claimed in setup

      // Alice tries to claim again — should revert
      await expect(
        crowdfund.connect(alice).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM already claimed");

      // Alice delegates and votes
      await armToken.connect(alice).delegate(alice.address);
      await mine(1);

      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      await governor.propose(
        ProposalType.Standard,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Double-claim test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      // Alice tries to cast the same vote again — should revert
      await expect(
        governor.connect(alice).castVote(1, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: same vote");
    });

    it("unclaimed crowdfund participant cannot vote (no ARM, no delegation, no voting power)", async function () {
      // Run crowdfund but DON'T claim
      { const ws = Number(await crowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(0, amount);
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Skip past 7-day governance quiet period
      await time.increase(SEVEN_DAYS + 1);

      // DON'T claim — seeds have 0 ARM balance
      expect(await armToken.balanceOf(seeds[0].address)).to.equal(0);

      // Deployer delegates to create proposal
      await armToken.delegate(deployer.address);
      await mine(1);

      const dummyCalldata = treasuryGov.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
      await governor.propose(
        ProposalType.Standard,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Unclaimed test"
      );

      await time.increase(TWO_DAYS + 1);

      // Unclaimed seed tries to vote — no ARM, no delegation, no voting power
      await expect(
        governor.connect(seeds[0]).castVote(1, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });
  });

  // ============ Unified Treasury Integration ============

  describe("Unified Treasury Integration", function () {
    // Mirrors the real deployment sequence:
    // 1. Deploy canonical ARM token (governance deploys it)
    // 2. Deploy full governance stack
    // 3. Send treasury allocation ARM to treasury
    // 4. Deploy crowdfund with same ARM token + treasury address
    // 5. Send crowdfund allocation from deployer remainder
    // 6. Register crowdfund in governor quorum exclusion
    // 7. Verify balances, run crowdfund, verify quorum shifts, governance works

    // Named constants for this test suite's ARM distribution — derived from supply
    const TOTAL_SUPPLY = ARM(12_000_000);                    // must match ArmadaToken.INITIAL_SUPPLY
    const TREASURY_ALLOCATION = TOTAL_SUPPLY * 65n / 100n;   // 65% to treasury
    const CROWDFUND_ALLOCATION = ARM(1_800_000);              // MAX_SALE (fixed by crowdfund economics)

    let localArmToken: any;
    let localUsdc: any;
    let localCrowdfund: any;
    let localTimelockController: any;
    let localGovernor: any;
    let localTreasury: any;
    let localDeployer: SignerWithAddress;
    let localSeeds: SignerWithAddress[];

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      localDeployer = signers[0];
      localSeeds = signers.slice(2, 102); // 100 seeds

      // Step 1: Deploy canonical ARM token
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      localArmToken = await ArmadaToken.deploy(localDeployer.address, localDeployer.address);
      await localArmToken.waitForDeployment();
      await localArmToken.initWhitelist([localDeployer.address]);

      // Step 2: Deploy governance stack
      const LOCAL_MAX_PAUSE = 14 * ONE_DAY;

      const TimelockController = await ethers.getContractFactory("TimelockController");
      localTimelockController = await TimelockController.deploy(
        ONE_DAY,
        [localDeployer.address],
        [localDeployer.address],
        localDeployer.address
      );
      await localTimelockController.waitForDeployment();
      const localTlAddr = await localTimelockController.getAddress();

      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      localTreasury = await ArmadaTreasuryGov.deploy(
        localTlAddr, localDeployer.address, LOCAL_MAX_PAUSE
      );
      await localTreasury.waitForDeployment();

      localGovernor = await deployGovernorProxy(
        await localArmToken.getAddress(),
        localTlAddr,
        await localTreasury.getAddress(),
        localDeployer.address, LOCAL_MAX_PAUSE
      );

      // Grant governor roles on timelock
      const PROPOSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PROPOSER_ROLE"));
      const EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EXECUTOR_ROLE"));
      await localTimelockController.grantRole(PROPOSER_ROLE, await localGovernor.getAddress());
      await localTimelockController.grantRole(EXECUTOR_ROLE, await localGovernor.getAddress());

      // Step 3: Send treasury allocation
      await localArmToken.transfer(await localTreasury.getAddress(), TREASURY_ALLOCATION);

      // Step 4: Deploy crowdfund with shared ARM + treasury
      const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
      localUsdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
      await localUsdc.waitForDeployment();

      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const localOpenTimestamp = (await time.latest()) + 300;
      localCrowdfund = await ArmadaCrowdfund.deploy(
        await localUsdc.getAddress(),
        await localArmToken.getAddress(),
        await localTreasury.getAddress(),
        localDeployer.address,
        localDeployer.address,  // securityCouncil
        localOpenTimestamp,      // openTimestamp
        false                    // single-tx settlement
      );
      await localCrowdfund.waitForDeployment();

      // Whitelist contracts that transfer ARM tokens
      await localArmToken.addToWhitelist(await localCrowdfund.getAddress());

      // Step 5: Fund crowdfund from deployer remainder
      await localArmToken.transfer(await localCrowdfund.getAddress(), CROWDFUND_ALLOCATION);
      await localCrowdfund.loadArm();

      // Step 6: Register crowdfund in quorum exclusion and quiet period
      await localGovernor.setExcludedAddresses([await localCrowdfund.getAddress()]);
      await localGovernor.setCrowdfundAddress(await localCrowdfund.getAddress());
    });

    it("all ARM balances sum to total supply", async function () {
      const totalSupply = await localArmToken.totalSupply();
      expect(totalSupply).to.equal(TOTAL_SUPPLY);

      const treasuryBal = await localArmToken.balanceOf(await localTreasury.getAddress());
      const crowdfundBal = await localArmToken.balanceOf(await localCrowdfund.getAddress());
      const deployerBal = await localArmToken.balanceOf(localDeployer.address);

      // Treasury + crowdfund + deployer remainder = total supply
      expect(treasuryBal + crowdfundBal + deployerBal).to.equal(TOTAL_SUPPLY);
      expect(treasuryBal).to.equal(TREASURY_ALLOCATION);
      expect(crowdfundBal).to.equal(CROWDFUND_ALLOCATION);

      // Deployer remainder = total - treasury - crowdfund
      const expectedRemainder = TOTAL_SUPPLY - TREASURY_ALLOCATION - CROWDFUND_ALLOCATION;
      expect(deployerBal).to.equal(expectedRemainder);
    });

    it("quorum excludes both treasury and crowdfund balances", async function () {
      // Delegate deployer tokens for proposal threshold
      await localArmToken.delegate(localDeployer.address);
      await mine(1);

      // Create a proposal to get quorum value
      const dummyCalldata = localTreasury.interface.encodeFunctionData("distribute", [await localUsdc.getAddress(), localDeployer.address, 1]);
      await localGovernor.propose(
        ProposalType.Standard,
        [await localTreasury.getAddress()],
        [0],
        [dummyCalldata],
        "Quorum exclusion test"
      );

      const quorum = await localGovernor.quorum(1);
      const totalSupply = await localArmToken.totalSupply();
      const treasuryBal = await localArmToken.balanceOf(await localTreasury.getAddress());
      const crowdfundBal = await localArmToken.balanceOf(await localCrowdfund.getAddress());

      // eligibleSupply = totalSupply - treasury - crowdfund
      const eligibleSupply = totalSupply - treasuryBal - crowdfundBal;
      const expectedQuorum = (eligibleSupply * 2000n) / 10000n; // 20% of eligible

      expect(quorum).to.equal(expectedQuorum);
    });

    it("quorum denominator shifts as participants claim ARM from crowdfund", async function () {
      // Run crowdfund lifecycle
      { const ws = Number(await localCrowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(0, amount);
      }

      await time.increase(THREE_WEEKS + 1);
      await localCrowdfund.finalize();

      // Skip quiet period so governance proposals can proceed
      await time.increase(SEVEN_DAYS + 1);

      // Before any claims: crowdfund still holds all ARM
      const crowdfundArmBefore = await localArmToken.balanceOf(await localCrowdfund.getAddress());

      // Delegate deployer tokens for proposal
      await localArmToken.delegate(localDeployer.address);
      await mine(1);

      // Create proposal before claims
      const dummyCalldata = localTreasury.interface.encodeFunctionData("distribute", [await localUsdc.getAddress(), localDeployer.address, 1]);
      await localGovernor.propose(
        ProposalType.Standard,
        [await localTreasury.getAddress()],
        [0],
        [dummyCalldata],
        "Pre-claim quorum test"
      );
      const quorumBefore = await localGovernor.quorum(1);

      // Now all seeds claim their ARM — ARM leaves the crowdfund contract
      for (const seed of localSeeds) {
        await localCrowdfund.connect(seed).claim(ethers.ZeroAddress);
      }

      const crowdfundArmAfter = await localArmToken.balanceOf(await localCrowdfund.getAddress());
      expect(crowdfundArmAfter).to.be.lt(crowdfundArmBefore);

      // Create another proposal after claims
      await mine(1);
      await localGovernor.propose(
        ProposalType.Standard,
        [await localTreasury.getAddress()],
        [0],
        [dummyCalldata],
        "Post-claim quorum test"
      );
      const quorumAfter = await localGovernor.quorum(2);

      // After claims, crowdfund holds less ARM → excluded balance is smaller →
      // eligible supply is larger → quorum is larger
      expect(quorumAfter).to.be.gt(quorumBefore);
    });

    it("finalize pushes USDC proceeds to treasury contract", async function () {
      // Run crowdfund
      { const ws = Number(await localCrowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(0, amount);
      }

      await time.increase(THREE_WEEKS + 1);
      await localCrowdfund.finalize();

      // All seeds claim
      for (const seed of localSeeds) {
        await localCrowdfund.connect(seed).claim(ethers.ZeroAddress);
      }

      const treasuryAddress = await localTreasury.getAddress();

      // Proceeds are pushed to treasury at finalization (minus small rounding buffer)
      const treasuryUsdc = await localUsdc.balanceOf(treasuryAddress);
      const totalAllocUsdc = await localCrowdfund.totalAllocatedUsdc();
      // Treasury receives proceeds minus rounding buffer (at most ~participantCount units)
      expect(treasuryUsdc).to.be.gte(totalAllocUsdc - 500n);
      expect(treasuryUsdc).to.be.lte(totalAllocUsdc);
    });

    it("withdrawUnallocatedArm sends ARM to treasury contract", async function () {
      // Run crowdfund
      { const ws = Number(await localCrowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(0, amount);
      }

      await time.increase(THREE_WEEKS + 1);
      await localCrowdfund.finalize();

      const treasuryAddress = await localTreasury.getAddress();
      const armBefore = await localArmToken.balanceOf(treasuryAddress);

      await localCrowdfund.withdrawUnallocatedArm();

      const armAfter = await localArmToken.balanceOf(treasuryAddress);
      // Unallocated ARM (excess beyond what's owed to claimants) goes to treasury
      expect(armAfter).to.be.gt(armBefore);
    });

    it("full lifecycle: crowdfund → claim → delegate → propose → vote → execute", async function () {
      // Run crowdfund
      { const ws = Number(await localCrowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(0, amount);
      }

      await time.increase(THREE_WEEKS + 1);
      await localCrowdfund.finalize();

      // 5 seeds claim
      const claimedSeeds = localSeeds.slice(0, 5);
      for (const seed of claimedSeeds) {
        await localCrowdfund.connect(seed).claim(ethers.ZeroAddress);
      }

      // Skip past 7-day governance quiet period
      await time.increase(SEVEN_DAYS + 1);

      // Deployer and seeds delegate to activate ERC20Votes voting power
      await localArmToken.delegate(localDeployer.address);

      // Seeds delegate their claimed ARM
      for (const seed of claimedSeeds) {
        await localArmToken.connect(seed).delegate(seed.address);
      }

      await mine(1);

      // Fund treasury with a small amount of USDC so the distribute call succeeds
      await localUsdc.mint(await localTreasury.getAddress(), 1);
      const dummyCalldata = localTreasury.interface.encodeFunctionData("distribute", [await localUsdc.getAddress(), localDeployer.address, 1]);
      await localGovernor.propose(
        ProposalType.Standard,
        [await localTreasury.getAddress()],
        [0],
        [dummyCalldata],
        "Full lifecycle integration test"
      );
      const proposalId = 1;

      // Vote
      await time.increase(TWO_DAYS + 1);
      for (const seed of claimedSeeds) {
        await localGovernor.connect(seed).castVote(proposalId, Vote.For);
      }
      await localGovernor.castVote(proposalId, Vote.For);

      // Wait for voting period (7 days)
      await time.increase(SEVEN_DAYS + 1);
      expect(await localGovernor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Queue and execute
      await localGovernor.queue(proposalId);
      await time.increase(TWO_DAYS + 1);
      await localGovernor.execute(proposalId);
      expect(await localGovernor.state(proposalId)).to.equal(ProposalState.Executed);
    });

    it("setExcludedAddresses is one-time only", async function () {
      // The beforeEach already called setExcludedAddresses once
      await expect(
        localGovernor.setExcludedAddresses([localDeployer.address])
      ).to.be.revertedWith("ArmadaGovernor: already locked");
    });

    it("getExcludedFromQuorum returns registered addresses", async function () {
      const excluded = await localGovernor.getExcludedFromQuorum();
      expect(excluded.length).to.equal(1);
      expect(excluded[0]).to.equal(await localCrowdfund.getAddress());
    });

    it("non-deployer cannot call setExcludedAddresses", async function () {
      // Deploy a fresh governor to test (the existing one already has it locked)
      const freshGovernor = await deployGovernorProxy(
        await localArmToken.getAddress(),
        await localTimelockController.getAddress(),
        await localTreasury.getAddress(),
        localDeployer.address, 14 * ONE_DAY
      );

      // Non-deployer tries to call
      const nonDeployer = localSeeds[0];
      await expect(
        freshGovernor.connect(nonDeployer).setExcludedAddresses([localDeployer.address])
      ).to.be.revertedWith("ArmadaGovernor: not deployer");
    });
  });
});
