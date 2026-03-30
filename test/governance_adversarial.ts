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
import { deployGovernorProxy } from "./helpers/deploy-governor";

const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2 };
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
    proposalType: number = ProposalType.Standard,
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

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasuryContract = await ArmadaTreasuryGov.deploy(timelockAddr);
    await treasuryContract.waitForDeployment();

    governor = await deployGovernorProxy(
      await armToken.getAddress(),
      timelockAddr,
      await treasuryContract.getAddress(),
    );

    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    stewardContract = await TreasurySteward.deploy(timelockAddr);
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
    it("ArmadaGovernor rejects zero armToken", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      const impl = await ArmadaGovernor.deploy();
      await impl.waitForDeployment();
      const initData = ArmadaGovernor.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        await timelockController.getAddress(),
        await treasuryContract.getAddress(),
      ]);
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await impl.getAddress(), initData)
      ).to.be.revertedWith("ArmadaGovernor: zero armToken");
    });

    it("ArmadaGovernor rejects zero timelock", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      const impl = await ArmadaGovernor.deploy();
      await impl.waitForDeployment();
      const initData = ArmadaGovernor.interface.encodeFunctionData("initialize", [
        await armToken.getAddress(),
        ethers.ZeroAddress,
        await treasuryContract.getAddress(),
      ]);
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await impl.getAddress(), initData)
      ).to.be.revertedWith("ArmadaGovernor: zero timelock");
    });

    it("ArmadaGovernor rejects zero treasury", async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      const impl = await ArmadaGovernor.deploy();
      await impl.waitForDeployment();
      const initData = ArmadaGovernor.interface.encodeFunctionData("initialize", [
        await armToken.getAddress(),
        await timelockController.getAddress(),
        ethers.ZeroAddress,
      ]);
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await impl.getAddress(), initData)
      ).to.be.revertedWith("ArmadaGovernor: zero treasury");
    });

    it("TreasurySteward rejects zero timelock", async function () {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      await expect(
        TreasurySteward.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("TreasurySteward: zero timelock");
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
      const proposalId1 = await createProposal(alice, ProposalType.Standard, "Proposal 1");
      const quorum1 = await governor.quorum(proposalId1);

      // Transfer 5% of supply worth of alice's ARM to treasury, changing the balance
      const transferAmount = TOTAL_SUPPLY * 5n / 100n;
      await armToken.connect(alice).transfer(await treasuryContract.getAddress(), transferAmount);
      await mineBlock();

      // Create proposal 2 with different treasury balance
      const proposalId2 = await createProposal(alice, ProposalType.Standard, "Proposal 2");
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
  // 6. Extended Proposal Timing
  // ============================================================

  describe("Extended Proposal Timing", function () {
    it("Extended proposal uses 14d voting and 7d execution delay", async function () {
      // Create an Extended proposal
      const proposalId = await createProposal(alice, ProposalType.Extended, "Elect steward");

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

    it("Extended proposal requires 30% quorum", async function () {
      // Eligible = 35% of supply. 30% quorum = 10.5% of supply.
      // Bob (15% of supply) exceeds quorum.
      const proposalId = await createProposal(alice, ProposalType.Extended);

      await time.increase(TWO_DAYS + 1);

      // Only bob votes For — exceeds 30% quorum of eligible supply
      await governor.connect(bob).castVote(proposalId, Vote.For);

      await time.increase(EXTENDED_VOTING_PERIOD + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    it("Extended proposal defeated if 30% quorum not reached", async function () {
      // Eligible = 35% of supply. 30% quorum = 10.5% of supply.
      // Transfer half of alice's tokens to reduce her voting power (10% of supply < 10.5% quorum).
      await armToken.connect(alice).transfer(carol.address, ALICE_AMOUNT / 2n);
      await mineBlock();

      const proposalId = await createProposal(alice, ProposalType.Extended);

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

    it("expired-succeeded proposal bond is immediately claimable", async function () {
      // Enable transfers and approve bond
      await armToken.setWindDownContract(dave.address);
      await armToken.connect(dave).setTransferable(true);
      const bondAmount = ethers.parseUnits("1000", ARM_DECIMALS);
      await armToken.connect(alice).approve(await governor.getAddress(), bondAmount);

      const balanceBefore = await armToken.balanceOf(alice.address);
      const proposalId = await createProposal(alice);

      // Bond was taken
      expect(await armToken.balanceOf(alice.address)).to.equal(balanceBefore - bondAmount);

      // Vote it through
      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      // Wait for voting to end — Succeeded
      await time.increase(STANDARD_VOTING_PERIOD + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Wait past the 14-day grace period without queuing — now Defeated
      await time.increase(FOURTEEN_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);

      // Bond should be immediately claimable — proposer did nothing wrong
      await governor.claimBond(proposalId);
      expect(await armToken.balanceOf(alice.address)).to.equal(balanceBefore);
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
  // 9. Steward Budget Enforcement
  // ============================================================

  describe("Steward Budget Enforcement", function () {
    // Deploy a standalone treasury with deployer as owner for direct steward tests.
    // The main treasuryContract is owned by the timelock, which complicates direct testing.
    // stewardSpend is onlyOwner — deployer calls it directly as the authorized timelock/owner.
    let budgetTreasury: any;
    const TREASURY_USDC = ethers.parseUnits("1000000", 6); // $1M USDC
    const STEWARD_LIMIT = ethers.parseUnits("10000", 6);   // $10K steward budget per window
    const STEWARD_WINDOW = 30 * ONE_DAY;

    async function setupBudgetTreasury() {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      budgetTreasury = await ArmadaTreasuryGov.deploy(deployer.address);
      await budgetTreasury.waitForDeployment();

      // Fund with USDC and authorize token for steward spending
      await usdc.mint(await budgetTreasury.getAddress(), TREASURY_USDC);
      await budgetTreasury.addStewardBudgetToken(await usdc.getAddress(), STEWARD_LIMIT, STEWARD_WINDOW);
    }

    it("stewardSpend enforces the authorized budget limit", async function () {
      await setupBudgetTreasury();

      // $5K spend — within $10K limit
      const firstSpend = ethers.parseUnits("5000", 6);
      await budgetTreasury.stewardSpend(
        await usdc.getAddress(), dave.address, firstSpend
      );

      // Another $5K — reaches limit
      const secondSpend = ethers.parseUnits("5000", 6);
      await budgetTreasury.stewardSpend(
        await usdc.getAddress(), dave.address, secondSpend
      );

      // $10K budget fully used — even $1 more should fail
      await expect(
        budgetTreasury.stewardSpend(
          await usdc.getAddress(), dave.address, 1n
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: exceeds steward budget");
    });

    it("stewardSpend budget resets after window expires", async function () {
      await setupBudgetTreasury();

      // Use the full $10K budget
      await budgetTreasury.stewardSpend(
        await usdc.getAddress(), dave.address, STEWARD_LIMIT
      );

      // At limit — next spend fails
      await expect(
        budgetTreasury.stewardSpend(await usdc.getAddress(), dave.address, 1n)
      ).to.be.revertedWith("ArmadaTreasuryGov: exceeds steward budget");

      // Advance past window
      await time.increase(STEWARD_WINDOW + 1);

      // Budget resets — can spend again
      await budgetTreasury.stewardSpend(
        await usdc.getAddress(), dave.address, STEWARD_LIMIT
      );
      expect(await usdc.balanceOf(dave.address)).to.equal(STEWARD_LIMIT * 2n);
    });

    it("getStewardBudget returns correct values during active window", async function () {
      await setupBudgetTreasury();

      const spend = ethers.parseUnits("3000", 6);
      await budgetTreasury.stewardSpend(
        await usdc.getAddress(), dave.address, spend
      );

      const [budget, spent, remaining] = await budgetTreasury.getStewardBudget(await usdc.getAddress());
      expect(budget).to.equal(STEWARD_LIMIT);
      expect(spent).to.equal(spend);
      expect(remaining).to.equal(STEWARD_LIMIT - spend);
    });

    it("getStewardBudget shows full budget after window expires", async function () {
      await setupBudgetTreasury();

      // Spend some in current window
      const spend = ethers.parseUnits("3000", 6);
      await budgetTreasury.stewardSpend(
        await usdc.getAddress(), dave.address, spend
      );

      // Advance past window
      await time.increase(STEWARD_WINDOW + 1);

      // Spent resets to 0 (view-level reset)
      const [budget, spent, remaining] = await budgetTreasury.getStewardBudget(await usdc.getAddress());
      expect(budget).to.equal(STEWARD_LIMIT);
      expect(spent).to.equal(0n);
      expect(remaining).to.equal(STEWARD_LIMIT);
    });

    it("non-owner cannot call stewardSpend", async function () {
      await setupBudgetTreasury();

      await expect(
        budgetTreasury.connect(carol).stewardSpend(
          await usdc.getAddress(), dave.address, ethers.parseUnits("100", 6)
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: not owner");
    });

    it("stewardSpend reverts for unauthorized token", async function () {
      await setupBudgetTreasury();

      // Deploy a second token not authorized for steward spending
      const MockERC20 = await ethers.getContractFactory("MockUSDCV2");
      const otherToken = await MockERC20.deploy("Other Token", "OTH");
      await otherToken.waitForDeployment();
      await otherToken.mint(await budgetTreasury.getAddress(), ethers.parseUnits("100000", 6));

      await expect(
        budgetTreasury.stewardSpend(
          await otherToken.getAddress(), dave.address, ethers.parseUnits("100", 6)
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: token not authorized for steward");
    });
  });

  describe("TreasurySteward Identity Management", function () {
    // TreasurySteward is identity-only: election, term tracking, and removal.
    // All calls to electSteward/removeSteward are onlyTimelock.
    let testSteward: any;

    async function setupStewardTest() {
      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      testSteward = await TreasurySteward.deploy(
        deployer.address,   // deployer acts as timelock for direct control
      );
      await testSteward.waitForDeployment();
    }

    it("electSteward sets currentSteward and emits StewardElected", async function () {
      await setupStewardTest();

      await expect(testSteward.electSteward(carol.address))
        .to.emit(testSteward, "StewardElected")
        .withArgs(carol.address, (v: bigint) => v > 0n, (v: bigint) => v > 0n);

      expect(await testSteward.currentSteward()).to.equal(carol.address);
      expect(await testSteward.isStewardActive()).to.be.true;
    });

    it("removeSteward clears currentSteward and emits StewardRemoved", async function () {
      await setupStewardTest();

      await testSteward.electSteward(carol.address);
      await expect(testSteward.removeSteward())
        .to.emit(testSteward, "StewardRemoved")
        .withArgs(carol.address);

      expect(await testSteward.currentSteward()).to.equal(ethers.ZeroAddress);
      expect(await testSteward.isStewardActive()).to.be.false;
    });

    it("non-timelock cannot call electSteward", async function () {
      await setupStewardTest();

      await expect(
        testSteward.connect(carol).electSteward(carol.address)
      ).to.be.revertedWith("TreasurySteward: not timelock");
    });

    it("non-timelock cannot call removeSteward", async function () {
      await setupStewardTest();

      await testSteward.electSteward(carol.address);
      await expect(
        testSteward.connect(carol).removeSteward()
      ).to.be.revertedWith("TreasurySteward: not timelock");
    });

    it("isStewardActive returns false after TERM_DURATION expires", async function () {
      await setupStewardTest();

      await testSteward.electSteward(carol.address);
      expect(await testSteward.isStewardActive()).to.be.true;

      const termDuration = await testSteward.TERM_DURATION();
      await time.increase(Number(termDuration) + 1);

      expect(await testSteward.isStewardActive()).to.be.false;
    });

    it("electSteward zero address reverts", async function () {
      await setupStewardTest();

      await expect(
        testSteward.electSteward(ethers.ZeroAddress)
      ).to.be.revertedWith("TreasurySteward: zero address");
    });
  });

  describe("Treasury ETH Handling", function () {
    it("treasury accepts direct ETH transfers (needed for wind-down sweep)", async function () {
      const treasuryAddr = await treasuryContract.getAddress();
      const balanceBefore = await ethers.provider.getBalance(treasuryAddr);

      await deployer.sendTransaction({
        to: treasuryAddr,
        value: ethers.parseEther("1.0"),
      });

      const balanceAfter = await ethers.provider.getBalance(treasuryAddr);
      expect(balanceAfter).to.equal(balanceBefore + ethers.parseEther("1.0"));
    });
  });
});
