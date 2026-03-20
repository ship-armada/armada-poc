/**
 * Emergency Pause Tests
 *
 * Tests the EmergencyPausable mechanism across all governance contracts:
 * - Guardian can pause, auto-expiry works
 * - Governance (timelock) can unpause and rotate guardian
 * - Paused functions revert, unpaused functions work
 * - Non-guardian/non-timelock cannot pause/unpause
 * - Lock remains available during pause (VotingLocker)
 * - Propose remains available during pause (ArmadaGovernor)
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ProposalType = { ParameterChange: 0, Treasury: 1, StewardElection: 2 };
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
const USDC_DECIMALS = 6;
const STEWARD_ACTION_DELAY = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);

describe("Governance Emergency Pause", function () {
  let armToken: any;
  let votingLocker: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;
  let stewardContract: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let guardian: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  async function mineBlock() {
    await mine(1);
  }

  // Helper: create, pass, queue a proposal (but don't execute — for testing paused execute)
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

    const votingPeriod = proposalType === ProposalType.StewardElection ? EXTENDED_VOTING_PERIOD : STANDARD_VOTING_PERIOD;
    await time.increase(votingPeriod + 1);
    await governor.queue(proposalId);

    const executionDelay = proposalType === ProposalType.StewardElection ? EXTENDED_EXECUTION_DELAY : STANDARD_EXECUTION_DELAY;
    await time.increase(executionDelay + 1);

    return proposalId;
  }

  // Helper: full proposal lifecycle (including execute)
  async function passProposal(
    proposer: SignerWithAddress,
    voters: { signer: SignerWithAddress; support: number }[],
    proposalType: number,
    targets: string[],
    values: bigint[],
    calldatas: string[],
    description: string
  ): Promise<number> {
    const proposalId = await passAndQueueProposal(
      proposer, voters, proposalType, targets, values, calldatas, description
    );
    await governor.execute(proposalId);
    return proposalId;
  }

  beforeEach(async function () {
    [deployer, guardian, alice, bob, carol, dave] = await ethers.getSigners();

    // 1. Deploy TimelockController (needed by ArmadaToken)
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    // 2. Deploy ARM token (needs timelockAddr for governance-gated whitelist)
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    // 3. Deploy VotingLocker (used for pause tests in this file)
    const VotingLocker = await ethers.getContractFactory("VotingLocker");
    votingLocker = await VotingLocker.deploy(
      await armToken.getAddress(),
      guardian.address, MAX_PAUSE_DURATION, timelockAddr
    );
    await votingLocker.waitForDeployment();

    // 4. Deploy ArmadaTreasuryGov
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(
      timelockAddr, guardian.address, MAX_PAUSE_DURATION
    );
    await treasury.waitForDeployment();

    // 5. Deploy ArmadaGovernor (uses ArmadaToken ERC20Votes for voting power)
    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await armToken.getAddress(),
      timelockAddr,
      await treasury.getAddress(),
      guardian.address, MAX_PAUSE_DURATION
    );
    await governor.waitForDeployment();

    // 6. Deploy TreasurySteward
    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    stewardContract = await TreasurySteward.deploy(
      timelockAddr,
      await treasury.getAddress(),
      await governor.getAddress(),
      STEWARD_ACTION_DELAY,
      guardian.address, MAX_PAUSE_DURATION
    );
    await stewardContract.waitForDeployment();

    // 7. Configure timelock roles
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelockController.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelockController.TIMELOCK_ADMIN_ROLE();

    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());
    await timelockController.renounceRole(ADMIN_ROLE, deployer.address);

    // 8. Deploy mock USDC
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // 9. Configure ARM token
    await armToken.setNoDelegation(await treasury.getAddress());
    await armToken.initWhitelist([deployer.address, await treasury.getAddress(), alice.address, bob.address]);

    // 10. Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // 11. Mint USDC to treasury
    await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));

    // 12. Alice and Bob delegate to themselves (ERC20Votes requires delegation to activate voting power)
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

    await mineBlock();
  });

  // ============================================================
  // 1. EmergencyPausable Base Behavior
  // ============================================================

  describe("EmergencyPausable Base Behavior", function () {
    it("guardian can pause a contract", async function () {
      expect(await votingLocker.paused()).to.be.false;
      await votingLocker.connect(guardian).emergencyPause();
      expect(await votingLocker.paused()).to.be.true;
    });

    it("non-guardian cannot pause", async function () {
      await expect(
        votingLocker.connect(alice).emergencyPause()
      ).to.be.revertedWith("EmergencyPausable: not guardian");
    });

    it("cannot pause when already paused", async function () {
      await votingLocker.connect(guardian).emergencyPause();
      await expect(
        votingLocker.connect(guardian).emergencyPause()
      ).to.be.revertedWith("EmergencyPausable: already paused");
    });

    it("pause auto-expires after maxPauseDuration", async function () {
      await votingLocker.connect(guardian).emergencyPause();
      expect(await votingLocker.paused()).to.be.true;

      // Advance past max pause duration
      await time.increase(MAX_PAUSE_DURATION + 1);

      // Should auto-expire
      expect(await votingLocker.paused()).to.be.false;
    });

    it("pauseExpiry is set correctly", async function () {
      const tx = await votingLocker.connect(guardian).emergencyPause();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const expiry = await votingLocker.pauseExpiry();
      expect(expiry).to.equal(BigInt(block!.timestamp) + BigInt(MAX_PAUSE_DURATION));
    });

    it("emits EmergencyPaused event", async function () {
      await expect(votingLocker.connect(guardian).emergencyPause())
        .to.emit(votingLocker, "EmergencyPaused")
        .withArgs(guardian.address, (value: bigint) => value > 0n);
    });

    it("guardian can re-pause after auto-expiry", async function () {
      await votingLocker.connect(guardian).emergencyPause();
      await time.increase(MAX_PAUSE_DURATION + 1);
      expect(await votingLocker.paused()).to.be.false;

      // Should be able to pause again
      await votingLocker.connect(guardian).emergencyPause();
      expect(await votingLocker.paused()).to.be.true;
    });
  });

  // ============================================================
  // 2. Governance Unpause
  // ============================================================

  describe("Governance Unpause", function () {
    // For these tests, we use a standalone treasury where deployer is the owner/timelock
    // so we can call emergencyUnpause directly without full governance cycle.
    let standaloneTreasury: any;

    beforeEach(async function () {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      standaloneTreasury = await ArmadaTreasuryGov.deploy(
        deployer.address, // deployer acts as timelock/owner
        guardian.address,
        MAX_PAUSE_DURATION
      );
      await standaloneTreasury.waitForDeployment();
    });

    it("timelock can unpause", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();
      expect(await standaloneTreasury.paused()).to.be.true;

      await standaloneTreasury.connect(deployer).emergencyUnpause();
      expect(await standaloneTreasury.paused()).to.be.false;
    });

    it("non-timelock cannot unpause", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();
      await expect(
        standaloneTreasury.connect(alice).emergencyUnpause()
      ).to.be.revertedWith("EmergencyPausable: not timelock");
    });

    it("cannot unpause when not paused", async function () {
      await expect(
        standaloneTreasury.connect(deployer).emergencyUnpause()
      ).to.be.revertedWith("EmergencyPausable: not paused");
    });

    it("emits EmergencyUnpaused event", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();
      await expect(standaloneTreasury.connect(deployer).emergencyUnpause())
        .to.emit(standaloneTreasury, "EmergencyUnpaused")
        .withArgs(deployer.address);
    });

    it("unpause resets pauseExpiry to 0", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();
      expect(await standaloneTreasury.pauseExpiry()).to.be.gt(0n);

      await standaloneTreasury.connect(deployer).emergencyUnpause();
      expect(await standaloneTreasury.pauseExpiry()).to.equal(0n);
    });
  });

  // ============================================================
  // 3. Guardian Rotation
  // ============================================================

  describe("Guardian Rotation", function () {
    let standaloneTreasury: any;

    beforeEach(async function () {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      standaloneTreasury = await ArmadaTreasuryGov.deploy(
        deployer.address, guardian.address, MAX_PAUSE_DURATION
      );
      await standaloneTreasury.waitForDeployment();
    });

    it("timelock can rotate guardian", async function () {
      await standaloneTreasury.connect(deployer).setGuardian(alice.address);
      expect(await standaloneTreasury.guardian()).to.equal(alice.address);
    });

    it("non-timelock cannot rotate guardian", async function () {
      await expect(
        standaloneTreasury.connect(alice).setGuardian(alice.address)
      ).to.be.revertedWith("EmergencyPausable: not timelock");
    });

    it("cannot set zero-address guardian", async function () {
      await expect(
        standaloneTreasury.connect(deployer).setGuardian(ethers.ZeroAddress)
      ).to.be.revertedWith("EmergencyPausable: zero guardian");
    });

    it("old guardian cannot pause after rotation", async function () {
      await standaloneTreasury.connect(deployer).setGuardian(alice.address);
      await expect(
        standaloneTreasury.connect(guardian).emergencyPause()
      ).to.be.revertedWith("EmergencyPausable: not guardian");
    });

    it("new guardian can pause after rotation", async function () {
      await standaloneTreasury.connect(deployer).setGuardian(alice.address);
      await standaloneTreasury.connect(alice).emergencyPause();
      expect(await standaloneTreasury.paused()).to.be.true;
    });

    it("emits GuardianUpdated event", async function () {
      await expect(standaloneTreasury.connect(deployer).setGuardian(alice.address))
        .to.emit(standaloneTreasury, "GuardianUpdated")
        .withArgs(guardian.address, alice.address);
    });
  });

  // ============================================================
  // 4. Constructor Validation
  // ============================================================

  describe("Constructor Validation", function () {
    it("rejects zero guardian", async function () {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      await expect(
        ArmadaTreasuryGov.deploy(deployer.address, ethers.ZeroAddress, MAX_PAUSE_DURATION)
      ).to.be.revertedWith("EmergencyPausable: zero guardian");
    });

    it("rejects zero maxPauseDuration", async function () {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      await expect(
        ArmadaTreasuryGov.deploy(deployer.address, guardian.address, 0)
      ).to.be.revertedWith("EmergencyPausable: zero duration");
    });

    it("rejects zero timelock", async function () {
      const VotingLocker = await ethers.getContractFactory("VotingLocker");
      await expect(
        VotingLocker.deploy(await armToken.getAddress(), guardian.address, MAX_PAUSE_DURATION, ethers.ZeroAddress)
      ).to.be.revertedWith("EmergencyPausable: zero timelock");
    });
  });

  // ============================================================
  // 5. VotingLocker Pause Behavior
  // ============================================================

  describe("VotingLocker Pause", function () {
    // Use a standalone VotingLocker where deployer is the pauseTimelock for direct control
    let standaloneLocker: any;

    beforeEach(async function () {
      const VotingLocker = await ethers.getContractFactory("VotingLocker");
      standaloneLocker = await VotingLocker.deploy(
        await armToken.getAddress(),
        guardian.address, MAX_PAUSE_DURATION, deployer.address
      );
      await standaloneLocker.waitForDeployment();

      // Deploy a fresh ARM token for this standalone test (main supply is fully allocated)
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      const standaloneArm = await ArmadaToken.deploy(deployer.address, deployer.address);
      await standaloneArm.waitForDeployment();

      const VotingLockerFactory = await ethers.getContractFactory("VotingLocker");
      standaloneLocker = await VotingLockerFactory.deploy(
        await standaloneArm.getAddress(),
        guardian.address, MAX_PAUSE_DURATION, deployer.address
      );
      await standaloneLocker.waitForDeployment();

      // Whitelist deployer, carol, and locker for transfer restrictions on the standalone token
      await standaloneArm.initWhitelist([deployer.address, carol.address, await standaloneLocker.getAddress()]);

      const carolAmount = ethers.parseUnits("1000", ARM_DECIMALS);
      await standaloneArm.transfer(carol.address, carolAmount);
      await standaloneArm.connect(carol).approve(await standaloneLocker.getAddress(), carolAmount);
      await standaloneLocker.connect(carol).lock(ethers.parseUnits("500", ARM_DECIMALS));
    });

    it("unlock reverts when paused", async function () {
      await standaloneLocker.connect(guardian).emergencyPause();

      await expect(
        standaloneLocker.connect(carol).unlock(ethers.parseUnits("100", ARM_DECIMALS))
      ).to.be.revertedWith("Pausable: paused");
    });

    it("lock remains available when paused", async function () {
      await standaloneLocker.connect(guardian).emergencyPause();

      // Lock should still work
      await standaloneLocker.connect(carol).lock(ethers.parseUnits("100", ARM_DECIMALS));
      const balance = await standaloneLocker.getLockedBalance(carol.address);
      expect(balance).to.equal(ethers.parseUnits("600", ARM_DECIMALS));
    });

    it("unlock works again after unpause", async function () {
      await standaloneLocker.connect(guardian).emergencyPause();
      await standaloneLocker.connect(deployer).emergencyUnpause();

      await standaloneLocker.connect(carol).unlock(ethers.parseUnits("100", ARM_DECIMALS));
      const balance = await standaloneLocker.getLockedBalance(carol.address);
      expect(balance).to.equal(ethers.parseUnits("400", ARM_DECIMALS));
    });

    it("unlock works again after auto-expiry", async function () {
      await standaloneLocker.connect(guardian).emergencyPause();
      await time.increase(MAX_PAUSE_DURATION + 1);

      await standaloneLocker.connect(carol).unlock(ethers.parseUnits("100", ARM_DECIMALS));
      const balance = await standaloneLocker.getLockedBalance(carol.address);
      expect(balance).to.equal(ethers.parseUnits("400", ARM_DECIMALS));
    });
  });

  // ============================================================
  // 6. ArmadaTreasuryGov Pause Behavior
  // ============================================================

  describe("ArmadaTreasuryGov Pause", function () {
    let standaloneTreasury: any;

    beforeEach(async function () {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      standaloneTreasury = await ArmadaTreasuryGov.deploy(
        deployer.address, guardian.address, MAX_PAUSE_DURATION
      );
      await standaloneTreasury.waitForDeployment();

      // Fund with USDC
      await usdc.mint(await standaloneTreasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));

      // Set carol as steward
      await standaloneTreasury.setSteward(carol.address);

      // Create a claim for alice
      await standaloneTreasury.createClaim(
        await usdc.getAddress(), alice.address, ethers.parseUnits("10000", USDC_DECIMALS)
      );
    });

    it("distribute reverts when paused", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();

      await expect(
        standaloneTreasury.distribute(await usdc.getAddress(), bob.address, ethers.parseUnits("100", USDC_DECIMALS))
      ).to.be.revertedWith("Pausable: paused");
    });

    it("exerciseClaim reverts when paused", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();

      await expect(
        standaloneTreasury.connect(alice).exerciseClaim(1, ethers.parseUnits("100", USDC_DECIMALS))
      ).to.be.revertedWith("Pausable: paused");
    });

    it("stewardSpend reverts when paused", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();

      await expect(
        standaloneTreasury.connect(carol).stewardSpend(
          await usdc.getAddress(), dave.address, ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.be.revertedWith("Pausable: paused");
    });

    it("createClaim still works when paused (owner-only, no fund outflow)", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();

      // Creating a claim is safe — it doesn't move funds out
      await standaloneTreasury.createClaim(
        await usdc.getAddress(), bob.address, ethers.parseUnits("5000", USDC_DECIMALS)
      );
      const remaining = await standaloneTreasury.getClaimRemaining(2);
      expect(remaining).to.equal(ethers.parseUnits("5000", USDC_DECIMALS));
    });

    it("all paused functions resume after unpause", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();
      await standaloneTreasury.connect(deployer).emergencyUnpause();

      // distribute should work
      await standaloneTreasury.distribute(
        await usdc.getAddress(), bob.address, ethers.parseUnits("100", USDC_DECIMALS)
      );

      // exerciseClaim should work
      await standaloneTreasury.connect(alice).exerciseClaim(1, ethers.parseUnits("100", USDC_DECIMALS));

      // stewardSpend should work
      await standaloneTreasury.connect(carol).stewardSpend(
        await usdc.getAddress(), dave.address, ethers.parseUnits("100", USDC_DECIMALS)
      );
    });
  });

  // ============================================================
  // 7. TreasurySteward Pause Behavior
  // ============================================================

  describe("TreasurySteward Pause", function () {
    let standaloneSteward: any;
    let standaloneTreasury: any;

    beforeEach(async function () {
      // Deploy standalone treasury + steward with deployer as timelock
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      standaloneTreasury = await ArmadaTreasuryGov.deploy(
        deployer.address, guardian.address, MAX_PAUSE_DURATION
      );
      await standaloneTreasury.waitForDeployment();

      const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
      standaloneSteward = await TreasurySteward.deploy(
        deployer.address,
        await standaloneTreasury.getAddress(),
        await governor.getAddress(),
        STEWARD_ACTION_DELAY,
        guardian.address, MAX_PAUSE_DURATION
      );
      await standaloneSteward.waitForDeployment();

      // Elect carol as steward
      await standaloneSteward.electSteward(carol.address);

      // Fund treasury and set steward contract as treasury's steward
      await usdc.mint(await standaloneTreasury.getAddress(), ethers.parseUnits("1000000", USDC_DECIMALS));
      await standaloneTreasury.setSteward(await standaloneSteward.getAddress());
    });

    it("executeAction reverts when paused", async function () {
      // Propose a valid action
      const spendData = standaloneTreasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), dave.address, ethers.parseUnits("100", USDC_DECIMALS)
      ]);
      await standaloneSteward.connect(carol).proposeAction(
        await standaloneTreasury.getAddress(), spendData, 0
      );

      // Wait for delay
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Pause the steward
      await standaloneSteward.connect(guardian).emergencyPause();

      // Execute should fail
      await expect(
        standaloneSteward.connect(carol).executeAction(1)
      ).to.be.revertedWith("Pausable: paused");
    });

    it("proposeAction still works when paused (proposing is harmless)", async function () {
      await standaloneSteward.connect(guardian).emergencyPause();

      const spendData = standaloneTreasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), dave.address, ethers.parseUnits("100", USDC_DECIMALS)
      ]);
      await standaloneSteward.connect(carol).proposeAction(
        await standaloneTreasury.getAddress(), spendData, 0
      );

      expect(await standaloneSteward.actionCount()).to.equal(1);
    });

    it("executeAction works after unpause", async function () {
      const spendData = standaloneTreasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), dave.address, ethers.parseUnits("100", USDC_DECIMALS)
      ]);
      await standaloneSteward.connect(carol).proposeAction(
        await standaloneTreasury.getAddress(), spendData, 0
      );
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Pause then unpause
      await standaloneSteward.connect(guardian).emergencyPause();
      await standaloneSteward.connect(deployer).emergencyUnpause();

      // Should execute successfully
      await standaloneSteward.connect(carol).executeAction(1);
      const [,,, executed] = await standaloneSteward.getAction(1);
      expect(executed).to.be.true;
    });
  });

  // ============================================================
  // 8. ArmadaGovernor Pause Behavior
  // ============================================================

  describe("ArmadaGovernor Pause", function () {
    // For governor, we need to test that execute() reverts when paused.
    // We need a standalone governor where we can call emergencyPause via the guardian
    // and emergencyUnpause via the timelock.
    // The main governor's pauseTimelock is the real timelockController.

    // Use a standalone governor with deployer as pauseTimelock for direct control
    let standaloneGovernor: any;
    let standaloneTimelock: any;

    beforeEach(async function () {
      // Deploy a separate timelock and governor where deployer keeps admin
      const TimelockController = await ethers.getContractFactory("TimelockController");
      standaloneTimelock = await TimelockController.deploy(
        TWO_DAYS, [], [], deployer.address
      );
      await standaloneTimelock.waitForDeployment();
      const tlAddr = await standaloneTimelock.getAddress();

      // Deploy standalone governor with deployer as pauseTimelock via the guardian constructor param
      // Actually, the pauseTimelock IS the timelock param. So we need the governor to use
      // a timelock we control. Let's use the standaloneTimelock but keep deployer as admin.
      const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
      standaloneGovernor = await ArmadaGovernor.deploy(
        await armToken.getAddress(),
        tlAddr,
        await treasury.getAddress(),
        guardian.address, MAX_PAUSE_DURATION
      );
      await standaloneGovernor.waitForDeployment();

      // Grant governor the proposer/executor roles on the timelock
      const PROPOSER_ROLE = await standaloneTimelock.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await standaloneTimelock.EXECUTOR_ROLE();
      await standaloneTimelock.grantRole(PROPOSER_ROLE, await standaloneGovernor.getAddress());
      await standaloneTimelock.grantRole(EXECUTOR_ROLE, await standaloneGovernor.getAddress());
    });

    it("propose still works when paused", async function () {
      await standaloneGovernor.connect(guardian).emergencyPause();

      await standaloneGovernor.connect(alice).propose(
        ProposalType.ParameterChange,
        [await standaloneGovernor.getAddress()],
        [0n],
        [standaloneGovernor.interface.encodeFunctionData("proposalCount")],
        "Test proposal while paused"
      );
      expect(await standaloneGovernor.proposalCount()).to.equal(1);
    });

    it("castVote still works when paused", async function () {
      // Create a proposal first
      await standaloneGovernor.connect(alice).propose(
        ProposalType.ParameterChange,
        [await standaloneGovernor.getAddress()],
        [0n],
        [standaloneGovernor.interface.encodeFunctionData("proposalCount")],
        "Test vote while paused"
      );

      await time.increase(TWO_DAYS + 1);

      // Pause, then vote
      await standaloneGovernor.connect(guardian).emergencyPause();

      await standaloneGovernor.connect(alice).castVote(1, Vote.For);
      expect(await standaloneGovernor.hasVoted(1, alice.address)).to.be.true;
    });

    it("execute reverts when paused", async function () {
      // Create and advance a proposal to Queued state
      await standaloneGovernor.connect(alice).propose(
        ProposalType.ParameterChange,
        [await standaloneGovernor.getAddress()],
        [0n],
        [standaloneGovernor.interface.encodeFunctionData("proposalCount")],
        "Test execute while paused"
      );

      await time.increase(TWO_DAYS + 1);
      await standaloneGovernor.connect(alice).castVote(1, Vote.For);
      await standaloneGovernor.connect(bob).castVote(1, Vote.For);
      await time.increase(STANDARD_VOTING_PERIOD + 1);
      await standaloneGovernor.queue(1);
      await time.increase(TWO_DAYS + 1);

      // Pause the governor
      await standaloneGovernor.connect(guardian).emergencyPause();

      await expect(
        standaloneGovernor.execute(1)
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  // ============================================================
  // 9. Adversarial: Guardian Cannot Permanently Freeze
  // ============================================================

  describe("Guardian Cannot Permanently Freeze", function () {
    let standaloneTreasury: any;

    beforeEach(async function () {
      const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
      standaloneTreasury = await ArmadaTreasuryGov.deploy(
        deployer.address, guardian.address, MAX_PAUSE_DURATION
      );
      await standaloneTreasury.waitForDeployment();

      await usdc.mint(await standaloneTreasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));
    });

    it("pause auto-expires even if guardian does nothing", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();
      expect(await standaloneTreasury.paused()).to.be.true;

      // Advance past max pause
      await time.increase(MAX_PAUSE_DURATION + 1);
      expect(await standaloneTreasury.paused()).to.be.false;

      // distribute should work again
      await standaloneTreasury.distribute(
        await usdc.getAddress(), bob.address, ethers.parseUnits("100", USDC_DECIMALS)
      );
    });

    it("guardian cannot extend pause beyond maxPauseDuration", async function () {
      await standaloneTreasury.connect(guardian).emergencyPause();

      // Advance to 1 second before expiry
      await time.increase(MAX_PAUSE_DURATION - 2);
      expect(await standaloneTreasury.paused()).to.be.true;

      // Guardian cannot re-pause while still paused
      await expect(
        standaloneTreasury.connect(guardian).emergencyPause()
      ).to.be.revertedWith("EmergencyPausable: already paused");
    });

    it("guardian can re-pause after expiry, but each pause is time-limited", async function () {
      // First pause
      await standaloneTreasury.connect(guardian).emergencyPause();
      await time.increase(MAX_PAUSE_DURATION + 1);
      expect(await standaloneTreasury.paused()).to.be.false;

      // Second pause
      await standaloneTreasury.connect(guardian).emergencyPause();
      expect(await standaloneTreasury.paused()).to.be.true;
      await time.increase(MAX_PAUSE_DURATION + 1);
      expect(await standaloneTreasury.paused()).to.be.false;
    });
  });

  // ============================================================
  // 10. maxPauseDuration and guardian are correctly set
  // ============================================================

  describe("Immutable Configuration", function () {
    it("maxPauseDuration is set correctly on all contracts", async function () {
      expect(await votingLocker.maxPauseDuration()).to.equal(MAX_PAUSE_DURATION);
      expect(await treasury.maxPauseDuration()).to.equal(MAX_PAUSE_DURATION);
      expect(await governor.maxPauseDuration()).to.equal(MAX_PAUSE_DURATION);
      expect(await stewardContract.maxPauseDuration()).to.equal(MAX_PAUSE_DURATION);
    });

    it("guardian is set correctly on all contracts", async function () {
      expect(await votingLocker.guardian()).to.equal(guardian.address);
      expect(await treasury.guardian()).to.equal(guardian.address);
      expect(await governor.guardian()).to.equal(guardian.address);
      expect(await stewardContract.guardian()).to.equal(guardian.address);
    });

    it("pauseTimelock is set correctly on all contracts", async function () {
      const timelockAddr = await timelockController.getAddress();
      expect(await votingLocker.pauseTimelock()).to.equal(timelockAddr);
      expect(await treasury.pauseTimelock()).to.equal(timelockAddr);
      expect(await governor.pauseTimelock()).to.equal(timelockAddr);
      expect(await stewardContract.pauseTimelock()).to.equal(timelockAddr);
    });
  });
});
