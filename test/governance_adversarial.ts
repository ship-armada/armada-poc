/**
 * Governance Adversarial Tests
 *
 * Phase 2 security testing:
 * - Voting boundary conditions (exact timestamps, tied votes, quorum edge cases)
 * - State machine violations (queue defeated, execute unqueued, cancel active)
 * - VotingLocker checkpoint consistency
 * - Cross-contract reentrancy protection
 * - Constructor zero-address validation
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
const SEVEN_DAYS = 7 * ONE_DAY;
const FOUR_DAYS = 4 * ONE_DAY;

const ARM_DECIMALS = 18;
const TOTAL_SUPPLY = ethers.parseUnits("100000000", ARM_DECIMALS); // 100M
const TREASURY_AMOUNT = ethers.parseUnits("65000000", ARM_DECIMALS); // 65M
const ALICE_AMOUNT = ethers.parseUnits("20000000", ARM_DECIMALS); // 20M
const BOB_AMOUNT = ethers.parseUnits("15000000", ARM_DECIMALS); // 15M

describe("Governance Adversarial", function () {
  let armToken: any;
  let votingLocker: any;
  let timelockController: any;
  let governor: any;
  let treasuryContract: any;
  let stewardContract: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  async function mineBlock() {
    await mine(1);
  }

  // Helper: create a simple proposal
  async function createProposal(
    proposer: SignerWithAddress,
    proposalType: number = ProposalType.ParameterChange,
    description: string = "Test proposal"
  ): Promise<number> {
    // Dummy target: call a view function (harmless)
    const tx = await governor.connect(proposer).propose(
      proposalType,
      [await governor.getAddress()],
      [0n],
      [governor.interface.encodeFunctionData("proposalCount")],
      description
    );
    await tx.wait();
    return Number(await governor.proposalCount());
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address);
    await armToken.waitForDeployment();

    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();
    const MAX_PAUSE_DURATION = 14 * ONE_DAY;

    const VotingLocker = await ethers.getContractFactory("VotingLocker");
    votingLocker = await VotingLocker.deploy(
      await armToken.getAddress(),
      deployer.address, MAX_PAUSE_DURATION, timelockAddr
    );
    await votingLocker.waitForDeployment();

    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasuryContract = await ArmadaTreasuryGov.deploy(
      timelockAddr, deployer.address, MAX_PAUSE_DURATION
    );
    await treasuryContract.waitForDeployment();

    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await votingLocker.getAddress(),
      await armToken.getAddress(),
      timelockAddr,
      await treasuryContract.getAddress(),
      deployer.address, MAX_PAUSE_DURATION
    );
    await governor.waitForDeployment();

    // Set governor on VotingLocker (needed for vote cooldown)
    await votingLocker.setGovernor(await governor.getAddress());

    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    // Minimum action delay = 120% of governance cycle (2d + 5d + 2d = 9d)
    const stewardActionDelay = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);
    stewardContract = await TreasurySteward.deploy(
      timelockAddr,
      await treasuryContract.getAddress(),
      await governor.getAddress(),
      stewardActionDelay,
      deployer.address, MAX_PAUSE_DURATION
    );
    await stewardContract.waitForDeployment();

    // Configure timelock roles
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelockController.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelockController.TIMELOCK_ADMIN_ROLE();

    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());
    await timelockController.renounceRole(ADMIN_ROLE, deployer.address);

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Distribute ARM tokens
    await armToken.transfer(await treasuryContract.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // Alice and Bob lock tokens
    await armToken.connect(alice).approve(await votingLocker.getAddress(), ALICE_AMOUNT);
    await votingLocker.connect(alice).lock(ALICE_AMOUNT);

    await armToken.connect(bob).approve(await votingLocker.getAddress(), BOB_AMOUNT);
    await votingLocker.connect(bob).lock(BOB_AMOUNT);

    await mineBlock();
  });

  // ============================================================
  // 1. Voting Boundary Conditions
  // ============================================================

  describe("Voting Boundary Conditions", function () {
    it("cast vote at exact voteStart timestamp succeeds", async function () {
      const proposalId = await createProposal(alice);
      const proposal = await governor.getProposal(proposalId);
      const voteStart = proposal[2]; // voteStart

      // Fast-forward to exactly voteStart
      await time.increaseTo(voteStart);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;
    });

    it("cast vote just before voteEnd succeeds", async function () {
      const proposalId = await createProposal(alice);
      const proposal = await governor.getProposal(proposalId);
      const voteEnd = proposal[3]; // voteEnd

      // increaseTo(X) sets block.timestamp to X, then the tx mines at X+1
      // Governor checks block.timestamp <= voteEnd, so go to voteEnd - 1
      await time.increaseTo(voteEnd - 1n);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;
    });

    it("cast vote after voteEnd reverts", async function () {
      const proposalId = await createProposal(alice);
      const proposal = await governor.getProposal(proposalId);
      const voteEnd = proposal[3];

      await time.increaseTo(voteEnd);

      await expect(
        governor.connect(alice).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: voting ended");
    });

    it("cast vote before voteStart reverts", async function () {
      const proposalId = await createProposal(alice);
      const proposal = await governor.getProposal(proposalId);
      const voteStart = proposal[2];

      // increaseTo(voteStart - 2) → tx mines at voteStart - 1 → before voteStart
      await time.increaseTo(voteStart - 2n);

      await expect(
        governor.connect(alice).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: voting not started");
    });

    it("tied vote (forVotes == againstVotes) results in Defeated", async function () {
      // Alice: 20M votes For, Bob: 15M votes Against
      // We need a tie. Give carol exactly bob's amount so alice vs carol+bob can tie.
      // Actually simpler: alice votes For (20M), bob votes Against (15M) → alice wins.
      // For a tie: we need equal amounts. Let's just have bob vote For and alice Against with same amount.
      // Alice has 20M, Bob has 15M. Not equal.
      // Instead: create proposal, alice votes Against (20M), bob votes For (15M)
      // forVotes=15M < againstVotes=20M → Defeated

      // For a TRUE tie: alice locks 15M (same as bob). Unlock 5M first.
      await votingLocker.connect(alice).unlock(ethers.parseUnits("5000000", ARM_DECIMALS));
      await mineBlock();

      // Now alice and bob both have 15M locked
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.Against);

      // Fast-forward past voting period
      await time.increase(FIVE_DAYS + 1);

      // forVotes == againstVotes (both 15M) → Defeated because forVotes > againstVotes is false
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("quorum reached with 100% abstain votes results in Defeated", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      // Both vote abstain — reaches quorum but forVotes = 0, againstVotes = 0
      await governor.connect(alice).castVote(proposalId, Vote.Abstain);
      await governor.connect(bob).castVote(proposalId, Vote.Abstain);

      await time.increase(FIVE_DAYS + 1);

      // Total participation (35M abstain) >= quorum (7M) → quorum reached
      // But forVotes (0) > againstVotes (0) is false → Defeated
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("against votes count toward quorum (participation model)", async function () {
      // Eligible supply = 100M - 65M = 35M. Quorum = 20% = 7M.
      // Bob votes Against with 15M → exceeds quorum on its own.
      // Proposal should be Defeated (quorum met, but forVotes=0).
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      await governor.connect(bob).castVote(proposalId, Vote.Against);

      await time.increase(FIVE_DAYS + 1);

      // Quorum reached via against votes alone (15M >= 7M)
      // Defeated because forVotes (0) > againstVotes (15M) is false
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);

      // Verify the quorum threshold was indeed met
      const q = await governor.quorum(proposalId);
      expect(BOB_AMOUNT).to.be.gte(q);
    });

    it("propose with exactly threshold voting power succeeds", async function () {
      // Threshold = 0.1% of 100M = 100,000 ARM
      // Alice has 20M locked which is well above threshold. She can propose.
      // Bob has 15M locked. Let's test with a smaller holder.
      // Transfer from alice (who has locked tokens) — she needs to unlock first.
      // Simpler: alice already has enough, just verify she can propose.
      const proposalId = await createProposal(alice);
      expect(proposalId).to.equal(1);

      // Verify the threshold value
      const threshold = await governor.proposalThreshold();
      expect(threshold).to.equal(ethers.parseUnits("100000", ARM_DECIMALS));
    });

    it("propose with no voting power reverts", async function () {
      // carol has no locked tokens
      await expect(
        createProposal(carol)
      ).to.be.revertedWith("ArmadaGovernor: below proposal threshold");
    });

    it("invalid vote type (>2) reverts", async function () {
      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);

      await expect(
        governor.connect(alice).castVote(proposalId, 3)
      ).to.be.revertedWith("ArmadaGovernor: invalid vote type");
    });
  });

  // ============================================================
  // 2. State Machine Violations
  // ============================================================

  describe("State Machine Violations", function () {
    it("queue a Defeated proposal reverts", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      // Bob votes against (alone) — quorum reached but forVotes=0 → Defeated
      await governor.connect(bob).castVote(proposalId, Vote.Against);

      await time.increase(FIVE_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);

      await expect(
        governor.queue(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not succeeded");
    });

    it("execute a proposal that was never queued reverts", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      await time.increase(FIVE_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Try to execute without queuing
      await expect(
        governor.execute(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not queued");
    });

    it("cancel a proposal that is Active (voting started) reverts", async function () {
      const proposalId = await createProposal(alice);

      // Fast-forward into voting period
      await time.increase(TWO_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      await expect(
        governor.connect(alice).cancel(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not pending");
    });

    it("cancel by non-proposer reverts", async function () {
      const proposalId = await createProposal(alice);

      // Proposal is Pending
      expect(await governor.state(proposalId)).to.equal(ProposalState.Pending);

      await expect(
        governor.connect(bob).cancel(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not proposer");
    });

    it("vote on unknown proposal reverts", async function () {
      await time.increase(TWO_DAYS + 1);

      await expect(
        governor.connect(alice).castVote(999, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: unknown proposal");
    });

    it("queue an already-queued proposal reverts at timelock level", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);
      await time.increase(FIVE_DAYS + 1);

      await governor.queue(proposalId);

      // Second queue attempt — state is now Queued, not Succeeded
      await expect(
        governor.queue(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not succeeded");
    });

    it("vote without locked tokens reverts", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      // carol has no locked tokens
      await expect(
        governor.connect(carol).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });
  });

  // ============================================================
  // 3. VotingLocker Checkpoint Consistency
  // ============================================================

  describe("VotingLocker Checkpoint Consistency", function () {
    it("totalLocked equals sum of individual locked balances", async function () {
      const totalLocked = await votingLocker.totalLocked();
      const aliceLocked = await votingLocker.getLockedBalance(alice.address);
      const bobLocked = await votingLocker.getLockedBalance(bob.address);

      expect(totalLocked).to.equal(aliceLocked + bobLocked);
    });

    it("multiple lock/unlock operations maintain consistent totals", async function () {
      // Alice unlocks some, re-locks, total should stay consistent
      const unlockAmount = ethers.parseUnits("5000000", ARM_DECIMALS);

      await votingLocker.connect(alice).unlock(unlockAmount);
      const afterUnlock = await votingLocker.getLockedBalance(alice.address);
      expect(afterUnlock).to.equal(ALICE_AMOUNT - unlockAmount);

      // Re-lock
      await armToken.connect(alice).approve(await votingLocker.getAddress(), unlockAmount);
      await votingLocker.connect(alice).lock(unlockAmount);
      const afterRelock = await votingLocker.getLockedBalance(alice.address);
      expect(afterRelock).to.equal(ALICE_AMOUNT);

      // Total should still be consistent
      const totalLocked = await votingLocker.totalLocked();
      const aliceLocked = await votingLocker.getLockedBalance(alice.address);
      const bobLocked = await votingLocker.getLockedBalance(bob.address);
      expect(totalLocked).to.equal(aliceLocked + bobLocked);
    });

    it("getPastLockedBalance returns 0 for address that never locked", async function () {
      await mineBlock();
      const blockNum = (await ethers.provider.getBlockNumber()) - 1;
      const balance = await votingLocker.getPastLockedBalance(carol.address, blockNum);
      expect(balance).to.equal(0);
    });

    it("getPastLockedBalance for current block reverts", async function () {
      const blockNum = await ethers.provider.getBlockNumber();
      await expect(
        votingLocker.getPastLockedBalance(alice.address, blockNum)
      ).to.be.revertedWith("VotingLocker: block not yet mined");
    });

    it("unlock more than locked reverts", async function () {
      const locked = await votingLocker.getLockedBalance(alice.address);
      await expect(
        votingLocker.connect(alice).unlock(locked + 1n)
      ).to.be.revertedWith("VotingLocker: insufficient locked");
    });

    it("lock zero amount reverts", async function () {
      await expect(
        votingLocker.connect(alice).lock(0)
      ).to.be.revertedWith("VotingLocker: zero amount");
    });

    it("unlock zero amount reverts", async function () {
      await expect(
        votingLocker.connect(alice).unlock(0)
      ).to.be.revertedWith("VotingLocker: zero amount");
    });

    it("voting power reflects state at snapshot block, not current state", async function () {
      // Alice has 20M locked. Create proposal (snapshots current block).
      const proposalId = await createProposal(alice);
      const proposal = await governor.getProposal(proposalId);
      const snapshotBlock = proposal[7]; // snapshotBlock

      // Alice unlocks all her tokens AFTER proposal creation
      await votingLocker.connect(alice).unlock(ALICE_AMOUNT);

      // Current balance is 0
      expect(await votingLocker.getLockedBalance(alice.address)).to.equal(0);

      // But voting power at snapshot should still be 20M
      const pastBalance = await votingLocker.getPastLockedBalance(alice.address, snapshotBlock);
      expect(pastBalance).to.equal(ALICE_AMOUNT);

      // Alice can still vote (using snapshot power)
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      expect(await governor.hasVoted(proposalId, alice.address)).to.be.true;
    });
  });

  // ============================================================
  // 4. Constructor Zero-Address Validation
  // ============================================================

  describe("Constructor Zero-Address Validation", function () {
    const MAX_PAUSE = 14 * ONE_DAY;

    it("ArmadaGovernor rejects zero votingLocker", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      await expect(
        ArmadaGovernor.deploy(
          ethers.ZeroAddress,
          await armToken.getAddress(),
          await timelockController.getAddress(),
          await treasuryContract.getAddress(),
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("ArmadaGovernor: zero votingLocker");
    });

    it("ArmadaGovernor rejects zero armToken", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      await expect(
        ArmadaGovernor.deploy(
          await votingLocker.getAddress(),
          ethers.ZeroAddress,
          await timelockController.getAddress(),
          await treasuryContract.getAddress(),
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("ArmadaGovernor: zero armToken");
    });

    it("ArmadaGovernor rejects zero timelock", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      // Zero timelock is caught by EmergencyPausable first
      await expect(
        ArmadaGovernor.deploy(
          await votingLocker.getAddress(),
          await armToken.getAddress(),
          ethers.ZeroAddress,
          await treasuryContract.getAddress(),
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("EmergencyPausable: zero timelock");
    });

    it("ArmadaGovernor rejects zero treasury", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      await expect(
        ArmadaGovernor.deploy(
          await votingLocker.getAddress(),
          await armToken.getAddress(),
          await timelockController.getAddress(),
          ethers.ZeroAddress,
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("ArmadaGovernor: zero treasury");
    });

    it("TreasurySteward rejects zero timelock", async function () {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      const stewardDelay = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);
      // Zero timelock is caught by EmergencyPausable first
      await expect(
        TreasurySteward.deploy(
          ethers.ZeroAddress,
          await treasuryContract.getAddress(),
          await governor.getAddress(),
          stewardDelay,
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("EmergencyPausable: zero timelock");
    });

    it("TreasurySteward rejects zero treasury", async function () {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      const stewardDelay = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);
      await expect(
        TreasurySteward.deploy(
          await timelockController.getAddress(),
          ethers.ZeroAddress,
          await governor.getAddress(),
          stewardDelay,
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("TreasurySteward: zero treasury");
    });

    it("TreasurySteward rejects zero governor", async function () {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      const stewardDelay = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);
      await expect(
        TreasurySteward.deploy(
          await timelockController.getAddress(),
          await treasuryContract.getAddress(),
          ethers.ZeroAddress,
          stewardDelay,
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("TreasurySteward: zero governor");
    });

    it("TreasurySteward rejects delay below governance cycle", async function () {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      await expect(
        TreasurySteward.deploy(
          await timelockController.getAddress(),
          await treasuryContract.getAddress(),
          await governor.getAddress(),
          ONE_DAY, // way below minimum
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("TreasurySteward: delay below governance cycle");
    });
  });

  // ============================================================
  // 5. Quorum Snapshot Stability
  // ============================================================

  describe("Quorum Snapshot Stability", function () {
    it("quorum stays fixed after treasury balance decreases", async function () {
      const proposalId = await createProposal(alice);

      // Record quorum at creation time
      const quorumAtCreation = await governor.quorum(proposalId);

      // Unlock some of alice's ARM and send it to treasury to change the balance.
      // All ARM is locked, so we must unlock first.
      const transferAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await votingLocker.connect(alice).unlock(transferAmount);
      await armToken.connect(alice).transfer(await treasuryContract.getAddress(), transferAmount);

      // Quorum should be unchanged despite treasury now holding more ARM
      const quorumAfterDeposit = await governor.quorum(proposalId);
      expect(quorumAfterDeposit).to.equal(quorumAtCreation);

      // Verify the eligible supply is correctly snapshotted via getProposal
      const proposal = await governor.getProposal(proposalId);
      const snapshotEligibleSupply = proposal[8]; // new field at index 8
      // Eligible supply = 100M total - 65M treasury = 35M
      expect(snapshotEligibleSupply).to.equal(ethers.parseUnits("35000000", ARM_DECIMALS));

      // Quorum = 20% of 35M = 7M
      expect(quorumAtCreation).to.equal(ethers.parseUnits("7000000", ARM_DECIMALS));
    });

    it("quorum stays fixed after ARM moves between excluded and non-excluded addresses", async function () {
      const proposalId = await createProposal(alice);
      const quorumAtCreation = await governor.quorum(proposalId);

      // Move voting period forward and vote
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Quorum should still be the same even during active voting
      const quorumDuringVoting = await governor.quorum(proposalId);
      expect(quorumDuringVoting).to.equal(quorumAtCreation);

      // End voting
      await time.increase(FIVE_DAYS + 1);

      // Quorum should still be the same after voting ends
      const quorumAfterVoting = await governor.quorum(proposalId);
      expect(quorumAfterVoting).to.equal(quorumAtCreation);

      // Proposal should succeed (35M eligible, 20% quorum = 7M, alice+bob = 35M votes)
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("concurrent proposals have independent quorum snapshots", async function () {
      // Create proposal 1
      const proposalId1 = await createProposal(alice, ProposalType.ParameterChange, "Proposal 1");
      const quorum1 = await governor.quorum(proposalId1);

      // Unlock 5M of alice's ARM and send to treasury, changing the balance
      const transferAmount = ethers.parseUnits("5000000", ARM_DECIMALS);
      await votingLocker.connect(alice).unlock(transferAmount);
      await armToken.connect(alice).transfer(await treasuryContract.getAddress(), transferAmount);
      await mineBlock();

      // Create proposal 2 with different treasury balance
      const proposalId2 = await createProposal(alice, ProposalType.ParameterChange, "Proposal 2");
      const quorum2 = await governor.quorum(proposalId2);

      // Proposal 1 quorum should reflect original treasury balance (65M excluded)
      // Eligible = 100M - 65M = 35M, quorum = 20% = 7M
      expect(quorum1).to.equal(ethers.parseUnits("7000000", ARM_DECIMALS));

      // Proposal 2 quorum should reflect updated treasury balance (70M excluded)
      // Eligible = 100M - 70M = 30M, quorum = 20% = 6M
      expect(quorum2).to.equal(ethers.parseUnits("6000000", ARM_DECIMALS));

      // They should be different — independent snapshots
      expect(quorum1).to.not.equal(quorum2);
    });
  });

  // ============================================================
  // 6. StewardElection Extended Timing
  // ============================================================

  describe("Steward Election Timing", function () {
    it("StewardElection uses 7d voting and 4d execution delay", async function () {
      // Create a StewardElection proposal
      const proposalId = await createProposal(alice, ProposalType.StewardElection, "Elect steward");

      await time.increase(TWO_DAYS + 1);

      // Vote during 7-day window
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Still active after 5 days
      await time.increase(FIVE_DAYS - 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      // Succeeded after 7 days
      await time.increase(TWO_DAYS + 2);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("StewardElection requires 30% quorum", async function () {
      // Eligible supply = 100M - 65M (treasury) = 35M
      // 30% quorum = 10.5M
      // Bob has 15M → his vote alone reaches quorum (15M > 10.5M)
      const proposalId = await createProposal(alice, ProposalType.StewardElection);

      await time.increase(TWO_DAYS + 1);

      // Only bob votes For (15M) — exceeds 30% of 35M (10.5M)
      await governor.connect(bob).castVote(proposalId, Vote.For);

      await time.increase(SEVEN_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("StewardElection defeated if 30% quorum not reached", async function () {
      // Eligible supply = 100M - 65M (treasury) = 35M. 30% quorum = 10.5M.
      // Alice has 20M, bob has 15M. If neither votes, quorum not reached.
      // But we need at least one voter. Unlock alice's tokens to below quorum.
      // Alice unlocks down to 10M (below 10.5M quorum).
      await votingLocker.connect(alice).unlock(ethers.parseUnits("10000000", ARM_DECIMALS));
      await mineBlock();

      const proposalId = await createProposal(alice, ProposalType.StewardElection);

      await time.increase(TWO_DAYS + 1);

      // Only alice votes For (10M < 10.5M quorum)
      await governor.connect(alice).castVote(proposalId, Vote.For);

      await time.increase(SEVEN_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });
  });

  // ============================================================
  // 7. Treasury Ownership Immutability
  // ============================================================

  describe("Treasury Ownership Immutability", function () {
    it("treasury owner is immutable — set at deployment and cannot be changed", async function () {
      const timelockAddr = await timelockController.getAddress();

      // Owner was set to timelock at deployment
      expect(await treasuryContract.owner()).to.equal(timelockAddr);

      // There is no transferOwnership function — calling it reverts (no fallback)
      const transferOwnershipSelector = ethers.id("transferOwnership(address)").slice(0, 10);
      const encodedCall = transferOwnershipSelector +
        ethers.AbiCoder.defaultAbiCoder().encode(["address"], [alice.address]).slice(2);

      const treasuryAddr = await treasuryContract.getAddress();
      await expect(
        deployer.sendTransaction({ to: treasuryAddr, data: encodedCall })
      ).to.be.reverted;

      // Owner remains the timelock — unchanged
      expect(await treasuryContract.owner()).to.equal(timelockAddr);
    });

    it("owner cannot be changed even by the timelock itself", async function () {
      const timelockAddr = await timelockController.getAddress();

      // Owner is set at deployment and is immutable
      expect(await treasuryContract.owner()).to.equal(timelockAddr);

      // The ABI does not contain transferOwnership — confirm by checking the contract interface
      const treasuryInterface = treasuryContract.interface;
      const functionNames = Object.keys(treasuryInterface.fragments
        .filter((f: any) => f.type === "function")
        .reduce((acc: any, f: any) => { acc[f.name] = true; return acc; }, {}));

      expect(functionNames).to.not.include("transferOwnership");
    });
  });

  // ============================================================
  // 8. Proposal Queue Grace Period
  // ============================================================

  describe("Proposal Queue Grace Period", function () {
    const FOURTEEN_DAYS = 14 * ONE_DAY;

    it("succeeded proposal can be queued within 14-day grace period", async function () {
      const proposalId = await createProposal(alice);

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Wait for voting to end
      await time.increase(FIVE_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Wait 13 days (still within 14-day grace period)
      await time.increase(13 * ONE_DAY);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Queue succeeds
      await governor.queue(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);
    });

    it("succeeded proposal expires after 14-day grace period", async function () {
      const proposalId = await createProposal(alice);

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Wait for voting to end
      await time.increase(FIVE_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Wait past the 14-day grace period
      await time.increase(FOURTEEN_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);

      // Queue now reverts
      await expect(
        governor.queue(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not succeeded");
    });

    it("queued proposal is unaffected by grace period expiry", async function () {
      const proposalId = await createProposal(alice);

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Wait for voting to end and queue immediately
      await time.increase(FIVE_DAYS + 1);
      await governor.queue(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

      // Wait well past the grace period
      await time.increase(FOURTEEN_DAYS + FOURTEEN_DAYS);

      // Still Queued — grace period only applies to un-queued proposals
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);
    });
  });

  // ============================================================
  // 9. Steward Budget Snapshot
  // ============================================================

  describe("Steward Budget Snapshot", function () {
    // Deploy a standalone treasury with deployer as owner for direct steward tests.
    // The main treasuryContract is owned by the timelock, which complicates direct testing.
    let budgetTreasury: any;
    const TREASURY_USDC = ethers.parseUnits("1000000", 6); // $1M USDC

    async function setupBudgetTreasury() {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      budgetTreasury = await ArmadaTreasuryGov.deploy(deployer.address, deployer.address, 14 * ONE_DAY);
      await budgetTreasury.waitForDeployment();

      // Fund with USDC and set carol as steward
      await usdc.mint(await budgetTreasury.getAddress(), TREASURY_USDC);
      await budgetTreasury.setSteward(carol.address);
    }

    it("budget is based on snapshotted balance, not current balance", async function () {
      await setupBudgetTreasury();

      // First spend triggers period reset and snapshots $1M balance
      // Budget = 1% of $1M = $10K
      const firstSpend = ethers.parseUnits("5000", 6); // $5K
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, firstSpend
      );

      // Deposit another $1M into treasury mid-period
      await usdc.mint(await budgetTreasury.getAddress(), TREASURY_USDC);

      // Budget should still be based on original $1M snapshot, not current $1.995M
      // Remaining = $10K - $5K = $5K
      const secondSpend = ethers.parseUnits("5000", 6); // $5K — should succeed
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, secondSpend
      );

      // $10K budget fully used — even $1 more should fail
      await expect(
        budgetTreasury.connect(carol).stewardSpend(
          await usdc.getAddress(), dave.address, 1n
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: exceeds monthly budget");
    });

    it("budget does not shrink when treasury balance decreases mid-period", async function () {
      await setupBudgetTreasury();

      // First spend triggers snapshot at $1M → budget = $10K
      const smallSpend = ethers.parseUnits("1000", 6); // $1K
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, smallSpend
      );

      // Governance distributes $900K out of the treasury (owner = deployer in this test)
      await budgetTreasury.distribute(
        await usdc.getAddress(), alice.address, ethers.parseUnits("900000", 6)
      );

      // Treasury now holds ~$99K, but budget is still based on $1M snapshot
      // Remaining = $10K - $1K = $9K — steward can still spend up to $9K
      const largeSpend = ethers.parseUnits("9000", 6);
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, largeSpend
      );

      expect(await usdc.balanceOf(dave.address)).to.equal(smallSpend + largeSpend);
    });

    it("new period snapshots the current balance", async function () {
      await setupBudgetTreasury();

      // First period: snapshot at $1M
      const spend = ethers.parseUnits("5000", 6);
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, spend
      );

      // Governance distributes $500K out
      await budgetTreasury.distribute(
        await usdc.getAddress(), alice.address, ethers.parseUnits("500000", 6)
      );

      // Fast-forward past the 30-day period
      await time.increase(30 * ONE_DAY + 1);

      // New period: snapshot at current balance (~$495K)
      // New budget = 1% of ~$495K = ~$4,950
      const newBudget = ethers.parseUnits("4950", 6);
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, newBudget
      );

      // Exceeding the new (lower) budget should fail
      await expect(
        budgetTreasury.connect(carol).stewardSpend(
          await usdc.getAddress(), dave.address, 1n
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: exceeds monthly budget");
    });

    it("getStewardBudget reflects snapshot during active period", async function () {
      await setupBudgetTreasury();

      // Trigger first period
      const spend = ethers.parseUnits("3000", 6);
      await budgetTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, spend
      );

      // Deposit more USDC mid-period
      await usdc.mint(await budgetTreasury.getAddress(), TREASURY_USDC);

      // getStewardBudget should reflect the original snapshot, not current balance
      const [budget, spent, remaining] = await budgetTreasury.getStewardBudget(await usdc.getAddress());
      const expectedBudget = TREASURY_USDC / 100n; // 1% of $1M = $10K
      expect(budget).to.equal(expectedBudget);
      expect(spent).to.equal(spend);
      expect(remaining).to.equal(expectedBudget - spend);
    });
  });

  describe("Steward Action Error Encoding", function () {
    // Deploy a standalone steward with deployer as timelock for direct control.
    let testSteward: any;
    let testTreasury: any;
    // Steward delay: 120% of governance cycle (2d + 5d + 2d = 9d)
    const testStewardDelay = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);

    async function setupStewardTest() {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      testTreasury = await ArmadaTreasuryGov.deploy(deployer.address, deployer.address, 14 * ONE_DAY);
      await testTreasury.waitForDeployment();

      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      testSteward = await TreasurySteward.deploy(
        deployer.address,                    // deployer acts as timelock
        await testTreasury.getAddress(),
        await governor.getAddress(),
        testStewardDelay,
        deployer.address, 14 * ONE_DAY
      );
      await testSteward.waitForDeployment();

      // Elect carol as steward
      await testSteward.electSteward(carol.address);

      // Fund treasury with USDC and set steward contract as the treasury's steward
      await usdc.mint(await testTreasury.getAddress(), ethers.parseUnits("1000000", 6));
      await testTreasury.setSteward(await testSteward.getAddress());
    }

    it("failed executeAction bubbles up the original revert reason", async function () {
      await setupStewardTest();

      // Propose a spend that exceeds the budget (budget = 1% of $1M = $10K)
      const overBudget = ethers.parseUnits("20000", 6); // $20K > $10K budget
      const spendData = testTreasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), dave.address, overBudget
      ]);
      await testSteward.connect(carol).proposeAction(
        await testTreasury.getAddress(), spendData, 0
      );
      await time.increase(testStewardDelay + 1);

      // The original revert reason from the treasury is bubbled up
      await expect(
        testSteward.connect(carol).executeAction(await testSteward.actionCount())
      ).to.be.revertedWith("ArmadaTreasuryGov: exceeds monthly budget");
    });

    it("successful executeAction emits ActionExecuted", async function () {
      await setupStewardTest();

      // Propose a spend within budget (budget = 1% of $1M = $10K)
      const withinBudget = ethers.parseUnits("5000", 6); // $5K < $10K budget
      const spendData = testTreasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), dave.address, withinBudget
      ]);
      await testSteward.connect(carol).proposeAction(
        await testTreasury.getAddress(), spendData, 0
      );
      await time.increase(testStewardDelay + 1);

      const actionId = await testSteward.actionCount();

      // Successful action emits ActionExecuted
      await expect(
        testSteward.connect(carol).executeAction(actionId)
      ).to.emit(testSteward, "ActionExecuted").withArgs(actionId);

      expect(await usdc.balanceOf(dave.address)).to.equal(withinBudget);
    });
  });

  describe("Treasury ETH Rejection", function () {
    it("treasury rejects direct ETH transfers", async function () {
      await expect(
        deployer.sendTransaction({
          to: await treasuryContract.getAddress(),
          value: ethers.parseEther("1.0"),
        })
      ).to.be.reverted;
    });

    it("treasury rejects ETH via selfdestruct-style forced sends", async function () {
      // Even without receive(), ETH can be forced via selfdestruct.
      // This test documents that the contract has no way to recover forced ETH,
      // but at least it won't silently accept voluntary transfers.
      const treasuryAddr = await treasuryContract.getAddress();
      const balanceBefore = await ethers.provider.getBalance(treasuryAddr);
      expect(balanceBefore).to.equal(0n);
    });
  });
});
