// ABOUTME: Tests the 7-day governance quiet period after crowdfund finalization.
// ABOUTME: Covers proposal blocking, boundary conditions, governable duration, and access control.

/**
 * Governance Quiet Period Tests (T6.1)
 *
 * After crowdfund finalization, a 7-day quiet period blocks all governance proposals.
 * This gives participants time to claim ARM and delegate before governance begins.
 * The quiet period is governable — governance can shorten, extend, or remove it.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2 };
const ONE_DAY = 86400;
const SEVEN_DAYS = 7 * ONE_DAY;
const THREE_WEEKS = 21 * ONE_DAY;

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
    const MAX_PAUSE_DURATION = 14 * ONE_DAY;

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
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      deployer.address,
      treasuryAddr.address,
      deployer.address,
      deployer.address // securityCouncil
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
      deployer.address,
      MAX_PAUSE_DURATION
    );

    // Grant governor roles on timelock
    await timelockController.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelockController.grantRole(EXECUTOR_ROLE, await governor.getAddress());

    // Deploy treasury for dummy calldata target
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(timelockAddr, deployer.address, MAX_PAUSE_DURATION);
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
    const calldata = treasury.interface.encodeFunctionData("createClaim", [await usdc.getAddress(), deployer.address, 1]);
    return governor.propose(
      ProposalType.Standard,
      [treasuryAddress],
      [0],
      [calldata],
      description
    );
  }

  // Helper: call setQuietPeriodDuration through the timelock (the only authorized caller)
  async function setQuietPeriodViaTImelock(duration: number) {
    const calldata = governor.interface.encodeFunctionData("setQuietPeriodDuration", [duration]);
    const governorAddr = await governor.getAddress();
    const salt = ethers.id(`set-quiet-period-${duration}`);
    await timelockController.schedule(governorAddr, 0, calldata, ethers.ZeroHash, salt, ONE_DAY);
    await time.increase(ONE_DAY + 1);
    await timelockController.execute(governorAddr, 0, calldata, ethers.ZeroHash, salt);
  }

  // Helper: run crowdfund to finalization (normal path — above MIN_SALE)
  async function finalizeCrowdfund() {
    await crowdfund.addSeeds(seeds.map(s => s.address));
    await crowdfund.startWindow();

    for (const seed of seeds) {
      const amount = USDC(15_000);
      await usdc.mint(seed.address, amount);
      await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
      await crowdfund.connect(seed).commit(amount, 0);
    }

    await time.increase(THREE_WEEKS + 1);
    await crowdfund.finalize();
  }

  beforeEach(async function () {
    await deployStack();
  });

  // ============ Core quiet period behavior ============

  describe("Proposal blocking during quiet period", function () {
    it("propose reverts during quiet period (day 1-6 post-finalization)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();

      // Day 3 — well within 7-day quiet period
      await time.increase(3 * ONE_DAY);

      await expect(propose()).to.be.revertedWith("ArmadaGovernor: quiet period active");
    });

    it("propose succeeds after quiet period (day 8+)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();

      await time.increase(SEVEN_DAYS + 1);

      await expect(propose()).to.not.be.reverted;
    });

    it("propose succeeds at exactly finalizedAt + 7 days", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();

      const finalizedAt = await crowdfund.finalizedAt();

      await lockArmForProposal();

      // Move to exactly finalizedAt + 7 days. The lock/mine above advanced time
      // slightly, so compute the remaining offset.
      const currentTime = BigInt(await time.latest());
      const target = finalizedAt + BigInt(SEVEN_DAYS);
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

  // ============ Governable quiet period duration ============

  describe("Governable quiet period duration", function () {
    it("governance can set quietPeriodDuration to 0 to remove it", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());
      await finalizeCrowdfund();
      await lockArmForProposal();

      // Quiet period active — proposal should revert
      await expect(propose("before removal")).to.be.revertedWith("ArmadaGovernor: quiet period active");

      // Governance (timelock) sets quiet period to 0
      await setQuietPeriodViaTImelock(0);

      // Now proposal succeeds during what would have been the quiet period
      await expect(propose("after removal")).to.not.be.reverted;
    });

    it("governance can extend quiet period — propose at day 8 reverts if extended to 14 days", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());

      // Extend quiet period to 14 days via timelock BEFORE finalization
      // (so we don't have to time-travel through the quiet period to execute the timelock op)
      await setQuietPeriodViaTImelock(14 * ONE_DAY);

      await finalizeCrowdfund();
      await lockArmForProposal();

      // Day 8 — would succeed with 7-day period, but now reverts with 14-day
      await time.increase(8 * ONE_DAY);
      await expect(propose()).to.be.revertedWith("ArmadaGovernor: quiet period active");

      // Day 15 (from finalization) — succeeds after extended period
      await time.increase(7 * ONE_DAY);
      await expect(propose()).to.not.be.reverted;
    });
  });

  // ============ Access control ============

  describe("Access control", function () {
    it("setQuietPeriodDuration by non-timelock reverts", async function () {
      await expect(
        governor.connect(nonDeployer).setQuietPeriodDuration(0)
      ).to.be.revertedWith("ArmadaGovernor: not timelock");
    });

    it("setQuietPeriodDuration above MAX_QUIET_PERIOD reverts", async function () {
      const MAX_QUIET_PERIOD = 30 * ONE_DAY;
      const calldata = governor.interface.encodeFunctionData(
        "setQuietPeriodDuration", [MAX_QUIET_PERIOD + 1]
      );
      const governorAddr = await governor.getAddress();
      const salt = ethers.id("exceeds-max-quiet");
      await timelockController.schedule(governorAddr, 0, calldata, ethers.ZeroHash, salt, ONE_DAY);
      await time.increase(ONE_DAY + 1);
      await expect(
        timelockController.execute(governorAddr, 0, calldata, ethers.ZeroHash, salt)
      ).to.be.revertedWith("TimelockController: underlying transaction reverted");
    });

    it("setCrowdfundAddress is one-time only (second call reverts)", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());

      await expect(
        governor.setCrowdfundAddress(await crowdfund.getAddress())
      ).to.be.revertedWith("ArmadaGovernor: already locked");
    });

    it("setCrowdfundAddress by non-deployer reverts", async function () {
      await expect(
        governor.connect(nonDeployer).setCrowdfundAddress(await crowdfund.getAddress())
      ).to.be.revertedWith("ArmadaGovernor: not deployer");
    });

    it("setCrowdfundAddress with zero address reverts", async function () {
      await expect(
        governor.setCrowdfundAddress(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaGovernor: zero address");
    });
  });

  // ============ RefundMode ============

  describe("RefundMode finalization", function () {
    it("quiet period applies even when finalized in refundMode", async function () {
      await governor.setCrowdfundAddress(await crowdfund.getAddress());

      // To trigger refundMode: totalCommitted >= MIN_SALE ($1M) but totalAllocUsdc < MIN_SALE.
      // Must stay below ELASTIC_TRIGGER ($1.5M) to keep saleSize at BASE_SALE ($1.2M).
      // 70 seeds × $15K = $1.05M committed (≥ $1M, < $1.5M → BASE_SALE).
      // Hop-0 ceiling = 70% × $1.2M = $840K. Demand $1.05M > $840K → pro-rata $840K.
      // No hop-1/2 participants → totalAllocUsdc = $840K < $1M → refundMode. ✓
      const refundSeeds = seeds.slice(0, 70);
      await crowdfund.addSeeds(refundSeeds.map(s => s.address));
      await crowdfund.startWindow();

      for (const seed of refundSeeds) {
        const amount = USDC(15_000);
        await usdc.mint(seed.address, amount);
        await usdc.connect(seed).approve(await crowdfund.getAddress(), amount);
        await crowdfund.connect(seed).commit(amount, 0);
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Verify refundMode was triggered
      expect(await crowdfund.refundMode()).to.be.true;
      expect(await crowdfund.finalizedAt()).to.be.gt(0);

      await lockArmForProposal();

      // Quiet period should be active even in refundMode
      await time.increase(3 * ONE_DAY);
      await expect(propose()).to.be.revertedWith("ArmadaGovernor: quiet period active");

      // After quiet period, proposal succeeds
      await time.increase(5 * ONE_DAY);
      await expect(propose()).to.not.be.reverted;
    });
  });
});
