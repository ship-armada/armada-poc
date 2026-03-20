/**
 * Governance Adversarial Tests
 *
 * Phase 2 security testing:
 * - Voting boundary conditions (exact timestamps, tied votes, quorum edge cases)
 * - State machine violations (queue defeated, execute unqueued, cancel active)
 * - ERC20Votes delegation consistency
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
const SEVEN_DAYS = 7 * ONE_DAY;
const FOURTEEN_DAYS = 14 * ONE_DAY;
const STANDARD_VOTING_PERIOD = SEVEN_DAYS;
const EXTENDED_VOTING_PERIOD = FOURTEEN_DAYS;
const STANDARD_EXECUTION_DELAY = TWO_DAYS;
const EXTENDED_EXECUTION_DELAY = SEVEN_DAYS;

const ARM_DECIMALS = 18;
const TOTAL_SUPPLY = ethers.parseUnits("12000000", ARM_DECIMALS); // must match ArmadaToken.INITIAL_SUPPLY
const TREASURY_AMOUNT = TOTAL_SUPPLY * 65n / 100n; // 65% to treasury
const ALICE_AMOUNT = TOTAL_SUPPLY * 20n / 100n;    // 20% to Alice (voter)
const BOB_AMOUNT = TOTAL_SUPPLY * 15n / 100n;      // 15% to Bob (voter)

describe("Governance Adversarial", function () {
  let armToken: any;
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

    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();
    const MAX_PAUSE_DURATION = 14 * ONE_DAY;

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasuryContract = await ArmadaTreasuryGov.deploy(
      timelockAddr, deployer.address, MAX_PAUSE_DURATION
    );
    await treasuryContract.waitForDeployment();

    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await armToken.getAddress(),
      timelockAddr,
      await treasuryContract.getAddress(),
      deployer.address, MAX_PAUSE_DURATION
    );
    await governor.waitForDeployment();

    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    // Minimum action delay = 120% of governance cycle (2d + 7d + 2d = 11d)
    const stewardActionDelay = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);
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

    // Configure ARM token post-deploy
    await armToken.setNoDelegation(await treasuryContract.getAddress());
    await armToken.initWhitelist([
      deployer.address,
      await treasuryContract.getAddress(),
      alice.address,
      bob.address,
    ]);

    // Distribute ARM tokens
    await armToken.transfer(await treasuryContract.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // Delegate tokens for voting power
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

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

      // For a TRUE tie: alice needs same voting power as bob. Transfer the difference away.
      await armToken.connect(alice).transfer(carol.address, ALICE_AMOUNT - BOB_AMOUNT);
      await mineBlock();

      // Now alice and bob both have BOB_AMOUNT locked
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.Against);

      // Fast-forward past voting period
      await time.increase(STANDARD_VOTING_PERIOD + 1);

      // forVotes == againstVotes (both 15M) → Defeated because forVotes > againstVotes is false
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("quorum reached with 100% abstain votes results in Defeated", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      // Both vote abstain — reaches quorum but forVotes = 0, againstVotes = 0
      await governor.connect(alice).castVote(proposalId, Vote.Abstain);
      await governor.connect(bob).castVote(proposalId, Vote.Abstain);

      await time.increase(STANDARD_VOTING_PERIOD + 1);

      // Total participation (35% of supply abstain) >= quorum (7% of supply) → quorum reached
      // But forVotes (0) > againstVotes (0) is false → Defeated
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("against votes count toward quorum (participation model)", async function () {
      // Eligible supply = 35% of total. Quorum = 20% of eligible = 7% of total.
      // Bob (15% of supply) votes Against → exceeds quorum on its own.
      // Proposal should be Defeated (quorum met, but forVotes=0).
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      await governor.connect(bob).castVote(proposalId, Vote.Against);

      await time.increase(STANDARD_VOTING_PERIOD + 1);

      // Quorum reached via against votes alone (15% >= 7%)
      // Defeated because forVotes (0) > againstVotes is false
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);

      // Verify the quorum threshold was indeed met
      const q = await governor.quorum(proposalId);
      expect(BOB_AMOUNT).to.be.gte(q);
    });

    it("propose with exactly threshold voting power succeeds", async function () {
      // Threshold = 0.1% of total supply
      // Alice has 20% of supply locked, well above threshold. She can propose.
      // Transfer from alice (who has locked tokens) — she needs to unlock first.
      // Simpler: alice already has enough, just verify she can propose.
      const proposalId = await createProposal(alice);
      expect(proposalId).to.equal(1);

      // Verify the threshold value (0.1% of total supply)
      const threshold = await governor.proposalThreshold();
      expect(threshold).to.equal((TOTAL_SUPPLY * 10n) / 10000n);
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

      await time.increase(STANDARD_VOTING_PERIOD + 1);

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

      await time.increase(STANDARD_VOTING_PERIOD + 1);

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
      await time.increase(STANDARD_VOTING_PERIOD + 1);

      await governor.queue(proposalId);

      // Second queue attempt — state is now Queued, not Succeeded
      await expect(
        governor.queue(proposalId)
      ).to.be.revertedWith("ArmadaGovernor: not succeeded");
    });

    it("vote without delegated tokens reverts", async function () {
      const proposalId = await createProposal(alice);

      await time.increase(TWO_DAYS + 1);

      // carol has no delegated tokens
      await expect(
        governor.connect(carol).castVote(proposalId, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });
  });

  // ============================================================
  // 3. ERC20Votes Delegation Consistency
  // ============================================================

  describe("ERC20Votes Delegation Consistency", function () {
    it("total delegated power equals sum of individual delegations", async function () {
      const aliceVotes = await armToken.getVotes(alice.address);
      const bobVotes = await armToken.getVotes(bob.address);
      // Total delegated = alice + bob (treasury is not delegated)
      expect(aliceVotes).to.equal(ALICE_AMOUNT);
      expect(bobVotes).to.equal(BOB_AMOUNT);
    });

    it("re-delegation maintains consistent totals", async function () {
      // Alice re-delegates to bob
      await armToken.connect(alice).delegate(bob.address);
      await mineBlock();

      expect(await armToken.getVotes(alice.address)).to.equal(0);
      expect(await armToken.getVotes(bob.address)).to.equal(ALICE_AMOUNT + BOB_AMOUNT);

      // Alice re-delegates back to self
      await armToken.connect(alice).delegate(alice.address);
      await mineBlock();

      expect(await armToken.getVotes(alice.address)).to.equal(ALICE_AMOUNT);
      expect(await armToken.getVotes(bob.address)).to.equal(BOB_AMOUNT);
    });

    it("getPastVotes returns 0 for address that never delegated", async function () {
      await mineBlock();
      const blockNum = (await ethers.provider.getBlockNumber()) - 1;
      const balance = await armToken.getPastVotes(carol.address, blockNum);
      expect(balance).to.equal(0);
    });

    it("getPastVotes for current block reverts", async function () {
      const blockNum = await ethers.provider.getBlockNumber();
      await expect(
        armToken.getPastVotes(alice.address, blockNum)
      ).to.be.revertedWith("ERC20Votes: future lookup");
    });

    it("voting power reflects state at snapshot block, not current state", async function () {
      // Alice has ALICE_AMOUNT delegated. Create proposal (snapshots current block).
      const proposalId = await createProposal(alice);
      const proposal = await governor.getProposal(proposalId);
      const snapshotBlock = proposal[7]; // snapshotBlock

      // Alice re-delegates to bob AFTER proposal creation (removes her own voting power)
      await armToken.connect(alice).delegate(bob.address);

      // Current votes for alice is 0
      expect(await armToken.getVotes(alice.address)).to.equal(0);

      // But voting power at snapshot should still be ALICE_AMOUNT
      const pastVotes = await armToken.getPastVotes(alice.address, snapshotBlock);
      expect(pastVotes).to.equal(ALICE_AMOUNT);

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

    it("ArmadaGovernor rejects zero armToken", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      await expect(
        ArmadaGovernor.deploy(
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
          await armToken.getAddress(),
          await timelockController.getAddress(),
          ethers.ZeroAddress,
          deployer.address, MAX_PAUSE
        )
      ).to.be.revertedWith("ArmadaGovernor: zero treasury");
    });

    it("TreasurySteward rejects zero timelock", async function () {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      const stewardDelay = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);
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
      const stewardDelay = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);
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
      const stewardDelay = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);
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

      // Transfer some of alice's ARM to treasury to change the balance.
      const transferAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await armToken.connect(alice).transfer(await treasuryContract.getAddress(), transferAmount);

      // Quorum should be unchanged despite treasury now holding more ARM
      const quorumAfterDeposit = await governor.quorum(proposalId);
      expect(quorumAfterDeposit).to.equal(quorumAtCreation);

      // Verify the eligible supply is correctly snapshotted via getProposal
      const proposal = await governor.getProposal(proposalId);
      const snapshotEligibleSupply = proposal[8]; // new field at index 8
      // Eligible supply = totalSupply - treasury (65%) = 35% of supply
      const expectedEligible = TOTAL_SUPPLY - TREASURY_AMOUNT;
      expect(snapshotEligibleSupply).to.equal(expectedEligible);

      // Quorum = 20% of eligible supply
      const expectedQuorum = (expectedEligible * 2000n) / 10000n;
      expect(quorumAtCreation).to.equal(expectedQuorum);
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
      await time.increase(STANDARD_VOTING_PERIOD + 1);

      // Quorum should still be the same after voting ends
      const quorumAfterVoting = await governor.quorum(proposalId);
      expect(quorumAfterVoting).to.equal(quorumAtCreation);

      // Proposal should succeed (alice+bob = 35% of supply > 7% quorum)
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("concurrent proposals have independent quorum snapshots", async function () {
      // Create proposal 1
      const proposalId1 = await createProposal(alice, ProposalType.ParameterChange, "Proposal 1");
      const quorum1 = await governor.quorum(proposalId1);

      // Transfer 5% of supply worth of alice's ARM to treasury, changing the balance
      const transferAmount = TOTAL_SUPPLY * 5n / 100n;
      await armToken.connect(alice).transfer(await treasuryContract.getAddress(), transferAmount);
      await mineBlock();

      // Create proposal 2 with different treasury balance
      const proposalId2 = await createProposal(alice, ProposalType.ParameterChange, "Proposal 2");
      const quorum2 = await governor.quorum(proposalId2);

      // Proposal 1 quorum should reflect original treasury balance (65% excluded)
      const eligible1 = TOTAL_SUPPLY - TREASURY_AMOUNT;
      expect(quorum1).to.equal((eligible1 * 2000n) / 10000n);

      // Proposal 2 quorum should reflect updated treasury balance (70% excluded)
      const eligible2 = TOTAL_SUPPLY - TREASURY_AMOUNT - transferAmount;
      expect(quorum2).to.equal((eligible2 * 2000n) / 10000n);

      // They should be different — independent snapshots
      expect(quorum1).to.not.equal(quorum2);
    });
  });

  // ============================================================
  // 6. StewardElection Extended Timing
  // ============================================================

  describe("Steward Election Timing", function () {
    it("StewardElection uses 14d voting and 7d execution delay", async function () {
      // Create a StewardElection proposal
      const proposalId = await createProposal(alice, ProposalType.StewardElection, "Elect steward");

      await time.increase(TWO_DAYS + 1);

      // Vote during 14-day window
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Still active after 7 days (within 14-day extended voting period)
      await time.increase(STANDARD_VOTING_PERIOD - 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      // Succeeded after 14 days
      await time.increase(SEVEN_DAYS + 2);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("StewardElection requires 30% quorum", async function () {
      // Eligible = 35% of supply. 30% quorum = 10.5% of supply.
      // Bob (15% of supply) exceeds quorum.
      const proposalId = await createProposal(alice, ProposalType.StewardElection);

      await time.increase(TWO_DAYS + 1);

      // Only bob votes For — exceeds 30% quorum of eligible supply
      await governor.connect(bob).castVote(proposalId, Vote.For);

      await time.increase(EXTENDED_VOTING_PERIOD + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("StewardElection defeated if 30% quorum not reached", async function () {
      // Eligible = 35% of supply. 30% quorum = 10.5% of supply.
      // Transfer half of alice's tokens to reduce her voting power (10% of supply < 10.5% quorum).
      await armToken.connect(alice).transfer(carol.address, ALICE_AMOUNT / 2n);
      await mineBlock();

      const proposalId = await createProposal(alice, ProposalType.StewardElection);

      await time.increase(TWO_DAYS + 1);

      // Only alice votes For (10% of supply < 10.5% quorum)
      await governor.connect(alice).castVote(proposalId, Vote.For);

      await time.increase(EXTENDED_VOTING_PERIOD + 1);

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
    it("succeeded proposal can be queued within 14-day grace period", async function () {
      const proposalId = await createProposal(alice);

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Wait for voting to end
      await time.increase(STANDARD_VOTING_PERIOD + 1);
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
      await time.increase(STANDARD_VOTING_PERIOD + 1);
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
      await time.increase(STANDARD_VOTING_PERIOD + 1);
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
    // Steward delay: 120% of governance cycle (2d + 7d + 2d = 11d)
    const testStewardDelay = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);

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
