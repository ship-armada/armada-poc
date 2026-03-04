/**
 * Cross-Contract Integration Tests (Phase 6)
 *
 * Tests the full lifecycle across all contracts:
 * 1. End-to-end: crowdfund → claim ARM → lock in VotingLocker → propose → vote → execute
 * 2. Token supply consistency: quorum calculations after crowdfund distributes tokens
 * 3. Adversarial cross-contract: snapshot manipulation, timelock permission checks
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ProposalType = { ParameterChange: 0, Treasury: 1, StewardElection: 2 };
const ProposalState = {
  Pending: 0, Active: 1, Defeated: 2, Succeeded: 3,
  Queued: 4, Executed: 5, Canceled: 6,
};
const Vote = { Against: 0, For: 1, Abstain: 2 };

const ONE_DAY = 86400;
const TWO_DAYS = 2 * ONE_DAY;
const FIVE_DAYS = 5 * ONE_DAY;
const TWO_WEEKS = 14 * ONE_DAY;
const ONE_WEEK = 7 * ONE_DAY;

const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

describe("Cross-Contract Integration (Phase 6)", function () {
  // Contracts
  let armToken: any;
  let usdc: any;
  let crowdfund: any;
  let votingLocker: any;
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
    seeds = signers.slice(2, 82);      // 80 seeds
    hop1Addrs = signers.slice(82, 92); // 10 hop-1

    // Deploy tokens
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address);
    await armToken.waitForDeployment();

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Deploy crowdfund
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      deployer.address,
      treasuryAddr.address
    );
    await crowdfund.waitForDeployment();

    // Fund ARM to crowdfund (1.8M for MAX_SALE)
    await armToken.transfer(await crowdfund.getAddress(), CROWDFUND_ARM_FUNDING);

    // Deploy governance
    const VotingLocker = await ethers.getContractFactory("VotingLocker");
    votingLocker = await VotingLocker.deploy(await armToken.getAddress());
    await votingLocker.waitForDeployment();

    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      ONE_DAY,
      [deployer.address],
      [deployer.address],
      deployer.address
    );
    await timelockController.waitForDeployment();

    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await votingLocker.getAddress(),
      await armToken.getAddress(),
      await timelockController.getAddress(),
      treasuryAddr.address
    );
    await governor.waitForDeployment();

    // Grant governor roles on timelock
    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());

    // Deploy TreasuryGov (holds ARM for governance distributions)
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasuryGov = await ArmadaTreasuryGov.deploy(deployer.address);
    await treasuryGov.waitForDeployment();

    // Send most ARM to treasury address to make quorum reachable
    // Deployer starts with 100M - 1.8M (crowdfund) = 98.2M ARM
    // Send 97M to treasury so eligible supply = 100M - 97M = 3M
    // Quorum (20%) = 600K ARM — reachable with deployer lock + seed claims
    const TREASURY_ARM_ALLOCATION = ARM(97_000_000);
    await armToken.transfer(treasuryAddr.address, TREASURY_ARM_ALLOCATION);
  });

  // ============ End-to-End Lifecycle ============

  describe("End-to-End: Crowdfund → Governance", function () {
    it("full lifecycle: crowdfund seeds claim ARM, lock, propose, vote, queue, execute", async function () {
      // === CROWDFUND PHASE ===

      // 1. Add seeds and start invitations
      await crowdfund.addSeeds(seeds.map(s => s.address));
      await crowdfund.startInvitations();

      // 2. Seeds invite hop-1 addresses
      for (let i = 0; i < 3 && i < hop1Addrs.length; i++) {
        await crowdfund.connect(seeds[i]).invite(hop1Addrs[i].address);
      }

      // 3. Fast-forward past invitation window into commitment window
      await time.increase(TWO_WEEKS + 1);

      // 4. All seeds commit $15K each = $1.2M (meets MIN_SALE)
      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(amount);
      }

      // 5. Fast-forward past commitment window
      await time.increase(ONE_WEEK + 1);

      // 6. Finalize
      await crowdfund.finalize();
      expect(await crowdfund.phase()).to.equal(3); // Finalized

      // 7. Seeds claim their ARM
      const claimedSeeds = seeds.slice(0, 5); // claim first 5 for governance testing
      for (const seed of claimedSeeds) {
        await crowdfund.connect(seed).claim();
      }

      // Verify seeds received ARM
      const seed0Arm = await armToken.balanceOf(claimedSeeds[0].address);
      expect(seed0Arm).to.be.gt(0);

      // === GOVERNANCE PHASE ===

      // 8. Deployer needs voting power to propose AND reach quorum
      // Treasury has 97M ARM → eligible supply = 3M → quorum (20%) = 600K
      // Deployer has 100M - 1.8M(crowdfund) - 97M(treasury) = 1.2M ARM remaining
      const deployerLock = ARM(600_000); // enough for both threshold and quorum
      await armToken.approve(await votingLocker.getAddress(), deployerLock);
      await votingLocker.lock(deployerLock);

      // 9. Seeds lock their claimed ARM in VotingLocker
      for (const seed of claimedSeeds) {
        const balance = await armToken.balanceOf(seed.address);
        await armToken.connect(seed).approve(await votingLocker.getAddress(), balance);
        await votingLocker.connect(seed).lock(balance);
      }

      // Verify voting power
      await mine(1); // need a new block for snapshot
      const seed0VotingPower = await votingLocker.getLockedBalance(claimedSeeds[0].address);
      expect(seed0VotingPower).to.equal(seed0Arm);

      // 10. Transfer TreasuryGov ownership to timelock so governance can execute on it
      await treasuryGov.transferOwnership(await timelockController.getAddress());

      // Deployer creates a ParameterChange proposal to transfer ownership back
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      const proposalTx = await governor.propose(
        ProposalType.ParameterChange,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Test proposal from crowdfund participants"
      );
      const receipt = await proposalTx.wait();
      const proposalId = 1;

      // 11. Wait for voting delay (2 days)
      await time.increase(TWO_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      // 12. Seeds vote FOR the proposal
      for (const seed of claimedSeeds) {
        await governor.connect(seed).castVote(proposalId, Vote.For);
      }

      // Deployer also votes
      await governor.castVote(proposalId, Vote.For);

      // 13. Verify vote tallies
      const [, , , , forVotes, againstVotes, abstainVotes] = await governor.getProposal(proposalId);
      expect(forVotes).to.be.gt(0);
      expect(againstVotes).to.equal(0);

      // 14. Wait for voting period to end (5 days)
      await time.increase(FIVE_DAYS + 1);

      // Check quorum is reached
      const state = await governor.state(proposalId);
      expect(state).to.equal(ProposalState.Succeeded);

      // 15. Queue to timelock
      await governor.queue(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

      // 16. Wait for execution delay (2 days timelock)
      await time.increase(TWO_DAYS + 1);

      // 17. Execute
      await governor.execute(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Executed);
    });
  });

  // ============ Token Supply Consistency ============

  describe("Token Supply Consistency", function () {
    async function runCrowdfundAndClaim() {
      await crowdfund.addSeeds(seeds.map(s => s.address));
      await crowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(amount);
      }

      await time.increase(ONE_WEEK + 1);
      await crowdfund.finalize();

      // Claim all
      for (const seed of seeds) {
        await crowdfund.connect(seed).claim();
      }
    }

    it("ARM total supply remains 100M after crowdfund distribution", async function () {
      await runCrowdfundAndClaim();

      const totalSupply = await armToken.totalSupply();
      expect(totalSupply).to.equal(ARM(100_000_000));
    });

    it("quorum calculation remains correct after crowdfund distributes tokens", async function () {
      await runCrowdfundAndClaim();

      // Treasury already has 97M from beforeEach.
      // quorum = (totalSupply - treasuryBalance) * quorumBps / 10000
      // = (100M - 97M) * 2000 / 10000 = 3M * 0.2 = 600K ARM
      const deployerLock = ARM(200_000);
      await armToken.approve(await votingLocker.getAddress(), deployerLock);
      await votingLocker.lock(deployerLock);
      await mine(1);

      // Create proposal to check quorum
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      await governor.propose(
        ProposalType.ParameterChange,
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
      // Verify the quorum is reachable: 600K ARM, deployer has 200K locked,
      // seeds claimed ~840K total (80 seeds * 10.5K each)
      expect(quorum).to.equal(ARM(600_000));
    });

    it("proposal threshold (0.1% of total supply = 100K ARM) is reachable by crowdfund participant", async function () {
      await runCrowdfundAndClaim();

      // With BASE_SALE ($1.2M), hop-0 reserve = 70% = $840K.
      // 80 seeds * $15K = $1.2M demand > $840K reserve → pro-rata.
      // Each seed gets (15K * 840K) / 1.2M = $10,500 = 10,500 ARM.
      // Threshold = 100M * 0.001 = 100,000 ARM.
      // Need ceil(100K / 10.5K) = 10 seeds pooled.

      const threshold = await governor.proposalThreshold();
      expect(threshold).to.equal(ARM(100_000));

      // Single seed's ARM balance
      const seedBalance = await armToken.balanceOf(seeds[0].address);
      expect(seedBalance).to.be.lt(threshold); // single seed can't propose

      // 10 seeds pooling tokens: transfer to one address
      const pooledSeed = seeds[0];
      for (let i = 1; i < 10; i++) {
        const bal = await armToken.balanceOf(seeds[i].address);
        await armToken.connect(seeds[i]).transfer(pooledSeed.address, bal);
      }

      const pooledBalance = await armToken.balanceOf(pooledSeed.address);
      expect(pooledBalance).to.be.gte(threshold); // pooled seeds can propose

      // Lock and propose
      await armToken.connect(pooledSeed).approve(await votingLocker.getAddress(), pooledBalance);
      await votingLocker.connect(pooledSeed).lock(pooledBalance);
      await mine(1);

      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      await expect(
        governor.connect(pooledSeed).propose(
          ProposalType.ParameterChange,
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
      await crowdfund.addSeeds(seeds.map(s => s.address));
      await crowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(amount);
      }
      await time.increase(ONE_WEEK + 1);
      await crowdfund.finalize();

      // Claim first 10 seeds
      for (let i = 0; i < 10; i++) {
        await crowdfund.connect(seeds[i]).claim();
      }

      // Deployer locks enough to propose AND reach quorum (600K with 97M in treasury)
      const deployerLock = ARM(600_000);
      await armToken.approve(await votingLocker.getAddress(), deployerLock);
      await votingLocker.lock(deployerLock);
    }

    it("claim ARM, lock, unlock, transfer to other address — other address has no voting power at snapshot", async function () {
      await setupCrowdfundAndGovernance();

      const alice = seeds[0];
      const bob = seeds[9]; // bob already claimed too

      // Alice locks her ARM
      const aliceBalance = await armToken.balanceOf(alice.address);
      await armToken.connect(alice).approve(await votingLocker.getAddress(), aliceBalance);
      await votingLocker.connect(alice).lock(aliceBalance);

      // Create proposal (snapshot is taken at current block - 1)
      await mine(1);
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      await governor.propose(
        ProposalType.ParameterChange,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Snapshot test"
      );
      const proposalId = 1;

      // Now alice unlocks and transfers ARM to a non-participant (address with no prior locks)
      await votingLocker.connect(alice).unlock(aliceBalance);
      const recipient = hop1Addrs[0]; // never locked before
      await armToken.connect(alice).transfer(recipient.address, aliceBalance);

      // Recipient locks the ARM
      await armToken.connect(recipient).approve(await votingLocker.getAddress(), aliceBalance);
      await votingLocker.connect(recipient).lock(aliceBalance);

      // Fast-forward to voting period
      await time.increase(TWO_DAYS + 1);

      // Recipient tries to vote — should fail (no voting power at snapshot block)
      await expect(
        governor.connect(recipient).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");

      // Alice also can't vote (she unlocked before snapshot was for current block - 1,
      // but she had voting power at snapshot block since lock was before proposal)
      // Actually: alice locked BEFORE the proposal, so she HAD power at snapshot.
      // Let's verify alice CAN still vote despite having unlocked after.
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Verify alice's vote was counted
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;
    });

    it("governance proposal calling crowdfund.withdrawProceeds via timelock requires admin role", async function () {
      await setupCrowdfundAndGovernance();

      // The crowdfund admin is the deployer, NOT the timelock.
      // A governance proposal that tries to call withdrawProceeds via timelock should fail
      // because timelock is not the crowdfund admin.

      // Seeds lock to create voting power
      for (let i = 0; i < 10; i++) {
        const bal = await armToken.balanceOf(seeds[i].address);
        await armToken.connect(seeds[i]).approve(await votingLocker.getAddress(), bal);
        await votingLocker.connect(seeds[i]).lock(bal);
      }
      await mine(1);

      // Create proposal to withdraw crowdfund proceeds via timelock
      const withdrawCalldata = crowdfund.interface.encodeFunctionData(
        "withdrawProceeds"
      );

      await governor.propose(
        ProposalType.Treasury,
        [await crowdfund.getAddress()],
        [0],
        [withdrawCalldata],
        "Attempt to withdraw crowdfund proceeds via governance"
      );
      const proposalId = 1;

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      for (let i = 0; i < 10; i++) {
        await governor.connect(seeds[i]).castVote(proposalId, Vote.For);
      }
      await governor.castVote(proposalId, Vote.For);
      await time.increase(FIVE_DAYS + 1);

      // Queue and wait
      await governor.queue(proposalId);
      await time.increase(TWO_DAYS + 1);

      // Execute should revert because timelock is not the crowdfund admin
      await expect(
        governor.execute(proposalId)
      ).to.be.reverted; // TimelockController will revert because the underlying call fails
    });

    it("voting power reflects lock state at proposal snapshot, not current state", async function () {
      await setupCrowdfundAndGovernance();

      const alice = seeds[0];
      const bob = seeds[1];

      // Alice locks 100% of her ARM
      const aliceBal = await armToken.balanceOf(alice.address);
      await armToken.connect(alice).approve(await votingLocker.getAddress(), aliceBal);
      await votingLocker.connect(alice).lock(aliceBal);

      // Bob does NOT lock yet
      await mine(2);

      // Create proposal — snapshot is block.number - 1
      // At snapshot: Alice has voting power, Bob does not
      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      await governor.propose(
        ProposalType.ParameterChange,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Snapshot timing test"
      );
      const proposalId = 1;

      // NOW bob locks (after proposal creation)
      const bobBal = await armToken.balanceOf(bob.address);
      await armToken.connect(bob).approve(await votingLocker.getAddress(), bobBal);
      await votingLocker.connect(bob).lock(bobBal);

      // Fast-forward to voting
      await time.increase(TWO_DAYS + 1);

      // Alice can vote (had power at snapshot)
      await governor.connect(alice).castVote(proposalId, Vote.For);
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;

      // Bob cannot vote (locked AFTER snapshot)
      await expect(
        governor.connect(bob).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });

    it("double-claim prevention across crowdfund claim and governance vote", async function () {
      await setupCrowdfundAndGovernance();

      const alice = seeds[0]; // already claimed in setup

      // Alice tries to claim again — should revert
      await expect(
        crowdfund.connect(alice).claim()
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");

      // Alice locks and votes
      const aliceBal = await armToken.balanceOf(alice.address);
      await armToken.connect(alice).approve(await votingLocker.getAddress(), aliceBal);
      await votingLocker.connect(alice).lock(aliceBal);
      await mine(1);

      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      await governor.propose(
        ProposalType.ParameterChange,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Double-claim test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      // Alice tries to vote again — should revert
      await expect(
        governor.connect(alice).castVote(1, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: already voted");
    });

    it("unclaimed crowdfund participant cannot vote (no ARM, no lock, no voting power)", async function () {
      // Run crowdfund but DON'T claim
      await crowdfund.addSeeds(seeds.map(s => s.address));
      await crowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of seeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(amount);
      }
      await time.increase(ONE_WEEK + 1);
      await crowdfund.finalize();

      // DON'T claim — seeds have 0 ARM balance
      expect(await armToken.balanceOf(seeds[0].address)).to.equal(0);

      // Deployer locks to create proposal
      await armToken.approve(await votingLocker.getAddress(), ARM(200_000));
      await votingLocker.lock(ARM(200_000));
      await mine(1);

      const dummyCalldata = treasuryGov.interface.encodeFunctionData("transferOwnership", [deployer.address]);
      await governor.propose(
        ProposalType.ParameterChange,
        [await treasuryGov.getAddress()],
        [0],
        [dummyCalldata],
        "Unclaimed test"
      );

      await time.increase(TWO_DAYS + 1);

      // Unclaimed seed tries to vote — no ARM, no lock, no voting power
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

    // Named constants for this test suite's ARM distribution
    const TREASURY_ALLOCATION = ARM(65_000_000);  // 65M to treasury
    const CROWDFUND_ALLOCATION = ARM(1_800_000);  // 1.8M to crowdfund
    const TOTAL_SUPPLY = ARM(100_000_000);         // 100M total

    let localArmToken: any;
    let localUsdc: any;
    let localCrowdfund: any;
    let localVotingLocker: any;
    let localTimelockController: any;
    let localGovernor: any;
    let localTreasury: any;
    let localDeployer: SignerWithAddress;
    let localSeeds: SignerWithAddress[];

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      localDeployer = signers[0];
      localSeeds = signers.slice(2, 82); // 80 seeds

      // Step 1: Deploy canonical ARM token
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      localArmToken = await ArmadaToken.deploy(localDeployer.address);
      await localArmToken.waitForDeployment();

      // Step 2: Deploy governance stack
      const VotingLocker = await ethers.getContractFactory("VotingLocker");
      localVotingLocker = await VotingLocker.deploy(await localArmToken.getAddress());
      await localVotingLocker.waitForDeployment();

      const TimelockController = await ethers.getContractFactory("TimelockController");
      localTimelockController = await TimelockController.deploy(
        ONE_DAY,
        [localDeployer.address],
        [localDeployer.address],
        localDeployer.address
      );
      await localTimelockController.waitForDeployment();

      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      localTreasury = await ArmadaTreasuryGov.deploy(
        await localTimelockController.getAddress()
      );
      await localTreasury.waitForDeployment();

      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      localGovernor = await ArmadaGovernor.deploy(
        await localVotingLocker.getAddress(),
        await localArmToken.getAddress(),
        await localTimelockController.getAddress(),
        await localTreasury.getAddress()
      );
      await localGovernor.waitForDeployment();

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
      localCrowdfund = await ArmadaCrowdfund.deploy(
        await localUsdc.getAddress(),
        await localArmToken.getAddress(),
        localDeployer.address,
        await localTreasury.getAddress()
      );
      await localCrowdfund.waitForDeployment();

      // Step 5: Fund crowdfund from deployer remainder
      await localArmToken.transfer(await localCrowdfund.getAddress(), CROWDFUND_ALLOCATION);

      // Step 6: Register crowdfund in quorum exclusion
      await localGovernor.setExcludedAddresses([await localCrowdfund.getAddress()]);
    });

    it("all ARM balances sum to 100M total supply", async function () {
      const totalSupply = await localArmToken.totalSupply();
      expect(totalSupply).to.equal(TOTAL_SUPPLY);

      const treasuryBal = await localArmToken.balanceOf(await localTreasury.getAddress());
      const crowdfundBal = await localArmToken.balanceOf(await localCrowdfund.getAddress());
      const deployerBal = await localArmToken.balanceOf(localDeployer.address);

      // Treasury + crowdfund + deployer remainder = 100M
      expect(treasuryBal + crowdfundBal + deployerBal).to.equal(TOTAL_SUPPLY);
      expect(treasuryBal).to.equal(TREASURY_ALLOCATION);
      expect(crowdfundBal).to.equal(CROWDFUND_ALLOCATION);

      // Deployer remainder = 100M - 65M - 1.8M = 33.2M
      const expectedRemainder = TOTAL_SUPPLY - TREASURY_ALLOCATION - CROWDFUND_ALLOCATION;
      expect(deployerBal).to.equal(expectedRemainder);
    });

    it("quorum excludes both treasury and crowdfund balances", async function () {
      // Lock deployer tokens for proposal threshold
      const deployerLock = ARM(200_000);
      await localArmToken.approve(await localVotingLocker.getAddress(), deployerLock);
      await localVotingLocker.lock(deployerLock);
      await mine(1);

      // Create a proposal to get quorum value
      const dummyCalldata = localTreasury.interface.encodeFunctionData("transferOwnership", [localDeployer.address]);
      await localGovernor.propose(
        ProposalType.ParameterChange,
        [await localTreasury.getAddress()],
        [0],
        [dummyCalldata],
        "Quorum exclusion test"
      );

      const quorum = await localGovernor.quorum(1);
      const totalSupply = await localArmToken.totalSupply();
      const treasuryBal = await localArmToken.balanceOf(await localTreasury.getAddress());
      const crowdfundBal = await localArmToken.balanceOf(await localCrowdfund.getAddress());

      // eligibleSupply = 100M - 65M(treasury) - 1.8M(crowdfund) = 33.2M
      const eligibleSupply = totalSupply - treasuryBal - crowdfundBal;
      const expectedQuorum = (eligibleSupply * 2000n) / 10000n; // 20% of eligible

      expect(quorum).to.equal(expectedQuorum);
      // 33.2M * 20% = 6.64M
      expect(quorum).to.equal(ARM(6_640_000));
    });

    it("quorum denominator shifts as participants claim ARM from crowdfund", async function () {
      // Run crowdfund lifecycle
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));
      await localCrowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(amount);
      }

      await time.increase(ONE_WEEK + 1);
      await localCrowdfund.finalize();

      // Before any claims: crowdfund still holds all ARM
      const crowdfundArmBefore = await localArmToken.balanceOf(await localCrowdfund.getAddress());

      // Lock deployer tokens for proposal
      const deployerLock = ARM(200_000);
      await localArmToken.approve(await localVotingLocker.getAddress(), deployerLock);
      await localVotingLocker.lock(deployerLock);
      await mine(1);

      // Create proposal before claims
      const dummyCalldata = localTreasury.interface.encodeFunctionData("transferOwnership", [localDeployer.address]);
      await localGovernor.propose(
        ProposalType.ParameterChange,
        [await localTreasury.getAddress()],
        [0],
        [dummyCalldata],
        "Pre-claim quorum test"
      );
      const quorumBefore = await localGovernor.quorum(1);

      // Now all seeds claim their ARM — ARM leaves the crowdfund contract
      for (const seed of localSeeds) {
        await localCrowdfund.connect(seed).claim();
      }

      const crowdfundArmAfter = await localArmToken.balanceOf(await localCrowdfund.getAddress());
      expect(crowdfundArmAfter).to.be.lt(crowdfundArmBefore);

      // Create another proposal after claims
      await mine(1);
      await localGovernor.propose(
        ProposalType.ParameterChange,
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

    it("withdrawProceeds sends USDC to treasury contract", async function () {
      // Run crowdfund
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));
      await localCrowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(amount);
      }

      await time.increase(ONE_WEEK + 1);
      await localCrowdfund.finalize();

      // All seeds claim
      for (const seed of localSeeds) {
        await localCrowdfund.connect(seed).claim();
      }

      const treasuryAddress = await localTreasury.getAddress();
      const usdcBefore = await localUsdc.balanceOf(treasuryAddress);

      await localCrowdfund.withdrawProceeds();

      const usdcAfter = await localUsdc.balanceOf(treasuryAddress);
      expect(usdcAfter).to.be.gt(usdcBefore);

      // Proceeds should equal totalProceedsAccrued
      const proceeds = await localCrowdfund.totalProceedsAccrued();
      expect(usdcAfter - usdcBefore).to.equal(proceeds);
    });

    it("withdrawUnallocatedArm sends ARM to treasury contract", async function () {
      // Run crowdfund
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));
      await localCrowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(amount);
      }

      await time.increase(ONE_WEEK + 1);
      await localCrowdfund.finalize();

      const treasuryAddress = await localTreasury.getAddress();
      const armBefore = await localArmToken.balanceOf(treasuryAddress);

      await localCrowdfund.withdrawUnallocatedArm();

      const armAfter = await localArmToken.balanceOf(treasuryAddress);
      // Unallocated ARM (excess beyond what's owed to claimants) goes to treasury
      expect(armAfter).to.be.gt(armBefore);
    });

    it("full lifecycle: crowdfund → claim → lock → propose → vote → execute", async function () {
      // Run crowdfund
      await localCrowdfund.addSeeds(localSeeds.map(s => s.address));
      await localCrowdfund.startInvitations();
      await time.increase(TWO_WEEKS + 1);

      for (const seed of localSeeds) {
        const amount = USDC(15_000);
        await localUsdc.mint(seed.address, amount);
        await localUsdc.connect(seed).approve(await localCrowdfund.getAddress(), amount);
        await localCrowdfund.connect(seed).commit(amount);
      }

      await time.increase(ONE_WEEK + 1);
      await localCrowdfund.finalize();

      // 5 seeds claim
      const claimedSeeds = localSeeds.slice(0, 5);
      for (const seed of claimedSeeds) {
        await localCrowdfund.connect(seed).claim();
      }

      // Deployer locks enough to propose
      const deployerLock = ARM(6_700_000); // > 6.64M quorum
      await localArmToken.approve(await localVotingLocker.getAddress(), deployerLock);
      await localVotingLocker.lock(deployerLock);

      // Seeds lock their claimed ARM
      for (const seed of claimedSeeds) {
        const balance = await localArmToken.balanceOf(seed.address);
        await localArmToken.connect(seed).approve(await localVotingLocker.getAddress(), balance);
        await localVotingLocker.connect(seed).lock(balance);
      }

      await mine(1);

      // Propose: transfer treasury ownership back to deployer (demo action)
      const dummyCalldata = localTreasury.interface.encodeFunctionData("transferOwnership", [localDeployer.address]);
      await localGovernor.propose(
        ProposalType.ParameterChange,
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

      // Wait for voting period
      await time.increase(FIVE_DAYS + 1);
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
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      const freshGovernor = await ArmadaGovernor.deploy(
        await localVotingLocker.getAddress(),
        await localArmToken.getAddress(),
        await localTimelockController.getAddress(),
        await localTreasury.getAddress()
      );
      await freshGovernor.waitForDeployment();

      // Non-deployer tries to call
      const nonDeployer = localSeeds[0];
      await expect(
        freshGovernor.connect(nonDeployer).setExcludedAddresses([localDeployer.address])
      ).to.be.revertedWith("ArmadaGovernor: not deployer");
    });
  });
});
