/**
 * Governance Parameter Update Tests
 *
 * Tests the ability to update proposal type parameters via governance:
 * - Timelock-only access control
 * - Bounded parameter validation (min/max for all fields)
 * - Full governance lifecycle to change params via ParameterChange proposal
 * - Quorum snapshotting: in-flight proposals unaffected by param changes
 * - TreasurySteward.minActionDelay() reflects updated governor timing
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
const FOURTEEN_DAYS = 14 * ONE_DAY;
const MAX_PAUSE_DURATION = FOURTEEN_DAYS;

const ARM_DECIMALS = 18;
const TOTAL_SUPPLY = ethers.parseUnits("100000000", ARM_DECIMALS); // 100M
const TREASURY_AMOUNT = ethers.parseUnits("65000000", ARM_DECIMALS); // 65M
const ALICE_AMOUNT = ethers.parseUnits("20000000", ARM_DECIMALS); // 20M
const BOB_AMOUNT = ethers.parseUnits("15000000", ARM_DECIMALS); // 15M
const STEWARD_ACTION_DELAY = Math.ceil((TWO_DAYS + FIVE_DAYS + TWO_DAYS) * 12000 / 10000);

describe("Governance Parameter Updates", function () {
  let armToken: any;
  let votingLocker: any;
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

    const votingPeriod = proposalType === ProposalType.StewardElection ? SEVEN_DAYS : FIVE_DAYS;
    await time.increase(votingPeriod + 1);
    await governor.queue(proposalId);

    const executionDelay = proposalType === ProposalType.StewardElection ? FOUR_DAYS : TWO_DAYS;
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

    const votingPeriod = proposalType === ProposalType.StewardElection ? SEVEN_DAYS : FIVE_DAYS;
    await time.increase(votingPeriod + 1);
    await governor.queue(proposalId);

    const executionDelay = proposalType === ProposalType.StewardElection ? FOUR_DAYS : TWO_DAYS;
    await time.increase(executionDelay + 1);

    return proposalId;
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
    treasury = await ArmadaTreasuryGov.deploy(
      timelockAddr, deployer.address, MAX_PAUSE_DURATION
    );
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

    // Set governor on VotingLocker (needed for vote cooldown)
    await votingLocker.setGovernor(await governor.getAddress());

    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    stewardContract = await TreasurySteward.deploy(
      timelockAddr,
      await treasury.getAddress(),
      await governor.getAddress(),
      STEWARD_ACTION_DELAY,
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

    // Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // Lock tokens for voting
    await armToken.connect(alice).approve(await votingLocker.getAddress(), ALICE_AMOUNT);
    await votingLocker.connect(alice).lock(ALICE_AMOUNT);
    await armToken.connect(bob).approve(await votingLocker.getAddress(), BOB_AMOUNT);
    await votingLocker.connect(bob).lock(BOB_AMOUNT);

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
        governor.connect(alice).setProposalTypeParams(ProposalType.ParameterChange, newParams)
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
        governor.connect(deployer).setProposalTypeParams(ProposalType.ParameterChange, newParams)
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
        await votingLocker.getAddress(),
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
      await standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, validParams);
      const [delay, period, execDelay, quorum] = await standaloneGovernor.proposalTypeParams(ProposalType.ParameterChange);
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
      await standaloneGovernor.setProposalTypeParams(ProposalType.Treasury, minParams);
      const [delay, period, execDelay, quorum] = await standaloneGovernor.proposalTypeParams(ProposalType.Treasury);
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
      await standaloneGovernor.setProposalTypeParams(ProposalType.Treasury, maxParams);
      const [delay, period, execDelay, quorum] = await standaloneGovernor.proposalTypeParams(ProposalType.Treasury);
      expect(quorum).to.equal(maxParams.quorumBps);
    });

    it("rejects votingDelay below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, votingDelay: ONE_DAY - 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingDelay out of bounds");
    });

    it("rejects votingDelay above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, votingDelay: 14 * ONE_DAY + 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingDelay out of bounds");
    });

    it("rejects votingPeriod below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, votingPeriod: ONE_DAY - 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingPeriod out of bounds");
    });

    it("rejects votingPeriod above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, votingPeriod: 30 * ONE_DAY + 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: votingPeriod out of bounds");
    });

    it("rejects executionDelay below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, executionDelay: ONE_DAY - 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: executionDelay out of bounds");
    });

    it("rejects executionDelay above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, executionDelay: 14 * ONE_DAY + 1,
        })
      ).to.be.revertedWith("ArmadaGovernor: executionDelay out of bounds");
    });

    it("rejects quorumBps below minimum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, quorumBps: 499,
        })
      ).to.be.revertedWith("ArmadaGovernor: quorumBps out of bounds");
    });

    it("rejects quorumBps above maximum", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, {
          ...validParams, quorumBps: 5001,
        })
      ).to.be.revertedWith("ArmadaGovernor: quorumBps out of bounds");
    });

    it("emits ProposalTypeParamsUpdated event", async function () {
      await expect(
        standaloneGovernor.setProposalTypeParams(ProposalType.ParameterChange, validParams)
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
        await votingLocker.getAddress(),
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
        ProposalType.ParameterChange,
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
        [ProposalType.ParameterChange, newParams]
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
      const [,,, newQuorumBps] = await standaloneGovernor.proposalTypeParams(ProposalType.ParameterChange);
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
    it("governance can update ParameterChange params", async function () {
      const newParams = {
        votingDelay: 3 * ONE_DAY,
        votingPeriod: 7 * ONE_DAY,
        executionDelay: 3 * ONE_DAY,
        quorumBps: 2500,
      };
      const calldata = governor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType.ParameterChange, newParams]
      );

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.ParameterChange,
        [await governor.getAddress()],
        [0n],
        [calldata],
        "Update ParameterChange timing to 3d/7d/3d and 25% quorum"
      );

      const [delay, period, execDelay, quorum] = await governor.proposalTypeParams(ProposalType.ParameterChange);
      expect(delay).to.equal(newParams.votingDelay);
      expect(period).to.equal(newParams.votingPeriod);
      expect(execDelay).to.equal(newParams.executionDelay);
      expect(quorum).to.equal(newParams.quorumBps);
    });

    it("governance can update StewardElection params", async function () {
      const newParams = {
        votingDelay: 3 * ONE_DAY,
        votingPeriod: 10 * ONE_DAY,
        executionDelay: 5 * ONE_DAY,
        quorumBps: 3500,
      };
      const calldata = governor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType.StewardElection, newParams]
      );

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.ParameterChange,
        [await governor.getAddress()],
        [0n],
        [calldata],
        "Update StewardElection timing"
      );

      const [delay, period, execDelay, quorum] = await governor.proposalTypeParams(ProposalType.StewardElection);
      expect(delay).to.equal(newParams.votingDelay);
      expect(period).to.equal(newParams.votingPeriod);
      expect(execDelay).to.equal(newParams.executionDelay);
      expect(quorum).to.equal(newParams.quorumBps);
    });
  });

  // ============================================================
  // 5. Steward Min Action Delay Coupling
  // ============================================================

  describe("Steward Min Action Delay Coupling", function () {
    it("steward minActionDelay reflects updated governor timing", async function () {
      const minDelayBefore = await stewardContract.minActionDelay();

      // Shorten the ParameterChange cycle: 1d + 3d + 1d = 5d → 120% = 6d
      const newParams = {
        votingDelay: 1 * ONE_DAY,
        votingPeriod: 3 * ONE_DAY,
        executionDelay: 1 * ONE_DAY,
        quorumBps: 2000,
      };
      const calldata = governor.interface.encodeFunctionData(
        "setProposalTypeParams",
        [ProposalType.ParameterChange, newParams]
      );

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.ParameterChange,
        [await governor.getAddress()],
        [0n],
        [calldata],
        "Shorten ParameterChange cycle"
      );

      const minDelayAfter = await stewardContract.minActionDelay();

      // Before: (2d + 5d + 2d) * 1.2 = 10.8d
      // After:  (1d + 3d + 1d) * 1.2 = 6d
      expect(minDelayAfter).to.be.lt(minDelayBefore);

      const expectedMinDelay = BigInt(Math.ceil((ONE_DAY + 3 * ONE_DAY + ONE_DAY) * 12000 / 10000));
      expect(minDelayAfter).to.equal(expectedMinDelay);
    });
  });
});
