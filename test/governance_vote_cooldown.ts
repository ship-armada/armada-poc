/**
 * Governance Vote Cooldown Tests
 *
 * Tests the vote-and-dump prevention mechanism:
 * - Users who vote on a proposal cannot unlock tokens until the voting period ends
 * - The cooldown extends to the latest voteEnd across all proposals voted on
 * - Users who haven't voted can unlock freely
 * - After the cooldown expires, tokens can be unlocked normally
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ProposalType = { ParameterChange: 0, Treasury: 1, StewardElection: 2 };
const Vote = { Against: 0, For: 1, Abstain: 2 };

const ONE_DAY = 86400;
const TWO_DAYS = 2 * ONE_DAY;
const FIVE_DAYS = 5 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;

describe("Governance Vote Cooldown", function () {
  let armToken: any;
  let votingLocker: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  const ARM_DECIMALS = 18;
  const TOTAL_SUPPLY = ethers.parseUnits("100000000", ARM_DECIMALS);
  const TREASURY_AMOUNT = ethers.parseUnits("65000000", ARM_DECIMALS);
  const ALICE_AMOUNT = ethers.parseUnits("20000000", ARM_DECIMALS);
  const BOB_AMOUNT = ethers.parseUnits("10000000", ARM_DECIMALS);
  const CAROL_AMOUNT = ethers.parseUnits("5000000", ARM_DECIMALS);
  const MAX_PAUSE_DURATION = 14 * ONE_DAY;

  async function mineBlock() {
    await mine(1);
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol] = await ethers.getSigners();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address);
    await armToken.waitForDeployment();

    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    const VotingLocker = await ethers.getContractFactory("VotingLocker");
    votingLocker = await VotingLocker.deploy(
      await armToken.getAddress(),
      deployer.address, MAX_PAUSE_DURATION, timelockAddr
    );
    await votingLocker.waitForDeployment();

    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(timelockAddr, deployer.address, MAX_PAUSE_DURATION);
    await treasury.waitForDeployment();

    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await votingLocker.getAddress(),
      await armToken.getAddress(),
      timelockAddr,
      await treasury.getAddress(),
      deployer.address, MAX_PAUSE_DURATION
    );
    await governor.waitForDeployment();

    // Set governor on VotingLocker for vote cooldown
    await votingLocker.setGovernor(await governor.getAddress());

    // Configure timelock roles
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelockController.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelockController.TIMELOCK_ADMIN_ROLE();
    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());
    await timelockController.renounceRole(ADMIN_ROLE, deployer.address);

    // Distribute tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);
    await armToken.transfer(carol.address, CAROL_AMOUNT);

    // Lock tokens
    await armToken.connect(alice).approve(await votingLocker.getAddress(), ALICE_AMOUNT);
    await votingLocker.connect(alice).lock(ALICE_AMOUNT);

    await armToken.connect(bob).approve(await votingLocker.getAddress(), BOB_AMOUNT);
    await votingLocker.connect(bob).lock(BOB_AMOUNT);

    await armToken.connect(carol).approve(await votingLocker.getAddress(), CAROL_AMOUNT);
    await votingLocker.connect(carol).lock(CAROL_AMOUNT);

    await mineBlock();
  });

  // Helper: create a proposal
  async function createProposal(
    proposer: SignerWithAddress,
    proposalType: number = ProposalType.ParameterChange
  ): Promise<number> {
    const targets = [await governor.getAddress()];
    const values = [0n];
    const calldatas = [governor.interface.encodeFunctionData("proposalCount")];
    await governor.connect(proposer).propose(
      proposalType, targets, values, calldatas, "Test proposal"
    );
    return Number(await governor.proposalCount());
  }

  // ============================================================
  // setGovernor admin function
  // ============================================================

  describe("setGovernor", function () {
    it("should revert if governor is already set", async function () {
      await expect(
        votingLocker.setGovernor(alice.address)
      ).to.be.revertedWith("VotingLocker: governor already set");
    });

    it("should revert if called by non-guardian", async function () {
      // Deploy a fresh locker to test
      const VotingLocker = await ethers.getContractFactory("VotingLocker");
      const freshLocker = await VotingLocker.deploy(
        await armToken.getAddress(),
        deployer.address, MAX_PAUSE_DURATION,
        await timelockController.getAddress()
      );
      await freshLocker.waitForDeployment();

      await expect(
        freshLocker.connect(alice).setGovernor(await governor.getAddress())
      ).to.be.revertedWith("VotingLocker: not guardian");
    });

    it("should revert if zero address", async function () {
      const VotingLocker = await ethers.getContractFactory("VotingLocker");
      const freshLocker = await VotingLocker.deploy(
        await armToken.getAddress(),
        deployer.address, MAX_PAUSE_DURATION,
        await timelockController.getAddress()
      );
      await freshLocker.waitForDeployment();

      await expect(
        freshLocker.setGovernor(ethers.ZeroAddress)
      ).to.be.revertedWith("VotingLocker: zero address");
    });

    it("should emit GovernorSet event", async function () {
      const VotingLocker = await ethers.getContractFactory("VotingLocker");
      const freshLocker = await VotingLocker.deploy(
        await armToken.getAddress(),
        deployer.address, MAX_PAUSE_DURATION,
        await timelockController.getAddress()
      );
      await freshLocker.waitForDeployment();

      await expect(freshLocker.setGovernor(await governor.getAddress()))
        .to.emit(freshLocker, "GovernorSet")
        .withArgs(await governor.getAddress());
    });
  });

  // ============================================================
  // Core vote cooldown behavior
  // ============================================================

  describe("Vote cooldown enforcement", function () {
    it("should allow unlock when no vote has been cast", async function () {
      // Carol never votes — should unlock freely
      const unlockAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await expect(votingLocker.connect(carol).unlock(unlockAmount))
        .to.emit(votingLocker, "TokensUnlocked");
    });

    it("should prevent unlock during active voting period after voting", async function () {
      const proposalId = await createProposal(alice);

      // Fast-forward past voting delay
      await time.increase(TWO_DAYS + 1);

      // Alice votes
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Alice tries to unlock immediately — should fail
      const unlockAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await expect(
        votingLocker.connect(alice).unlock(unlockAmount)
      ).to.be.revertedWith("VotingLocker: vote cooldown active");
    });

    it("should allow unlock after voting period ends", async function () {
      const proposalId = await createProposal(alice);

      // Fast-forward past voting delay
      await time.increase(TWO_DAYS + 1);

      // Alice votes
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Fast-forward past the voting period end
      await time.increase(FIVE_DAYS + 1);

      // Alice can now unlock
      const unlockAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await expect(votingLocker.connect(alice).unlock(unlockAmount))
        .to.emit(votingLocker, "TokensUnlocked");
    });

    it("should emit VoteLockExtended event when voting", async function () {
      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);

      // Get proposal details to know the voteEnd
      const proposal = await governor.getProposal(proposalId);
      const voteEnd = proposal.voteEnd;

      await expect(governor.connect(alice).castVote(proposalId, Vote.For))
        .to.emit(votingLocker, "VoteLockExtended")
        .withArgs(alice.address, voteEnd);
    });

    it("should not affect users who did not vote", async function () {
      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);

      // Only Alice votes
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Bob didn't vote — should be able to unlock
      const unlockAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await expect(votingLocker.connect(bob).unlock(unlockAmount))
        .to.emit(votingLocker, "TokensUnlocked");
    });
  });

  // ============================================================
  // Multiple proposals / extended cooldown
  // ============================================================

  describe("Multiple proposal cooldowns", function () {
    it("should extend cooldown to latest voteEnd across proposals", async function () {
      // Create a ParameterChange proposal (5-day voting)
      const proposalId1 = await createProposal(alice, ProposalType.ParameterChange);
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId1, Vote.For);

      // Create a StewardElection proposal (7-day voting) shortly after
      const proposalId2 = await createProposal(alice, ProposalType.StewardElection);
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId2, Vote.For);

      // After first proposal's voting period but before second's
      // The first proposal's voting period ends earlier, but Alice is still
      // locked because she voted on the second (longer) proposal
      const proposal2 = await governor.getProposal(proposalId2);
      const voteEnd2 = proposal2.voteEnd;

      // Verify lockUntil matches the later proposal's voteEnd
      expect(await votingLocker.lockUntil(alice.address)).to.equal(voteEnd2);
    });

    it("should not shorten cooldown when voting on a proposal with earlier end", async function () {
      // Create both proposals close together so we can compare their voteEnd times
      // StewardElection has 7-day voting; ParameterChange has 5-day voting
      const proposalId1 = await createProposal(alice, ProposalType.StewardElection);
      const proposalId2 = await createProposal(alice, ProposalType.ParameterChange);

      const proposal1 = await governor.getProposal(proposalId1);
      const proposal2 = await governor.getProposal(proposalId2);
      const voteEnd1 = proposal1.voteEnd;
      const voteEnd2 = proposal2.voteEnd;

      // StewardElection should have a later voteEnd (7d vs 5d voting)
      expect(voteEnd1).to.be.gt(voteEnd2);

      // Advance past both voting delays
      await time.increase(TWO_DAYS + 1);

      // Vote on the longer proposal first
      await governor.connect(alice).castVote(proposalId1, Vote.For);
      expect(await votingLocker.lockUntil(alice.address)).to.equal(voteEnd1);

      // Vote on the shorter proposal second — lockUntil should NOT decrease
      await governor.connect(alice).castVote(proposalId2, Vote.For);
      expect(await votingLocker.lockUntil(alice.address)).to.equal(voteEnd1);
    });
  });

  // ============================================================
  // Vote-and-dump attack scenario
  // ============================================================

  describe("Vote-and-dump attack prevention", function () {
    it("should prevent the complete vote-and-dump attack vector", async function () {
      // Attack scenario: Alice locks, votes, tries to immediately unlock and sell

      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);

      // Step 1: Alice votes (has voting power)
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Step 2: Alice tries to unlock immediately — BLOCKED
      await expect(
        votingLocker.connect(alice).unlock(ALICE_AMOUNT)
      ).to.be.revertedWith("VotingLocker: vote cooldown active");

      // Step 3: Even partial unlock is blocked
      await expect(
        votingLocker.connect(alice).unlock(1n)
      ).to.be.revertedWith("VotingLocker: vote cooldown active");

      // Step 4: After voting period ends, unlock succeeds
      await time.increase(FIVE_DAYS + 1);
      await expect(votingLocker.connect(alice).unlock(ALICE_AMOUNT))
        .to.emit(votingLocker, "TokensUnlocked");
    });

    it("should apply cooldown regardless of vote direction", async function () {
      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);

      // Vote against
      await governor.connect(bob).castVote(proposalId, Vote.Against);
      await expect(
        votingLocker.connect(bob).unlock(1n)
      ).to.be.revertedWith("VotingLocker: vote cooldown active");

      // Abstain vote also triggers cooldown (Carol votes on a different proposal)
      const proposalId2 = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);
      await governor.connect(carol).castVote(proposalId2, Vote.Abstain);
      await expect(
        votingLocker.connect(carol).unlock(1n)
      ).to.be.revertedWith("VotingLocker: vote cooldown active");
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================

  describe("Edge cases", function () {
    it("should allow locking additional tokens during cooldown", async function () {
      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Alice should still be able to lock MORE tokens during cooldown
      // Carol hasn't voted so she can unlock, then transfer to Alice
      const extraAmount = ethers.parseUnits("100", ARM_DECIMALS);
      await votingLocker.connect(carol).unlock(extraAmount);
      await armToken.connect(carol).transfer(alice.address, extraAmount);
      await armToken.connect(alice).approve(await votingLocker.getAddress(), extraAmount);
      await expect(votingLocker.connect(alice).lock(extraAmount))
        .to.emit(votingLocker, "TokensLocked");
    });

    it("should handle cooldown expiry at exact boundary", async function () {
      const proposalId = await createProposal(alice);
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);

      const proposal = await governor.getProposal(proposalId);
      const voteEnd = Number(proposal.voteEnd);

      // Set time to exactly voteEnd — should be allowed (>= check)
      await time.increaseTo(voteEnd);

      const unlockAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await expect(votingLocker.connect(alice).unlock(unlockAmount))
        .to.emit(votingLocker, "TokensUnlocked");
    });

    it("should not allow extendLockUntil from non-governor", async function () {
      await expect(
        votingLocker.connect(alice).extendLockUntil(bob.address, 9999999999)
      ).to.be.revertedWith("VotingLocker: not governor");
    });

    it("lockUntil should be zero for users who never voted", async function () {
      expect(await votingLocker.lockUntil(carol.address)).to.equal(0);
    });
  });
});
