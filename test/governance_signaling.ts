/**
 * Governance Signaling Proposal Tests
 *
 * Tests the Signaling proposal type — non-executable, text-only proposals
 * for measuring token-holder preference. Signaling proposals follow the
 * standard lifecycle (submit → pending → active → outcome) but skip the
 * execution phase (no queue, no timelock, no execute).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

// Proposal types (must match IArmadaGovernance.sol enum order)
const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2, Steward: 3, Signaling: 4 };
// Proposal states
const ProposalState = {
  Pending: 0, Active: 1, Defeated: 2, Succeeded: 3,
  Queued: 4, Executed: 5, Canceled: 6,
};
// Vote support values
const Vote = { Against: 0, For: 1, Abstain: 2 };

// Time constants
const ONE_DAY = 86400;
const TWO_DAYS = 2 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;
const FOURTEEN_DAYS = 14 * ONE_DAY;
const THIRTY_DAYS = 30 * ONE_DAY;

describe("Governance — Signaling Proposals", function () {
  // Contracts
  let armToken: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;

  // Signers
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  // Constants
  const ARM_DECIMALS = 18;
  const TOTAL_SUPPLY = ethers.parseUnits("12000000", ARM_DECIMALS);
  const TREASURY_AMOUNT = TOTAL_SUPPLY * 65n / 100n;
  const ALICE_AMOUNT = TOTAL_SUPPLY * 20n / 100n;
  const BOB_AMOUNT = TOTAL_SUPPLY * 15n / 100n;

  async function mineBlock() {
    await mine(1);
  }

  // Helper: create a signaling proposal
  async function createSignalingProposal(
    proposer: SignerWithAddress,
    description: string,
  ): Promise<number> {
    await governor.connect(proposer).propose(
      ProposalType.Signaling, [], [], [], description
    );
    return Number(await governor.proposalCount());
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    // 1. Deploy TimelockController
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    // 2. Deploy ARM token
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    // 3. Deploy Treasury
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(timelockAddr);
    await treasury.waitForDeployment();

    // 4. Deploy Governor
    governor = await deployGovernorProxy(
      await armToken.getAddress(),
      timelockAddr,
      await treasury.getAddress(),
    );

    // 5. Configure token: whitelist and noDelegation
    await armToken.initWhitelist([
      deployer.address,
      await treasury.getAddress(),
      alice.address,
      bob.address,
    ]);
    await armToken.initNoDelegation([await treasury.getAddress()]);

    // 6. Configure timelock roles
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelockController.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelockController.TIMELOCK_ADMIN_ROLE();

    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());

    // 7. Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // 8. Renounce deployer admin
    await timelockController.renounceRole(ADMIN_ROLE, deployer.address);

    // 9. Self-delegate to activate voting power
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

    await mineBlock();
  });

  // ========== Lifecycle Tests ==========

  describe("Lifecycle", function () {
    // WHY: Signaling proposals must be creatable with empty execution arrays.
    // This is the fundamental difference from executable proposals — the propose()
    // function must accept empty targets for Signaling type.
    it("should create a signaling proposal in Pending state", async function () {
      const proposalId = await createSignalingProposal(alice, "Should we pursue cross-chain MASP?");

      expect(await governor.state(proposalId)).to.equal(ProposalState.Pending);
      const proposal = await governor.getProposal(proposalId);
      expect(proposal.proposalType).to.equal(ProposalType.Signaling);
    });

    // WHY: Verify that the signaling lifecycle correctly transitions through
    // Pending → Active after the standard 48h voting delay.
    it("should become Active after voting delay", async function () {
      const proposalId = await createSignalingProposal(alice, "Temperature check: Aave integration");

      await time.increase(TWO_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);
    });

    // WHY: After voting ends with quorum met and majority FOR, signaling proposals
    // must resolve to Succeeded. This is terminal — no queue/execute phase follows.
    it("should resolve to Succeeded when quorum met and majority FOR", async function () {
      const proposalId = await createSignalingProposal(alice, "Pursue hub-and-spoke architecture");

      // Fast-forward past voting delay
      await time.increase(TWO_DAYS + 1);

      // Alice votes FOR (20% > quorum of 20% eligible = passes)
      await governor.connect(alice).castVote(proposalId, Vote.For);

      // Fast-forward past voting period
      await time.increase(SEVEN_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    // WHY: Signaling Succeeded state must be permanent — there is no grace period
    // because there is nothing to queue. Without the Signaling-specific check in
    // state(), the grace period expiry would incorrectly transition to Defeated.
    it("should remain Succeeded indefinitely (no grace period expiry)", async function () {
      const proposalId = await createSignalingProposal(alice, "Permanent signaling result");

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await time.increase(SEVEN_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Fast-forward well past the QUEUE_GRACE_PERIOD (14 days)
      await time.increase(THIRTY_DAYS);

      // Still Succeeded — not expired to Defeated
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);
    });

    // WHY: Signaling proposals with insufficient quorum must be Defeated,
    // same as executable proposals. The quorum mechanism is shared.
    it("should resolve to Defeated when quorum not reached", async function () {
      const proposalId = await createSignalingProposal(alice, "No quorum scenario");

      await time.increase(TWO_DAYS + 1);

      // No one votes — quorum not met
      await time.increase(SEVEN_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    // WHY: A majority of AGAINST votes with quorum must defeat the proposal.
    it("should resolve to Defeated when majority votes AGAINST", async function () {
      const proposalId = await createSignalingProposal(alice, "Unpopular idea");

      await time.increase(TWO_DAYS + 1);

      // Alice FOR, Bob AGAINST — Bob has 15% but with Alice's 20%, quorum met.
      // Majority is AGAINST only if againstVotes >= forVotes. Here Alice 20% > Bob 15%
      // so we need Bob to have more weight. Let's have Alice AGAINST, Bob FOR isn't enough.
      // Actually: Alice 20% FOR, Bob 15% AGAINST — majority FOR. Let's flip.
      await governor.connect(alice).castVote(proposalId, Vote.Against);
      await governor.connect(bob).castVote(proposalId, Vote.For);

      await time.increase(SEVEN_DAYS + 1);

      // Alice has 20% against, Bob has 15% for — majority against, quorum met
      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });
  });

  // ========== Guard Tests ==========

  describe("Guards", function () {
    // WHY: Signaling proposals must not carry execution data. If targets are non-empty,
    // someone is trying to sneak executable data into a non-executable proposal type.
    it("should revert when creating signaling with non-empty targets", async function () {
      const target = await governor.getAddress();
      await expect(
        governor.connect(alice).propose(
          ProposalType.Signaling,
          [target],
          [0n],
          ["0x"],
          "Sneaky executable"
        )
      ).to.be.revertedWithCustomError(governor, "Gov_SignalingMustBeEmpty");
    });

    // WHY: Defense-in-depth — even though state() prevents Signaling from reaching
    // Succeeded-with-queue-eligibility, the explicit guard in queue() provides a
    // clear revert reason and prevents reliance on state machine logic alone.
    it("should revert when trying to queue a signaling proposal", async function () {
      const proposalId = await createSignalingProposal(alice, "Cannot queue me");

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(proposalId, Vote.For);
      await time.increase(SEVEN_DAYS + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      await expect(
        governor.queue(proposalId)
      ).to.be.revertedWithCustomError(governor, "Gov_SignalingNoExecution");
    });

    // WHY: Signaling proposal params (timing, quorum) must be immutable — they represent
    // fixed spec requirements and should not be changeable via governance votes.
    it("should revert when trying to change signaling params", async function () {
      // Need to call via timelock — impersonate it
      const timelockAddr = await timelockController.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
      await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
      const timelockSigner = await ethers.getSigner(timelockAddr);

      await expect(
        governor.connect(timelockSigner).setProposalTypeParams(
          ProposalType.Signaling,
          { votingDelay: ONE_DAY, votingPeriod: FOURTEEN_DAYS, executionDelay: 0, quorumBps: 3000 }
        )
      ).to.be.revertedWithCustomError(governor, "Gov_ImmutableProposalType");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
    });

    // WHY: Signaling proposals must enforce the same proposal threshold as all other types.
    // A proposer without sufficient delegated ARM must be rejected.
    it("should require proposal threshold to create signaling proposal", async function () {
      // Carol has no ARM tokens — should fail threshold check
      await expect(
        governor.connect(carol).propose(
          ProposalType.Signaling, [], [], [], "No tokens carol"
        )
      ).to.be.revertedWithCustomError(governor, "Gov_BelowProposalThreshold");
    });

    // WHY: Signaling proposals must be blocked after wind-down is activated,
    // same as all other proposal types.
    it("should be blocked after wind-down", async function () {
      // Register a mock wind-down address and activate via impersonation.
      // We only need windDownActive=true; full ArmadaWindDown deployment is tested elsewhere.
      const timelockAddr = await timelockController.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
      await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
      const timelockSigner = await ethers.getSigner(timelockAddr);

      const mockWindDown = dave.address;
      await governor.connect(timelockSigner).setWindDownContract(mockWindDown);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);

      await ethers.provider.send("hardhat_impersonateAccount", [mockWindDown]);
      await governor.connect(dave).setWindDownActive();
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [mockWindDown]);

      await expect(
        governor.connect(alice).propose(
          ProposalType.Signaling, [], [], [], "After wind-down"
        )
      ).to.be.revertedWithCustomError(governor, "Gov_GovernanceEnded");
    });

    // WHY: Signaling proposals use standard timing and must never be auto-promoted
    // to Extended. Since they have no calldata, classification is skipped entirely.
    it("should use standard timing (7d vote, 48h delay)", async function () {
      const proposalId = await createSignalingProposal(alice, "Check timing params");

      const proposal = await governor.getProposal(proposalId);
      const votingPeriod = Number(proposal.voteEnd - proposal.voteStart);
      const votingDelay = Number(proposal.voteStart) - (await time.latest());

      // Voting period = 7 days (604800 seconds)
      expect(votingPeriod).to.equal(SEVEN_DAYS);
      // Voting delay should be approximately 2 days (with small block time variance)
      expect(votingDelay).to.be.closeTo(TWO_DAYS, 5);
    });
  });

  // ========== Voting Tests ==========

  describe("Voting", function () {
    // WHY: FOR/AGAINST/ABSTAIN voting mechanics must work identically to executable
    // proposals. The voting system is shared across all proposal types.
    it("should support FOR/AGAINST/ABSTAIN votes", async function () {
      const proposalId = await createSignalingProposal(alice, "Vote mechanics test");

      await time.increase(TWO_DAYS + 1);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      await governor.connect(bob).castVote(proposalId, Vote.Against);

      const proposal = await governor.getProposal(proposalId);
      expect(proposal.forVotes).to.equal(ALICE_AMOUNT);
      expect(proposal.againstVotes).to.equal(BOB_AMOUNT);
    });

    // WHY: Vote changing during the voting period is a core governance feature
    // that must work for signaling proposals too.
    it("should allow vote changing during voting period", async function () {
      const proposalId = await createSignalingProposal(alice, "Change your mind");

      await time.increase(TWO_DAYS + 1);

      await governor.connect(alice).castVote(proposalId, Vote.For);
      expect((await governor.getProposal(proposalId)).forVotes).to.equal(ALICE_AMOUNT);

      // Change vote from FOR to AGAINST
      await governor.connect(alice).castVote(proposalId, Vote.Against);
      const proposal = await governor.getProposal(proposalId);
      expect(proposal.forVotes).to.equal(0n);
      expect(proposal.againstVotes).to.equal(ALICE_AMOUNT);
    });
  });

  // ========== Cancellation Tests ==========

  describe("Cancellation", function () {
    // WHY: Signaling proposals follow Standard cancellation rules — proposer can
    // cancel only during the Pending state (before voting starts).
    it("should allow proposer to cancel during Pending", async function () {
      const proposalId = await createSignalingProposal(alice, "Cancel me");

      expect(await governor.state(proposalId)).to.equal(ProposalState.Pending);

      await governor.connect(alice).cancel(proposalId);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Canceled);
    });

    // WHY: Signaling proposals (like Standard) must not be cancellable once voting
    // has started. Only Steward proposals have the extended cancel window.
    it("should revert cancel during Active (Standard rule)", async function () {
      const proposalId = await createSignalingProposal(alice, "Too late to cancel");

      await time.increase(TWO_DAYS + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      await expect(
        governor.connect(alice).cancel(proposalId)
      ).to.be.revertedWithCustomError(governor, "Gov_NotPending");
    });
  });

  // ========== Event Tests ==========

  describe("Events", function () {
    // WHY: The ProposalCreated event must correctly reflect the Signaling type
    // so off-chain indexers and UIs can distinguish proposal kinds.
    it("should emit ProposalCreated with Signaling type", async function () {
      const description = "Signaling event test";

      await expect(
        governor.connect(alice).propose(
          ProposalType.Signaling, [], [], [], description
        )
      ).to.emit(governor, "ProposalCreated")
        .withArgs(
          1, // proposalId (first proposal)
          alice.address,
          ProposalType.Signaling,
          (v: any) => true, // voteStart (any timestamp)
          (v: any) => true, // voteEnd (any timestamp)
          description
        );
    });
  });
});
