// ABOUTME: Hardhat integration tests for SC veto mechanism, ratification votes, and bond deferral.
// ABOUTME: Covers veto lifecycle, SC ejection, double-veto prevention, queue/execute guards, and post-ejection behavior.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

// Proposal types (must match IArmadaGovernance.sol enum order)
const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2 };
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

// Spec-aligned timing
const STANDARD_VOTING_PERIOD = SEVEN_DAYS;
const STANDARD_EXECUTION_DELAY = TWO_DAYS;

describe("Governance Veto", function () {
  // Contracts
  let armToken: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;

  // Signers
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress; // used as Security Council
  let dave: SignerWithAddress;

  // Constants
  const ARM_DECIMALS = 18;
  const TOTAL_SUPPLY = ethers.parseUnits("12000000", ARM_DECIMALS);
  const TREASURY_AMOUNT = TOTAL_SUPPLY * 65n / 100n;
  const ALICE_AMOUNT = TOTAL_SUPPLY * 20n / 100n;
  const BOB_AMOUNT = TOTAL_SUPPLY * 15n / 100n;

  // Helper: mine a block so checkpoint reads work
  async function mineBlock() {
    await mine(1);
  }

  // Helper: impersonate timelock to call governor functions that require timelock caller
  async function asTimelock(): Promise<SignerWithAddress> {
    const timelockAddr = await timelockController.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
    await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
    return await ethers.getSigner(timelockAddr) as unknown as SignerWithAddress;
  }

  async function stopImpersonatingTimelock() {
    const timelockAddr = await timelockController.getAddress();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
  }

  // Helper: create a Standard proposal, vote it through, and queue it
  async function createAndQueueProposal(
    proposer: SignerWithAddress,
    targets?: string[],
    calldatas?: string[],
    description?: string,
  ): Promise<number> {
    const govAddr = await governor.getAddress();
    const _targets = targets ?? [govAddr];
    const _values = [0n];
    const _calldatas = calldatas ?? [governor.interface.encodeFunctionData("proposalCount")];
    const _description = description ?? "Test proposal";

    await governor.connect(proposer).propose(
      ProposalType.Standard, _targets, _values, _calldatas, _description
    );
    const proposalId = Number(await governor.proposalCount());

    // Advance past voting delay (2 days)
    await time.increase(TWO_DAYS + 1);

    // Vote FOR with alice and bob (35% combined, exceeds 20% quorum)
    await governor.connect(alice).castVote(proposalId, Vote.For);
    await governor.connect(bob).castVote(proposalId, Vote.For);

    // Advance past voting period (7 days for Standard)
    await time.increase(STANDARD_VOTING_PERIOD + 1);

    // Queue
    await governor.queue(proposalId);
    expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

    return proposalId;
  }

  // Helper: veto a queued proposal as SC, return the ratification proposal ID
  async function vetoProposal(proposalId: number, rationaleHash?: string): Promise<number> {
    const hash = rationaleHash ?? ethers.keccak256(ethers.toUtf8Bytes("Security risk identified"));

    await governor.connect(carol).veto(proposalId, hash);
    return Number(await governor.proposalCount());
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    // 1. Deploy TimelockController (minDelay = 2 days)
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

    // 5. Configure timelock roles: PROPOSER, EXECUTOR, and CANCELLER for governor
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelockController.EXECUTOR_ROLE();
    const CANCELLER_ROLE = await timelockController.CANCELLER_ROLE();
    const ADMIN_ROLE = await timelockController.TIMELOCK_ADMIN_ROLE();
    const govAddr = await governor.getAddress();

    await timelockController.grantRole(PROPOSER_ROLE, govAddr);
    await timelockController.grantRole(EXECUTOR_ROLE, govAddr);
    await timelockController.grantRole(CANCELLER_ROLE, govAddr);

    // 6. Set Security Council (carol) via timelock impersonation
    const timelockSigner = await asTimelock();
    await governor.connect(timelockSigner).setSecurityCouncil(carol.address);
    await stopImpersonatingTimelock();

    // 7. Renounce deployer admin role on timelock
    await timelockController.renounceRole(ADMIN_ROLE, deployer.address);

    // 8. Configure ARM token
    await armToken.setNoDelegation(await treasury.getAddress());
    await armToken.initWhitelist([
      deployer.address,
      await treasury.getAddress(),
      alice.address,
      bob.address,
      govAddr,
    ]);

    // 9. Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // 10. Delegate tokens for voting power
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

    await mineBlock();
  });

  // ======== Veto Core ========

  describe("Veto Core", function () {
    it("should cancel a queued proposal when SC vetoes", async function () {
      const proposalId = await createAndQueueProposal(alice);

      await governor.connect(carol).veto(
        proposalId, ethers.keccak256(ethers.toUtf8Bytes("Security risk"))
      );

      expect(await governor.state(proposalId)).to.equal(ProposalState.Canceled);
    });

    it("should create a ratification proposal on veto", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const countBefore = Number(await governor.proposalCount());

      const ratId = await vetoProposal(proposalId);

      expect(ratId).to.equal(countBefore + 1);
      expect(await governor.ratificationOf(ratId)).to.equal(proposalId);
      expect(await governor.vetoRatificationId(proposalId)).to.equal(ratId);
    });

    it("should create ratification with correct VetoRatification params", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      const [proposer, proposalType, voteStart, voteEnd] = await governor.getProposal(ratId);

      expect(proposer).to.equal(carol.address); // SC is the proposer
      expect(proposalType).to.equal(ProposalType.VetoRatification);

      // VetoRatification has 0 voting delay — voting starts at creation time
      // voteEnd should be voteStart + 7 days
      expect(voteEnd - voteStart).to.equal(SEVEN_DAYS);
    });

    it("should start ratification voting immediately (Active state)", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      // Should be Active immediately (0 voting delay)
      expect(await governor.state(ratId)).to.equal(ProposalState.Active);

      // Can vote immediately
      await governor.connect(alice).castVote(ratId, Vote.For);
    });

    it("should emit ProposalVetoed event", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const rationaleHash = ethers.keccak256(ethers.toUtf8Bytes("Security risk"));
      const expectedRatId = Number(await governor.proposalCount()) + 1;

      await expect(
        governor.connect(carol).veto(proposalId, rationaleHash)
      ).to.emit(governor, "ProposalVetoed").withArgs(
        proposalId, rationaleHash, expectedRatId
      );
    });

    it("should cancel the timelock operation on veto", async function () {
      const proposalId = await createAndQueueProposal(alice);

      // Get the timelock operation ID before veto.
      // ethers v6 returns readonly Result objects — convert to plain arrays for contract calls.
      const result = await governor.getProposalActions(proposalId);
      const targets = Array.from(result[0]);
      const values = Array.from(result[1]);
      const calldatas = Array.from(result[2]);
      const salt = ethers.zeroPadValue(ethers.toBeHex(proposalId), 32);
      const timelockId = await timelockController.hashOperationBatch(
        targets, values, calldatas, ethers.ZeroHash, salt
      );

      // Verify operation is pending in timelock
      expect(await timelockController.isOperationPending(timelockId)).to.be.true;

      await vetoProposal(proposalId);

      // Verify operation is no longer pending
      expect(await timelockController.isOperationPending(timelockId)).to.be.false;
    });
  });

  // ======== Veto Access Control ========

  describe("Veto Access Control", function () {
    it("should revert if caller is not SC", async function () {
      const proposalId = await createAndQueueProposal(alice);

      await expect(
        governor.connect(alice).veto(
          proposalId, ethers.keccak256(ethers.toUtf8Bytes("rationale"))
        )
      ).to.be.revertedWithCustomError(governor, "Gov_NotSecurityCouncil");
    });

    it("should revert if SC has been ejected", async function () {
      const proposalId = await createAndQueueProposal(alice);

      // Eject SC via timelock
      const timelockSigner = await asTimelock();
      await governor.connect(timelockSigner).setSecurityCouncil(ethers.ZeroAddress);
      await stopImpersonatingTimelock();

      await expect(
        governor.connect(carol).veto(
          proposalId, ethers.keccak256(ethers.toUtf8Bytes("rationale"))
        )
      ).to.be.revertedWithCustomError(governor, "Gov_NotSecurityCouncil");
    });

    it("should revert if proposal is not Queued", async function () {
      // Create proposal but don't queue it
      const govAddr = await governor.getAddress();
      await governor.connect(alice).propose(
        ProposalType.Standard,
        [govAddr], [0n],
        [governor.interface.encodeFunctionData("proposalCount")],
        "Test proposal"
      );
      const proposalId = Number(await governor.proposalCount());

      // Still Pending
      await expect(
        governor.connect(carol).veto(
          proposalId, ethers.keccak256(ethers.toUtf8Bytes("rationale"))
        )
      ).to.be.revertedWithCustomError(governor, "Gov_NotQueued");

      // Advance to Active
      await time.increase(TWO_DAYS + 1);
      await expect(
        governor.connect(carol).veto(
          proposalId, ethers.keccak256(ethers.toUtf8Bytes("rationale"))
        )
      ).to.be.revertedWithCustomError(governor, "Gov_NotQueued");
    });
  });

  // ======== Ratification Resolution ========

  describe("Ratification Resolution", function () {
    it("should uphold veto when FOR wins", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      // Vote FOR (uphold veto)
      await governor.connect(alice).castVote(ratId, Vote.For);
      await governor.connect(bob).castVote(ratId, Vote.For);

      // Advance past voting period (7 days)
      await time.increase(SEVEN_DAYS + 1);

      await expect(governor.resolveRatification(ratId))
        .to.emit(governor, "RatificationResolved")
        .withArgs(ratId, true);

      // SC retains seat
      expect(await governor.securityCouncil()).to.equal(carol.address);
      // Original proposal stays canceled
      expect(await governor.state(proposalId)).to.equal(ProposalState.Canceled);
    });

    it("should uphold veto when quorum is not met", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      // No one votes — quorum not met

      // Advance past voting period
      await time.increase(SEVEN_DAYS + 1);

      await expect(governor.resolveRatification(ratId))
        .to.emit(governor, "RatificationResolved")
        .withArgs(ratId, true);

      // SC retains seat
      expect(await governor.securityCouncil()).to.equal(carol.address);
    });

    it("should eject SC when AGAINST wins with quorum", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      // Vote AGAINST (deny veto)
      await governor.connect(alice).castVote(ratId, Vote.Against);
      await governor.connect(bob).castVote(ratId, Vote.Against);

      // Advance past voting period
      await time.increase(SEVEN_DAYS + 1);

      const tx = governor.resolveRatification(ratId);
      await expect(tx).to.emit(governor, "SecurityCouncilEjected").withArgs(ratId);
      await expect(tx).to.emit(governor, "SecurityCouncilUpdated").withArgs(carol.address, ethers.ZeroAddress);
      await expect(tx).to.emit(governor, "RatificationResolved").withArgs(ratId, false);

      // SC ejected
      expect(await governor.securityCouncil()).to.equal(ethers.ZeroAddress);
    });

    it("should store calldata hash when veto is denied", async function () {
      const proposalId = await createAndQueueProposal(alice);

      // Compute expected calldata hash
      const [targets, values, calldatas] = await governor.getProposalActions(proposalId);
      const expectedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address[]", "uint256[]", "bytes[]"],
          [targets, values, calldatas]
        )
      );

      const ratId = await vetoProposal(proposalId);

      // Vote AGAINST
      await governor.connect(alice).castVote(ratId, Vote.Against);
      await governor.connect(bob).castVote(ratId, Vote.Against);

      await time.increase(SEVEN_DAYS + 1);
      await governor.resolveRatification(ratId);

      expect(await governor.vetoDeniedHashes(expectedHash)).to.be.true;
    });

    it("should revert if voting hasn't ended", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      await expect(
        governor.resolveRatification(ratId)
      ).to.be.revertedWithCustomError(governor, "Gov_VotingNotEnded");
    });

    it("should revert if not a ratification proposal", async function () {
      const proposalId = await createAndQueueProposal(alice);

      await expect(
        governor.resolveRatification(proposalId)
      ).to.be.revertedWithCustomError(governor, "Gov_NotARatificationProposal");
    });

    it("should revert if already resolved", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      await governor.connect(alice).castVote(ratId, Vote.For);
      await time.increase(SEVEN_DAYS + 1);
      await governor.resolveRatification(ratId);

      await expect(
        governor.resolveRatification(ratId)
      ).to.be.revertedWithCustomError(governor, "Gov_AlreadyResolved");
    });
  });

  // ======== Double-Veto Prevention ========

  describe("Double-Veto Prevention", function () {
    it("should block veto on identical calldata after community denial", async function () {
      // First proposal: create, queue, veto, community AGAINST → deny veto
      const proposalId1 = await createAndQueueProposal(alice);
      const ratId1 = await vetoProposal(proposalId1);

      await governor.connect(alice).castVote(ratId1, Vote.Against);
      await governor.connect(bob).castVote(ratId1, Vote.Against);
      await time.increase(SEVEN_DAYS + 1);
      await governor.resolveRatification(ratId1);

      // SC ejected, set new SC (dave)
      expect(await governor.securityCouncil()).to.equal(ethers.ZeroAddress);
      const timelockSigner = await asTimelock();
      await governor.connect(timelockSigner).setSecurityCouncil(dave.address);
      await stopImpersonatingTimelock();

      // Second proposal with identical calldata
      const proposalId2 = await createAndQueueProposal(
        alice,
        undefined, // same targets (governor)
        undefined, // same calldatas (proposalCount)
        "second attempt"
      );

      // New SC tries to veto — should revert
      await expect(
        governor.connect(dave).veto(
          proposalId2, ethers.keccak256(ethers.toUtf8Bytes("rationale2"))
        )
      ).to.be.revertedWithCustomError(governor, "Gov_CommunityOverrodeNoDoubleVeto");
    });

    it("should allow veto on modified calldata", async function () {
      // First: veto denied
      const proposalId1 = await createAndQueueProposal(alice);
      const ratId1 = await vetoProposal(proposalId1);

      await governor.connect(alice).castVote(ratId1, Vote.Against);
      await governor.connect(bob).castVote(ratId1, Vote.Against);
      await time.increase(SEVEN_DAYS + 1);
      await governor.resolveRatification(ratId1);

      // Set new SC (dave)
      const timelockSigner = await asTimelock();
      await governor.connect(timelockSigner).setSecurityCouncil(dave.address);
      await stopImpersonatingTimelock();

      // Second proposal with DIFFERENT calldata
      const govAddr = await governor.getAddress();
      const proposalId2 = await createAndQueueProposal(
        alice,
        [govAddr],
        [governor.interface.encodeFunctionData("proposalThreshold")],
        "different calldata"
      );

      // New SC can veto — different calldata hash
      await governor.connect(dave).veto(
        proposalId2, ethers.keccak256(ethers.toUtf8Bytes("rationale2"))
      );

      expect(await governor.state(proposalId2)).to.equal(ProposalState.Canceled);
    });
  });

  // ======== Queue/Execute Guards ========

  describe("Queue/Execute Guards", function () {
    it("should revert queue() for ratification proposals", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      // Vote FOR so it would be "Succeeded"
      await governor.connect(alice).castVote(ratId, Vote.For);
      await governor.connect(bob).castVote(ratId, Vote.For);
      await time.increase(SEVEN_DAYS + 1);

      await expect(
        governor.queue(ratId)
      ).to.be.revertedWithCustomError(governor, "Gov_UseResolveRatification");
    });

    it("should revert execute() for ratification proposals", async function () {
      const proposalId = await createAndQueueProposal(alice);
      const ratId = await vetoProposal(proposalId);

      // Vote FOR
      await governor.connect(alice).castVote(ratId, Vote.For);
      await governor.connect(bob).castVote(ratId, Vote.For);
      await time.increase(SEVEN_DAYS + 1);

      // Ratification proposals are never queued (they bypass normal execution path),
      // so execute() reverts at the Queued state check before reaching the type guard.
      await expect(
        governor.execute(ratId)
      ).to.be.revertedWithCustomError(governor, "Gov_NotQueued");
    });
  });

  // ======== Post-Ejection ========

  describe("Post-Ejection", function () {
    it("should prevent ejected SC from vetoing", async function () {
      const proposalId1 = await createAndQueueProposal(alice);

      // Veto → community AGAINST → SC ejected
      const ratId = await vetoProposal(proposalId1);
      await governor.connect(alice).castVote(ratId, Vote.Against);
      await governor.connect(bob).castVote(ratId, Vote.Against);
      await time.increase(SEVEN_DAYS + 1);
      await governor.resolveRatification(ratId);

      expect(await governor.securityCouncil()).to.equal(ethers.ZeroAddress);

      // Create a new proposal and queue it
      const proposalId2 = await createAndQueueProposal(alice);

      // Ejected SC tries to veto — carol is no longer SC
      await expect(
        governor.connect(carol).veto(
          proposalId2, ethers.keccak256(ethers.toUtf8Bytes("rationale"))
        )
      ).to.be.revertedWithCustomError(governor, "Gov_NotSecurityCouncil");
    });

    it("should allow governance to set a new SC after ejection", async function () {
      // Eject SC via timelock
      const timelockSigner = await asTimelock();
      await governor.connect(timelockSigner).setSecurityCouncil(ethers.ZeroAddress);

      expect(await governor.securityCouncil()).to.equal(ethers.ZeroAddress);

      // Set new SC (dave) via governance
      await governor.connect(timelockSigner).setSecurityCouncil(dave.address);
      await stopImpersonatingTimelock();

      expect(await governor.securityCouncil()).to.equal(dave.address);
    });
  });

  // ======== Full Lifecycle Integration ========

  describe("Full Lifecycle", function () {
    it("should complete veto-upheld lifecycle: propose → vote → queue → veto → FOR → upheld", async function () {
      // 1. Create and queue a proposal
      const proposalId = await createAndQueueProposal(alice);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

      // 2. SC vetoes
      const rationaleHash = ethers.keccak256(ethers.toUtf8Bytes("Potential reentrancy vulnerability"));
      await governor.connect(carol).veto(proposalId, rationaleHash);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Canceled);

      // 3. Ratification vote begins immediately
      const ratId = Number(await governor.proposalCount());
      expect(await governor.state(ratId)).to.equal(ProposalState.Active);

      // 4. Community votes FOR (uphold veto)
      await governor.connect(alice).castVote(ratId, Vote.For);
      await governor.connect(bob).castVote(ratId, Vote.For);

      // 5. Voting ends
      await time.increase(SEVEN_DAYS + 1);

      // 6. Resolve
      await governor.resolveRatification(ratId);

      // 7. Verify final state
      expect(await governor.securityCouncil()).to.equal(carol.address);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Canceled);
      expect(await governor.state(ratId)).to.equal(ProposalState.Executed);
    });

    it("should complete veto-denied lifecycle: propose → vote → queue → veto → AGAINST → SC ejected → new SC set", async function () {
      // 1. Create and queue
      const proposalId = await createAndQueueProposal(alice);

      // 2. SC vetoes
      await governor.connect(carol).veto(
        proposalId, ethers.keccak256(ethers.toUtf8Bytes("False alarm"))
      );

      // 3. Community votes AGAINST (deny veto)
      const ratId = Number(await governor.proposalCount());
      await governor.connect(alice).castVote(ratId, Vote.Against);
      await governor.connect(bob).castVote(ratId, Vote.Against);

      // 4. Resolve
      await time.increase(SEVEN_DAYS + 1);
      await governor.resolveRatification(ratId);

      // 5. SC ejected
      expect(await governor.securityCouncil()).to.equal(ethers.ZeroAddress);

      // 6. Calldata hash stored
      const [targets, values, calldatas] = await governor.getProposalActions(proposalId);
      const calldataHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address[]", "uint256[]", "bytes[]"],
          [targets, values, calldatas]
        )
      );
      expect(await governor.vetoDeniedHashes(calldataHash)).to.be.true;

      // 7. Governance can set new SC
      const timelockSigner = await asTimelock();
      await governor.connect(timelockSigner).setSecurityCouncil(dave.address);
      await stopImpersonatingTimelock();
      expect(await governor.securityCouncil()).to.equal(dave.address);
    });
  });
});
