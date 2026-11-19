// ABOUTME: Tests the immutable 10-day governance quiet period and 70-day veto bootstrap after crowdfund finalization.
// ABOUTME: Covers proposal blocking, final early vetoes, boundary conditions, edge cases, and access control.

/**
 * Governance Quiet Period Tests (T6.1)
 *
 * After crowdfund finalization, an immutable 10-day quiet period blocks all governance proposals.
 * This gives participants time to claim ARM and delegate before governance begins.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2 };
const ONE_DAY = 86400;
const QUIET_PERIOD = 10 * ONE_DAY;
const VETO_BOOTSTRAP = 70 * ONE_DAY;

const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

describe("Governance Quiet Period (T6.1)", function () {
  let armToken: any;
  let usdc: any;
  let crowdfund: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;

  let deployer: SignerWithAddress;
  let treasuryAddr: SignerWithAddress;
  let seeds: SignerWithAddress[];
  let nonDeployer: SignerWithAddress;

  const PROPOSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PROPOSER_ROLE"));
  const EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EXECUTOR_ROLE"));

  // Helper: deploy full stack (tokens, crowdfund, governance)
  async function deployStack() {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    treasuryAddr = signers[1];
    nonDeployer = signers[2];
    seeds = signers.slice(3, 103); // 100 seeds

    // Deploy USDC mock
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Deploy governance infrastructure (timelock first — ArmadaToken needs its address)
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      ONE_DAY,
      [deployer.address],
      [deployer.address],
      deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    // Deploy ArmadaToken (ERC20Votes) — requires timelock for governance-gated whitelist
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    // Deploy crowdfund
    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasuryAddr.address,
      deployer.address,
      deployer.address, // securityCouncil
      openTimestamp      // openTimestamp
    );
    await crowdfund.waitForDeployment();

    // Initialize token whitelist (after crowdfund is deployed, before transfers)
    await armToken.initWhitelist([deployer.address, await crowdfund.getAddress(), treasuryAddr.address]);

    // Fund ARM to crowdfund (1.8M for MAX_SALE)
    await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
    await crowdfund.loadArm();

    governor = await deployGovernorProxy(
      await armToken.getAddress(),
      timelockAddr,
      treasuryAddr.address,
    );

    // Grant governor roles on timelock
    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());

    // Deploy treasury for dummy calldata target
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(timelockAddr);
    await treasury.waitForDeployment();
  }

  // Helper: delegate ARM for proposer threshold
  async function lockArmForProposal(amount: bigint = ARM(200_000)) {
    await armToken.delegate(deployer.address);
    await mine(1);
  }

  // Helper: create a basic proposal (async — resolves treasury address)
  async function propose(description = "Test proposal") {
    const treasuryAddress = await treasury.getAddress();
    const calldata = treasury.interface.encodeFunctionData("distribute", [await usdc.getAddress(), deployer.address, 1]);
    return governor.propose(
      ProposalType.Standard,
      [treasuryAddress],
      [0],
      [calldata],
      description
    );
  }

  // Helper: run crowdfund to finalization (normal path — above MIN_SALE)
  async function finalizeCrowdfund() {
    { const ws = Number(await crowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
    await crowdfund.addSeeds(seeds.map(s => s.address));

    for (const seed of seeds) {
      const amount = USDC(15_000);
      await usdc.mint(seed.address, amount);
      await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
      await crowdfund.connect(seed).commit(0, amount);
    }

    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
    await crowdfund.finalize();
  }

  beforeEach(async function () {
    await deployStack();
  });

  // ============ Core quiet period behavior ============

  describe("Proposal blocking during quiet period", function () {
    it("propose reverts during quiet period (day 1-9 post-finalization)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();

      // Day 3 — well within 10-day quiet period
      await time.increase(3 * ONE_DAY);

      await expect(propose()).to.be.revertedWithCustomError(governor, "Gov_QuietPeriodActive");
    });

    // WHY: pins the 10-day length — day 9 post-finalization is still inside the quiet period.
    it("propose still reverts on day 9 post-finalization", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();

      await time.increase(9 * ONE_DAY);

      await expect(propose()).to.be.revertedWithCustomError(governor, "Gov_QuietPeriodActive");
    });

    it("propose succeeds after quiet period (day 11+)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();

      await time.increase(QUIET_PERIOD + 1);

      await expect(propose()).to.not.be.reverted;
    });

    it("propose succeeds at exactly finalizedAt + 10 days", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();

      const finalizedAt = await crowdfund.finalizedAt();

      await lockArmForProposal();

      // Move to exactly finalizedAt + 10 days. The lock/mine above advanced time
      // slightly, so compute the remaining offset.
      const currentTime = BigInt(await time.latest());
      const target = finalizedAt + BigInt(QUIET_PERIOD);
      if (currentTime < target) {
        await time.increaseTo(target);
      }

      await expect(propose()).to.not.be.reverted;
    });
  });

  // ============ Edge cases: no crowdfund / not finalized ============

  describe("Edge cases — no crowdfund or not finalized", function () {
    it("propose succeeds if crowdfund not yet finalized (finalizedAt == 0)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());

      // Crowdfund exists but not finalized — finalizedAt == 0
      expect(await crowdfund.finalizedAt()).to.equal(0);

      await lockArmForProposal();
      await expect(propose()).to.not.be.reverted;
    });

    it("propose succeeds if no crowdfund registered (crowdfundAddress == 0)", async function () {
      // Don't call setCrowdfundAddress — crowdfundAddress remains address(0)
      expect(await governor.crowdfundAddress()).to.equal(ethers.ZeroAddress);

      await lockArmForProposal();
      await expect(propose()).to.not.be.reverted;
    });
  });

  // ============ Access control ============

  describe("Access control", function () {
    it("setCrowdfundAddress is one-time only (second call reverts)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());

      await expect(
        governor.setCrowdfundAddress(await crowdfund.getAddress())
      ).to.be.revertedWithCustomError(governor, "Gov_AlreadyLocked");
    });

    it("setCrowdfundAddress by non-deployer reverts", async function () {
      await expect(
        governor.connect(nonDeployer).setCrowdfundAddress(await crowdfund.getAddress())
      ).to.be.revertedWithCustomError(governor, "Gov_NotDeployer");
    });

    it("setCrowdfundAddress with zero address reverts", async function () {
      await expect(
        governor.setCrowdfundAddress(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(governor, "Gov_ZeroAddress");
    });
  });

  // ============ RefundMode ============

  describe("RefundMode finalization", function () {
    it("quiet period applies even when finalized in refundMode", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());

      // To trigger refundMode: capped demand < MIN_SALE ($250K).
      // 16 seeds × $15K = $240K committed < $250K → refundMode. ✓
      const refundSeeds = seeds.slice(0, 16);
      { const ws = Number(await crowdfund.windowStart()); if ((await time.latest()) < ws) await time.increaseTo(ws); }
      await crowdfund.addSeeds(refundSeeds.map(s => s.address));

      for (const seed of refundSeeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(0, amount);
      }

      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.finalize();

      // Verify refundMode was triggered
      expect(await crowdfund.refundMode()).to.be.true;
      expect(await crowdfund.finalizedAt()).to.be.gt(0);

      await lockArmForProposal();

      // Quiet period should be active even in refundMode
      await time.increase(3 * ONE_DAY);
      await expect(propose()).to.be.revertedWithCustomError(governor, "Gov_QuietPeriodActive");

      // After quiet period, proposal succeeds
      await time.increase(8 * ONE_DAY);
      await expect(propose()).to.not.be.reverted;
    });
  });

  // ============ Veto bootstrap ============

  describe("Veto bootstrap (first 70 days after finalization)", function () {
    let sc: SignerWithAddress;

    // Propose, pass and queue a proposal, returning its id.
    async function proposeAndQueue(description: string): Promise<bigint> {
      await propose(description);
      const id = await governor.proposalCount();
      const [, , voteStart, voteEnd] = await governor.getProposal(id);
      await time.increaseTo(voteStart + 1n);
      await governor.castVote(id, 1);
      await time.increaseTo(voteEnd + 1n);
      await governor.queue(id);
      return id;
    }

    beforeEach(async function () {
      sc = nonDeployer;
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await governor.setSecurityCouncil(sc.address); // deployer bootstrap path
      // veto() cancels the queued timelock operation.
      await timelockController.grantRole(await timelockController.CANCELLER_ROLE(), await governor.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();
      await time.increase(QUIET_PERIOD);
    });

    // WHY: with the real crowdfund and governor, a veto inside the bootstrap is final: the
    // proposal is canceled for good and no ratification vote is created to challenge it.
    it("a veto within 70 days of finalization is final (no ratification vote)", async function () {
      const id = await proposeAndQueue("early proposal");
      const finalizedAt = await crowdfund.finalizedAt();
      expect(BigInt(await time.latest())).to.be.lt(finalizedAt + BigInt(VETO_BOOTSTRAP));
      const countBefore = await governor.proposalCount();
      const rationale = ethers.id("bootstrap veto");

      await expect(governor.connect(sc).veto(id, rationale))
        .to.emit(governor, "ProposalVetoed").withArgs(id, rationale, 0);

      expect(await governor.proposalCount()).to.equal(countBefore);
      expect(await governor.vetoRatificationId(id)).to.equal(0);
      expect(await governor.state(id)).to.equal(6); // ProposalState.Canceled
      expect(await governor.securityCouncil()).to.equal(sc.address);
    });

    // WHY: from finalizedAt + 70 days a veto follows the normal path again and opens the
    // 14-day ratification vote, so later vetoes stay challengeable.
    it("a veto from finalizedAt + 70 days creates a ratification vote", async function () {
      const finalizedAt = await crowdfund.finalizedAt();
      const id = await proposeAndQueue("late proposal");
      await time.increaseTo(finalizedAt + BigInt(VETO_BOOTSTRAP));
      const rationale = ethers.id("post-bootstrap veto");

      await expect(governor.connect(sc).veto(id, rationale))
        .to.emit(governor, "ProposalVetoed").withArgs(id, rationale, id + 1n);

      expect(await governor.vetoRatificationId(id)).to.equal(id + 1n);
      expect(await governor.ratificationOf(id + 1n)).to.equal(id);
    });
  });
});
