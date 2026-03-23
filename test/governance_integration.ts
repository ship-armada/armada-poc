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
const SEVEN_DAYS = 7 * ONE_DAY;
const FOURTEEN_DAYS = 14 * ONE_DAY;
const THIRTY_DAYS = 30 * ONE_DAY;

// Spec-aligned timing: standard voting = 7d, extended voting = 14d, extended execution = 7d
const STANDARD_VOTING_PERIOD = SEVEN_DAYS;
const EXTENDED_VOTING_PERIOD = FOURTEEN_DAYS;
const STANDARD_EXECUTION_DELAY = TWO_DAYS;
const EXTENDED_EXECUTION_DELAY = SEVEN_DAYS;

describe("Governance Integration", function () {
  // Contracts
  let armToken: any;
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

  // Constants — derived from total supply so tests adapt if supply changes
  const ARM_DECIMALS = 18;
  const TOTAL_SUPPLY = ethers.parseUnits("12000000", ARM_DECIMALS); // must match ArmadaToken.INITIAL_SUPPLY
  const TREASURY_AMOUNT = TOTAL_SUPPLY * 65n / 100n; // 65% to treasury
  const ALICE_AMOUNT = TOTAL_SUPPLY * 20n / 100n;    // 20% to Alice (voter)
  const BOB_AMOUNT = TOTAL_SUPPLY * 15n / 100n;      // 15% to Bob (voter)
  const USDC_DECIMALS = 6;
  // Minimum action delay = 120% of governance cycle (2d + 7d + 2d = 11d)
  // 11 days * 1.2 = 13.2 days = 1140480 seconds
  const STEWARD_ACTION_DELAY = Math.ceil((TWO_DAYS + STANDARD_VOTING_PERIOD + STANDARD_EXECUTION_DELAY) * 12000 / 10000);

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
    const votingPeriod = proposalType === ProposalType.StewardElection ? EXTENDED_VOTING_PERIOD : STANDARD_VOTING_PERIOD;
    await time.increase(votingPeriod + 1);

    // Queue
    await governor.queue(proposalId);

    // Fast-forward past execution delay
    const executionDelay = proposalType === ProposalType.StewardElection ? EXTENDED_EXECUTION_DELAY : STANDARD_EXECUTION_DELAY;
    await time.increase(executionDelay + 1);

    // Execute
    await governor.execute(proposalId);

    return proposalId;
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    // 1. Deploy TimelockController (minDelay = 2 days, deployer as temp admin)
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS,
      [], // proposers (added later)
      [], // executors (added later)
      deployer.address // admin
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    // 2. Deploy ARM token (all supply to deployer, timelock for whitelist governance)
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    // Emergency pause config: deployer as guardian, 14 day max pause duration
    const MAX_PAUSE_DURATION = 14 * ONE_DAY;

    // 3. Deploy ArmadaTreasuryGov (owned by timelock)
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(
      timelockAddr,
      deployer.address,        // guardian
      MAX_PAUSE_DURATION
    );
    await treasury.waitForDeployment();

    // 4. Deploy ArmadaGovernor
    const ArmadaGovernor = await ethers.getContractFactory("ArmadaGovernor");
    governor = await ArmadaGovernor.deploy(
      await armToken.getAddress(),
      timelockAddr,
      await treasury.getAddress(),
      deployer.address,        // guardian
      MAX_PAUSE_DURATION
    );
    await governor.waitForDeployment();

    // 5. Deploy TreasurySteward
    const TreasurySteward = await ethers.getContractFactory("TreasurySteward");
    stewardContract = await TreasurySteward.deploy(
      timelockAddr,
      await treasury.getAddress(),
      await governor.getAddress(),
      STEWARD_ACTION_DELAY,
      deployer.address,        // guardian
      MAX_PAUSE_DURATION
    );
    await stewardContract.waitForDeployment();

    // 6. Configure token: whitelist addresses so transfers work, set treasury as noDelegation
    await armToken.initWhitelist([
      deployer.address,
      await treasury.getAddress(),
      alice.address,
      bob.address,
    ]);
    await armToken.setNoDelegation(await treasury.getAddress());

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

    // 12. Alice and Bob self-delegate to activate voting power
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

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
      // Alice and Bob hold tokens directly
      expect(await armToken.balanceOf(alice.address)).to.equal(ALICE_AMOUNT);
      expect(await armToken.balanceOf(bob.address)).to.equal(BOB_AMOUNT);
    });

    it("should have voting power via delegation", async function () {
      // Alice and Bob self-delegated in beforeEach
      expect(await armToken.getVotes(alice.address)).to.equal(ALICE_AMOUNT);
      expect(await armToken.getVotes(bob.address)).to.equal(BOB_AMOUNT);
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
      await time.increase(STANDARD_VOTING_PERIOD + 1);
      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);
    });

    it("should be defeated if quorum not reached", async function () {
      // Alice (20% of supply) meets quorum (7% of supply).
      // Test with no votes at all to verify defeated state.
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "No votes"
      );

      await time.increase(TWO_DAYS + 1);
      // Nobody votes
      await time.increase(STANDARD_VOTING_PERIOD + 1);

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

      await time.increase(STANDARD_VOTING_PERIOD + 1);
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
      await time.increase(STANDARD_VOTING_PERIOD + 1);

      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);

      // Queue
      await governor.queue(1);
      expect(await governor.state(1)).to.equal(ProposalState.Queued);

      // Fast-forward past execution delay
      await time.increase(STANDARD_EXECUTION_DELAY + 1);

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
      // voteEnd should be ~9 days from now (2d delay + 7d period)
      expect(Number(voteEnd) - blockTimestamp).to.be.closeTo(TWO_DAYS + STANDARD_VOTING_PERIOD, 5);
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
      // Eligible supply = totalSupply - treasury (65%) = 35% of supply
      // 20% quorum = 7% of total supply
      // Alice has 20% of supply locked, exceeding quorum
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.Treasury, targets, values, calldatas, "Quorum test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);
      await time.increase(STANDARD_VOTING_PERIOD + 1);

      // Should succeed with only Alice's vote (20% of supply > 7% quorum)
      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);
    });

    it("should calculate quorum excluding treasury-held ARM", async function () {
      // Quorum = 20% of (totalSupply - treasury balance)
      const expectedEligible = TOTAL_SUPPLY - TREASURY_AMOUNT; // 35% of supply
      const expectedQuorum = (expectedEligible * 2000n) / 10000n; // 7% of supply

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

    it("should enforce quorum floor when percentage-based quorum is below 100k ARM", async function () {
      // Exclude Alice and Bob from quorum denominator, leaving eligible supply = 0.
      // Percentage quorum = 20% of 0 = 0, which is below the 100k floor.
      // The floor should apply.
      await governor.setExcludedAddresses([alice.address, bob.address]);

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];
      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Quorum floor test"
      );

      const QUORUM_FLOOR = ethers.parseUnits("100000", ARM_DECIMALS);
      const actualQuorum = await governor.quorum(1);
      expect(actualQuorum).to.equal(QUORUM_FLOOR);
    });

    it("should use percentage-based quorum when it exceeds the floor", async function () {
      // With default setup: eligible = 4.2M ARM, 20% = 840k ARM > 100k floor.
      // Percentage should win.
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];
      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Percentage quorum test"
      );

      const expectedEligible = TOTAL_SUPPLY - TREASURY_AMOUNT;
      const expectedQuorum = (expectedEligible * 2000n) / 10000n;
      const QUORUM_FLOOR = ethers.parseUnits("100000", ARM_DECIMALS);

      const actualQuorum = await governor.quorum(1);
      expect(actualQuorum).to.equal(expectedQuorum);
      expect(actualQuorum).to.be.greaterThan(QUORUM_FLOOR);
    });

    it("should enforce quorum floor for extended proposals (30% quorum type)", async function () {
      // Exclude Alice and Bob → eligible = 0 → 30% of 0 = 0 < floor.
      await governor.setExcludedAddresses([alice.address, bob.address]);

      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];
      await governor.connect(alice).propose(
        ProposalType.StewardElection, targets, values, calldatas, "Extended quorum floor test"
      );

      const QUORUM_FLOOR = ethers.parseUnits("100000", ARM_DECIMALS);
      expect(await governor.quorum(1)).to.equal(QUORUM_FLOOR);
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
      // 30% of eligible (35% of supply) = 10.5% of total supply
      // Bob (15% of supply) should meet this
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

    it("should use extended timing (14d voting, 7d execution)", async function () {
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
      expect(Number(voteEnd) - Number(voteStart)).to.be.closeTo(EXTENDED_VOTING_PERIOD, 5);
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

      // Execution reverts — the original treasury revert reason is bubbled up.
      await expect(
        stewardContract.connect(dave).executeAction(await stewardContract.actionCount())
      ).to.be.revertedWith("ArmadaTreasuryGov: exceeds monthly budget");
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

    it("should reject new steward executing previous steward's actions", async function () {
      // Elect Dave as first steward
      await electDaveSteward();

      // Dave proposes an action
      const spendAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, spendAmount
      ]);
      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      const actionId = await stewardContract.actionCount();

      // Elect Carol as new steward (replaces Dave)
      const targets = [await stewardContract.getAddress()];
      const values = [0n];
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [carol.address]),
      ];
      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.StewardElection, targets, values, calldatas,
        "Elect Carol as steward"
      );
      expect(await stewardContract.currentSteward()).to.equal(carol.address);

      // Wait for action delay to elapse
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Carol (new steward) tries to execute Dave's action — should fail
      await expect(
        stewardContract.connect(carol).executeAction(actionId)
      ).to.be.revertedWith("TreasurySteward: not proposed by current steward");
    });

    it("should allow steward to cancel own proposed action", async function () {
      // Elect Dave as steward
      await electDaveSteward();

      // Dave proposes an action
      const spendAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, spendAmount
      ]);
      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      const actionId = await stewardContract.actionCount();

      // Dave cancels the action
      await expect(
        stewardContract.connect(dave).cancelAction(actionId)
      ).to.emit(stewardContract, "ActionCanceled").withArgs(actionId);

      // Wait for action delay
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Action should be blocked from execution (vetoed flag set)
      await expect(
        stewardContract.connect(dave).executeAction(actionId)
      ).to.be.revertedWith("TreasurySteward: vetoed");
    });

    it("should reject new steward canceling previous steward's action", async function () {
      // Elect Dave as steward
      await electDaveSteward();

      // Dave proposes an action
      const spendAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, spendAmount
      ]);
      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      const actionId = await stewardContract.actionCount();

      // Elect Carol as new steward
      const targets = [await stewardContract.getAddress()];
      const values = [0n];
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [carol.address]),
      ];
      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.StewardElection, targets, values, calldatas,
        "Elect Carol as steward"
      );

      // Carol tries to cancel Dave's action — should fail
      await expect(
        stewardContract.connect(carol).cancelAction(actionId)
      ).to.be.revertedWith("TreasurySteward: not your action");
    });

    it("should allow steward to execute own actions after re-election", async function () {
      // Elect Dave as steward
      await electDaveSteward();

      // Dave proposes an action
      const spendAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const spendData = treasury.interface.encodeFunctionData("stewardSpend", [
        await usdc.getAddress(), carol.address, spendAmount
      ]);
      await stewardContract.connect(dave).proposeAction(
        await treasury.getAddress(), spendData, 0
      );
      const actionId = await stewardContract.actionCount();

      // Re-elect Dave (same person, new term)
      const targets = [await stewardContract.getAddress()];
      const values = [0n];
      const calldatas = [
        stewardContract.interface.encodeFunctionData("electSteward", [dave.address]),
      ];
      await passProposal(
        alice,
        [{ signer: alice, support: Vote.For }, { signer: bob, support: Vote.For }],
        ProposalType.StewardElection, targets, values, calldatas,
        "Re-elect Dave"
      );

      // Wait for action delay
      await time.increase(STEWARD_ACTION_DELAY + 1);

      // Dave can still execute his own action after re-election
      await stewardContract.connect(dave).executeAction(actionId);
      expect(await usdc.balanceOf(carol.address)).to.equal(spendAmount);
    });
  });

  // ============================================================
  // 8. Voter Functions
  // ============================================================

  describe("Voter Functions", function () {
    it("should record yes/no/abstain votes correctly", async function () {
      // Give carol some tokens and delegation to vote with
      const carolAmount = ALICE_AMOUNT / 10n; // 10% of alice's balance
      await armToken.connect(alice).transfer(carol.address, carolAmount);
      await armToken.connect(carol).delegate(carol.address);
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
      // Alice transferred carolAmount away, so her voting power is reduced
      expect(forVotes).to.equal(ALICE_AMOUNT - carolAmount);
      expect(againstVotes).to.equal(BOB_AMOUNT);
      expect(abstainVotes).to.equal(carolAmount);
    });

    it("should reject vote without delegated tokens", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "No power test"
      );

      await time.increase(TWO_DAYS + 1);

      // Carol has no delegated tokens
      await expect(
        governor.connect(carol).castVote(1, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: no voting power");
    });

    it("should allow vote switching from For to Against", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Vote switch test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      let [,,,,forVotes, againstVotes] = await governor.getProposal(1);
      expect(forVotes).to.equal(ALICE_AMOUNT);
      expect(againstVotes).to.equal(0n);

      // Switch to Against
      await expect(governor.connect(alice).castVote(1, Vote.Against))
        .to.emit(governor, "VoteChanged")
        .withArgs(alice.address, 1, Vote.For, Vote.Against, ALICE_AMOUNT);

      [,,,,forVotes, againstVotes] = await governor.getProposal(1);
      expect(forVotes).to.equal(0n);
      expect(againstVotes).to.equal(ALICE_AMOUNT);
      expect(await governor.hasVoted(1, alice.address)).to.be.true;
      expect(await governor.voteChoice(1, alice.address)).to.equal(Vote.Against);
    });

    it("should allow vote switching from Against to Abstain", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Switch test 2"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.Against);
      await governor.connect(alice).castVote(1, Vote.Abstain);

      const [,,,,forVotes, againstVotes, abstainVotes] = await governor.getProposal(1);
      expect(forVotes).to.equal(0n);
      expect(againstVotes).to.equal(0n);
      expect(abstainVotes).to.equal(ALICE_AMOUNT);
    });

    it("should reject casting the same vote twice", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Same vote test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      await expect(
        governor.connect(alice).castVote(1, Vote.For)
      ).to.be.revertedWith("ArmadaGovernor: same vote");
    });

    it("should preserve quorum total when vote is switched", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Quorum conservation test"
      );

      await time.increase(TWO_DAYS + 1);

      // Alice and Bob both vote For
      await governor.connect(alice).castVote(1, Vote.For);
      await governor.connect(bob).castVote(1, Vote.For);

      let [,,,,forVotes, againstVotes, abstainVotes] = await governor.getProposal(1);
      const totalBefore = forVotes + againstVotes + abstainVotes;

      // Alice switches to Against
      await governor.connect(alice).castVote(1, Vote.Against);

      [,,,,forVotes, againstVotes, abstainVotes] = await governor.getProposal(1);
      const totalAfter = forVotes + againstVotes + abstainVotes;
      expect(totalAfter).to.equal(totalBefore);
    });

    it("should allow multiple vote changes", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Multi-switch test"
      );

      await time.increase(TWO_DAYS + 1);

      // For → Against → Abstain → For
      await governor.connect(alice).castVote(1, Vote.For);
      await governor.connect(alice).castVote(1, Vote.Against);
      await governor.connect(alice).castVote(1, Vote.Abstain);
      await governor.connect(alice).castVote(1, Vote.For);

      const [,,,,forVotes, againstVotes, abstainVotes] = await governor.getProposal(1);
      expect(forVotes).to.equal(ALICE_AMOUNT);
      expect(againstVotes).to.equal(0n);
      expect(abstainVotes).to.equal(0n);
    });

    it("should allow re-delegation after voting (snapshot-based)", async function () {
      const targets = [await treasury.getAddress()];
      const values = [0n];
      const calldatas = ["0x"];

      await governor.connect(alice).propose(
        ProposalType.ParameterChange, targets, values, calldatas, "Re-delegation test"
      );

      await time.increase(TWO_DAYS + 1);
      await governor.connect(alice).castVote(1, Vote.For);

      // Alice re-delegates to bob while voting is still active
      await armToken.connect(alice).delegate(bob.address);
      expect(await armToken.getVotes(alice.address)).to.equal(0);

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
    it("should complete: delegate → propose → vote → queue → execute treasury payout", async function () {
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
      await time.increase(STANDARD_VOTING_PERIOD + 1);
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
