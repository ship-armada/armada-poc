/**
 * Governance Integration Tests
 *
 * Tests the full Armada governance system:
 * - Token locking and voting power
 * - Proposal lifecycle (create, vote, queue, execute)
 * - Proposal types with different quorum/timing
 * - Treasury operations (distribute, claims, steward budget)
 * - Steward election, action queue, and veto mechanism
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Proposal types (must match IArmadaGovernance.sol enum order)
const ProposalType = { ParameterChange: 0, Treasury: 1, StewardElection: 2 };
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
const FIVE_DAYS = 5 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;
const FOUR_DAYS = 4 * ONE_DAY;
const THIRTY_DAYS = 30 * ONE_DAY;

describe("Governance Integration", function () {
  // Contracts
  let armToken: any;
  let votingLocker: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;
  let stewardContract: any;
  let usdc: any;

  // Signers
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  // Constants
  const ARM_DECIMALS = 18;
  const TOTAL_SUPPLY = ethers.parseUnits("100000000", ARM_DECIMALS); // 100M
  const TREASURY_AMOUNT = ethers.parseUnits("65000000", ARM_DECIMALS); // 65M
  const ALICE_AMOUNT = ethers.parseUnits("20000000", ARM_DECIMALS); // 20M
  const BOB_AMOUNT = ethers.parseUnits("15000000", ARM_DECIMALS); // 15M
  const USDC_DECIMALS = 6;
  const STEWARD_ACTION_DELAY = ONE_DAY; // 1 day veto window for tests

  // Helper: mine a block so checkpoint reads work
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
    const receipt = await tx.wait();
    const proposalId = Number(await governor.proposalCount());

    // Fast-forward past voting delay (2 days)
    await time.increase(TWO_DAYS + 1);

    // Vote
    for (const v of voters) {
      await governor.connect(v.signer).castVote(proposalId, v.support);
    }

    // Fast-forward past voting period
    const votingPeriod = proposalType === ProposalType.StewardElection ? SEVEN_DAYS : FIVE_DAYS;
    await time.increase(votingPeriod + 1);

    // Queue
    await governor.queue(proposalId);

    // Fast-forward past execution delay
    const executionDelay = proposalType === ProposalType.StewardElection ? FOUR_DAYS : TWO_DAYS;
    await time.increase(executionDelay + 1);

    // Execute
    await governor.execute(proposalId);

    return proposalId;
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    // 1. Deploy ARM token (all supply to deployer)
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address);
    await armToken.waitForDeployment();

    // 2. Deploy VotingLocker
    const VotingLocker = await ethers.getContractFactory("VotingLocker");
    votingLocker = await VotingLocker.deploy(await armToken.getAddress());
    await votingLocker.waitForDeployment();

    // 3. Deploy TimelockController (minDelay = 2 days, deployer as temp admin)
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS,
      [], // proposers (added later)
      [], // executors (added later)
      deployer.address // admin
    );
    await timelockController.waitForDeployment();

    // 4. Deploy ArmadaTreasuryGov (owned by timelock)
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(await timelockController.getAddress());
    await treasury.waitForDeployment();

    // 5. Deploy ArmadaGovernor
    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await votingLocker.getAddress(),
      await armToken.getAddress(),
      await timelockController.getAddress(),
      await treasury.getAddress()
    );
    await governor.waitForDeployment();

    // 6. Deploy TreasurySteward
    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    stewardContract = await TreasurySteward.deploy(
      await timelockController.getAddress(),
      await treasury.getAddress(),
      STEWARD_ACTION_DELAY
    );
    await stewardContract.waitForDeployment();

    // 7. Configure timelock roles
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelockController.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelockController.TIMELOCK_ADMIN_ROLE();

    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());

    // 8. Renounce deployer admin
    await timelockController.renounceRole(ADMIN_ROLE, deployer.address);

    // 9. Deploy mock USDC for treasury tests
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // 10. Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // 11. Mint USDC to treasury for payout tests
    await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));

    // 12. Alice and Bob lock tokens for voting
    await armToken.connect(alice).approve(await votingLocker.getAddress(), ALICE_AMOUNT);
    await votingLocker.connect(alice).lock(ALICE_AMOUNT);

    await armToken.connect(bob).approve(await votingLocker.getAddress(), BOB_AMOUNT);
    await votingLocker.connect(bob).lock(BOB_AMOUNT);

    // Mine a block so checkpoints are queryable
    await mineBlock();
  });

  // ============================================================
  // 1. ArmadaToken
  // ============================================================

  describe("ArmadaToken", function () {
    it("should have correct total supply", async function () {
      expect(await armToken.totalSupply()).to.equal(TOTAL_SUPPLY);
    });

    it("should have correct distribution", async function () {
      expect(await armToken.balanceOf(await treasury.getAddress())).to.equal(TREASURY_AMOUNT);
      // Alice and Bob tokens are in the VotingLocker
      expect(await votingLocker.getLockedBalance(alice.address)).to.equal(ALICE_AMOUNT);
      expect(await votingLocker.getLockedBalance(bob.address)).to.equal(BOB_AMOUNT);
    });
  });

  // ============================================================
  // 2. VotingLocker
  // ============================================================

  describe("VotingLocker", function () {
    it("should track locked balances", async function () {
      expect(await votingLocker.getLockedBalance(alice.address)).to.equal(ALICE_AMOUNT);
      expect(await votingLocker.getLockedBalance(bob.address)).to.equal(BOB_AMOUNT);
      expect(await votingLocker.totalLocked()).to.equal(ALICE_AMOUNT + BOB_AMOUNT);
    });

    it("should unlock tokens", async function () {
      const unlockAmount = ethers.parseUnits("5000000", ARM_DECIMALS);
      await votingLocker.connect(alice).unlock(unlockAmount);

      expect(await votingLocker.getLockedBalance(alice.address)).to.equal(ALICE_AMOUNT - unlockAmount);
      expect(await armToken.balanceOf(alice.address)).to.equal(unlockAmount);
    });

    it("should reject unlock with insufficient balance", async function () {
      const tooMuch = ALICE_AMOUNT + 1n;
      await expect(
        votingLocker.connect(alice).unlock(tooMuch)
      ).to.be.revertedWith("VotingLocker: insufficient locked");
    });

    it("should checkpoint locked balances for historical queries", async function () {
      const blockBefore = await ethers.provider.getBlockNumber();
      await mineBlock();

      // Alice unlocks some, then relocks — this creates new checkpoints
      const unlockAmount = ethers.parseUnits("5000000", ARM_DECIMALS);
      await votingLocker.connect(alice).unlock(unlockAmount);
      await mineBlock();

      // Re-lock
      await armToken.connect(alice).approve(await votingLocker.getAddress(), unlockAmount);
      await votingLocker.connect(alice).lock(unlockAmount);
      await mineBlock();

      // Historical query at blockBefore should return original balance
      expect(await votingLocker.getPastLockedBalance(alice.address, blockBefore))
        .to.equal(ALICE_AMOUNT);

      // Current should be back to original
      expect(await votingLocker.getLockedBalance(alice.address))
        .to.equal(ALICE_AMOUNT);
    });

    it("should reject lock of zero amount", async function () {
      await expect(
        votingLocker.connect(alice).lock(0)
      ).to.be.revertedWith("VotingLocker: zero amount");
    });
  });

  // ============================================================
  // 3. Proposal Lifecycle — Parameter Change
  // ============================================================

  describe("Proposal Lifecycle - ParameterChange", function () {
    it("should create proposal with sufficient voting power", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("distribute", [
        await armToken.getAddress(), carol.address, ethers.parseUnits("100", ARM_DECIMALS)
      ])];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas,
        "Test parameter change"
      );

      expect(await governor.proposalCount()).to.equal(1);
      expect(await governor.state(1)).to.equal(ProposalState.Pending);
    });

    it("should reject proposal below threshold", async function () {
      // Carol has no locked tokens
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await expect(
        governor.connect(carol).propose(
          ProposalType.ParameterChange, targets, values, calldatas, "Should fail"
        )
      ).to.be.revertedWith("ArmadaGovernor: below proposal threshold");
    });

    it("should transition Pending → Active → Succeeded", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("distribute", [
        await armToken.getAddress(), carol.address, ethers.parseUnits("100", ARM_DECIMALS)
      ])];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Lifecycle test"
      );

      // Pending
      expect(await governor.state(1)).to.equal(ProposalState.Pending);

      // Fast-forward past voting delay
      await time.increase(TWO_DAYS + 1);
      expect(await governor.state(1)).to.equal(ProposalState.Active);

      // Vote
      await governor.connect(alice).castVote(1, Vote.For);
      await governor.connect(bob).castVote(1, Vote.For);

      // Fast-forward past voting period
      await time.increase(FIVE_DAYS + 1);
      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);
    });

    it("should be defeated if quorum not reached", async function () {
      // Only Alice votes (20M). Quorum = 20% of (100M - 65M) = 7M. Alice meets it.
      // But if we reduce alice's lock to below quorum threshold...
      // Actually 20M > 7M so quorum is met. Let's test with no votes at all.
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "No votes"
      );

      await time.increase(TWO_DAYS + 1);
      // Nobody votes
      await time.increase(FIVE_DAYS + 1);

      expect(await governor.state(1)).to.equal(ProposalState.Defeated);
    });

    it("should be defeated if majority against", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Majority against"
      );

      await time.increase(TWO_DAYS + 1);

      // Alice votes FOR (20M), Bob votes AGAINST (15M) — Alice wins
      // Flip: Bob votes FOR (15M), Alice AGAINST (20M) — Alice wins against
      await governor.connect(alice).castVote(1, Vote.Against);
      await governor.connect(bob).castVote(1, Vote.For);

      await time.increase(FIVE_DAYS + 1);
      expect(await governor.state(1)).to.equal(ProposalState.Defeated);
    });

    it("should queue and execute via timelock", async function () {
      const distributeAmount = ethers.parseUnits("1000", ARM_DECIMALS);
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("distribute", [
        await armToken.getAddress(), carol.address, distributeAmount
      ])];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Execute test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);
      await governor.connect(bob).castVote(1, Vote.For);
      await time.increase(FIVE_DAYS + 1);

      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);

      // Queue
      await governor.queue(1);
      expect(await governor.state(1)).to.equal(ProposalState.Queued);

      // Fast-forward past execution delay
      await time.increase(TWO_DAYS + 1);

      // Execute
      const carolBalanceBefore = await armToken.balanceOf(carol.address);
      await governor.execute(1);
      expect(await governor.state(1)).to.equal(ProposalState.Executed);

      const carolBalanceAfter = await armToken.balanceOf(carol.address);
      expect(carolBalanceAfter - carolBalanceBefore).to.equal(distributeAmount);
    });

    it("should use standard timing (2d delay, 5d voting, 2d execution)", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Timing test"
      );

      const [,, voteStart, voteEnd] = await governor.getProposal(1);
      const blockTimestamp = (await ethers.provider.getBlock("latest"))!.timestamp;

      // voteStart should be ~2 days from now
      expect(Number(voteStart) - blockTimestamp).to.be.closeTo(TWO_DAYS, 5);
      // voteEnd should be ~7 days from now (2d delay + 5d period)
      expect(Number(voteEnd) - blockTimestamp).to.be.closeTo(TWO_DAYS + FIVE_DAYS, 5);
    });
  });

  // ============================================================
  // 4. Proposal Lifecycle — Treasury
  // ============================================================

  describe("Proposal Lifecycle - Treasury", function () {
    it("should pay USDC to an address via treasury proposal", async function () {
      const payAmount = ethers.parseUnits("500", USDC_DECIMALS);
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("distribute", [
        await usdc.getAddress(), carol.address, payAmount
      ])];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.Treasury, targets, values, calldatas,
        "Pay Carol 500 USDC"
      );

      expect(await usdc.balanceOf(carol.address)).to.equal(payAmount);
    });

    it("should use 20% quorum for standard treasury proposals", async function () {
      // Eligible supply = 100M - 65M (treasury) = 35M
      // 20% quorum = 7M ARM
      // Alice has 20M locked > 7M, so her vote alone meets quorum
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.Treasury, targets, values, calldatas, "Quorum test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);
      await time.increase(FIVE_DAYS + 1);

      // Should succeed with only Alice's 20M vote (quorum = 7M)
      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);
    });

    it("should calculate quorum excluding treasury-held ARM", async function () {
      // Quorum = 20% of (totalSupply - treasury balance)
      const expectedEligible = TOTAL_SUPPLY - TREASURY_AMOUNT; // 35M
      const expectedQuorum = (expectedEligible * 2000n) / 10000n; // 7M

      // Create a dummy proposal to check quorum
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];
      await governor.connect(alice).propose(
        ProposalType.Treasury, targets, values, calldatas, "Quorum calc test"
      );

      const actualQuorum = await governor.quorum(1);
      expect(actualQuorum).to.equal(expectedQuorum);
    });
  });

  // ============================================================
  // 5. Proposal Lifecycle — Steward Election
  // ============================================================

  describe("Proposal Lifecycle - StewardElection", function () {
    it("should elect steward via proposal with extended timing", async function () {
      const targets = [
        await stewardContract.getAddress(),
        await treasury.getAddress(),
      ];
      const values = [0n, 0n];
      // setSteward sets the TreasurySteward contract (not the person) as treasury steward,
      // so that executeAction() → treasury.stewardSpend() works (msg.sender = contract).
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [dave.address]),
        treasury.interface.encodeFunctionData("setSteward", [await stewardContract.getAddress()]),
      ];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.StewardElection, targets, values, calldatas,
        "Elect Dave as steward"
      );

      expect(await stewardContract.currentSteward()).to.equal(dave.address);
      expect(await stewardContract.isStewardActive()).to.be.true;
      expect(await treasury.steward()).to.equal(await stewardContract.getAddress());
    });

    it("should use 30% quorum for steward elections", async function () {
      // 30% of 35M eligible = 10.5M
      // Bob alone (15M) should meet this
      const targets = [await stewardContract.getAddress()];
      const values = [0n];
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [dave.address]),
      ];

      await governor.connect(alice).propose(
        ProposalType.StewardElection, targets, values, calldatas, "30% quorum test"
      );

      const expectedQuorum = ((TOTAL_SUPPLY - TREASURY_AMOUNT) * 3000n) / 10000n;
      expect(await governor.quorum(1)).to.equal(expectedQuorum);
    });

    it("should use extended timing (7d voting, 4d execution)", async function () {
      const targets = [await stewardContract.getAddress()];
      const values = [0n];
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [dave.address]),
      ];

      await governor.connect(alice).propose(
        ProposalType.StewardElection, targets, values, calldatas, "Extended timing"
      );

      const [,, voteStart, voteEnd] = await governor.getProposal(1);
      const blockTimestamp = (await ethers.provider.getBlock("latest"))!.timestamp;

      expect(Number(voteStart) - blockTimestamp).to.be.closeTo(TWO_DAYS, 5);
      expect(Number(voteEnd) - Number(voteStart)).to.be.closeTo(SEVEN_DAYS, 5);
    });
  });

  // ============================================================
  // 6. Treasury Claims
  // ============================================================

  describe("Treasury Claims", function () {
    it("should create and exercise a claim via governance", async function () {
      const claimAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("createClaim", [
        await usdc.getAddress(), carol.address, claimAmount
      ])];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.Treasury, targets, values, calldatas,
        "Create claim for Carol"
      );

      // Carol exercises the claim
      const claimId = 1;
      expect(await treasury.getClaimRemaining(claimId)).to.equal(claimAmount);

      await treasury.connect(carol).exerciseClaim(claimId, claimAmount);
      expect(await usdc.balanceOf(carol.address)).to.equal(claimAmount);
      expect(await treasury.getClaimRemaining(claimId)).to.equal(0);
    });

    it("should support partial claim exercise", async function () {
      const claimAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("createClaim", [
        await usdc.getAddress(), carol.address, claimAmount
      ])];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.Treasury, targets, values, calldatas,
        "Partial claim test"
      );

      const half = claimAmount / 2n;
      await treasury.connect(carol).exerciseClaim(1, half);
      expect(await treasury.getClaimRemaining(1)).to.equal(half);

      await treasury.connect(carol).exerciseClaim(1, half);
      expect(await treasury.getClaimRemaining(1)).to.equal(0);
    });

    it("should reject exercise by non-beneficiary", async function () {
      const claimAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("createClaim", [
        await usdc.getAddress(), carol.address, claimAmount
      ])];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.Treasury, targets, values, calldatas,
        "Non-beneficiary test"
      );

      await expect(
        treasury.connect(dave).exerciseClaim(1, claimAmount)
      ).to.be.revertedWith("ArmadaTreasuryGov: not beneficiary");
    });
  });

  // ============================================================
  // 7. Treasury Steward
  // ============================================================

  describe("Treasury Steward", function () {
    // Helper: elect Dave as steward before each steward test.
    // Sets the TreasurySteward contract as the treasury's steward so that
    // executeAction() → treasury.stewardSpend() works (msg.sender = contract).
    async function electDaveSteward() {
      const targets = [
        await stewardContract.getAddress(),
        await treasury.getAddress(),
      ];
      const values = [0n, 0n];
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [dave.address]),
        treasury.interface.encodeFunctionData("setSteward", [await stewardContract.getAddress()]),
      ];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.StewardElection, targets, values, calldatas,
        "Elect Dave"
      );
    }

    it("should allow steward to spend within 1% monthly budget", async function () {
      await electDaveSteward();

      const treasuryUsdcBalance = await usdc.balanceOf(await treasury.getAddress());
      const budget = treasuryUsdcBalance / 100n; // 1%
      const spendAmount = budget / 2n; // Spend half the budget

      // Steward spends via action queue (proposeAction → delay → executeAction)
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, spendAmount
      ]);
      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      await time.increase(STEWARD_ACTION_DELAY + 1);
      await stewardContract.connect(dave).executeAction(await stewardContract.actionCount());

      expect(await usdc.balanceOf(carol.address)).to.equal(spendAmount);
    });

    it("should reject steward spending above budget", async function () {
      await electDaveSteward();

      const treasuryUsdcBalance = await usdc.balanceOf(await treasury.getAddress());
      const overBudget = (treasuryUsdcBalance / 100n) + 1n; // Just over 1%

      // Steward proposes over-budget spend via action queue
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, overBudget
      ]);
      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Execution reverts because treasury rejects the over-budget spend.
      await expect(
        stewardContract.connect(dave).executeAction(await stewardContract.actionCount())
      ).to.be.revertedWith("TreasurySteward: execution failed");
    });

    it("should reject steward spending after term expires", async function () {
      await electDaveSteward();

      // Fast-forward past 6-month term
      await time.increase(180 * ONE_DAY + 1);

      expect(await stewardContract.isStewardActive()).to.be.false;

      // Treasury stewardSpend still works (it checks msg.sender == steward, not term)
      // But stewardContract.proposeAction checks term
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, ethers.parseUnits("10", USDC_DECIMALS)
      ]);

      await expect(
        stewardContract.connect(dave).proposeAction(
          await treasury.getAddress(), spendData, 0
        )
      ).to.be.revertedWith("TreasurySteward: term expired");
    });

    it("should allow governance to veto a steward action", async function () {
      await electDaveSteward();

      // Steward proposes an action
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, ethers.parseUnits("500", USDC_DECIMALS)
      ]);

      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      const actionId = 1;

      // Governance vetoes the action
      const vetoTargets = [await stewardContract.getAddress()];
      const vetoValues = [0n];
      const vetoCalldatas = [
        stewardContract.interface.encodeFunctionData("vetoAction", [actionId])
      ];

      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.ParameterChange, vetoTargets, vetoValues, vetoCalldatas,
        "Veto steward action #1"
      );

      // Steward tries to execute the vetoed action
      await time.increase(STEWARD_ACTION_DELAY + 1);
      await expect(
        stewardContract.connect(dave).executeAction(actionId)
      ).to.be.revertedWith("TreasurySteward: vetoed");
    });

    it("should execute steward action after delay if not vetoed", async function () {
      await electDaveSteward();

      const spendAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, spendAmount
      ]);

      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );

      // Can't execute before delay
      await expect(
        stewardContract.connect(dave).executeAction(1)
      ).to.be.revertedWith("TreasurySteward: delay not elapsed");

      // Wait for delay
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Now execute succeeds
      await stewardContract.connect(dave).executeAction(1);
      expect(await usdc.balanceOf(carol.address)).to.equal(spendAmount);
    });
  });

  // ============================================================
  // 8. Voter Functions
  // ============================================================

  describe("Voter Functions", function () {
    it("should record yes/no/abstain votes correctly", async function () {
      // Give carol some tokens to vote with (alice unlocks some to fund carol)
      const carolAmount = ethers.parseUnits("1000000", ARM_DECIMALS);
      await votingLocker.connect(alice).unlock(carolAmount);
      await armToken.connect(alice).transfer(carol.address, carolAmount);
      // Alice still has ALICE_AMOUNT - carolAmount locked (no re-lock needed)
      // Lock carol's tokens
      await armToken.connect(carol).approve(await votingLocker.getAddress(), carolAmount);
      await votingLocker.connect(carol).lock(carolAmount);
      await mineBlock();

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Vote test"
      );

      await time.increase(TWO_DAYS + 1);

      await governor.connect(alice).castVote(1, Vote.For);
      await governor.connect(bob).castVote(1, Vote.Against);
      await governor.connect(carol).castVote(1, Vote.Abstain);

      const [,,,,forVotes, againstVotes, abstainVotes] = await governor.getProposal(1);
      // Alice has ALICE_AMOUNT - carolAmount locked at snapshot
      expect(forVotes).to.equal(ALICE_AMOUNT - carolAmount);
      expect(againstVotes).to.equal(BOB_AMOUNT);
      expect(abstainVotes).to.equal(carolAmount);
    });

    it("should reject vote without locked tokens", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "No power test"
      );

      await time.increase(TWO_DAYS + 1);

      // Carol has no locked tokens
      await expect(
        governor.connect(carol).castVote(1, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });

    it("should reject double voting", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Double vote test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      await expect(
        governor.connect(alice).castVote(1, Vote.Against)
      ).to.be.revertedWith("ArmadaGovernor: already voted");
    });

    it("should allow unlock after voting (snapshot-based)", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Unlock test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      // Alice unlocks all tokens while voting is still active
      await votingLocker.connect(alice).unlock(ALICE_AMOUNT);
      expect(await armToken.balanceOf(alice.address)).to.equal(ALICE_AMOUNT);

      // Vote was already recorded with snapshot, so it still counts
      const [,,,,forVotes] = await governor.getProposal(1);
      expect(forVotes).to.equal(ALICE_AMOUNT);
    });
  });

  // ============================================================
  // 9. Proposal Cancel
  // ============================================================

  describe("Proposal Cancel", function () {
    it("should allow proposer to cancel while pending", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Cancel test"
      );

      await governor.connect(alice).cancel(1);
      expect(await governor.state(1)).to.equal(ProposalState.Canceled);
    });

    it("should reject cancel by non-proposer", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Cancel auth test"
      );

      await expect(
        governor.connect(bob).cancel(1)
      ).to.be.revertedWith("ArmadaGovernor: not proposer");
    });
  });

  // ============================================================
  // 10. Full End-to-End Flow
  // ============================================================

  describe("Full Flow", function () {
    it("should complete: lock → propose → vote → queue → execute treasury payout", async function () {
      const payAmount = ethers.parseUnits("2500", USDC_DECIMALS);

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = [treasury.interface.encodeFunctionData("distribute", [
        await usdc.getAddress(), carol.address, payAmount
      ])];

      // Propose
      await governor.connect(alice).propose(
        ProposalType.Treasury, targets, values, calldatas, "Pay Carol 2500 USDC"
      );
      expect(await governor.state(1)).to.equal(ProposalState.Pending);

      // Wait for voting delay
      await time.increase(TWO_DAYS + 1);
      expect(await governor.state(1)).to.equal(ProposalState.Active);

      // Vote
      await governor.connect(alice).castVote(1, Vote.For);
      await governor.connect(bob).castVote(1, Vote.For);

      // Wait for voting period
      await time.increase(FIVE_DAYS + 1);
      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);

      // Queue
      await governor.queue(1);
      expect(await governor.state(1)).to.equal(ProposalState.Queued);

      // Wait for execution delay
      await time.increase(TWO_DAYS + 1);

      // Execute
      const carolBefore = await usdc.balanceOf(carol.address);
      await governor.execute(1);
      expect(await governor.state(1)).to.equal(ProposalState.Executed);

      const carolAfter = await usdc.balanceOf(carol.address);
      expect(carolAfter - carolBefore).to.equal(payAmount);
    });
  });
});
