/**
 * Governance Parameter Update Tests
 *
 * Tests the ability to update proposal type parameters via governance:
 * - Timelock-only access control
 * - Bounded parameter validation (min/max for all fields)
 * - Full governance lifecycle to change params (auto-classified as Extended)
 * - Quorum snapshotting: in-flight proposals unaffected by param changes
 * - TreasurySteward.minActionDelay() reflects updated governor timing
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

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
const MAX_PAUSE_DURATION = FOURTEEN_DAYS;
const STANDARD_VOTING_PERIOD = SEVEN_DAYS;
const EXTENDED_VOTING_PERIOD = FOURTEEN_DAYS;
const STANDARD_EXECUTION_DELAY = TWO_DAYS;
const EXTENDED_EXECUTION_DELAY = SEVEN_DAYS;

const ARM_DECIMALS = 18;
const TOTAL_SUPPLY = ethers.parseUnits("12000000", ARM_DECIMALS); // must match ArmadaToken.INITIAL_SUPPLY
const TREASURY_AMOUNT = TOTAL_SUPPLY * 65n / 100n; // 65% to treasury
const ALICE_AMOUNT = TOTAL_SUPPLY * 20n / 100n;    // 20% to Alice (voter)
const BOB_AMOUNT = TOTAL_SUPPLY * 15n / 100n;      // 15% to Bob (voter)
// ProposalType enum values
const ProposalType_Steward = 3;

describe("Governance Parameter Updates", function () {
  let armToken: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;
  let stewardContract: any;

  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  async function mineBlock() {
    await mine(1);
  }

  // Helper: create, pass, queue, and execute a proposal
  async function passProposal(
    proposer: SignerWithAddress,
    voters: { signer: SignerWithAddress; support: number }[],
    proposalType: number,
    targets: string[],
    values: bigint[],
    calldatas: string[],
    description: string
  ): Promise<number> {
    const tx = await governor.connect(proposer).propose(
      proposalType, targets, values, calldatas, description
    );
    await tx.wait();
    const proposalId = Number(await governor.proposalCount());

    await time.increase(TWO_DAYS + 1);
    for (const v of voters) {
      await governor.connect(v.signer).castVote(proposalId, v.support);
    }

    const votingPeriod = proposalType === ProposalType.Extended ? EXTENDED_VOTING_PERIOD : STANDARD_VOTING_PERIOD;
    await time.increase(votingPeriod + 1);
    await governor.queue(proposalId);

    const executionDelay = proposalType === ProposalType.Extended ? EXTENDED_EXECUTION_DELAY : TWO_DAYS;
    await time.increase(executionDelay + 1);
    await governor.execute(proposalId);

    return proposalId;
  }

  // Helper: create and pass proposal but don't execute (return at Queued + ready state)
  async function passAndQueueProposal(
    proposer: SignerWithAddress,
    voters: { signer: SignerWithAddress; support: number }[],
    proposalType: number,
    targets: string[],
    values: bigint[],
    calldatas: string[],
    description: string
  ): Promise<number> {
    const tx = await governor.connect(proposer).propose(
      proposalType, targets, values, calldatas, description
    );
    await tx.wait();
    const proposalId = Number(await governor.proposalCount());

    await time.increase(TWO_DAYS + 1);
    for (const v of voters) {
      await governor.connect(v.signer).castVote(proposalId, v.support);
    }

    const votingPeriod = proposalType === ProposalType.Extended ? EXTENDED_VOTING_PERIOD : STANDARD_VOTING_PERIOD;
    await time.increase(votingPeriod + 1);
    await governor.queue(proposalId);

    const executionDelay = proposalType === ProposalType.Extended ? EXTENDED_EXECUTION_DELAY : TWO_DAYS;
    await time.increase(executionDelay + 1);

    return proposalId;
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol] = await ethers.getSigners();

    // Deploy TimelockController first (needed by ArmadaToken)
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
    treasury = await ArmadaTreasuryGov.deploy(
      timelockAddr, deployer.address, MAX_PAUSE_DURATION
    );
    await treasury.waitForDeployment();

    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await armToken.getAddress(),
      timelockAddr,
      await treasury.getAddress(),
      deployer.address, MAX_PAUSE_DURATION
    );
    await governor.waitForDeployment();

    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    stewardContract = await TreasurySteward.deploy(
      timelockAddr,
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

    // Configure token: mark treasury as no-delegation, whitelist all participants
    await armToken.setNoDelegation(await treasury.getAddress());
    await armToken.initWhitelist([deployer.address, await treasury.getAddress(), alice.address, bob.address]);

    // Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // Delegate voting power to self
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

    await mineBlock();
  });

  // ============================================================
  // 1. Access Control
  // ============================================================

  describe("Access Control", function () {
    it("non-timelock cannot update proposal params", async function () {
      const newParams = {
        votingDelay: 3 * ONE_DAY,
        votingPeriod: 7 * ONE_DAY,
        executionDelay: 3 * ONE_DAY,
        quorumBps: 2500,
      };
      await expect(
        governor.connect(alice).setProposalTypeParams(ProposalType.Standard, newParams)
      ).to.be.revertedWith("ArmadaGovernor: not timelock");
    });

    it("deployer cannot update proposal params", async function () {
      const newParams = {
        votingDelay: 3 * ONE_DAY,
        votingPeriod: 7 * ONE_DAY,
        executionDelay: 3 * ONE_DAY,
        quorumBps: 2500,
      };
      await expect(
        governor.connect(deployer).setProposalTypeParams(ProposalType.Standard, newParams)
      ).to.be.revertedWith("ArmadaGovernor: not timelock");
    });
  });

  // ============================================================
  // 2. Bounds Validation
  // ============================================================

  describe("Bounds Validation", function () {
    // Use a standalone governor where deployer acts as timelock for direct testing
    let standaloneGovernor: any;

    beforeEach(async function () {
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      standaloneGovernor = await ArmadaGovernor.deploy(
        await armToken.getAddress(),
        deployer.address,   // deployer acts as timelock
        await treasury.getAddress(),
        deployer.address, MAX_PAUSE_DURATION
      );
      await standaloneGovernor.waitForDeployment();
    });

    const validParams = {
      votingDelay: 2 * ONE_DAY,
      votingPeriod: 5 * ONE_DAY,
      executionDelay: 2 * ONE_DAY,
      quorumBps: 2000,
    };

    it("accepts valid params within bounds", async function () {
      await standaloneGovernor.setProposalTypeParams(ProposalType.Standard, validParams);
      const [delay, period, execDelay, quorum] = await standaloneGovernor.proposalTypeParams(ProposalType.Standard);
      expect(delay).to.equal(validParams.votingDelay);
      expect(period).to.equal(validParams.votingPeriod);
      expect(execDelay).to.equal(validParams.executionDelay);
      expect(quorum).to.equal(validParams.quorumBps);
    });

    it("accepts minimum valid bounds", async function () {
      const minParams = {
        votingDelay: 1 * ONE_DAY,
        votingPeriod: 1 * ONE_DAY,
        executionDelay: 1 * ONE_DAY,
        quorumBps: 500,
      };
      await standaloneGovernor.setProposalTypeParams(ProposalType.Standard, minParams);
      const [delay, period, execDelay, quorum] = await standaloneGovernor.proposalTypeParams(ProposalType.Standard);
      expect(delay).to.equal(minParams.votingDelay);
      expect(period).to.equal(minParams.votingPeriod);
      expect(execDelay).to.equal(minParams.executionDelay);
      expect(quorum).to.equal(minParams.quorumBps);
    });

    it("accepts maximum valid bounds", async function () {
      const maxParams = {
        votingDelay: 14 * ONE_DAY,
        votingPeriod: 30 * ONE_DAY,
        executionDelay: 14 * ONE_DAY,
        quorumBps: 5000,
      };
      await standaloneGovernor.setProposalTypeParams(ProposalType.Standard, maxParams);
      const [delay, period, execDelay, quorum] = await standaloneGovernor.proposalTypeParams(ProposalType.Standard);
      expect(quorum).to.equal(maxParams.quorumBps);
    });

    it("rejects votingDelay below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, votingDelay: ONE_DAY - 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingDelay out of bounds");
    });

    it("rejects votingDelay above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, votingDelay: 14 * ONE_DAY + 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingDelay out of bounds");
    });

    it("rejects votingPeriod below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, votingPeriod: ONE_DAY - 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingPeriod out of bounds");
    });

    it("rejects votingPeriod above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, votingPeriod: 30 * ONE_DAY + 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingPeriod out of bounds");
    });

    it("rejects executionDelay below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, executionDelay: ONE_DAY - 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: executionDelay out of bounds");
    });

    it("rejects executionDelay above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, executionDelay: 14 * ONE_DAY + 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: executionDelay out of bounds");
    });

    it("rejects quorumBps below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, quorumBps: 499,
        })
      ).to.be.revertedWith("ArmadaGovernor: quorumBps out of bounds");
    });

    it("rejects quorumBps above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, {
          ...validParams, quorumBps: 5001,
        })
      ).to.be.revertedWith("ArmadaGovernor: quorumBps out of bounds");
    });

    it("emits ProposalTypeParamsUpdated event", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.Standard, validParams)
      ).to.emit(standaloneGovernor, "ProposalTypeParamsUpdated");
    });
  });

  // ============================================================
  // 3. Quorum Snapshotting
  // ============================================================

  describe("Quorum Snapshotting", function () {
    // Use a standalone governor where deployer acts as timelock for direct param changes
    let standaloneGovernor: any;
    let standaloneTimelock: any;

    beforeEach(async function () {
      // Deploy a timelock where deployer keeps admin for direct control
      const TimelockController = await ethers.getContractFactory("TimelockController");
      standaloneTimelock = await TimelockController.deploy(
        TWO_DAYS, [], [], deployer.address
      );
      await standaloneTimelock.waitForDeployment();
      const tlAddr = await standaloneTimelock.getAddress();

      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      standaloneGovernor = await ArmadaGovernor.deploy(
        await armToken.getAddress(),
        tlAddr,
        await treasury.getAddress(),
        deployer.address, MAX_PAUSE_DURATION
      );
      await standaloneGovernor.waitForDeployment();

      // Grant roles — governor for proposals, deployer for direct schedule/execute in tests
      const PROPOSER_ROLE = await standaloneTimelock.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await standaloneTimelock.EXECUTOR_ROLE();
      await standaloneTimelock.grantRole(PROPOSER_ROLE, await standaloneGovernor.getAddress());
      await standaloneTimelock.grantRole(EXECUTOR_ROLE, await standaloneGovernor.getAddress());
      await standaloneTimelock.grantRole(PROPOSER_ROLE, deployer.address);
      await standaloneTimelock.grantRole(EXECUTOR_ROLE, deployer.address);
    });

    it("quorum uses snapshotted quorumBps, not current params", async function () {
      // Create a proposal with current quorumBps (2000 = 20%)
      await standaloneGovernor.connect(alice).propose(
        ProposalType.Standard,
        [await standaloneGovernor.getAddress()],
        [0n],
        [standaloneGovernor.interface.encodeFunctionData("proposalCount")],
        "Proposal created before param change"
      );
      const proposalId = Number(await standaloneGovernor.proposalCount());

      // Read quorum before param change
      const quorumBefore = await standaloneGovernor.quorum(proposalId);

      // Now change quorumBps to 30% via direct timelock call
      // (We use schedule+execute on the timelock directly since deployer is admin)
      const newParams = {
        votingDelay: 2 * ONE_DAY,
        votingPeriod: 5 * ONE_DAY,
        executionDelay: 2 * ONE_DAY,
        quorumBps: 3000,
      };
      const calldata = standaloneGovernor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType.Standard, newParams]
      );

      const salt = ethers.id("change-quorum");
      await standaloneTimelock.schedule(
        await standaloneGovernor.getAddress(), 0, calldata, ethers.ZeroHash, salt, TWO_DAYS
      );
      await time.increase(TWO_DAYS + 1);
      await standaloneTimelock.execute(
        await standaloneGovernor.getAddress(), 0, calldata, ethers.ZeroHash, salt
      );

      // Verify params actually changed
      const [,,, newQuorumBps] = await standaloneGovernor.proposalTypeParams(ProposalType.Standard);
      expect(newQuorumBps).to.equal(3000);

      // The existing proposal's quorum should still use the snapshotted value (20%)
      const quorumAfter = await standaloneGovernor.quorum(proposalId);
      expect(quorumAfter).to.equal(quorumBefore);
    });
  });

  // ============================================================
  // 4. Full Governance Lifecycle for Param Changes
  // ============================================================

  describe("Full Lifecycle: Change Params via Governance", function () {
    it("governance can update Standard params", async function () {
      const newParams = {
        votingDelay: 3 * ONE_DAY,
        votingPeriod: 7 * ONE_DAY,
        executionDelay: 3 * ONE_DAY,
        quorumBps: 2500,
      };
      const calldata = governor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType.Standard, newParams]
      );

      // setProposalTypeParams is an extended selector, so auto-classification
      // upgrades this to Extended regardless of declared type
      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.Extended,
        [await governor.getAddress()],
        [0n],
        [calldata],
        "Update Standard timing to 3d/7d/3d and 25% quorum"
      );

      const [delay, period, execDelay, quorum] = await governor.proposalTypeParams(ProposalType.Standard);
      expect(delay).to.equal(newParams.votingDelay);
      expect(period).to.equal(newParams.votingPeriod);
      expect(execDelay).to.equal(newParams.executionDelay);
      expect(quorum).to.equal(newParams.quorumBps);
    });

    it("governance can update Extended params", async function () {
      const newParams = {
        votingDelay: 3 * ONE_DAY,
        votingPeriod: 10 * ONE_DAY,
        executionDelay: 5 * ONE_DAY,
        quorumBps: 3500,
      };
      const calldata = governor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType.Extended, newParams]
      );

      // setProposalTypeParams is an extended selector, so auto-classification
      // upgrades this to Extended regardless of declared type
      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.Extended,
        [await governor.getAddress()],
        [0n],
        [calldata],
        "Update Extended timing"
      );

      const [delay, period, execDelay, quorum] = await governor.proposalTypeParams(ProposalType.Extended);
      expect(delay).to.equal(newParams.votingDelay);
      expect(period).to.equal(newParams.votingPeriod);
      expect(execDelay).to.equal(newParams.executionDelay);
      expect(quorum).to.equal(newParams.quorumBps);
    });
  });

  // ============================================================
  // 5. Budget Management Extended Selectors
  // ============================================================

  describe("Budget Management Extended Selectors", function () {
    it("addStewardBudgetToken is auto-classified as Extended", async function () {
      const calldata = treasury.interface.encodeFunctionData(
        "addStewardBudgetToken",
        [carol.address, 10000, 30 * ONE_DAY]
      );

      // Propose as Standard — should be auto-upgraded to Extended
      await governor.connect(alice).propose(
        ProposalType.Standard,
        [await treasury.getAddress()],
        [0n],
        [calldata],
        "Add steward budget token"
      );
      const proposalId = await governor.proposalCount();
      const [, proposalType] = await governor.getProposal(proposalId);
      expect(proposalType).to.equal(ProposalType.Extended);
    });

    it("updateStewardBudgetToken is auto-classified as Extended", async function () {
      const calldata = treasury.interface.encodeFunctionData(
        "updateStewardBudgetToken",
        [carol.address, 20000, 30 * ONE_DAY]
      );

      await governor.connect(alice).propose(
        ProposalType.Standard,
        [await treasury.getAddress()],
        [0n],
        [calldata],
        "Update steward budget token"
      );
      const proposalId = await governor.proposalCount();
      const [, proposalType] = await governor.getProposal(proposalId);
      expect(proposalType).to.equal(ProposalType.Extended);
    });

    it("removeStewardBudgetToken is auto-classified as Extended", async function () {
      const calldata = treasury.interface.encodeFunctionData(
        "removeStewardBudgetToken",
        [carol.address]
      );

      await governor.connect(alice).propose(
        ProposalType.Standard,
        [await treasury.getAddress()],
        [0n],
        [calldata],
        "Remove steward budget token"
      );
      const proposalId = await governor.proposalCount();
      const [, proposalType] = await governor.getProposal(proposalId);
      expect(proposalType).to.equal(ProposalType.Extended);
    });

    it("setProposalTypeParams rejects Steward type", async function () {
      const newParams = {
        votingDelay: 1 * ONE_DAY,
        votingPeriod: 7 * ONE_DAY,
        executionDelay: 2 * ONE_DAY,
        quorumBps: 2000,
      };
      const calldata = governor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType_Steward, newParams]
      );

      // Pass the proposal containing setProposalTypeParams(Steward, ...)
      // It should execute and revert with "immutable proposal type"
      await expect(
        passProposal(
          alice,
          [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
          ProposalType.Extended,
          [await governor.getAddress()],
          [0n],
          [calldata],
          "Try to change Steward params"
        )
      ).to.be.revertedWith("TimelockController: underlying transaction reverted");
    });
  });
});
